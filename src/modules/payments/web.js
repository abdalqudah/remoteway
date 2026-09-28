// Public payment endpoints: the browser return from a gateway, gateway webhooks, and the HyperPay
// payment page. None of them trusts what it receives; each one asks the gateway for the real status.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { wrap } = require('../../routes/helpers');
const payments = require('./payments.service');
const { GATEWAYS } = require('./gateways');

const router = express.Router();
const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

const back = (res, result) => res.redirect(303, `/app/billing/invoices/${result.invoiceId}?payment=${encodeURIComponent(result.status)}`);

const onReturn = wrap(async (req, res, next) => {
  const result = await payments.handleReturn(req.params.token);
  if (!result) return next();
  return back(res, result);
});
router.get('/return/:token', limiter, onReturn);
router.post('/return/:token', limiter, onReturn); // PayTabs returns with a POST

router.post('/webhook/:provider', limiter, async (req, res) => {
  try {
    await payments.handleWebhook(req.params.provider, req.body);
  } catch (e) {
    console.error('[payments] webhook', req.params.provider, e.message); // eslint-disable-line no-console
  }
  res.json({ received: true }); // always 200: the reconciler catches anything missed
});

// HyperPay COPYandPAY: the card form is HyperPay's widget (their iframe/script), shown on our page.
router.get('/hyperpay/:token', limiter, wrap(async (req, res, next) => {
  const p = await payments.byToken(req.params.token);
  if (!p || p.provider !== 'hyperpay' || !p.provider_ref) return next();
  if (p.status !== 'initiated') return back(res, { invoiceId: p.invoice_id, status: p.status });
  const host = GATEWAYS.hyperpay.host(p.mode);
  const origin = new URL(host).origin;
  // A relaxed policy for this page only, as HyperPay requires for its widget (3-D Secure opens bank pages).
  res.set('Content-Security-Policy', [
    "default-src 'self'", `script-src 'self' 'unsafe-inline' ${origin}`, `style-src 'self' 'unsafe-inline' ${origin}`,
    `img-src 'self' data: https:`, `font-src 'self' ${origin}`, `connect-src 'self' ${origin}`, 'frame-src https:', "form-action 'self' https:", "frame-ancestors 'none'",
  ].join('; '));
  res.set('Cache-Control', 'no-store');
  return res.page('pages/payments/hyperpay', {
    layout: 'auth', title: req.t('payments.pay_title'), payment: p,
    script: `${host}/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(p.provider_ref)}`,
    brands: p.method === 'mada' ? 'MADA' : 'VISA MASTER', returnUrl: `/payments/return/${p.token}`,
  });
}));

module.exports = router;
