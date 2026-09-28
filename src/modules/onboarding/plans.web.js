// Employee onboarding plans (/app/employee-onboarding). The workspace setup wizard lives at /app/onboarding.
const express = require('express');
const { wrap, form, flash, back } = require('../../routes/helpers');
const { can, feature } = require('../../middleware/context');
const onboarding = require('./onboarding.service');

const router = express.Router();
router.use(feature('onboarding'));

const renderList = async (req, res, extra = {}) => {
  const status = req.query.status || 'active';
  const manage = req.ctx.permissions.has('onboarding.manage');
  const [plans, templates, candidates] = await Promise.all([
    onboarding.listPlans(req.ctx, { status }),
    manage ? onboarding.listTemplates(req.ctx.organizationId) : [],
    manage ? onboarding.employeesWithoutPlan(req.ctx.organizationId) : [],
  ]);
  res.page('pages/onboarding-plans/index', { title: req.t('nav.onboarding_module'), plans, templates, candidates, status, ...extra });
};

router.get('/', wrap((req, res) => renderList(req, res)));

router.post('/', can('onboarding.manage'), form(async (req, res) => {
  const id = await onboarding.startPlan(req.ctx, Number(req.body.employee_id), req.body);
  res.redirect(`/app/employee-onboarding/${id}`);
}, (req, res, extra) => renderList(req, res, { ...extra, openDialog: 'start' })));

const renderTemplates = async (req, res, extra = {}) => res.page('pages/onboarding-plans/templates', {
  title: req.t('onboarding_plans.templates'), templates: await onboarding.listTemplates(req.ctx.organizationId),
  categories: onboarding.CATEGORIES, assignees: onboarding.ASSIGNEES, ...extra,
});
router.get('/templates', can('onboarding.manage'), wrap((req, res) => renderTemplates(req, res)));
router.post('/templates', can('onboarding.manage'), form(async (req, res) => {
  const items = (Array.isArray(req.body.item_title) ? req.body.item_title : [req.body.item_title]).map((title, i) => ({
    title, category: [].concat(req.body.item_category || [])[i], assignee: [].concat(req.body.item_assignee || [])[i], due_offset_days: [].concat(req.body.item_due || [])[i],
  }));
  await onboarding.saveTemplate(req.ctx, req.body.id ? Number(req.body.id) : null, { name: req.body.name, items });
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/employee-onboarding/templates');
}, renderTemplates));
router.post('/templates/:id/default', can('onboarding.manage'), wrap(async (req, res) => {
  await onboarding.setDefaultTemplate(req.ctx, Number(req.params.id));
  res.redirect('/app/employee-onboarding/templates');
}));

router.get('/:id', wrap(async (req, res) => {
  res.page('pages/onboarding-plans/show', { title: req.t('nav.onboarding_module'), plan: await onboarding.getPlan(req.ctx, Number(req.params.id)) });
}));

router.post('/tasks/:taskId', form(async (req, res) => {
  const planId = await onboarding.setTaskDone(req.ctx, Number(req.params.taskId), req.body.done === '1');
  back(req, res, `/app/employee-onboarding/${planId}`);
}, async (req, res, extra) => {
  flash(req, 'error', extra.formError.message);
  back(req, res, '/app/employee-onboarding');
}));

router.post('/:id/cancel', can('onboarding.manage'), wrap(async (req, res) => {
  await onboarding.cancelPlan(req.ctx, Number(req.params.id));
  res.redirect('/app/employee-onboarding');
}));

module.exports = router;
