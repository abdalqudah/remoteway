const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can, feature } = require('../../middleware/context');
const leave = require('./leave.service');
const employees = require('../workforce/employee.service');
const { todayIn } = require('../../core/workdays');

const router = express.Router();
router.use(feature('leave'));

const render = async (req, res, extra = {}) => {
  const { ctx } = req;
  const tab = extra.tab || req.query.tab || 'mine';
  const self = await employees.linkedEmployeeId(ctx);
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : todayIn(req.organization.timezone).slice(0, 7);
  const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const [types, balances, mine, approvals, team, people] = await Promise.all([
    leave.listTypes(ctx.organizationId, { activeOnly: true }),
    self ? leave.balancesFor(ctx.organizationId, self) : [],
    leave.myRequests(ctx),
    leave.pendingApprovals(ctx),
    tab === 'calendar' ? leave.teamRequests(ctx, { from: `${month}-01`, to: monthEnd }) : [],
    ctx.permissions.has('leave.approve') ? employees.options(ctx.organizationId) : [],
  ]);
  const allTypes = tab === 'types' && ctx.permissions.has('settings.manage') ? await leave.listTypes(ctx.organizationId) : [];
  res.page('pages/leave/index', {
    title: req.t('nav.leave'), tab, self, types, balances, mine, approvals, team, people, month, monthEnd, allTypes, ...extra,
  });
};

router.get('/', wrap((req, res) => render(req, res)));

router.post('/', can('leave.request'), form(async (req, res) => {
  await leave.createRequest(req.ctx, req.body);
  flash(req, 'success', req.t('leave.requested'));
  res.redirect(req.body.employee_id ? '/app/leave?tab=approvals' : '/app/leave');
}, (req, res, extra) => render(req, res, { ...extra, openDialog: 'leave' })));

router.post('/:id/decide', form(async (req, res) => {
  await leave.decide(req.ctx, Number(req.params.id), { decision: req.body.decision, note: req.body.note });
  flash(req, 'success', req.t(req.body.decision === 'approved' ? 'leave.approved_msg' : 'leave.rejected_msg'));
  res.redirect('/app/leave?tab=approvals');
}, (req, res, extra) => render(req, res, { ...extra, tab: 'approvals' })));

router.post('/:id/cancel', form(async (req, res) => {
  await leave.cancel(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('leave.cancelled_msg'));
  res.redirect(req.get('referer')?.includes('tab=') ? req.get('referer') : '/app/leave');
}, (req, res, extra) => render(req, res, extra)));

router.post('/types', can('settings.manage'), form(async (req, res) => {
  await leave.saveType(req.ctx, req.body.id ? Number(req.body.id) : null, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/leave?tab=types');
}, (req, res, extra) => render(req, res, { ...extra, tab: 'types', openDialog: 'type' })));

router.post('/balances/adjust', can('leave.approve'), can('employees.view'), form(async (req, res) => {
  await leave.adjustBalance(req.ctx, Number(req.body.employee_id), Number(req.body.leave_type_id), req.body.adjustment, req.body.note);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/app/employees/${Number(req.body.employee_id)}?tab=leave`);
}, async (req, res, extra) => {
  flash(req, 'error', extra.formError.message);
  res.redirect(`/app/employees/${Number(req.body.employee_id)}?tab=leave`);
}));

module.exports = router;
