// Super Admin → Search & AI visibility (SEO/AEO/GEO), Marketing (social links, pixels),
// Google sign-in and white-label custom domains.
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const seo = require('../site/seo.service');
const media = require('../site/media.service');
const subscriptions = require('../billing/subscription.service');
const google = require('../auth/google.service');
const domains = require('../branding/domain.service');
const { PLATFORM_HOST } = require('../branding/branding.service');

const router = express.Router();

// ---------- Search & AI visibility ----------
/** Quick health checks shown at the top of the page. */
function seoChecks(s, siteMedia) {
  const L = (v, lc) => (v && v[lc]) || '';
  const out = [];
  const desc = L(s.description, 'ar') || L(s.description, 'en');
  out.push({ key: 'description', ok: desc.length >= 50 && desc.length <= 170 });
  out.push({ key: 'titles', ok: seo.PAGES.filter((p) => ['home', 'pricing', 'jobs'].includes(p)).every((p) => s.pages[p] && (L(s.pages[p].title, 'ar') || L(s.pages[p].title, 'en'))) });
  out.push({ key: 'og_image', ok: Boolean(s.og_image && siteMedia[s.og_image]) });
  out.push({ key: 'verify', ok: Boolean(s.verify.google || s.verify.bing) });
  out.push({ key: 'org', ok: Boolean(s.org.email || s.org.phone) });
  out.push({ key: 'home_indexed', ok: !(s.pages.home && s.pages.home.noindex) });
  return out;
}
const renderSeo = async (req, res, extra = {}) => {
  const [s, list, siteMedia] = await Promise.all([seo.get(), media.list(), media.map()]);
  res.page('pages/admin/seo', {
    layout: 'admin', title: req.t('seo.title'), s, images: list.filter((m) => m.kind === 'image'), PAGES: seo.PAGES, PATH_PAGE: seo.PATH_PAGE,
    AI_BOTS: seo.AI_BOTS, checks: seoChecks(s, siteMedia), ...extra,
  });
};
router.get('/seo', wrap((req, res) => renderSeo(req, res)));
router.post('/seo', form(async (req, res) => {
  await seo.save(req.ctx, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/admin/seo${req.body.tab ? `#${String(req.body.tab).replace(/[^a-z-]/g, '')}` : ''}`);
}, renderSeo));
// The generated llms.txt, to start editing from.
router.get('/seo/llms-default', wrap(async (req, res) => {
  const s = await seo.get();
  res.type('text/plain; charset=utf-8').send(seo.llmsDefault({ seo: s, site: res.locals.site, base: res.locals.baseUrl, plans: await subscriptions.listPublicPlans() }));
}));

// ---------- Marketing: social links and pixels ----------
const renderMarketing = async (req, res, extra = {}) => {
  res.page('pages/admin/marketing', { layout: 'admin', title: req.t('seo.marketing_title'), m: await seo.marketing(), SOCIAL: seo.SOCIAL, PIXELS: Object.keys(seo.PIXELS), ...extra });
};
router.get('/marketing', wrap((req, res) => renderMarketing(req, res)));
router.post('/marketing', form(async (req, res) => {
  await seo.saveMarketing(req.ctx, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/admin/marketing');
}, renderMarketing));

// ---------- Google sign-in ----------
const renderGoogle = async (req, res, extra = {}) => {
  res.page('pages/admin/google', { layout: 'admin', title: req.t('google.admin_title'), g: await google.settings(), redirectUri: google.redirectUri(), origin: res.locals.baseUrl, ...extra });
};
router.get('/google', wrap((req, res) => renderGoogle(req, res)));
router.post('/google', form(async (req, res) => {
  await google.save(req.ctx, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/admin/google');
}, renderGoogle));

// ---------- Custom domains (white label) ----------
const renderDomains = async (req, res, extra = {}) => {
  res.page('pages/admin/domains', { layout: 'admin', title: req.t('domains.title'), rows: await domains.list(), cp: await domains.hosting.get(), platformHost: PLATFORM_HOST, serverIp: process.env.SERVER_IP || '', ...extra });
};
router.get('/domains', wrap((req, res) => renderDomains(req, res)));
router.post('/domains/cpanel', form(async (req, res) => {
  await domains.hosting.save(req.ctx, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/admin/domains');
}, renderDomains));
const act = (fn, done) => wrap(async (req, res) => {
  const orgId = Number(req.params.org);
  try {
    const r = await fn(req, orgId);
    flash(req, r && r.flash ? r.flash[0] : 'success', r && r.flash ? r.flash[1] : req.t(done));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    const tr = req.t(`errors.${e.code}`);
    flash(req, 'error', tr !== `errors.${e.code}` ? tr : e.message);
  }
  res.redirect('/admin/domains');
});
router.post('/domains/:org/check', act(async (req, orgId) => {
  const r = await domains.check(req.ctx, orgId);
  return { flash: r.live ? ['success', req.t('domains.now_live')] : ['warning', req.t(!r.owned ? 'domains.missing_txt' : 'domains.missing_cname')] };
}));
router.post('/domains/:org/approve', act((req, orgId) => domains.approve(req.ctx, orgId), 'domains.approved'));
router.post('/domains/:org/suspend', act((req, orgId) => domains.suspend(req.ctx, orgId), 'domains.suspended'));
router.post('/domains/:org/resume', act((req, orgId) => domains.resume(req.ctx, orgId), 'domains.resumed'));
router.post('/domains/:org/hosting', act(async (req, orgId) => {
  const r = await domains.addToHosting(req.ctx, orgId);
  return { flash: [r.status === 'added' ? 'success' : 'error', r.note] };
}));
router.post('/domains/:org/manual', act((req, orgId) => domains.markManual(req.ctx, orgId), 'common.saved'));

// ---------- Test environment (test companies) ----------
const sandbox = require('./sandbox.service');
const renderSandbox = async (req, res, extra = {}) => {
  const created = req.session.sandboxCreated;
  delete req.session.sandboxCreated;
  res.page('pages/admin/sandbox', { layout: 'admin', title: req.t('sandbox.title'), list: await sandbox.list(), plans: await require('../../db/knex')('plans').orderBy('sort_order').select('key', 'name'), created, ...extra }); // eslint-disable-line global-require
};
router.get('/sandbox', wrap((req, res) => renderSandbox(req, res)));
router.post('/sandbox', form(async (req, res) => {
  const r = await sandbox.create(req.ctx, req.body);
  req.session.sandboxCreated = r.organizationId;
  flash(req, 'success', req.t('sandbox.created'));
  res.redirect(`/admin/sandbox#sb-${r.organizationId}`);
}, renderSandbox));
const sbAct = (fn) => wrap(async (req, res) => {
  try {
    const msg = await fn(req);
    if (msg) flash(req, 'success', msg);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    const tr = req.t(`errors.${e.code}`);
    flash(req, 'error', e.details ? Object.values(e.details).map((m) => require('../../core/i18n').translateMessage(req.locale, m)).join(' ') : (tr !== `errors.${e.code}` ? tr : e.message)); // eslint-disable-line global-require
  }
  res.redirect(`/admin/sandbox#sb-${req.params.id}`);
});
router.post('/sandbox/:id/members', sbAct(async (req) => { await sandbox.addMember(req.ctx, req.params.id, req.body); return req.t('sandbox.member_added'); }));
router.post('/sandbox/:id/members/:user/remove', sbAct(async (req) => { await sandbox.removeMember(req.ctx, req.params.id, req.params.user); return req.t('common.saved'); }));
router.post('/sandbox/:id/emails', sbAct(async (req) => { await sandbox.setEmails(req.ctx, req.params.id, req.body.emails === '1'); return req.t(req.body.emails === '1' ? 'sandbox.emails_on_done' : 'sandbox.emails_off_done'); }));
router.post('/sandbox/:id/reset', sbAct(async (req) => { const r = await sandbox.reset(req.ctx, req.params.id, req.body.password); req.session.sandboxCreated = r.organizationId; return req.t('sandbox.reset_done'); }));
router.post('/sandbox/:id/delete', sbAct(async (req) => { const r = await sandbox.remove(req.ctx, req.params.id, req.body.password); return req.t('sandbox.deleted', { name: r.name, n: r.accounts }); }));

module.exports = router;
