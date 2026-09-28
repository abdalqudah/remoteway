const express = require('express');
const { wrap, form, flash, back } = require('../../routes/helpers');
const { feature } = require('../../middleware/context');
const { E } = require('../../core/errors');
const structure = require('../workforce/structure.service');
const employees = require('../workforce/employee.service');
const goals = require('./goals.service');
const reviews = require('./reviews.service');
const { isAdmin, managedIds } = require('./access');

const router = express.Router();
router.use(feature('performance'));
router.use((req, res, next) => {
  res.locals.perfAdmin = isAdmin(req.ctx);
  res.locals.perfSection = req.path.split('/')[1] || 'overview';
  next();
});
const adminOnly = (req, res, next) => (isAdmin(req.ctx) ? next() : next(E.forbidden('performance.manage')));

/** Employees this user can set goals for / give feedback to. */
async function peopleFor(ctx, { forGoals = false } = {}) {
  const all = await employees.options(ctx.organizationId);
  if (!forGoals) return all;
  if (isAdmin(ctx)) return all;
  const self = await employees.linkedEmployeeId(ctx);
  const ids = new Set([self, ...(await managedIds(ctx))]);
  return all.filter((e) => ids.has(e.id));
}

// ---------- Overview ----------
router.get('/', wrap(async (req, res) => {
  const [queue, goalSummary, myGoals, feedback, cycles] = await Promise.all([
    reviews.myQueue(req.ctx), goals.summary(req.ctx), goals.list(req.ctx, { mine: true }), reviews.listFeedback(req.ctx),
    isAdmin(req.ctx) || req.ctx.permissions.has('performance.view') ? reviews.listCycles(req.ctx) : [],
  ]);
  const self = await employees.linkedEmployeeId(req.ctx);
  const people = (await peopleFor(req.ctx)).filter((p) => p.id !== self);
  res.page('pages/performance/index', { title: req.t('nav.performance'), queue, goalSummary, myGoals, feedback: feedback.slice(0, 6), cycles: cycles.filter((c) => c.status === 'active'), people });
}));

// ---------- Goals ----------
router.get('/goals', wrap(async (req, res) => {
  const rows = await goals.list(req.ctx, { ...req.query, mine: req.query.mine === '1' });
  res.page('pages/performance/goals', { title: req.t('performance.goals'), rows, status: req.query.status || 'active', scope: req.query.scope || '' });
}));

const renderGoalForm = async (req, res, extra = {}) => {
  const goal = req.params.id ? await goals.get(req.ctx, Number(req.params.id)) : null;
  if (goal && !goal.canEdit) throw E.forbidden('performance.manage');
  const [people, departments, parents] = await Promise.all([peopleFor(req.ctx, { forGoals: true }), structure.listDepartments(req.ctx.organizationId), goals.alignOptions(req.ctx.organizationId)]);
  res.page('pages/performance/goal-form', {
    title: goal ? goal.title : req.t('performance.new_goal'), goal, people, departments, parents: parents.filter((p) => !goal || p.id !== goal.id),
    me: await employees.linkedEmployeeId(req.ctx), presetScope: req.query.scope, presetEmployee: req.query.employee_id, ...extra,
  });
};
router.get('/goals/new', wrap((req, res) => renderGoalForm(req, res)));
router.post('/goals', form(async (req, res) => {
  const id = await goals.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('performance.goal_saved'));
  res.redirect(`/app/performance/goals/${id}`);
}, renderGoalForm));
router.get('/goals/:id', wrap(async (req, res) => {
  const goal = await goals.get(req.ctx, Number(req.params.id));
  res.page('pages/performance/goal', { title: goal.title, goal });
}));
router.get('/goals/:id/edit', wrap((req, res) => renderGoalForm(req, res)));
router.post('/goals/:id', form(async (req, res) => {
  await goals.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('performance.goal_saved'));
  res.redirect(`/app/performance/goals/${req.params.id}`);
}, renderGoalForm));
const goalAction = (fn, message) => form(async (req, res) => {
  await fn(req);
  if (message) flash(req, 'success', req.t(message));
  res.redirect(`/app/performance/goals/${req.params.id}`);
}, async (req, res, extra) => {
  flash(req, 'error', Object.values(extra.errors || {})[0] || extra.formError.message);
  res.redirect(`/app/performance/goals/${req.params.id}`);
});
router.post('/goals/:id/checkin', goalAction((req) => goals.checkIn(req.ctx, Number(req.params.id), req.body), 'performance.checkin_saved'));
router.post('/goals/:id/status', goalAction((req) => goals.setStatus(req.ctx, Number(req.params.id), req.body.status), 'common.saved'));

// ---------- Review cycles ----------
const renderCycles = async (req, res, extra = {}) => {
  const [cycles, competencies, departments] = await Promise.all([reviews.listCycles(req.ctx), reviews.listCompetencies(req.ctx.organizationId), structure.listDepartments(req.ctx.organizationId)]);
  res.page('pages/performance/cycles', { title: req.t('performance.reviews'), cycles, competencies, departments, ...extra });
};
router.get('/cycles', wrap(async (req, res, next) => {
  if (!isAdmin(req.ctx) && !req.ctx.permissions.has('performance.view')) return next(E.forbidden('performance.view'));
  return renderCycles(req, res);
}));
router.post('/cycles', adminOnly, form(async (req, res) => {
  const id = await reviews.saveCycle(req.ctx, null, req.body);
  flash(req, 'success', req.t('performance.cycle_saved'));
  res.redirect(`/app/performance/cycles/${id}`);
}, (req, res, extra) => renderCycles(req, res, { ...extra, openDialog: 'cycle' })));

const renderCycle = async (req, res, extra = {}) => {
  const [cycle, competencies, departments] = await Promise.all([reviews.getCycle(req.ctx, Number(req.params.id)), reviews.listCompetencies(req.ctx.organizationId), structure.listDepartments(req.ctx.organizationId)]);
  const preview = cycle.status === 'draft' ? (await reviews.participants(req.ctx.organizationId, cycle)).length : null;
  res.page('pages/performance/cycle', { title: cycle.name, cycle, competencies, departments, preview, ...extra });
};
router.get('/cycles/:id', wrap(async (req, res, next) => {
  if (!isAdmin(req.ctx) && !req.ctx.permissions.has('performance.view')) return next(E.forbidden('performance.view'));
  return renderCycle(req, res);
}));
router.post('/cycles/:id', adminOnly, form(async (req, res) => {
  await reviews.saveCycle(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('performance.cycle_saved'));
  res.redirect(`/app/performance/cycles/${req.params.id}`);
}, (req, res, extra) => renderCycle(req, res, { ...extra, openDialog: 'cycle' })));
const cycleAction = (fn, message, to) => [adminOnly, form(async (req, res) => {
  const out = await fn(req);
  flash(req, 'success', req.t(message, { n: out }));
  res.redirect(to ? to(req) : `/app/performance/cycles/${req.params.id}`);
}, async (req, res, extra) => {
  flash(req, 'error', extra.formError.message);
  res.redirect(`/app/performance/cycles/${req.params.id}`);
})];
router.post('/cycles/:id/launch', ...cycleAction((req) => reviews.launchCycle(req.ctx, Number(req.params.id)), 'performance.cycle_launched'));
router.post('/cycles/:id/close', ...cycleAction((req) => reviews.closeCycle(req.ctx, Number(req.params.id)), 'performance.cycle_closed'));
router.post('/cycles/:id/delete', ...cycleAction((req) => reviews.deleteDraft(req.ctx, Number(req.params.id)), 'common.deleted', () => '/app/performance/cycles'));

router.post('/competencies', adminOnly, form(async (req, res) => {
  await reviews.saveCompetency(req.ctx, null, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/performance/cycles#competencies');
}, (req, res, extra) => renderCycles(req, res, { ...extra, openDialog: 'competency-new' })));
router.post('/competencies/:id', adminOnly, form(async (req, res) => {
  await reviews.saveCompetency(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/performance/cycles#competencies');
}, (req, res, extra) => renderCycles(req, res, { ...extra, openDialog: `competency-${req.params.id}` })));

// ---------- Reviews ----------
const renderReview = async (req, res, extra = {}) => {
  const review = await reviews.getReview(req.ctx, Number(req.params.id));
  res.page('pages/performance/review', { title: `${review.first_name} ${review.last_name} · ${review.cycle_name}`, review, ...extra });
};
router.get('/reviews/:id', wrap((req, res) => renderReview(req, res)));
router.post('/reviews/:id/self', form(async (req, res) => {
  const submit = req.body.action === 'submit';
  await reviews.saveSelf(req.ctx, Number(req.params.id), req.body, submit);
  flash(req, 'success', req.t(submit ? 'performance.self_submitted' : 'performance.draft_saved'));
  res.redirect(submit ? '/app/performance' : `/app/performance/reviews/${req.params.id}`);
}, renderReview));
router.post('/reviews/:id/manager', form(async (req, res) => {
  const submit = req.body.action === 'submit';
  await reviews.saveManager(req.ctx, Number(req.params.id), req.body, submit);
  flash(req, 'success', req.t(submit ? 'performance.review_completed' : 'performance.draft_saved'));
  res.redirect(`/app/performance/reviews/${req.params.id}`);
}, renderReview));
router.post('/reviews/:id/acknowledge', form(async (req, res) => {
  await reviews.acknowledge(req.ctx, Number(req.params.id), req.body.comment);
  flash(req, 'success', req.t('performance.acknowledged'));
  res.redirect(`/app/performance/reviews/${req.params.id}`);
}, renderReview));

// ---------- Feedback ----------
const renderFeedback = async (req, res, extra = {}) => {
  const [rows, people, self] = await Promise.all([reviews.listFeedback(req.ctx), peopleFor(req.ctx), employees.linkedEmployeeId(req.ctx)]);
  res.page('pages/performance/feedback', { title: req.t('performance.feedback'), rows, people: people.filter((p) => p.id !== self), self, ...extra });
};
router.get('/feedback', wrap((req, res) => renderFeedback(req, res)));
router.post('/feedback', form(async (req, res) => {
  await reviews.giveFeedback(req.ctx, req.body);
  flash(req, 'success', req.t('performance.feedback_sent'));
  back(req, res, '/app/performance/feedback');
}, (req, res, extra) => renderFeedback(req, res, { ...extra, openDialog: 'feedback' })));

module.exports = router;
