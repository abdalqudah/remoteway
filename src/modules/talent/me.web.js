// The individual's area (/me): dashboard, profile editor, applications, recommended jobs, AI analysis.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { wrap, form, flash } = require('../../routes/helpers');
const { singleFile } = require('../../middleware/upload');
const storage = require('../../core/storage');
const ai = require('../ai/ai.service');
const orgs = require('../organizations/organization.service');
const profiles = require('./profile.service');
const marketplace = require('./marketplace.service');
const talentAi = require('./talent-ai');

const router = express.Router();
const aiLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(require('../../core/errors').E.rateLimited()) });

router.use(wrap(async (req, res, next) => {
  const id = await profiles.ensure(req.user);
  req.profile = await profiles.forUser(req.user.id);
  res.locals.profile = req.profile;
  res.locals.meSection = req.path.split('/')[1] || 'dashboard';
  res.locals.hasWorkspace = (await orgs.listForUser(req.user.id)).length > 0;
  res.locals.profileId = id;
  next();
}));

router.get('/', wrap(async (req, res) => {
  const p = req.profile;
  const [apps, invites, jobs, aiStatus] = await Promise.all([
    marketplace.myApplications(req.user.id), marketplace.myInvitations(p.id), talentAi.jobsForMe(req.user), ai.personalStatus(req.user.id),
  ]);
  res.page('pages/me/dashboard', { layout: 'me', title: req.t('me.dashboard'), comp: profiles.completion(p), apps: apps.slice(0, 5), invites, jobs: jobs.results.slice(0, 4), aiStatus });
}));

// ---------- Profile editor ----------
const renderProfile = (req, res, extra = {}) => res.page('pages/me/profile', {
  layout: 'me', title: req.t('me.my_profile'), p: req.profile, comp: profiles.completion(req.profile), countries: [], J: profiles.JOB_TYPES, W: profiles.WORK_MODES, L: profiles.LANG_LEVELS, ...extra,
});
router.get('/profile', wrap(async (req, res) => renderProfile(req, res, { countries: await orgs.listCountries(), openSection: req.query.section || null })));
const saved = (req, res, anchor) => { flash(req, 'success', req.t('common.saved')); res.redirect(`/me/profile#${anchor}`); };
const rerender = async (req, res, extra) => renderProfile(req, res, { countries: await orgs.listCountries(), ...extra });
router.post('/profile/basics', form(async (req, res) => { await profiles.saveBasics(req.user, req.body); saved(req, res, 'basics'); }, rerender));
router.post('/profile/skills', form(async (req, res) => { await profiles.saveSkills(req.user, req.body); saved(req, res, 'skills'); }, rerender));
router.post('/profile/section/:name', form(async (req, res) => { await profiles.saveSection(req.user, req.params.name, req.body); saved(req, res, req.params.name); }, rerender));
router.post('/profile/preferences', form(async (req, res) => { await profiles.savePreferences(req.user, req.body); saved(req, res, 'preferences'); }, rerender));
router.post('/profile/photo', ...singleFile('file'), form(async (req, res) => { await profiles.uploadPhoto(req.user, req.file); saved(req, res, 'basics'); }, rerender));
router.post('/profile/photo/remove', form(async (req, res) => { await profiles.removePhoto(req.user); saved(req, res, 'basics'); }, rerender));
router.post('/profile/cv', ...singleFile('file'), form(async (req, res) => { await profiles.uploadCv(req.user, req.file); saved(req, res, 'cv'); }, rerender));
router.post('/profile/cv/remove', form(async (req, res) => { await profiles.removeCv(req.user); saved(req, res, 'cv'); }, rerender));
router.get('/cv', wrap(async (req, res, next) => {
  const p = req.profile;
  if (!p.cv_storage_key) return next();
  res.setHeader('Content-Type', p.cv_mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(p.cv_name)}`);
  return storage.createReadStream(p.cv_storage_key).pipe(res);
}));

// ---------- Applications, jobs, invitations ----------
router.get('/applications', wrap(async (req, res) => {
  res.page('pages/me/applications', { layout: 'me', title: req.t('me.applications'), apps: await marketplace.myApplications(req.user.id), invites: await marketplace.myInvitations(req.profile.id) });
}));
const renderJobs = async (req, res, extra = {}) => res.page('pages/me/jobs', {
  layout: 'me', title: req.t('me.recommended_jobs'), rec: extra.rec || await talentAi.jobsForMe(req.user), aiStatus: await ai.personalStatus(req.user.id), ...extra,
});
router.get('/jobs', wrap((req, res) => renderJobs(req, res)));
router.post('/jobs', aiLimiter, form(async (req, res) => {
  const rec = await talentAi.jobsForMe(req.user, { useAi: true, locale: req.locale });
  return renderJobs(req, res, { rec });
}, renderJobs));
router.post('/invitations/:id/decline', form(async (req, res) => {
  await marketplace.declineInvitation(req.user.id, req.params.id);
  flash(req, 'success', req.t('me.invite_declined'));
  res.redirect('/me/applications#invitations');
}, async (req, res) => res.redirect('/me/applications')));

// ---------- AI profile analysis ----------
router.post('/analysis', aiLimiter, form(async (req, res) => {
  await talentAi.analyzeProfile(req.user, req.locale);
  res.redirect('/me#analysis');
}, async (req, res, extra) => {
  flash(req, 'error', extra.formError.message);
  res.redirect('/me#analysis');
}));

module.exports = router;
