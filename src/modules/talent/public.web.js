// Public marketplace pages: the jobs board, discover talent, public profiles, individual sign-up.
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const { wrap, form, flash } = require('../../routes/helpers');
const { requireAuth } = require('../../middleware/context');
const { E } = require('../../core/errors');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');
const profiles = require('./profile.service');
const marketplace = require('./marketplace.service');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isTest ? 1000 : 20, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(require('../../core/errors').E.rateLimited()) });

/** Who is looking: a signed-in member of a company with the marketplace also sees "companies only" profiles. */
async function viewerFor(req) {
  if (!req.user) return {};
  const v = { userId: req.user.id };
  const orgId = req.session.organizationId;
  if (orgId && await orgs.isMember(req.user.id, orgId) && await ent.hasFeature(orgId, 'talent_marketplace')) { v.organizationId = orgId; v.companyAccess = true; }
  return v;
}

// ---------- Individual sign-up ----------
const renderJoin = (req, res, extra = {}) => res.page('pages/talent/join', { layout: 'auth', title: req.t('talent.join_title'), next: req.query.next || '', ...extra });
router.get('/join', (req, res) => (req.user ? res.redirect('/me') : renderJoin(req, res)));
router.post('/join', limiter, form(async (req, res) => {
  const user = await profiles.signup(req.body, { ip: req.ip });
  await require('../auth/web').signIn(req, user, null); // eslint-disable-line global-require
  await require('../auth/verify.service').send(await require('../../db/knex')('users').where({ id: user.id }).first(), { locale: req.locale }).catch(() => {}); // eslint-disable-line global-require
  const next = String(req.body.next || '');
  require('../site/seo.service').markConversion(res, 'join'); // eslint-disable-line global-require
  res.redirect(next.startsWith('/jobs/') && !next.startsWith('//') ? next : '/me/profile');
}, renderJoin));

// ---------- Jobs board ----------
router.get('/jobs', wrap(async (req, res) => {
  const filters = { q: req.query.q, work_mode: req.query.work_mode, employment_type: req.query.employment_type, city: req.query.city };
  const page = Math.max(1, Number(req.query.page) || 1);
  res.page('pages/talent/jobs', { layout: 'public', title: req.t('talent.jobs_title'), result: await marketplace.listJobs(filters, { page }), filters });
}));

const renderJob = async (req, res, extra = {}) => {
  const job = await marketplace.getJob(req.params.org, req.params.job);
  if (!job) throw E.notFound('Job');
  const [me, applied, careers] = await Promise.all([
    req.user ? profiles.forUser(req.user.id) : null,
    req.user ? marketplace.appliedJobIds(req.user.id) : [],
    orgs.getSettings(job.organization_id).then((s) => Boolean(s.careers_enabled)),
  ]);
  return res.page('pages/talent/job', { layout: 'public', title: job.title, job, me, applied: applied.includes(job.id), careers, ...extra });
};
router.get('/jobs/:org/:job', wrap((req, res) => renderJob(req, res)));
router.post('/jobs/:org/:job/apply', requireAuth, limiter, form(async (req, res) => {
  const job = await marketplace.getJob(req.params.org, req.params.job);
  if (!job) return res.redirect('/jobs');
  await marketplace.apply(req.user, job, { cover_note: req.body.cover_note });
  flash(req, 'success', req.t('talent.applied_ok', { company: job.org_name }));
  return res.redirect('/me/applications');
}, renderJob));

// ---------- Discover talent ----------
router.get('/talent', wrap(async (req, res) => {
  const viewer = await viewerFor(req);
  const filters = { q: req.query.q, specialization: req.query.specialization, skills: req.query.skills, min_years: req.query.min_years, country: req.query.country, city: req.query.city, work_mode: req.query.work_mode };
  const page = Math.max(1, Number(req.query.page) || 1);
  const [result, specs] = await Promise.all([profiles.search(filters, viewer, { page }), profiles.specializations()]);
  res.page('pages/talent/discover', { layout: 'public', title: req.t('talent.discover_title'), result, filters, specs, viewer });
}));

router.get('/talent/:slug', wrap(async (req, res, next) => {
  const viewer = await viewerFor(req);
  const p = await profiles.bySlug(req.params.slug, viewer);
  if (!p) return next();
  const contact = await profiles.contactFor(p, viewer);
  return res.page('pages/talent/profile', { layout: 'public', title: `${p.name}${p.headline ? ` · ${p.headline}` : ''}`, p, contact, viewer, own: viewer.userId === p.user_id });
}));

// ---------- Media ----------
router.get('/talent-media/:id/photo/:sha', wrap(async (req, res, next) => {
  const a = await profiles.photo(Number(req.params.id), req.params.sha);
  if (!a) return next();
  res.set({ 'Content-Type': a.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
  return res.send(a.data);
}));

module.exports = { router, viewerFor };
