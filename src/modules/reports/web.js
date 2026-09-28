// Reports (/app/reports): templates, builder, saved reports, schedules and CSV export.
const express = require('express');
const knex = require('../../db/knex');
const csv = require('../../core/csv');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { E } = require('../../core/errors');
const reports = require('./reports.service');

const router = express.Router();
router.use(can('reports.view'));

async function context(req) {
  const [tiers, datasets, departments] = await Promise.all([
    reports.tiers(req.ctx.organizationId), reports.datasetsFor(req.ctx),
    knex('departments').where({ organization_id: req.ctx.organizationId }).orderBy('name').select('id', 'name'),
  ]);
  return { tiers, datasets, departments, DATASETS: reports.DATASETS, PERIODS: reports.PERIODS };
}

function sendCsv(req, res, result, name) {
  const table = reports.toTable(result, req.t);
  const file = `${String(name).replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'report'}.csv`;
  res.setHeader('Content-Disposition', `attachment; filename="report.csv"; filename*=UTF-8''${encodeURIComponent(file)}`);
  return csv.send(res, 'report.csv', table.header, table.rows);
}

router.get('/', wrap(async (req, res) => {
  const [c, templates, saved] = await Promise.all([context(req), reports.templatesFor(req.ctx), reports.listSaved(req.ctx)]);
  res.page('pages/reports/index', { title: req.t('reports.title'), ...c, templates: c.tiers.basic ? templates : [], saved });
}));

router.get('/templates/:key', wrap(async (req, res) => {
  const c = await context(req);
  if (!c.tiers.basic) throw E.featureNotInPlan('basic_reports');
  const tpl = reports.TEMPLATES.find((x) => x.key === req.params.key);
  if (!tpl) throw E.notFound('Report');
  const exporting = req.query.format === 'csv';
  const result = await reports.run(req.ctx, tpl.dataset, tpl.config, { limit: exporting ? reports.MAX_EXPORT : reports.MAX_ROWS });
  if (exporting) return sendCsv(req, res, result, req.t(`reports.tpl_${tpl.key}`));
  return res.page('pages/reports/run', { title: req.t(`reports.tpl_${tpl.key}`), ...c, result, template: tpl, report: null, schedules: [], builder: false });
}));

// ---------- Builder (GET so every result has a shareable URL) ----------
router.get('/builder', wrap(async (req, res) => {
  const c = await context(req);
  if (!c.tiers.advanced) throw E.featureNotInPlan('advanced_reports');
  const key = c.datasets.includes(req.query.dataset) ? req.query.dataset : c.datasets[0];
  if (!key) throw E.forbidden('reports.view');
  const exporting = req.query.format === 'csv';
  const result = await reports.run(req.ctx, key, reports.configFromForm(req.query), { limit: exporting ? reports.MAX_EXPORT : reports.MAX_ROWS });
  if (exporting) return sendCsv(req, res, result, req.t(`reports.ds_${key}`));
  let editing = null;
  if (req.query.report) {
    editing = await reports.getSaved(req.ctx, Number(req.query.report)).catch(() => null);
    if (editing && !reports.canEditSaved(req.ctx, editing)) editing = null;
  }
  return res.page('pages/reports/run', { title: editing ? editing.name : req.t('reports.builder'), ...c, result, template: null, report: null, editing, schedules: [], builder: true });
}));

router.post('/saved', form(async (req, res) => {
  const id = await reports.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('reports.saved_msg'));
  res.redirect(`/app/reports/saved/${id}`);
}, async (req, res, extra) => {
  flash(req, 'error', Object.values(extra.errors || {})[0] || extra.formError.message);
  res.redirect(`/app/reports/builder?${new URLSearchParams(Object.entries(req.body).filter(([k]) => k !== '_csrf').flatMap(([k, v]) => [].concat(v).map((x) => [k, x]))).toString()}`);
}));

const renderSaved = async (req, res, extra = {}) => {
  const c = await context(req);
  const report = await reports.getSaved(req.ctx, Number(req.params.id));
  const exporting = req.query.format === 'csv';
  const result = await reports.run(req.ctx, report.dataset, report.config, { limit: exporting ? reports.MAX_EXPORT : reports.MAX_ROWS });
  if (exporting) return sendCsv(req, res, result, report.name);
  const [schedules, members] = await Promise.all([
    reports.listSchedules(req.ctx, report.id),
    knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.organization_id': req.ctx.organizationId, 'm.status': 'active' }).orderBy('u.name').select('u.id', 'u.name', 'u.email'),
  ]);
  return res.page('pages/reports/run', {
    title: report.name, ...c, result, template: null, report, schedules, members, builder: false, canEdit: reports.canEditSaved(req.ctx, report), ...extra,
  });
};
router.get('/saved/:id', wrap((req, res) => renderSaved(req, res)));
router.post('/saved/:id', form(async (req, res) => {
  await reports.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('reports.saved_msg'));
  res.redirect(`/app/reports/saved/${req.params.id}`);
}, renderSaved));
router.post('/saved/:id/delete', wrap(async (req, res) => {
  await reports.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('reports.deleted_msg'));
  res.redirect('/app/reports');
}));
router.post('/saved/:id/schedules', form(async (req, res) => {
  await reports.saveSchedule(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('reports.scheduled_msg'));
  res.redirect(`/app/reports/saved/${req.params.id}#schedules`);
}, (req, res, extra) => renderSaved(req, res, { ...extra, openDialog: 'schedule-dialog' })));
router.post('/saved/:id/schedules/:sid/delete', wrap(async (req, res) => {
  await reports.removeSchedule(req.ctx, Number(req.params.id), Number(req.params.sid));
  res.redirect(`/app/reports/saved/${req.params.id}#schedules`);
}));

module.exports = router;
