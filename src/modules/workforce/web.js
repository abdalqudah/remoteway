const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const employees = require('./employee.service');
const structure = require('./structure.service');
const orgs = require('../organizations/organization.service');
const ent = require('../billing/entitlements.service');
const documents = require('../documents/document.service');

const router = express.Router();

async function formOptions(ctx) {
  const [departments, locations, managers, countries, usage] = await Promise.all([
    structure.listDepartments(ctx.organizationId), structure.listLocations(ctx.organizationId), employees.options(ctx.organizationId),
    orgs.listCountries(), ent.getUsage(ctx.organizationId),
  ]);
  return { departments, locations, managers, countries, usage };
}

// ---------- Employees ----------
router.get('/employees', canAny('employees.view', 'team.view'), wrap(async (req, res) => {
  const query = { status: 'current', ...req.query };
  const result = await employees.list(req.ctx, query);
  const [departments, locations, usage] = await Promise.all([
    structure.listDepartments(req.ctx.organizationId), structure.listLocations(req.ctx.organizationId), ent.getUsage(req.ctx.organizationId),
  ]);
  res.page('pages/employees/index', { title: req.t('nav.employees'), result, departments, locations, usage, types: employees.EMPLOYMENT_TYPES });
}));

router.get('/employees/export.csv', can('employees.view'), wrap(async (req, res) => {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const { data, meta } = await employees.list(req.ctx, { ...req.query, page, per_page: 100 });
    rows.push(...data);
    if (page >= meta.pages) break;
  }
  const cols = ['employee_number', 'first_name', 'last_name', 'email', 'phone', 'job_title', 'department_name', 'location_name', 'manager_name', 'employment_type', 'work_mode', 'status', 'joining_date'];
  if (req.ctx.permissions.has('employees.view_salary')) cols.push('base_salary', 'salary_currency');
  const esc = (v) => {
    let s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralize spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="employees-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`﻿${csv}`);
}));

const renderNew = async (req, res, extra = {}) => res.page('pages/employees/form', {
  title: req.t('employees.add'), employee: null, ...(await formOptions(req.ctx)), ...extra,
});

router.get('/employees/new', can('employees.create'), wrap((req, res) => renderNew(req, res)));
router.post('/employees', can('employees.create'), form(async (req, res) => {
  const employee = await employees.create(req.ctx, req.body);
  flash(req, 'success', req.t('employees.created', { name: employee.full_name }));
  res.redirect(`/app/employees/${employee.id}`);
}, renderNew));

router.get('/employees/:id', canAny('employees.view', 'team.view'), wrap(async (req, res) => {
  const employee = await employees.get(req.ctx, Number(req.params.id));
  const tab = req.query.tab || 'overview';
  const has = (f) => req.entitlements.features.has(f);
  const extra = {};
  if (tab === 'documents' && has('documents')) {
    extra.docs = await documents.list(req.ctx, { employee_id: employee.id });
    extra.categories = documents.CATEGORIES;
    extra.people = [];
  }
  if (tab === 'leave' && has('leave')) {
    const leaveService = require('../leave/leave.service');
    extra.balances = await leaveService.balancesFor(req.ctx.organizationId, employee.id);
    extra.requests = (await leaveService.teamRequests(req.ctx, { status: undefined })).filter((r) => r.employee_id === employee.id);
    extra.leaveTypes = await leaveService.listTypes(req.ctx.organizationId, { activeOnly: true });
  }
  if (tab === 'attendance' && has('attendance')) {
    extra.sheet = await require('../attendance/attendance.service').timesheet(req.ctx, employee.id, req.query.month);
  }
  const perms = req.ctx.permissions;
  if (tab === 'payroll' && has('payroll') && (perms.has('employees.view_salary') || perms.has('payroll.view'))) {
    const payroll = require('../payroll/payroll.service');
    extra.comp = perms.has('employees.view_salary') ? await payroll.getCompensation(req.ctx, employee.id) : null;
    extra.payslips = perms.has('payroll.view') ? await payroll.payslipsForEmployee(req.ctx, employee.id, { paidOnly: false }) : [];
  }
  if (tab === 'performance' && has('performance')) {
    const perfGoals = require('../performance/goals.service');
    const perfReviews = require('../performance/reviews.service');
    const [goalRows, reviewRows, feedbackRows] = await Promise.all([
      perfGoals.list(req.ctx, { employee_id: employee.id, status: 'all' }), perfReviews.reviewsForEmployee(req.ctx, employee.id), perfReviews.listFeedback(req.ctx, { employeeId: employee.id }),
    ]);
    Object.assign(extra, { perfGoals: goalRows, perfReviews: reviewRows, perfFeedback: feedbackRows });
  }
  if (tab === 'training' && has('learning')) {
    const learn = require('../learning/enrollments.service');
    extra.training = await learn.forEmployee(req.ctx, employee.id);
    extra.certificates = extra.training ? await learn.certificatesForEmployee(req.ctx, employee.id) : [];
  }
  res.page('pages/employees/show', { title: employee.full_name, employee, tab, ...extra });
}));

const renderEdit = async (req, res, extra = {}) => {
  const employee = await employees.get(req.ctx, Number(req.params.id));
  return res.page('pages/employees/form', { title: req.t('employees.edit'), employee, ...(await formOptions(req.ctx)), ...extra });
};
router.get('/employees/:id/edit', can('employees.edit'), wrap((req, res) => renderEdit(req, res)));
router.post('/employees/:id', can('employees.edit'), form(async (req, res) => {
  await employees.update(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/app/employees/${req.params.id}`);
}, renderEdit));

router.post('/employees/:id/terminate', can('employees.delete'), wrap(async (req, res) => {
  await employees.terminate(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('employees.terminated_msg'));
  res.redirect(`/app/employees/${req.params.id}`);
}));

router.post('/employees/:id/reactivate', can('employees.edit'), form(async (req, res) => {
  await employees.reactivate(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('employees.reactivated_msg'));
  res.redirect(`/app/employees/${req.params.id}`);
}, async (req, res, extra) => {
  flash(req, 'error', extra.formError.message);
  res.redirect(`/app/employees/${req.params.id}`);
}));

router.post('/employees/:id/delete', can('employees.delete'), wrap(async (req, res) => {
  await employees.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('employees.deleted_msg'));
  res.redirect('/app/employees');
}));

// ---------- Departments & locations ----------
const renderStructure = async (req, res, extra = {}) => {
  const [departments, locations, managers, countries] = await Promise.all([
    structure.listDepartments(req.ctx.organizationId), structure.listLocations(req.ctx.organizationId),
    employees.options(req.ctx.organizationId), orgs.listCountries(),
  ]);
  res.page('pages/structure/index', {
    title: req.t('nav.structure'), departments, locations, managers, countries, tab: extra.tab || req.query.tab || 'departments', ...extra,
  });
};

router.get('/structure', can('employees.view'), wrap((req, res) => renderStructure(req, res)));

router.post('/departments', can('departments.manage'), form(async (req, res) => {
  await structure.saveDepartment(req.ctx, req.body.id ? Number(req.body.id) : null, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/structure?tab=departments');
}, (req, res, extra) => renderStructure(req, res, { ...extra, tab: 'departments', openDialog: 'department' })));

router.post('/departments/:id/delete', can('departments.manage'), form(async (req, res) => {
  await structure.deleteDepartment(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect('/app/structure?tab=departments');
}, (req, res, extra) => renderStructure(req, res, { ...extra, tab: 'departments' })));

router.post('/locations', can('locations.manage'), form(async (req, res) => {
  await structure.saveLocation(req.ctx, req.body.id ? Number(req.body.id) : null, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/structure?tab=locations');
}, (req, res, extra) => renderStructure(req, res, { ...extra, tab: 'locations', openDialog: 'location' })));

router.post('/locations/:id/delete', can('locations.manage'), form(async (req, res) => {
  await structure.deleteLocation(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect('/app/structure?tab=locations');
}, (req, res, extra) => renderStructure(req, res, { ...extra, tab: 'locations' })));

module.exports = router;
