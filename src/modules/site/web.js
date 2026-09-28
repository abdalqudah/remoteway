const express = require('express');
const { wrap } = require('../../routes/helpers');
const subscriptions = require('../billing/subscription.service');
const ent = require('../billing/entitlements.service');
const config = require('../../config');
const marketplace = require('../talent/marketplace.service');
const profiles = require('../talent/profile.service');

const router = express.Router();

async function pricingData(req) {
  const cycle = req.query.cycle === 'yearly' ? 'yearly' : 'monthly';
  const [plans, addons, availability] = await Promise.all([subscriptions.listPublicPlans(), subscriptions.listAddons(), ent.featureAvailability()]);
  return { plans, addons, availability, cycle };
}

router.get('/', wrap(async (req, res) => {
  const [jobs, talents] = await Promise.all([marketplace.latestJobs(12), profiles.featured(12)]);
  res.page('pages/site/home', { layout: 'public', title: req.t('site.meta_title'), latestJobs: jobs, talents, ...(await pricingData(req)) });
}));

router.get('/pricing', wrap(async (req, res) => {
  res.page('pages/site/pricing', { layout: 'public', title: req.t('site.pricing'), ...(await pricingData(req)) });
}));

router.post('/preferences/theme', (req, res) => {
  const theme = ['light', 'dark', 'system'].includes(req.body.theme) ? req.body.theme : 'system';
  res.cookie('rw_theme', theme, { maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: false, secure: config.isProd });
  if (req.get('accept')?.includes('application/json')) return res.json({ success: true, data: { theme } });
  return res.redirect(req.get('referer') || '/');
});

module.exports = router;
