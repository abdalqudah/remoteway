const express = require('express');
const { wrap } = require('../../routes/helpers');
const subscriptions = require('../billing/subscription.service');
const ent = require('../billing/entitlements.service');
const config = require('../../config');
const cache = require('../../core/cache');
const marketplace = require('../talent/marketplace.service');
const profiles = require('../talent/profile.service');

const router = express.Router();

async function pricingData(req) {
  const cycle = req.query.cycle === 'yearly' ? 'yearly' : 'monthly';
  const [plans, addons, availability] = await Promise.all([subscriptions.listPublicPlans(), subscriptions.listAddons(), ent.featureAvailability()]);
  return { plans, addons, availability, cycle };
}

router.get('/', wrap(async (req, res) => {
  // The public home page is the busiest page: its carousels are refreshed at most once a minute.
  const [jobs, talents] = config.isTest ? await Promise.all([marketplace.latestJobs(12), profiles.featured(12)])
    : await Promise.all([cache.remember('site:jobs', () => marketplace.latestJobs(12), 60_000), cache.remember('site:talents', () => profiles.featured(12), 60_000)]);
  if (req.query.deleted === '1') res.locals.notice = req.t('privacy.deleted_done');
  res.page('pages/site/home', { layout: 'public', title: req.t('site.meta_title'), latestJobs: jobs, talents, ...(await pricingData(req)) });
}));

router.get('/pricing', wrap(async (req, res) => {
  res.page('pages/site/pricing', { layout: 'public', title: req.t('site.pricing'), ...(await pricingData(req)) });
}));

// ---------- Legal pages ----------
const legal = require('./legal.service');
for (const kind of legal.KINDS) {
  router.get(`/${kind}`, wrap(async (req, res) => {
    res.page('pages/site/legal', { layout: 'public', title: req.t(`legal.${kind}_title`), doc: await legal.page(kind, req.locale) });
  }));
}

// Essential cookies only: the notice just needs to be dismissed once.
router.post('/preferences/cookies', (req, res) => {
  res.cookie('rw_cookies_ok', '1', { maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: false, secure: config.isProd });
  if (req.get('accept')?.includes('application/json')) return res.json({ success: true });
  return res.redirect(req.get('referer') || '/');
});

// ---------- Search engines ----------
const PRIVATE_PATHS = ['/app', '/admin', '/me', '/api', '/security', '/reset', '/login/2fa', '/payments', '/webhooks', '/org-brand', '/invitations'];
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\n${PRIVATE_PATHS.map((p) => `Disallow: ${p}`).join('\n')}\n\nSitemap: ${res.locals.baseUrl}/sitemap.xml\n`);
});
router.get('/sitemap.xml', wrap(async (req, res) => {
  const base = res.locals.baseUrl;
  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const urls = ['/', '/pricing', '/jobs', '/talent', '/join', '/signup', '/demo', '/privacy', '/terms'].map((p) => ({ loc: p }));
  const [jobs, talents] = await Promise.all([marketplace.latestJobs(500), profiles.featured(500)]);
  for (const j of jobs) urls.push({ loc: `/jobs/${j.org_slug}/${j.slug}`, lastmod: j.marketplace_at });
  for (const p of talents) urls.push({ loc: `/talent/${p.slug}`, lastmod: p.updated_at });
  const body = urls.map((u) => `<url><loc>${xmlEsc(base + u.loc)}</loc>${u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString().slice(0, 10)}</lastmod>` : ''}</url>`).join('');
  res.set('Cache-Control', 'public, max-age=3600').type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`);
}));

router.post('/preferences/theme', (req, res) => {
  const theme = ['light', 'dark', 'system'].includes(req.body.theme) ? req.body.theme : 'system';
  res.cookie('rw_theme', theme, { maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: false, secure: config.isProd });
  if (req.get('accept')?.includes('application/json')) return res.json({ success: true, data: { theme } });
  return res.redirect(req.get('referer') || '/');
});

module.exports = router;
