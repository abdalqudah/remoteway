// Company side of the talent marketplace (/app/talent): find talent, AI talent search, recommended
// candidates for a job, saved / shortlisted people, invitations. Uses the recruitment permissions.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { wrap, form, flash } = require('../../routes/helpers');
const { can, feature } = require('../../middleware/context');
const knex = require('../../db/knex');
const ai = require('../ai/ai.service');
const profiles = require('./profile.service');
const marketplace = require('./marketplace.service');
const matching = require('./matching.service');
const talentAi = require('./talent-ai');

const router = express.Router();
const aiLimiter = rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(require('../../core/errors').E.rateLimited()) });
router.use(feature('talent_marketplace'), can('recruitment.view'));
const viewer = (req) => ({ organizationId: req.ctx.organizationId, companyAccess: true, userId: req.user.id });
const openJobs = (req) => knex('jobs').where({ organization_id: req.ctx.organizationId, status: 'open' }).orderBy('title').select('id', 'title', 'marketplace');

const renderFind = async (req, res, extra = {}) => {
  const filters = { q: req.query.q, specialization: req.query.specialization, skills: req.query.skills, min_years: req.query.min_years, max_years: req.query.max_years, country: req.query.country, city: req.query.city, work_mode: req.query.work_mode, job_type: req.query.job_type, language: req.query.language, open_to_work: req.query.open === '1' };
  const page = Math.max(1, Number(req.query.page) || 1);
  const [result, saved, specs, jobs, aiStatus] = await Promise.all([profiles.search(filters, viewer(req), { page }), marketplace.savedMap(req.ctx), profiles.specializations(), openJobs(req), ai.status(req.ctx.organizationId)]);
  res.page('pages/talent/company/find', { title: req.t('talent.find_title'), tab: 'find', result, filters, saved, specs, jobs, aiStatus, ...extra });
};
router.get('/', wrap((req, res) => renderFind(req, res)));

// ---------- AI talent search ----------
const renderAi = async (req, res, extra = {}) => {
  const [jobs, saved, aiStatus] = await Promise.all([openJobs(req), marketplace.savedMap(req.ctx), ai.status(req.ctx.organizationId)]);
  res.page('pages/talent/company/ai', { title: req.t('talent.ai_title'), tab: 'ai', jobs, saved, aiStatus, query: req.body?.query || '', jobId: req.body?.job_id || req.query.job_id || '', out: null, ...extra });
};
router.get('/ai', wrap((req, res) => renderAi(req, res)));
router.post('/ai', aiLimiter, form(async (req, res) => {
  const out = await talentAi.search(req.ctx, { query: req.body.query, jobId: req.body.job_id ? Number(req.body.job_id) : null, locale: req.locale, useAi: req.body.mode !== 'rules' });
  return renderAi(req, res, { out });
}, renderAi));

// ---------- Recommended candidates for one job (rule-based, instant) ----------
router.get('/jobs/:id', wrap(async (req, res) => {
  const job = await knex('jobs as j').leftJoin('locations as l', 'l.id', 'j.location_id').where({ 'j.id': Number(req.params.id), 'j.organization_id': req.ctx.organizationId }).first('j.*', 'l.city as location_city');
  if (!job) throw require('../../core/errors').E.notFound('Job');
  const out = await talentAi.search(req.ctx, { jobId: job.id, useAi: false });
  const [jobs, saved, aiStatus] = await Promise.all([openJobs(req), marketplace.savedMap(req.ctx), ai.status(req.ctx.organizationId)]);
  res.page('pages/talent/company/ai', { title: req.t('talent.recommended_for', { job: job.title }), tab: 'ai', jobs, saved, aiStatus, query: '', jobId: String(job.id), out, forJob: job });
}));

// ---------- Saved / shortlist / invitations ----------
router.get('/saved', wrap(async (req, res) => {
  const list = req.query.list === 'shortlist' ? 'shortlist' : null;
  res.page('pages/talent/company/saved', { title: req.t('talent.saved_title'), tab: list ? 'shortlist' : 'saved', list, people: await marketplace.savedList(req.ctx, list), saved: await marketplace.savedMap(req.ctx), jobs: await openJobs(req) });
}));
router.get('/invitations', wrap(async (req, res) => {
  res.page('pages/talent/company/invitations', { title: req.t('talent.invitations_title'), tab: 'invitations', invites: await marketplace.sentInvitations(req.ctx) });
}));

// ---------- One person ----------
router.get('/p/:id', wrap(async (req, res) => {
  const p = await marketplace.viewable(req.ctx, req.params.id);
  const [contact, saved, jobs, apps] = await Promise.all([
    profiles.contactFor(p, viewer(req)), marketplace.savedMap(req.ctx), openJobs(req),
    knex('applications as a').join('candidates as c', 'c.id', 'a.candidate_id').join('jobs as j', 'j.id', 'a.job_id').where({ 'a.organization_id': req.ctx.organizationId, 'c.user_id': p.user_id }).select('a.id', 'a.stage', 'j.title'),
  ]);
  let fit = null;
  if (req.query.job_id) {
    const job = await knex('jobs as j').leftJoin('locations as l', 'l.id', 'j.location_id').where({ 'j.id': Number(req.query.job_id), 'j.organization_id': req.ctx.organizationId }).first('j.*', 'l.city as location_city');
    if (job) fit = { job, ...matching.score(p, matching.criteriaFromJob(job)) };
  }
  res.page('pages/talent/company/person', { title: p.name, tab: null, p, contact, saved, jobs, apps, fit });
}));
const back = (req) => (String(req.body.back || '').startsWith('/app/talent') ? String(req.body.back) : `/app/talent/p/${Number(req.params.id)}`);
router.post('/p/:id/save', can('recruitment.manage'), form(async (req, res) => {
  await marketplace.save(req.ctx, req.params.id, { list: req.body.list, note: req.body.note, job_id: req.body.job_id });
  flash(req, 'success', req.body.list === 'shortlist' ? req.t('talent.shortlisted') : req.t('talent.saved'));
  res.redirect(back(req));
}, async (req, res, extra) => { flash(req, 'error', extra.formError.message); res.redirect(back(req)); }));
router.post('/p/:id/unsave', can('recruitment.manage'), form(async (req, res) => {
  await marketplace.unsave(req.ctx, req.params.id);
  flash(req, 'success', req.t('talent.removed'));
  res.redirect(back(req));
}, async (req, res) => res.redirect(back(req))));
router.post('/p/:id/invite', can('recruitment.manage'), form(async (req, res) => {
  await marketplace.invite(req.ctx, req.params.id, { job_id: req.body.job_id, message: req.body.message });
  flash(req, 'success', req.t('talent.invited'));
  res.redirect(back(req));
}, async (req, res, extra) => { flash(req, 'error', Object.values(extra.errors || {})[0] || extra.formError.message); res.redirect(back(req)); }));

// ---------- Publish a job on the RemoteWay board ----------
router.post('/jobs/:id/marketplace', can('recruitment.manage'), form(async (req, res) => {
  await marketplace.setMarketplace(req.ctx, Number(req.params.id), req.body.on === '1');
  flash(req, 'success', req.body.on === '1' ? req.t('talent.job_published') : req.t('talent.job_unpublished'));
  res.redirect(`/app/recruitment/jobs/${Number(req.params.id)}`);
}, async (req, res, extra) => { flash(req, 'error', extra.formError.message); res.redirect(`/app/recruitment/jobs/${Number(req.params.id)}`); }));

module.exports = router;
