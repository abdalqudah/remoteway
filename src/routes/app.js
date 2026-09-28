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
router.use('/employee-onboarding', require('../modules/onboarding/plans.web'));
router.use('/payroll', require('../modules/payroll/web'));
router.use('/performance', require('../modules/performance/web'));
router.use('/learning', require('../modules/learning/web'));
const integrationsWeb = require('../modules/integrations/web');
router.use('/settings/integrations', integrationsWeb.router);
router.use('/settings/calendar', integrationsWeb.calendarRouter);
router.use('/settings', require('../modules/settings/web'));
router.use('/billing', require('../modules/billing/web'));

// Honest placeholders for modules that are planned but not built yet.
router.get('/modules/:key', wrap(async (req, res, next) => {
  const mod = MODULES.find((m) => m.key === req.params.key);
  if (!mod) return next();
  return res.page('pages/modules/soon', { title: req.t(`nav.${mod.key}`), mod });
}));

module.exports = router;
