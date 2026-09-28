const express = require('express');
const { wrap, form, flash, back } = require('../../routes/helpers');
const { feature } = require('../../middleware/context');
const tasks = require('./task.service');

const router = express.Router();

const renderBoard = async (req, res, extra = {}) => {
  const view = req.query.view === 'list' ? 'list' : 'board';
  const filters = { ...req.query, mine: req.query.mine === '1', include_done: view === 'list' && req.query.include_done === '1' };
  const hasProjects = req.entitlements.features.has('projects');
  const [rows, members, projects] = await Promise.all([
    tasks.list(req.ctx, filters), tasks.members(req.ctx.organizationId), hasProjects ? tasks.listProjects(req.ctx) : [],
  ]);
  res.page('pages/tasks/index', {
    title: req.t('nav.tasks'), view, rows, members, projects, hasProjects, statuses: tasks.STATUSES, priorities: tasks.PRIORITIES, ...extra,
  });
};

router.get('/tasks', feature('tasks'), wrap((req, res) => renderBoard(req, res)));

router.post('/tasks', feature('tasks'), form(async (req, res) => {
  const id = await tasks.create(req.ctx, req.body);
  flash(req, 'success', req.t('tasks.created'));
  if (req.body.return_to === 'board') return back(req, res, '/app/tasks');
  return res.redirect(`/app/tasks/${id}`);
}, (req, res, extra) => renderBoard(req, res, { ...extra, openDialog: 'task' })));

const renderTask = async (req, res, extra = {}) => {
  const [task, members, projects] = await Promise.all([
    tasks.get(req.ctx, Number(req.params.id)), tasks.members(req.ctx.organizationId),
    req.entitlements.features.has('projects') ? tasks.listProjects(req.ctx) : [],
  ]);
  res.page('pages/tasks/show', { title: task.title, task, members, projects, statuses: tasks.STATUSES, priorities: tasks.PRIORITIES, ...extra });
};

router.get('/tasks/:id', feature('tasks'), wrap((req, res) => renderTask(req, res)));

router.post('/tasks/:id', feature('tasks'), form(async (req, res) => {
  await tasks.update(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/app/tasks/${req.params.id}`);
}, renderTask));

router.post('/tasks/:id/status', feature('tasks'), form(async (req, res) => {
  await tasks.setStatus(req.ctx, Number(req.params.id), req.body.status);
  back(req, res, '/app/tasks');
}, async (req, res, extra) => {
  flash(req, 'error', extra.formError.message);
  back(req, res, '/app/tasks');
}));

router.post('/tasks/:id/comments', feature('tasks'), form(async (req, res) => {
  await tasks.comment(req.ctx, Number(req.params.id), req.body.body);
  res.redirect(`/app/tasks/${req.params.id}#comments`);
}, renderTask));

router.post('/tasks/:id/delete', feature('tasks'), form(async (req, res) => {
  await tasks.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect('/app/tasks');
}, renderTask));

// ---------- Projects ----------
const renderProjects = async (req, res, extra = {}) => {
  res.page('pages/tasks/projects', { title: req.t('tasks.projects'), projects: await tasks.listProjects(req.ctx), ...extra });
};

router.get('/projects', feature('projects'), wrap((req, res) => renderProjects(req, res)));
router.post('/projects', feature('projects'), form(async (req, res) => {
  await tasks.saveProject(req.ctx, req.body.id ? Number(req.body.id) : null, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/projects');
}, (req, res, extra) => renderProjects(req, res, { ...extra, openDialog: 'project' })));

module.exports = router;
