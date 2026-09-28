const express = require('express');
const { z, validate } = require('../../core/validate');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const subscriptions = require('./subscription.service');
const ent = require('./entitlements.service');
const payments = require('../payments/payments.service');
const { GATEWAYS } = require('../payments/gateways');

const router = express.Router();

const renderBilling = async (req, res, extra = {}) => {
  const [plans, addons, usage, invoices] = await Promise.all([
    subscriptions.listPublicPlans(), subscriptions.listAddons(), ent.getUsage(req.ctx.organizationId), subscriptions.listInvoices(req.ctx.organizationId),
  ]);
  const entitlements = await ent.getEntitlements(req.ctx.organizationId);
  res.page('pages/billing/index', { title: req.t('nav.billing'), plans, addons, usage, invoices, ent: entitlements, ...extra });
};

router.get('/', can('billing.view'), wrap((req, res) => renderBilling(req, res)));

router.post('/plan', can('billing.manage'), form(async (req, res) => {
  const data = validate(z.object({ plan: z.string().min(1), cycle: z.enum(['monthly', 'yearly']) }), req.body);
  const { invoiceId } = await subscriptions.changePlan(req.ctx, { planKey: data.plan, cycle: data.cycle });
  flash(req, 'success', invoiceId ? req.t('billing.plan_changed_invoice') : req.t('billing.plan_changed'));
  res.redirect('/app/billing');
}, renderBilling));

router.post('/addons', can('billing.manage'), form(async (req, res) => {
  const data = validate(z.object({ addon: z.string().min(1), quantity: z.coerce.number().int().min(0).max(100) }), req.body);
  await subscriptions.setAddon(req.ctx, { addonKey: data.addon, quantity: data.quantity });
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/billing#addons');
}, renderBilling));

router.post('/activate', can('billing.manage'), form(async (req, res) => {
  const { invoiceId } = await subscriptions.requestActivation(req.ctx);
  res.redirect(`/app/billing/invoices/${invoiceId}`);
}, renderBilling));

const PAYMENT_RESULTS = new Set(['paid', 'failed', 'cancelled', 'expired', 'initiated']);
const renderInvoice = async (req, res, extra = {}) => {
  const id = Number(req.params.id);
  const invoice = await subscriptions.getInvoice(req.ctx.organizationId, id);
  const [gateways, attempts] = await Promise.all([payments.available(), payments.listForInvoice(req.ctx.organizationId, id)]);
  res.page('pages/billing/invoice', {
    title: invoice.number, invoice, gateways, attempts,
    inlineFormError: invoice.status === 'issued' && gateways.length > 0 && req.ctx.permissions.has('billing.manage'), // the pay panel shows it
    paymentResult: PAYMENT_RESULTS.has(req.query.payment) ? req.query.payment : null, ...extra,
  });
};
router.get('/invoices/:id', can('billing.view'), wrap((req, res) => renderInvoice(req, res)));

router.post('/invoices/:id/pay', can('billing.manage'), form(async (req, res) => {
  const [provider, method] = String(req.body.gateway || '').split(':');
  const { payment, url, widget } = await payments.start(req.ctx, Number(req.params.id), {
    provider, method, baseUrl: res.locals.baseUrl, locale: res.locals.locale, user: req.user,
  });
  if (widget) return res.redirect(303, `/payments/hyperpay/${payment.token}`);
  // The browser policy only allows forms to post to RemoteWay, so the hand-off to the gateway is a page, not a redirect.
  res.set('Refresh', `0; url=${url}`);
  res.set('Cache-Control', 'no-store');
  return res.page('pages/payments/redirect', { layout: 'auth', title: req.t('payments.redirecting'), url, gateway: GATEWAYS[provider].label });
}, renderInvoice));

module.exports = router;
