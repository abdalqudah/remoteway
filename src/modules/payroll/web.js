const express = require('express');
const { wrap, form, flash, back } = require('../../routes/helpers');
const { can, feature } = require('../../middleware/context');
const csv = require('../../core/csv');
const { todayIn } = require('../../core/workdays');
const payroll = require('./payroll.service');

const router = express.Router();
router.use(feature('payroll'));

const monthOptions = (timezone) => {
  const [y, m] = todayIn(timezone).slice(0, 7).split('-').map(Number);
  const out = [];
  for (let i = 1; i >= -3; i -= 1) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
};

// ---------- Overview ----------
const renderIndex = async (req, res, extra = {}) => {
  const [runs, readiness, missingSalary, missingIban, { rules }] = await Promise.all([
    payroll.listRuns(req.ctx), payroll.readiness(req.ctx.organizationId),
    payroll.missingProfiles(req.ctx.organizationId, 'salary'), payroll.missingProfiles(req.ctx.organizationId, 'iban'),
    payroll.rulesFor(req.ctx.organizationId),
  ]);
  const taken = new Set(runs.filter((r) => r.status !== 'cancelled').map((r) => r.period));
  const months = monthOptions(req.organization.timezone).filter((p) => !taken.has(p));
  res.page('pages/payroll/index', { title: req.t('nav.payroll'), runs, readiness, missingSalary, missingIban, months, rules, ...extra });
};
router.get('/', can('payroll.view'), wrap((req, res) => renderIndex(req, res)));
router.post('/runs', can('payroll.process'), form(async (req, res) => {
  const id = await payroll.createRun(req.ctx, req.body.period);
  flash(req, 'success', req.t('payroll.run_created'));
  res.redirect(`/app/payroll/runs/${id}`);
}, async (req, res, extra) => {
  if (extra.formError?.code === 'PAYROLL_EXISTS' && extra.formError.details?.id) return res.redirect(`/app/payroll/runs/${extra.formError.details.id}`);
  return renderIndex(req, res, { ...extra, openDialog: 'run' });
}));

// ---------- Run ----------
const renderRun = async (req, res, extra = {}) => {
  const run = await payroll.getRun(req.ctx, Number(req.params.id));
  const { rules } = await payroll.rulesFor(req.ctx.organizationId);
  res.page('pages/payroll/run', { title: req.t('payroll.run_title', { period: run.period }), run, rules, ...extra });
};
router.get('/runs/:id', can('payroll.view'), wrap((req, res) => renderRun(req, res)));

const runAction = (fn, message) => form(async (req, res) => {
  await fn(req);
  if (message) flash(req, 'success', req.t(message));
  res.redirect(`/app/payroll/runs/${req.params.id}`);
}, async (req, res, extra) => {
  if (extra.errors && Object.keys(extra.errors).length) return renderRun(req, res, { ...extra, openDialog: 'adjust' });
  flash(req, 'error', extra.formError.message);
  return res.redirect(`/app/payroll/runs/${req.params.id}`);
});

router.post('/runs/:id/recalculate', can('payroll.process'), runAction((req) => payroll.calculateRun(req.ctx, Number(req.params.id)), 'payroll.recalculated'));
router.post('/runs/:id/adjustments', can('payroll.process'), runAction((req) => payroll.addAdjustment(req.ctx, Number(req.params.id), req.body), 'payroll.adjustment_added'));
router.post('/runs/:id/adjustments/:adj/delete', can('payroll.process'), runAction((req) => payroll.removeAdjustment(req.ctx, Number(req.params.id), Number(req.params.adj))));
for (const [action, message] of [['submit', 'payroll.submitted_msg'], ['reopen', 'payroll.reopened_msg'], ['pay', 'payroll.paid_msg'], ['cancel', 'payroll.cancelled_msg']]) {
  router.post(`/runs/:id/${action}`, can('payroll.process'), runAction((req) => payroll.transition(req.ctx, Number(req.params.id), action, req.body), message));
}
router.post('/runs/:id/approve', can('payroll.approve'), runAction((req) => payroll.transition(req.ctx, Number(req.params.id), 'approve'), 'payroll.approved_msg'));

// ---------- Exports ----------
router.get('/runs/:id/export/:kind', can('payroll.view'), wrap(async (req, res, next) => {
  const run = await payroll.getRun(req.ctx, Number(req.params.id));
  const slips = run.payslips;
  const name = `payroll-${run.period}`;
  if (req.params.kind === 'register.csv') {
    return csv.send(res, `${name}-register.csv`,
      ['Employee ID', 'Name', 'Department', 'Job title', 'Paid days', 'Unpaid leave days', 'Basic', 'Allowances', 'Gross', 'Deductions', 'Net', 'GOSI employee', 'GOSI employer', 'Employer cost', 'Currency'],
      slips.map((s) => [s.employee_number, s.employee_name, s.department_name, s.job_title, Number(s.paid_days), Number(s.unpaid_leave_days), Number(s.basic), s.allowances,
        Number(s.gross), Number(s.total_deductions), Number(s.net), s.gosi_employee, s.gosi_employer, Number(s.employer_cost), run.currency]));
  }
  if (req.params.kind === 'bank.csv') {
    return csv.send(res, `${name}-bank-transfer.csv`, ['Employee ID', 'Beneficiary', 'Bank', 'IBAN', 'Amount', 'Currency', 'Reference'],
      slips.filter((s) => s.payment_method !== 'cash' && Number(s.net) > 0)
        .map((s) => [s.employee_number, s.employee_name, s.bank_name, s.iban, Number(s.net), run.currency, `Salary ${run.period}`]));
  }
  if (req.params.kind === 'gosi.csv') {
    return csv.send(res, `${name}-gosi.csv`, ['Employee ID', 'Name', 'Nationality', 'Contribution wage', 'Employee share', 'Employer share', 'Total', 'Currency'],
      slips.filter((s) => Number(s.gosi_base) > 0).map((s) => [s.employee_number, s.employee_name, s.nationality, Number(s.gosi_base), s.gosi_employee, s.gosi_employer,
        Math.round((s.gosi_employee + s.gosi_employer) * 1000) / 1000, run.currency]));
  }
  return next();
}));

// ---------- Payslips ----------
router.get('/payslips/:id', wrap(async (req, res) => {
  const slip = await payroll.getPayslip(req.ctx, Number(req.params.id));
  res.page('pages/payroll/payslip', { title: req.t('payroll.payslip_title', { period: slip.period }), slip, layout: req.query.print === '1' ? 'print' : 'app' });
}));
router.get('/my', wrap(async (req, res) => {
  res.page('pages/payroll/my', { title: req.t('payroll.my_payslips'), rows: await payroll.myPayslips(req.ctx) });
}));

// ---------- Settings & components ----------
const renderSettings = async (req, res, extra = {}) => {
  const [components, { rules, settings }] = await Promise.all([payroll.listComponents(req.ctx.organizationId), payroll.rulesFor(req.ctx.organizationId)]);
  res.page('pages/payroll/settings', { title: req.t('payroll.settings'), components, rules, settings, ...extra });
};
router.get('/settings', can('payroll.view'), wrap((req, res) => renderSettings(req, res)));
router.post('/settings', can('payroll.process'), form(async (req, res) => {
  await payroll.saveSettings(req.ctx, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/payroll/settings');
}, renderSettings));
router.post('/components', can('payroll.process'), form(async (req, res) => {
  await payroll.saveComponent(req.ctx, null, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/payroll/settings#components');
}, (req, res, extra) => renderSettings(req, res, { ...extra, openDialog: 'component-new' })));
router.post('/components/:id', can('payroll.process'), form(async (req, res) => {
  await payroll.saveComponent(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/payroll/settings#components');
}, (req, res, extra) => renderSettings(req, res, { ...extra, openDialog: `component-${req.params.id}` })));

// ---------- Employee compensation (form lives on the employee profile, Payroll tab) ----------
router.post('/compensation/:employeeId', can('payroll.process'), can('employees.view_salary'), form(async (req, res) => {
  await payroll.saveCompensation(req.ctx, Number(req.params.employeeId), req.body);
  flash(req, 'success', req.t('payroll.compensation_saved'));
  res.redirect(`/app/employees/${Number(req.params.employeeId)}?tab=payroll`);
}, async (req, res, extra) => {
  flash(req, 'error', Object.values(extra.errors || {})[0] || extra.formError.message);
  back(req, res, `/app/employees/${Number(req.params.employeeId)}?tab=payroll`);
}));

module.exports = router;
