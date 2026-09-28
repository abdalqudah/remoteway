// Settings → Approval workflows (/app/settings/workflows).
const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const rbac = require('../rbac/rbac.service');
const leave = require('../leave/leave.service');
const wf = require('./workflows.service');

const router = express.Router();
router.use((req, res, next) => { res.locals.section = 'workflows'; next(); });
router.use(can('workflows.manage'));

/** Each step arrives as one value: "manager", "department_head", "role:<key>" or "user:<id>". */
function stepsFromBody(body) {
  const list = Array.isArray(body.step) ? body.step : body.step ? [body.step] : [];
  const types = []; const refs = [];
  for (const v of list) {
    const [type, ...rest] = String(v).split(':');
    if (!type) continue;
    types.push(type); refs.push(rest.join(':'));
  }
  return { ...body, step_type: types, step_ref: refs };
}

async function options(req) {
  const [roles, people, types] = await Promise.all([
    rbac.listRoles(req.ctx.organizationId),
    knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.organization_id': req.ctx.organizationId, 'm.status': 'active' }).orderBy('u.name').select('u.id', 'u.name'),
    leave.listTypes(req.ctx.organizationId),
  ]);
  return { roles, people, types };
}

router.get('/', wrap(async (req, res) => {
  const [list, opts] = await Promise.all([wf.list(req.ctx.organizationId), options(req)]);
  const [{ n: running }] = await knex('leave_requests').where({ organization_id: req.ctx.organizationId, status: 'pending' }).whereNotNull('workflow_id').count({ n: '*' });
  res.page('pages/settings/workflows', { title: req.t('workflows.title'), list, ...opts, running: Number(running), inPlan: req.entitlements.features.has('custom_workflows') });
}));

const renderForm = async (req, res, extra = {}) => {
  const item = req.params.id ? await wf.get(req.ctx, Number(req.params.id)) : null;
  res.page('pages/settings/workflow-form', { title: item ? item.name : req.t('workflows.new'), item, ...(await options(req)), ...extra });
};
router.get('/new', wrap((req, res) => renderForm(req, res)));
router.get('/:id', wrap((req, res) => renderForm(req, res)));
router.post('/', form(async (req, res) => {
  await wf.save(req.ctx, null, stepsFromBody(req.body));
  flash(req, 'success', req.t('workflows.saved'));
  res.redirect('/app/settings/workflows');
}, renderForm));
router.post('/:id', form(async (req, res) => {
  await wf.save(req.ctx, Number(req.params.id), stepsFromBody(req.body));
  flash(req, 'success', req.t('workflows.saved'));
  res.redirect('/app/settings/workflows');
}, renderForm));
router.post('/:id/delete', wrap(async (req, res) => {
  await wf.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('workflows.deleted'));
  res.redirect('/app/settings/workflows');
}));

module.exports = router;
