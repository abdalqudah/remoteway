const express = require('express');
const { wrap } = require('./helpers');
const { MODULES } = require('./modules');

const router = express.Router();

// Newly created workspaces go through the setup wizard first (admins only).
router.use((req, res, next) => {
  if (!req.organization.onboarding_completed_at && req.ctx.permissions.has('settings.manage')
    && !req.path.startsWith('/onboarding') && req.method === 'GET' && !req.query.skip_onboarding) {
    return res.redirect('/app/onboarding');
  }
  return next();
});

// What the sidebar shows depends on who this person is here: an employee (linked employee record),
// an interviewer, someone with an onboarding plan — not only on the plan's features.
const knexDb = require('../db/knex');
router.use(wrap(async (req, res, next) => {
  const orgId = req.ctx.organizationId; const uid = req.ctx.userId;
  const me = await knexDb('employees').where({ organization_id: orgId, user_id: uid }).whereNot('status', 'terminated').first('id');
  const [interview, plan] = await Promise.all([
    knexDb('interviews').where({ organization_id: orgId, interviewer_user_id: uid }).first('id').catch(() => null),
    me ? knexDb('onboarding_plans').where({ organization_id: orgId, employee_id: me.id }).first('id').catch(() => null) : null,
  ]);
  res.locals.isEmployee = Boolean(me);
  res.locals.hasInterviews = Boolean(interview);
  res.locals.hasOnboardingPlan = Boolean(plan);
  next();
}));

const brandingWeb = require('../modules/branding/web');
router.use(brandingWeb.appLocals);
const aiWeb = require('../modules/ai/web');
router.use(aiWeb.locals);
router.use('/ai', aiWeb.actions);
router.use('/insights', aiWeb.insights);
router.use('/reports', require('../modules/reports/web'));
router.use('/analytics', require('../modules/analytics/web'));
router.use('/compliance', require('../modules/compliance/web'));
router.use('/automation', require('../modules/automation/web'));
router.use('/support', require('../modules/support/web'));
router.use('/', require('../modules/dashboard/web'));
router.use('/onboarding', require('../modules/onboarding/web'));
router.use('/employees/import', require('../modules/workforce/import.web'));
router.use('/', require('../modules/workforce/web'));
router.use('/leave', require('../modules/leave/web'));
router.use('/attendance', require('../modules/attendance/web'));
router.use('/documents', require('../modules/documents/web'));
router.use('/', require('../modules/tasks/web'));
router.use('/notifications', require('../modules/notifications/web'));
router.use('/recruitment', require('../modules/recruitment/web'));
router.use('/talent', require('../modules/talent/company.web'));
router.use('/employee-onboarding', require('../modules/onboarding/plans.web'));
router.use('/payroll', require('../modules/payroll/web'));
router.use('/performance', require('../modules/performance/web'));
router.use('/learning', require('../modules/learning/web'));
const integrationsWeb = require('../modules/integrations/web');
router.use('/settings/integrations', integrationsWeb.router);
router.use('/settings/calendar', integrationsWeb.calendarRouter);
router.use('/settings/ai', aiWeb.settings);
router.use('/settings/sso', require('../modules/sso/web').settings);
router.use('/settings/workflows', require('../modules/workflows/web'));
router.use('/settings/branding', brandingWeb.settings);
router.use('/settings/database', require('../modules/organizations/datasync.web')); // copy of the company's data in its own database
router.use('/settings', require('../modules/settings/web'));
router.use('/billing', require('../modules/billing/web'));

// Honest placeholders for modules that are planned but not built yet.
router.get('/modules/:key', wrap(async (req, res, next) => {
  const mod = MODULES.find((m) => m.key === req.params.key);
  if (!mod) return next();
  return res.page('pages/modules/soon', { title: req.t(`nav.${mod.key}`), mod });
}));

module.exports = router;
