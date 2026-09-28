// Automation (/app/automation): rules, builder with a dry-run preview, and the run log.
const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can, feature } = require('../../middleware/context');
const rbac = require('../rbac/rbac.service');
const automation = require('./automation.service');
const TEMPLATES = require('./templates');

const router = express.Router();
router.use(feature('automation'));
router.use(can('automation.manage'));

async function options(req) {
  const org = req.ctx.organizationId;
  const has = (f) => req.entitlements.features.has(f);
  const [departments, roles, people, leaveTypes, courses] = await Promise.all([
    knex('departments').where({ organization_id: org }).orderBy('name').select('id', 'name'),
    rbac.listRoles(org),
    knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.organization_id': org, 'm.status': 'active' }).orderBy('u.name').select('u.id', 'u.name'),
    has('leave') ? knex('leave_types').where({ organization_id: org, is_active: true }).orderBy('sort_order').select('id', 'name', 'name_ar') : [],
    has('learning') ? knex('courses').where({ organization_id: org, status: 'published' }).orderBy('title').select('id', 'title') : [],
  ]);
  const employees = await knex('employees').where({ organization_id: org }).whereNot('status', 'terminated').orderBy('first_name').limit(500).select('id', 'first_name', 'last_name');
  const triggers = Object.keys(automation.TRIGGERS).filter((k) => has(automation.TRIGGERS[k].feature));
  const actions = Object.keys(automation.ACTIONS).filter((k) => !automation.ACTIONS[k].feature || has(automation.ACTIONS[k].feature));
  return { departments, roles, people, leaveTypes, courses, employees, triggers, actions, A: automation };
}

/** A template or saved rule as form values. */
function fromTemplate(tpl, locale) {
  return {
    trigger: tpl.trigger, days: tpl.days, category: tpl.category, conditions: tpl.conditions || {},
    actions: tpl.actions.map((a) => ({ ...a, message: a.message ? a.message[locale] || a.message.en : '' })),
  };
}

router.get('/', wrap(async (req, res) => {
  const [rules, runs] = await Promise.all([automation.list(req.ctx.organizationId), automation.runs(req.ctx.organizationId, { limit: 15 })]);
  res.page('pages/automation/index', { title: req.t('automation.title'), rules, runs, TEMPLATES, available: (await options(req)).triggers, A_SCHEDULE: automation.SCHEDULE_TRIGGERS });
}));

const renderForm = async (req, res, extra = {}) => {
  let rule = null;
  if (req.params.id) rule = await automation.get(req.ctx, Number(req.params.id));
  const tpl = !rule && req.query.template ? TEMPLATES.find((x) => x.key === req.query.template) : null;
  const draft = rule ? { ...rule, days: rule.trigger_options.days, category: rule.trigger_options.category, actions: rule.actions.map((a) => ({ ...a, message: a.message || a.title })) }
    : tpl ? { ...fromTemplate(tpl, req.locale), name: req.t(`automation.tpl_${tpl.key}`), is_active: true } : null;
  res.page('pages/automation/form', { title: rule ? rule.name : req.t('automation.new'), rule, draft, preview: null, ...(await options(req)), ...extra });
};
router.get('/new', wrap((req, res) => renderForm(req, res)));
router.get('/runs', wrap(async (req, res) => {
  res.page('pages/automation/runs', { title: req.t('automation.runs'), runs: await automation.runs(req.ctx.organizationId, { limit: 200, ruleId: Number(req.query.rule) || null }) });
}));
router.get('/:id', wrap((req, res) => renderForm(req, res)));

router.post('/', form(async (req, res) => {
  if (req.body.action === 'preview') return renderPreview(req, res);
  await automation.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('automation.saved'));
  return res.redirect('/app/automation');
}, renderForm));
router.post('/:id', form(async (req, res) => {
  if (req.body.action === 'preview') return renderPreview(req, res);
  await automation.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('automation.saved'));
  return res.redirect('/app/automation');
}, renderForm));

/** Dry run against one employee: shows recipients and texts; nothing is sent or created. */
async function renderPreview(req, res) {
  const result = await automation.preview(req.ctx, req.body, req.body.preview_employee_id);
  return renderForm(req, res, { preview: result, old: req.body });
}

router.post('/:id/toggle', wrap(async (req, res) => {
  await automation.setActive(req.ctx, Number(req.params.id), req.body.on === '1');
  res.redirect('/app/automation');
}));
router.post('/:id/delete', wrap(async (req, res) => {
  await automation.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('automation.deleted'));
  res.redirect('/app/automation');
}));

module.exports = router;
