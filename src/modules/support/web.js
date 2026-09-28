// Help & support for companies (/app/support).
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const support = require('./support.service');

const router = express.Router();
router.use(can('support.manage'));

const renderList = async (req, res, extra = {}) => {
  const [tickets, sla] = await Promise.all([support.list(req.ctx), support.slaHours(req.ctx.organizationId, 'normal')]);
  res.page('pages/support/index', { title: req.t('support.title'), tickets, tier: sla.tier, SLA: support.SLA, CATEGORIES: support.CATEGORIES, PRIORITIES: support.PRIORITIES, ...extra });
};
router.get('/', wrap((req, res) => renderList(req, res)));
router.post('/', form(async (req, res) => {
  const id = await support.create(req.ctx, req.body);
  flash(req, 'success', req.t('support.created'));
  res.redirect(`/app/support/${id}`);
}, (req, res, extra) => renderList(req, res, { ...extra, openDialog: 'ticket-dialog' })));

const renderTicket = async (req, res, extra = {}) => {
  const ticket = await support.get(req.ctx, Number(req.params.id));
  res.page('pages/support/ticket', { title: ticket.subject, ticket, ...extra });
};
router.get('/:id', wrap((req, res) => renderTicket(req, res)));
router.post('/:id/reply', form(async (req, res) => {
  await support.reply(req.ctx, Number(req.params.id), req.body.body);
  res.redirect(`/app/support/${req.params.id}#latest`);
}, renderTicket));
router.post('/:id/status', form(async (req, res) => {
  await support.setStatus(req.ctx, Number(req.params.id), req.body.action);
  res.redirect(`/app/support/${req.params.id}`);
}, renderTicket));
router.post('/:id/rate', form(async (req, res) => {
  await support.rate(req.ctx, Number(req.params.id), req.body.satisfaction);
  flash(req, 'success', req.t('support.thanks_rating'));
  res.redirect(`/app/support/${req.params.id}`);
}, renderTicket));

module.exports = router;
