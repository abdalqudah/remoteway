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

// Cookie notice: essential cookies only need the notice dismissed; when advertising pixels are set up,
// the visitor accepts or declines them (rw_consent) and can change it later from the privacy page.
router.post('/preferences/cookies', (req, res) => {
  const opts = { maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: false, secure: config.isProd };
  res.cookie('rw_cookies_ok', '1', opts);
  if (['accept', 'decline'].includes(req.body.choice)) res.cookie('rw_consent', req.body.choice === 'accept' ? 'yes' : 'no', { ...opts, maxAge: 180 * 86_400_000 });
  if (req.get('accept')?.includes('application/json')) return res.json({ success: true });
  return res.redirect(req.get('referer') || '/');
});

// ---------- Search engines and AI assistants ----------
const seo = require('./seo.service');
const ROBOTS_PRIVATE = seo.PRIVATE_PATHS;
router.get('/robots.txt', wrap(async (req, res) => {
  res.type('text/plain').send(seo.robots(await seo.get(), res.locals.baseUrl, ROBOTS_PRIVATE));
}));
// llms.txt: a plain summary that AI assistants read to describe the platform correctly (GEO).
router.get('/llms.txt', wrap(async (req, res) => {
  const s = await seo.get();
  const text = s.llms || seo.llmsDefault({ seo: s, site: res.locals.site, base: res.locals.baseUrl, plans: await subscriptions.listPublicPlans() });
  res.set('Cache-Control', 'public, max-age=3600').type('text/plain; charset=utf-8').send(text);
}));
router.get('/sitemap.xml', wrap(async (req, res) => {
  const base = res.locals.baseUrl;
  const s = await seo.get();
  const xmlEsc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const urls = Object.entries(seo.PATH_PAGE).filter(([p, key]) => p !== '/login' && !(s.pages[key] && s.pages[key].noindex)).map(([p]) => ({ loc: p }));
  const [jobs, talents] = await Promise.all([marketplace.latestJobs(500), profiles.featured(500)]);
  for (const j of jobs) urls.push({ loc: `/jobs/${j.org_slug}/${j.slug}`, lastmod: j.marketplace_at });
  for (const p of talents) urls.push({ loc: `/talent/${p.slug}`, lastmod: p.updated_at });
  const alt = (loc) => ['ar', 'en'].map((lc) => `<xhtml:link rel="alternate" hreflang="${lc}" href="${xmlEsc(`${base}${loc}?lang=${lc}`)}"/>`).join('') + `<xhtml:link rel="alternate" hreflang="x-default" href="${xmlEsc(base + loc)}"/>`;
  const body = urls.map((u) => `<url><loc>${xmlEsc(base + u.loc)}</loc>${u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString().slice(0, 10)}</lastmod>` : ''}${alt(u.loc)}</url>`).join('');
  res.set('Cache-Control', 'public, max-age=3600').type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${body}</urlset>`);
}));

router.post('/preferences/theme', (req, res) => {
  const theme = ['light', 'dark', 'system'].includes(req.body.theme) ? req.body.theme : 'system';
  res.cookie('rw_theme', theme, { maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: false, secure: config.isProd });
  if (req.get('accept')?.includes('application/json')) return res.json({ success: true, data: { theme } });
  return res.redirect(req.get('referer') || '/');
});

module.exports = router;
