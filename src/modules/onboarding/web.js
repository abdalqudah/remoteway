// Post-signup setup wizard: Setup → Team → Integrations → Dashboard.
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const orgs = require('../organizations/organization.service');
const structure = require('../workforce/structure.service');
const employees = require('../workforce/employee.service');
const rbac = require('../rbac/rbac.service');
const ent = require('../billing/entitlements.service');

const router = express.Router();
const STEPS = ['setup', 'team', 'integrations'];
const DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];

router.use(can('settings.manage'));

router.get('/', (req, res) => res.redirect('/app/onboarding/setup'));

const render = (step) => async (req, res, extra = {}) => {
  const [departments, locations, settings, countries, list, roles, usage] = await Promise.all([
    structure.listDepartments(req.ctx.organizationId), structure.listLocations(req.ctx.organizationId), orgs.getSettings(req.ctx.organizationId),
    orgs.listCountries(), employees.list(req.ctx, { status: 'current', per_page: 50, sort: 'created', dir: 'desc' }), rbac.listRoles(req.ctx.organizationId),
    ent.getUsage(req.ctx.organizationId),
  ]);
  res.page(`pages/onboarding/${step}`, {
    layout: 'onboarding', title: req.t('onboarding.title'), step, steps: STEPS, days: DAYS, departments, locations, settings, countries,
    employees: list.data, roles: roles.filter((r) => r.key !== 'owner'), usage, ...extra,
  });
};

for (const step of STEPS) router.get(`/${step}`, wrap((req, res) => render(step)(req, res)));

router.post('/setup/department', form(async (req, res) => {
  await structure.saveDepartment(req.ctx, null, req.body);
  res.redirect('/app/onboarding/setup#departments');
}, render('setup')));

router.post('/setup/location', form(async (req, res) => {
  await structure.saveLocation(req.ctx, null, req.body);
  res.redirect('/app/onboarding/setup#locations');
}, render('setup')));

router.post('/setup/work', form(async (req, res) => {
  const days = Array.isArray(req.body.working_days) ? req.body.working_days : [req.body.working_days].filter(Boolean);
  const valid = days.filter((d) => DAYS.includes(d));
  const time = (v, d) => (/^\d{2}:\d{2}$/.test(v || '') ? v : d);
  if (!valid.length) {
    const { E } = require('../../core/errors');
    throw E.validation({ working_days: 'Choose at least one working day.' });
  }
  await orgs.updateSettings(req.ctx, { working_days: valid, work_start: time(req.body.work_start, '09:00'), work_end: time(req.body.work_end, '17:00') });
  res.redirect('/app/onboarding/team');
}, render('setup')));

router.post('/team/employee', can('employees.create'), form(async (req, res) => {
  const e = await employees.create(req.ctx, req.body);
  flash(req, 'success', req.t('employees.created', { name: e.full_name }));
  res.redirect('/app/onboarding/team');
}, render('team')));

router.post('/finish', wrap(async (req, res) => {
  await orgs.completeOnboarding(req.ctx);
  flash(req, 'success', req.t('onboarding.done'));
  res.redirect('/app');
}));

module.exports = router;
