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
router.use('/', require('../modules/workforce/web'));
router.use('/settings', require('../modules/settings/web'));
router.use('/billing', require('../modules/billing/web'));

// Honest placeholders for modules that are planned but not built yet.
router.get('/modules/:key', wrap(async (req, res, next) => {
  const mod = MODULES.find((m) => m.key === req.params.key);
  if (!mod) return next();
  return res.page('pages/modules/soon', { title: req.t(`nav.${mod.key}`), mod });
}));

module.exports = router;
