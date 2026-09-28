const express = require('express');
const { wrap, form, flash, back } = require('../../routes/helpers');
const { can, feature } = require('../../middleware/context');
const { singleFile } = require('../../middleware/upload');
const rec = require('./recruitment.service');
const structure = require('../workforce/structure.service');
const employees = require('../workforce/employee.service');
const tasks = require('../tasks/task.service');
const orgs = require('../organizations/organization.service');
const ai = require('../ai/ai.service');

const router = express.Router();
router.use(feature('recruitment'));

const opts = async (ctx) => {
  const [departments, locations, members] = await Promise.all([
    structure.listDepartments(ctx.organizationId), structure.listLocations(ctx.organizationId), tasks.members(ctx.organizationId),
  ]);
  return { departments, locations, members };
};

// ---------- Jobs ----------
router.get('/', can('recruitment.view'), wrap(async (req, res) => {
  const [jobs, settings, summary] = await Promise.all([rec.listJobs(req.ctx, req.query), orgs.getSettings(req.ctx.organizationId), rec.summary(req.ctx.organizationId)]);
  res.page('pages/recruitment/jobs', { title: req.t('nav.recruitment'), jobs, settings, summary, status: req.query.status || '' });
}));

const renderJobForm = async (req, res, extra = {}) => {
  const job = req.params.id ? await rec.getJob(req.ctx, Number(req.params.id)) : null;
  res.page('pages/recruitment/job-form', { title: job ? job.title : req.t('recruitment.new_job'), job, ...(await opts(req.ctx)), ...extra });
};
router.get('/jobs/new', can('recruitment.manage'), wrap((req, res) => renderJobForm(req, res)));
// "Publish on RemoteWay Jobs" checkbox of the job form (only shown when the plan has the marketplace)
async function syncMarketplace(req, id) {
  if (req.body.marketplace_field !== '1') return;
  await require('../talent/marketplace.service').setMarketplace(req.ctx, id, req.body.marketplace === 'on'); // eslint-disable-line global-require
}

router.post('/jobs', can('recruitment.manage'), form(async (req, res) => {
  const id = await rec.saveJob(req.ctx, null, req.body);
  await syncMarketplace(req, id);
  if (req.body.publish === '1') {
    // The job is saved either way; a plan limit only keeps it in draft.
    try { await rec.setJobStatus(req.ctx, id, 'open'); } catch (err) {
      if (!err.code) throw err;
      flash(req, 'error', req.t(`errors.${err.code}`) !== `errors.${err.code}` ? req.t(`errors.${err.code}`) : err.message);
      return res.redirect(`/app/recruitment/jobs/${id}`);
    }
  }
  flash(req, 'success', req.t('recruitment.job_saved'));
  res.redirect(`/app/recruitment/jobs/${id}`);
}, renderJobForm));

const renderJobPage = async (req, res, extra = {}) => {
  const [job, apps, settings] = await Promise.all([
    rec.getJob(req.ctx, Number(req.params.id)), rec.pipeline(req.ctx, Number(req.params.id)), orgs.getSettings(req.ctx.organizationId),
  ]);
  const manage = req.ctx.permissions.has('recruitment.manage');
  const [candidates, managers] = manage ? await Promise.all([rec.listCandidates(req.ctx, {}), employees.options(req.ctx.organizationId)]) : [[], []];
  // Talent marketplace: the job on the RemoteWay board, and the best-matching people on the platform
  let talent = null;
  if (await require('../billing/entitlements.service').hasFeature(req.ctx.organizationId, 'talent_marketplace')) { // eslint-disable-line global-require
    const out = await require('../talent/talent-ai').search(req.ctx, { jobId: job.id, useAi: false }); // eslint-disable-line global-require
    talent = { recommended: out.results.slice(0, 5) };
  }
  res.page('pages/recruitment/job', { title: job.title, job, apps, stages: rec.STAGES, settings, candidates, managers, sources: rec.SOURCES, talent, ...extra });
};
router.get('/jobs/:id', can('recruitment.view'), wrap((req, res) => renderJobPage(req, res)));
router.post('/jobs/:id/applications', can('recruitment.manage'), form(async (req, res) => {
  const id = await rec.addToJob(req.ctx, Number(req.body.candidate_id), Number(req.params.id));
  res.redirect(`/app/recruitment/applications/${id}`);
}, async (req, res, extra) => {
  flash(req, 'error', Object.values(extra.errors || {})[0] || extra.formError.message);
  res.redirect(`/app/recruitment/jobs/${req.params.id}`);
}));
router.get('/jobs/:id/edit', can('recruitment.manage'), wrap((req, res) => renderJobForm(req, res)));
router.post('/jobs/:id', can('recruitment.manage'), form(async (req, res) => {
  await rec.saveJob(req.ctx, Number(req.params.id), req.body);
  await syncMarketplace(req, Number(req.params.id));
  flash(req, 'success', req.t('recruitment.job_saved'));
  res.redirect(`/app/recruitment/jobs/${req.params.id}`);
}, renderJobForm));
router.post('/jobs/:id/status', can('recruitment.manage'), form(async (req, res) => {
  await rec.setJobStatus(req.ctx, Number(req.params.id), req.body.status);
  flash(req, 'success', req.t(`recruitment.job_${req.body.status}_msg`));
  res.redirect(`/app/recruitment/jobs/${req.params.id}`);
}, async (req, res, extra) => {
  flash(req, 'error', extra.formError.message);
  res.redirect(`/app/recruitment/jobs/${req.params.id}`);
}));

// Careers page settings
router.post('/careers', can('recruitment.manage'), wrap(async (req, res) => {
  await orgs.updateSettings(req.ctx, { careers_enabled: req.body.careers_enabled === 'on', careers_intro: String(req.body.careers_intro || '').slice(0, 1000) });
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/recruitment');
}));

// ---------- Candidates ----------
const renderCandidates = async (req, res, extra = {}) => {
  const [rows, jobs] = await Promise.all([rec.listCandidates(req.ctx, req.query), rec.listJobs(req.ctx, {})]);
  res.page('pages/recruitment/candidates', { title: req.t('recruitment.candidates'), rows, jobs, stages: rec.STAGES, sources: rec.SOURCES, ...extra });
};
router.get('/candidates', can('recruitment.view'), wrap((req, res) => renderCandidates(req, res)));
router.post('/candidates', can('recruitment.manage'), ...singleFile('file'), form(async (req, res) => {
  const id = await rec.saveCandidate(req.ctx, null, req.body, req.file);
  if (req.body.job_id) await rec.addToJob(req.ctx, id, Number(req.body.job_id), { source: req.body.source });
  flash(req, 'success', req.t('recruitment.candidate_saved'));
  res.redirect(req.body.job_id ? `/app/recruitment/jobs/${Number(req.body.job_id)}` : `/app/recruitment/candidates/${id}`);
}, (req, res, extra) => {
  if (req.body.job_id) { req.params.id = String(Number(req.body.job_id)); return renderJobPage(req, res, { ...extra, openDialog: 'candidate' }); }
  return renderCandidates(req, res, { ...extra, openDialog: 'candidate' });
}));

const renderCandidate = async (req, res, extra = {}) => {
  const [candidate, jobs] = await Promise.all([rec.getCandidate(req.ctx, Number(req.params.id)), rec.listJobs(req.ctx, {})]);
  res.page('pages/recruitment/candidate', { title: `${candidate.first_name} ${candidate.last_name}`, candidate, jobs, sources: rec.SOURCES, ...extra });
};
router.get('/candidates/:id', can('recruitment.view'), wrap((req, res) => renderCandidate(req, res)));
router.post('/candidates/:id', can('recruitment.manage'), ...singleFile('file'), form(async (req, res) => {
  await rec.saveCandidate(req.ctx, Number(req.params.id), req.body, req.file);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/app/recruitment/candidates/${req.params.id}`);
}, (req, res, extra) => renderCandidate(req, res, { ...extra, openDialog: 'edit' })));
router.post('/candidates/:id/apply', can('recruitment.manage'), form(async (req, res) => {
  const id = await rec.addToJob(req.ctx, Number(req.params.id), Number(req.body.job_id));
  res.redirect(`/app/recruitment/applications/${id}`);
}, renderCandidate));
router.post('/candidates/:id/delete', can('recruitment.manage'), form(async (req, res) => {
  await rec.deleteCandidate(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect('/app/recruitment/candidates');
}, renderCandidate));
router.get('/candidates/:id/cv', can('recruitment.view'), wrap(async (req, res) => {
  const f = await rec.openCv(req.ctx, Number(req.params.id));
  const inline = req.query.inline === '1' && f.inline;
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  f.stream.on('error', () => res.destroy());
  f.stream.pipe(res);
}));

// ---------- Applications ----------
const renderApp = async (req, res, extra = {}) => {
  const [app, members, managers] = await Promise.all([
    rec.getApplication(req.ctx, Number(req.params.id)), tasks.members(req.ctx.organizationId), employees.options(req.ctx.organizationId),
  ]);
  const aiMatch = res.locals.aiOn('recruitment') ? await ai.latestInsight(req.ctx.organizationId, 'candidate_match', 'application', app.id) : null;
  res.page('pages/recruitment/application', { title: `${app.first_name} ${app.last_name}`, app, members, managers, stages: rec.STAGES, aiMatch, ...extra });
};
router.get('/applications/:id', can('recruitment.view'), wrap((req, res) => renderApp(req, res)));

const appAction = (fn, message) => [can('recruitment.manage'), form(async (req, res) => {
  await fn(req);
  if (message) flash(req, 'success', req.t(message));
  if (req.get('x-requested-with') === 'fetch') return res.json({ success: true });
  return back(req, res, `/app/recruitment/applications/${req.params.id}`);
}, async (req, res, extra) => {
  flash(req, 'error', Object.values(extra.errors || {})[0] || extra.formError.message);
  if (req.get('x-requested-with') === 'fetch') return res.status(409).json({ success: false, error: extra.formError });
  return back(req, res, `/app/recruitment/applications/${req.params.id}`);
})];

router.post('/applications/:id/stage', ...appAction((req) => rec.moveStage(req.ctx, Number(req.params.id), req.body.stage, { reason: req.body.reason })));
router.post('/applications/:id/note', ...appAction((req) => rec.addNote(req.ctx, Number(req.params.id), req.body.note)));
router.post('/applications/:id/rate', ...appAction((req) => rec.rate(req.ctx, Number(req.params.id), req.body.rating)));
router.post('/applications/:id/interviews', ...appAction((req) => rec.scheduleInterview(req.ctx, Number(req.params.id), req.body), 'recruitment.interview_scheduled'));
router.post('/applications/:id/assessments', ...appAction((req) => rec.addAssessment(req.ctx, Number(req.params.id), req.body)));
router.post('/applications/:id/hire', can('recruitment.manage'), form(async (req, res) => {
  const { employeeId, planId } = await rec.hire(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t(planId ? 'recruitment.hired_onboarding' : 'recruitment.hired_msg'));
  res.redirect(planId ? `/app/employee-onboarding/${planId}` : `/app/employees/${employeeId}`);
}, (req, res, extra) => renderApp(req, res, { ...extra, openDialog: 'hire' })));

// ---------- Interviews (also open to interviewers without recruitment access) ----------
router.get('/interviews', wrap(async (req, res) => {
  const mine = req.query.mine === '1' || !req.ctx.permissions.has('recruitment.view');
  res.page('pages/recruitment/interviews', { title: req.t('recruitment.interviews'), rows: await rec.listInterviews(req.ctx, { mine }), mine });
}));
router.get('/interviews/:id', wrap(async (req, res) => {
  res.page('pages/recruitment/interview', { title: req.t('recruitment.interview'), iv: await rec.getInterview(req.ctx, Number(req.params.id)) });
}));
router.post('/interviews/:id/feedback', form(async (req, res) => {
  await rec.submitFeedback(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('recruitment.feedback_saved'));
  res.redirect(`/app/recruitment/interviews/${req.params.id}`);
}, async (req, res, extra) => res.page('pages/recruitment/interview', { title: req.t('recruitment.interview'), iv: await rec.getInterview(req.ctx, Number(req.params.id)), ...extra })));
router.post('/interviews/:id/cancel', can('recruitment.manage'), wrap(async (req, res) => {
  await rec.cancelInterview(req.ctx, Number(req.params.id));
  back(req, res, '/app/recruitment/interviews');
}));

module.exports = router;
