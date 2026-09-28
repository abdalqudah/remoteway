// Online payment of subscription invoices. Flow:
//   start()  → a payment row (with an unguessable token) + a hosted payment at the gateway
//   return / webhook / reconciler → verify(): read the status from the gateway ourselves → settle()
//   settle() → paid (amount and currency must match) marks the invoice paid and activates the subscription.
// Browser redirects and webhook bodies are only hints about which payment to check; they are never trusted.
const crypto = require('crypto');
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const secrets = require('../../core/secrets');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const subscriptions = require('../billing/subscription.service');
const notifications = require('../notifications/notification.service');
const { GATEWAYS, GatewayError } = require('./gateways');

const PROVIDER_KEYS = Object.keys(GATEWAYS);
const err = {
  notConfigured: () => new AppError('PAYMENTS_NOT_CONFIGURED', 'Online payment is not available yet. Please contact us to pay this invoice.', 409),
  gateway: (message) => new AppError('PAYMENT_GATEWAY_ERROR', message, 502, { reason: message }),
};

// ---------- Platform configuration (Super Admin → Payments) ----------
async function rawConfig() {
  const row = await knex('platform_settings').where({ key: 'payments' }).first();
  if (!row) return { mode: 'test', providers: {} };
  const v = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  return { mode: v.mode === 'live' ? 'live' : 'test', providers: v.providers || {} };
}

/** Decrypted settings of one saved gateway (secrets included), or null. */
function decryptProvider(key, saved) {
  if (!saved || !GATEWAYS[key]) return null;
  const out = { ...saved };
  for (const f of GATEWAYS[key].secretFields) {
    out[f] = saved[`${f}_enc`] ? secrets.decrypt(saved[`${f}_enc`]) : null;
    delete out[`${f}_enc`];
    delete out[`${f}_hint`];
    if (!out[f]) return null;
  }
  return out;
}

function config() {
  return cache.remember('payments:config', async () => {
    const raw = await rawConfig();
    const providers = {};
    for (const key of PROVIDER_KEYS) {
      const cfg = decryptProvider(key, raw.providers[key]);
      if (cfg) providers[key] = cfg;
    }
    return { mode: raw.mode, providers };
  }, 30_000);
}
function invalidateConfig() { cache.forgetPrefix('payments:config'); }

/** Gateways a customer can pay with right now: [{ key, label, methods }]. */
async function available() {
  const cfg = await config();
  return PROVIDER_KEYS.filter((k) => cfg.providers[k] && cfg.providers[k].enabled).map((k) => ({
    key: k, label: GATEWAYS[k].label,
    methods: k === 'hyperpay' ? ['mada', 'card'].filter((m) => GATEWAYS.hyperpay.entity(cfg.providers[k], m)) : null,
  }));
}

/**
 * Validates and saves one gateway. Empty secret fields keep the saved secret.
 * @returns the plain settings (for a connection test)
 */
async function saveProvider(ctx, key, body, { save = true } = {}) {
  const g = GATEWAYS[key];
  if (!g) throw E.notFound('Payment gateway');
  const raw = await rawConfig();
  const mode = body.mode === 'live' ? 'live' : body.mode === 'test' ? 'test' : raw.mode;
  const saved = raw.providers[key] || {};
  const cfg = { enabled: body.enabled === 'on' || body.enabled === true };
  for (const f of g.fields) {
    let v = String(body[f] ?? '').trim();
    if (!v && g.secretFields.includes(f) && saved[`${f}_enc`]) v = secrets.decrypt(saved[`${f}_enc`]) || '';
    cfg[f] = v;
  }
  if (key === 'paytabs' && !cfg.region) cfg.region = 'sa';
  const errors = g.validate(cfg, mode);
  if (Object.keys(errors).length) throw E.validation(errors);
  if (!save) return { cfg, mode };
  const stored = { enabled: cfg.enabled };
  for (const f of g.fields) {
    if (g.secretFields.includes(f)) { stored[`${f}_enc`] = secrets.encrypt(cfg[f]); stored[`${f}_hint`] = secrets.mask(cfg[f]); } else stored[f] = cfg[f] || null;
  }
  const value = JSON.stringify({ mode: raw.mode, providers: { ...raw.providers, [key]: stored } });
  await knex('platform_settings').insert({ key: 'payments', value }).onConflict('key').merge({ value, updated_at: new Date() });
  invalidateConfig();
  await audit.record(ctx, 'platform.payments_updated', { entityType: 'platform', newValues: { gateway: key, enabled: cfg.enabled } });
  return { cfg, mode };
}

async function setMode(ctx, mode) {
  if (!['test', 'live'].includes(mode)) throw E.validation({ mode: 'Choose test or live.' });
  const raw = await rawConfig();
  // Keys are per mode for Moyasar and Tap: a gateway whose saved key does not match the new mode is switched off.
  const providers = { ...raw.providers };
  for (const key of ['moyasar', 'tap']) {
    const cfg = decryptProvider(key, providers[key]);
    if (cfg && !cfg.secret_key.startsWith(`sk_${mode}_`)) providers[key] = { ...providers[key], enabled: false };
  }
  const value = JSON.stringify({ mode, providers });
  await knex('platform_settings').insert({ key: 'payments', value }).onConflict('key').merge({ value, updated_at: new Date() });
  invalidateConfig();
  await audit.record(ctx, 'platform.payments_mode', { entityType: 'platform', newValues: { mode } });
}

async function removeProvider(ctx, key) {
  const raw = await rawConfig();
  const providers = { ...raw.providers };
  delete providers[key];
  const value = JSON.stringify({ mode: raw.mode, providers });
  await knex('platform_settings').insert({ key: 'payments', value }).onConflict('key').merge({ value, updated_at: new Date() });
  invalidateConfig();
  await audit.record(ctx, 'platform.payments_updated', { entityType: 'platform', newValues: { gateway: key, removed: true } });
}

async function testProvider(ctx, key, body) {
  const { cfg, mode } = await saveProvider(ctx, key, body, { save: false });
  const started = Date.now();
  try {
    await GATEWAYS[key].test(cfg, mode);
  } catch (e) {
    throw err.gateway(e.message);
  }
  return { ms: Date.now() - started };
}

// ---------- Paying an invoice ----------
const publicBase = (baseUrl) => String(baseUrl || '').replace(/\/+$/, '');

/**
 * Starts an online payment for an issued invoice of the caller's organization.
 * @returns {{ payment, url?: string, widget?: object }}
 */
async function start(ctx, invoiceId, { provider, method, baseUrl, locale, user }) {
  const cfg = await config();
  const gCfg = cfg.providers[provider];
  if (!GATEWAYS[provider] || !gCfg || !gCfg.enabled) throw err.notConfigured();
  const invoice = await knex('invoices').where({ id: invoiceId, organization_id: ctx.organizationId }).first();
  if (!invoice) throw E.notFound('Invoice');
  if (invoice.status !== 'issued') throw E.conflict('INVOICE_NOT_PAYABLE', 'This invoice is not open for payment.');
  if (provider === 'hyperpay') {
    if (!['mada', 'card'].includes(method) || !GATEWAYS.hyperpay.entity(gCfg, method)) throw E.validation({ method: 'Choose how you want to pay.' });
  } else method = null; // eslint-disable-line no-param-reassign
  const org = await knex('organizations').where({ id: ctx.organizationId }).first('name', 'country_code', 'address');
  const token = crypto.randomBytes(24).toString('hex');
  const [id] = await knex('payments').insert({
    organization_id: ctx.organizationId, invoice_id: invoice.id, provider, method, mode: cfg.mode, token,
    amount: invoice.total, currency: invoice.currency, status: 'initiated', created_by: ctx.userId,
  });
  const base = publicBase(baseUrl);
  const params = {
    token, amount: Number(invoice.total), currency: invoice.currency, invoiceNumber: invoice.number, mode: cfg.mode, method, locale,
    description: `RemoteWay ${invoice.number}`, returnUrl: `${base}/payments/return/${token}`, webhookUrl: `${base}/payments/webhook/${provider}`,
    customer: { name: (user && user.name) || org.name, email: user && user.email }, country: org.country_code, city: null, street: org.address,
  };
  let created;
  try {
    created = await GATEWAYS[provider].create(gCfg, params);
  } catch (e) {
    await knex('payments').where({ id }).update({ status: 'failed', failure_reason: String(e.message).slice(0, 250), raw: e.raw ? JSON.stringify(e.raw) : null, updated_at: new Date() });
    await audit.record(ctx, 'payment.start_failed', { entityType: 'invoice', entityId: invoice.id, newValues: { provider, error: String(e.message).slice(0, 200) } });
    if (e instanceof GatewayError) throw err.gateway(e.message);
    throw e;
  }
  await knex('payments').where({ id }).update({ provider_ref: String(created.ref), raw: JSON.stringify(created.raw || null), updated_at: new Date() });
  await audit.record(ctx, 'payment.started', { entityType: 'invoice', entityId: invoice.id, newValues: { provider, method, amount: invoice.total } });
  const payment = await knex('payments').where({ id }).first();
  return { payment, url: created.url, widget: created.widget };
}

const sameAmount = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

/** Applies a status read from the gateway. Idempotent: only an initiated payment changes. */
async function settle(paymentId, result) {
  let paid = null;
  const out = await knex.transaction(async (trx) => {
    const p = await trx('payments').where({ id: paymentId }).forUpdate().first();
    if (!p || p.status !== 'initiated') return p;
    const now = new Date();
    const base = { raw: JSON.stringify(result.raw || null), checked_at: now, updated_at: now };
    if (result.status === 'pending') {
      await trx('payments').where({ id: p.id }).update(base);
      return { ...p, ...base };
    }
    if (result.status === 'paid') {
      if (!sameAmount(result.amount, p.amount) || String(result.currency).toUpperCase() !== String(p.currency).toUpperCase()) {
        await trx('payments').where({ id: p.id }).update({ ...base, status: 'failed', failure_reason: `amount_mismatch (${result.amount} ${result.currency})` });
        await audit.record({ organizationId: p.organization_id, userId: null }, 'payment.amount_mismatch', { entityType: 'payment', entityId: p.id, newValues: { expected: p.amount, got: result.amount, currency: result.currency } }, trx);
        return p;
      }
      const invoice = await trx('invoices').where({ id: p.invoice_id }).forUpdate().first();
      const reference = `${p.provider}:${result.reference || p.provider_ref}`.slice(0, 120);
      let note = null;
      if (invoice.status === 'issued') {
        await subscriptions.markInvoicePaidTrx(trx, { organizationId: p.organization_id, userId: p.created_by }, invoice.id, reference);
      } else note = 'invoice_already_paid'; // paid twice (e.g. two tabs): the platform must refund one
      await trx('payments').where({ id: p.id }).update({ ...base, status: 'paid', paid_at: now, note });
      await audit.record({ organizationId: p.organization_id, userId: p.created_by }, note ? 'payment.duplicate' : 'payment.succeeded', {
        entityType: 'invoice', entityId: p.invoice_id, newValues: { provider: p.provider, amount: p.amount, reference },
      }, trx);
      const managers = await notifications.usersWithPermission(p.organization_id, 'billing.manage', trx);
      await notifications.notify(p.organization_id, managers, 'payment_received', { number: invoice.number }, `/app/billing/invoices/${invoice.id}`, trx);
      paid = p;
      return { ...p, status: 'paid', note };
    }
    const status = result.status === 'cancelled' ? 'cancelled' : 'failed';
    await trx('payments').where({ id: p.id }).update({ ...base, status, failure_reason: result.reason ? String(result.reason).slice(0, 250) : null });
    await audit.record({ organizationId: p.organization_id, userId: p.created_by }, 'payment.failed', { entityType: 'invoice', entityId: p.invoice_id, newValues: { provider: p.provider, reason: result.reason || status } }, trx);
    return { ...p, status };
  });
  if (paid) {
    const ent = require('../billing/entitlements.service'); // eslint-disable-line global-require
    ent.invalidate(paid.organization_id);
  }
  return out;
}

/** Reads the payment's status from the gateway and applies it. Network/gateway problems leave it initiated. */
async function verify(payment) {
  if (!payment || payment.status !== 'initiated' || !payment.provider_ref) return payment;
  const cfg = await config();
  const gCfg = cfg.providers[payment.provider];
  if (!gCfg) return payment;
  let result;
  try {
    result = await GATEWAYS[payment.provider].fetch(gCfg, payment.provider_ref, { method: payment.method, mode: payment.mode });
  } catch (e) {
    await knex('payments').where({ id: payment.id }).update({ checked_at: new Date() });
    console.error(`[payments] verify ${payment.id}:`, e.message); // eslint-disable-line no-console
    return payment;
  }
  return settle(payment.id, result);
}

/** Browser return from the gateway (GET or POST). No session is needed: the token identifies the payment. */
async function handleReturn(token) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return null;
  const payment = await knex('payments').where({ token }).first();
  if (!payment) return null;
  const after = await verify(payment);
  return { invoiceId: payment.invoice_id, status: after ? after.status : payment.status };
}

/** Gateway notification: only used to find which of our payments to verify. */
async function handleWebhook(provider, body) {
  const g = GATEWAYS[provider];
  if (!g) return 0;
  const refs = [...new Set(g.webhookRefs(body || {}).filter((r) => r != null && r !== '').map((r) => String(r).slice(0, 120)))];
  if (!refs.length) return 0;
  const list = await knex('payments').where({ provider, status: 'initiated' }).whereIn('provider_ref', refs);
  for (const p of list) await verify(p);
  return list.length;
}

/**
 * Checks payments whose customer never came back (closed the tab, lost connection).
 * HyperPay allows few status reads per checkout, so it is read once, after its 30-minute checkout expiry.
 */
async function reconcile(now = new Date()) {
  const ago = (min) => new Date(now.getTime() - min * 60_000);
  const list = await knex('payments').where({ status: 'initiated' }).where('created_at', '<', ago(2)).orderBy('id').limit(100);
  let checked = 0;
  for (const p of list) {
    if (!p.provider_ref) {
      if (new Date(p.created_at) < ago(60)) await knex('payments').where({ id: p.id, status: 'initiated' }).update({ status: 'failed', failure_reason: 'not_started' });
      continue; // eslint-disable-line no-continue
    }
    if (p.provider === 'hyperpay') {
      if (new Date(p.created_at) > ago(35)) continue; // eslint-disable-line no-continue
      const after = p.checked_at && new Date(p.checked_at) > new Date(p.created_at).getTime() + 35 * 60_000 ? p : await verify(p);
      checked += 1;
      if (after && after.status === 'initiated') await knex('payments').where({ id: p.id, status: 'initiated' }).update({ status: 'expired', updated_at: now });
      continue; // eslint-disable-line no-continue
    }
    if (p.checked_at && new Date(p.checked_at) > ago(10)) continue; // eslint-disable-line no-continue
    const after = await verify(p);
    checked += 1;
    if (after && after.status === 'initiated' && new Date(p.created_at) < ago(48 * 60)) {
      await knex('payments').where({ id: p.id, status: 'initiated' }).update({ status: 'expired', updated_at: now });
    }
  }
  return checked;
}

async function listForInvoice(organizationId, invoiceId) {
  return knex('payments').where({ organization_id: organizationId, invoice_id: invoiceId }).orderBy('id', 'desc')
    .select('id', 'provider', 'method', 'status', 'amount', 'currency', 'failure_reason', 'note', 'created_at', 'paid_at');
}

async function adminList({ status } = {}) {
  const q = knex('payments as p').join('organizations as o', 'o.id', 'p.organization_id').join('invoices as i', 'i.id', 'p.invoice_id')
    .select('p.id', 'p.provider', 'p.method', 'p.mode', 'p.status', 'p.amount', 'p.currency', 'p.provider_ref', 'p.failure_reason', 'p.note', 'p.created_at', 'p.paid_at',
      'o.name as organization_name', 'o.id as organization_id', 'i.number as invoice_number')
    .orderBy('p.id', 'desc').limit(100);
  if (status) q.where('p.status', status);
  return q;
}

async function byToken(token) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return null;
  return knex('payments').where({ token }).first();
}

module.exports = {
  PROVIDER_KEYS, rawConfig, config, invalidateConfig, available, saveProvider, setMode, removeProvider, testProvider,
  start, settle, verify, handleReturn, handleWebhook, reconcile, listForInvoice, adminList, byToken,
};
