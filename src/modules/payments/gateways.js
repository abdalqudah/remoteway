// Saudi payment gateway adapters. Each one creates a hosted payment for an invoice and later reads its
// status back from the gateway: the status we act on always comes from our own server-to-server call,
// never from the browser redirect or the webhook body. Card details never touch RemoteWay.
//
//   create(cfg, p) → { ref, url } (hosted page) or { ref, widget } (HyperPay COPYandPAY)
//   fetch(cfg, ref, p) → { status: paid|pending|failed|cancelled, amount, currency, reason, reference, raw }
//   test(cfg) → true or throws GatewayError
//
// p = { token, amount, currency, description, invoiceNumber, returnUrl, webhookUrl, customer:{name,email}, locale, method, mode }
const http = require('../../core/http');

class GatewayError extends Error {
  constructor(message, raw) { super(message); this.raw = raw; }
}

const PAYTABS_REGIONS = {
  sa: 'https://secure.paytabs.sa', ae: 'https://secure.paytabs.com', eg: 'https://secure-egypt.paytabs.com',
  om: 'https://secure-oman.paytabs.com', jo: 'https://secure-jordan.paytabs.com', global: 'https://secure-global.paytabs.com',
};
const THREE_DECIMALS = new Set(['KWD', 'BHD', 'OMR', 'JOD']);
const minorUnits = (currency) => (THREE_DECIMALS.has(String(currency).toUpperCase()) ? 1000 : 100);
const toMinor = (amount, currency) => Math.round(Number(amount) * minorUnits(currency));
const fromMinor = (amount, currency) => Number(amount) / minorUnits(currency);
const fixed = (amount, currency) => Number(amount).toFixed(THREE_DECIMALS.has(String(currency).toUpperCase()) ? 3 : 2);

// Tests (and on-premise sandboxes) point every gateway at one local stub.
const base = (real) => (process.env.PAYMENTS_BASE_URL ? process.env.PAYMENTS_BASE_URL.replace(/\/+$/, '') : real);

async function call(url, { method = 'POST', headers = {}, json, form, auth } = {}) {
  const h = { accept: 'application/json', ...headers };
  let body = null;
  if (json !== undefined) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
  if (form !== undefined) { body = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
  if (auth) h.authorization = auth;
  let res;
  try {
    res = await http.request(url, { method, headers: h, body, timeoutMs: 20_000, maxBytes: 512 * 1024 });
  } catch (err) {
    throw new GatewayError(`Could not reach the payment gateway: ${err.message}`);
  }
  let data = null;
  try { data = res.body ? JSON.parse(res.body) : null; } catch { data = null; }
  return { status: res.status, data, text: res.body };
}

const messageOf = (d, fallback) => {
  if (!d) return fallback;
  const m = d.message || d.description || (d.result && d.result.description) || (d.errors && JSON.stringify(d.errors))
    || (Array.isArray(d.errors) && d.errors[0] && d.errors[0].description) || d.error;
  return String(m || fallback).slice(0, 250);
};
const keyFailure = (status) => (status === 401 || status === 403 ? 'The gateway rejected the key. Check that it is correct and matches test or live mode.' : null);

// ---------- Moyasar (hosted invoice: mada, Visa/Mastercard, Apple Pay, STC Pay as set in the dashboard) ----------
const moyasar = {
  label: 'Moyasar',
  fields: ['secret_key'],
  secretFields: ['secret_key'],
  webhookRefs: (b) => [b && b.id, b && b.invoice_id, b && b.data && b.data.invoice_id, b && b.data && b.data.id],
  auth: (cfg) => `Basic ${Buffer.from(`${cfg.secret_key}:`).toString('base64')}`,
  validate(cfg, mode) {
    const e = {};
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(cfg.secret_key || '')) e.secret_key = 'Enter the secret key (it starts with sk_test_ or sk_live_).';
    else if (!cfg.secret_key.startsWith(`sk_${mode}_`)) e.secret_key = `This key is not a ${mode} key.`;
    return e;
  },
  async create(cfg, p) {
    const r = await call(`${base('https://api.moyasar.com')}/v1/invoices`, {
      auth: this.auth(cfg),
      json: {
        amount: toMinor(p.amount, p.currency), currency: p.currency, description: p.description,
        success_url: p.returnUrl, back_url: p.returnUrl, callback_url: p.webhookUrl,
        metadata: { invoice_number: p.invoiceNumber, payment: p.token },
      },
    });
    if (r.status >= 300 || !r.data || !r.data.id || !r.data.url) throw new GatewayError(keyFailure(r.status) || messageOf(r.data, `Moyasar returned HTTP ${r.status}.`), r.data);
    return { ref: r.data.id, url: r.data.url, raw: r.data };
  },
  async fetch(cfg, ref) {
    const r = await call(`${base('https://api.moyasar.com')}/v1/invoices/${encodeURIComponent(ref)}`, { method: 'GET', auth: this.auth(cfg) });
    if (r.status >= 300 || !r.data) throw new GatewayError(keyFailure(r.status) || messageOf(r.data, `Moyasar returned HTTP ${r.status}.`), r.data);
    const d = r.data;
    const map = { paid: 'paid', initiated: 'pending', on_hold: 'pending', canceled: 'cancelled', cancelled: 'cancelled', expired: 'failed', failed: 'failed', refunded: 'failed', voided: 'failed' };
    const paidPayment = (d.payments || []).find((x) => x.status === 'paid');
    const lastPayment = (d.payments || [])[0];
    return {
      status: map[d.status] || 'pending', amount: fromMinor(d.amount, d.currency), currency: String(d.currency || '').toUpperCase(),
      reason: d.status === 'expired' ? 'expired' : (lastPayment && lastPayment.source && lastPayment.source.message) || null,
      reference: paidPayment ? paidPayment.id : d.id, raw: d,
    };
  },
  async test(cfg) {
    const r = await call(`${base('https://api.moyasar.com')}/v1/invoices?page=1`, { method: 'GET', auth: this.auth(cfg) });
    if (r.status >= 300) throw new GatewayError(keyFailure(r.status) || messageOf(r.data, `Moyasar returned HTTP ${r.status}.`));
    return true;
  },
};

// ---------- Tap Payments (hosted charge page: mada, cards, Apple Pay, STC Pay …) ----------
const tap = {
  label: 'Tap Payments',
  fields: ['secret_key'],
  secretFields: ['secret_key'],
  webhookRefs: (b) => [b && b.id],
  auth: (cfg) => `Bearer ${cfg.secret_key}`,
  validate(cfg, mode) {
    const e = {};
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(cfg.secret_key || '')) e.secret_key = 'Enter the secret key (it starts with sk_test_ or sk_live_).';
    else if (!cfg.secret_key.startsWith(`sk_${mode}_`)) e.secret_key = `This key is not a ${mode} key.`;
    return e;
  },
  async create(cfg, p) {
    const [first, ...rest] = String(p.customer.name || 'Customer').trim().split(/\s+/);
    const r = await call(`${base('https://api.tap.company')}/v2/charges`, {
      auth: this.auth(cfg),
      json: {
        amount: Number(fixed(p.amount, p.currency)), currency: p.currency, threeDSecure: true, save_card: false,
        description: p.description, statement_descriptor: 'RemoteWay', metadata: { payment: p.token },
        reference: { transaction: p.token, order: p.invoiceNumber }, receipt: { email: false, sms: false },
        customer: { first_name: first || 'Customer', last_name: rest.join(' ') || undefined, email: p.customer.email },
        source: { id: 'src_all' }, post: { url: p.webhookUrl }, redirect: { url: p.returnUrl },
      },
    });
    const url = r.data && r.data.transaction && r.data.transaction.url;
    if (r.status >= 300 || !r.data || !r.data.id || !url) throw new GatewayError(keyFailure(r.status) || messageOf(r.data, `Tap returned HTTP ${r.status}.`), r.data);
    return { ref: r.data.id, url, raw: r.data };
  },
  async fetch(cfg, ref) {
    const r = await call(`${base('https://api.tap.company')}/v2/charges/${encodeURIComponent(ref)}`, { method: 'GET', auth: this.auth(cfg) });
    if (r.status >= 300 || !r.data) throw new GatewayError(keyFailure(r.status) || messageOf(r.data, `Tap returned HTTP ${r.status}.`), r.data);
    const d = r.data;
    const s = String(d.status || '').toUpperCase();
    const status = s === 'CAPTURED' ? 'paid' : ['INITIATED', 'IN_PROGRESS'].includes(s) ? 'pending' : ['CANCELLED', 'ABANDONED'].includes(s) ? 'cancelled' : 'failed';
    return {
      status, amount: Number(d.amount), currency: String(d.currency || '').toUpperCase(),
      reason: status === 'paid' ? null : (d.response && d.response.message) || s.toLowerCase(), reference: d.id, raw: d,
    };
  },
  async test(cfg) {
    // Reading a charge that does not exist: a wrong key gives 401, a good key gives "not found".
    const r = await call(`${base('https://api.tap.company')}/v2/charges/chg_remoteway_connection_test`, { method: 'GET', auth: this.auth(cfg) });
    if (keyFailure(r.status)) throw new GatewayError(keyFailure(r.status));
    if (r.status >= 500) throw new GatewayError(`Tap returned HTTP ${r.status}.`);
    return true;
  },
};

// ---------- HyperPay COPYandPAY (payment widget on our page; mada needs its own entity) ----------
const HP_SUCCESS = /^(000\.000\.|000\.100\.1|000\.[36])/;
const HP_PENDING = /^(000\.200|800\.400\.5|100\.400\.500)/;
const hyperpay = {
  label: 'HyperPay',
  fields: ['access_token', 'entity_card', 'entity_mada'],
  secretFields: ['access_token'],
  methods: ['mada', 'card'],
  webhookRefs: () => [], // HyperPay notifications are encrypted; payments are confirmed on return and by the reconciler
  host: (mode) => base(mode === 'live' ? 'https://eu-prod.oppwa.com' : 'https://eu-test.oppwa.com'),
  auth: (cfg) => `Bearer ${cfg.access_token}`,
  entity: (cfg, method) => (method === 'mada' ? cfg.entity_mada : cfg.entity_card),
  validate(cfg) {
    const e = {};
    if (!cfg.access_token || cfg.access_token.length < 20) e.access_token = 'Enter the access token.';
    if (!/^[a-f0-9]{32}$/i.test(cfg.entity_card || '')) e.entity_card = 'Enter the Visa/Mastercard entity ID (32 characters).';
    if (cfg.entity_mada && !/^[a-f0-9]{32}$/i.test(cfg.entity_mada)) e.entity_mada = 'Enter the mada entity ID (32 characters) or leave it empty.';
    return e;
  },
  async create(cfg, p) {
    const entityId = this.entity(cfg, p.method);
    if (!entityId) throw new GatewayError('This payment method is not set up for HyperPay.');
    const [given, ...rest] = String(p.customer.name || 'Customer').trim().split(/\s+/);
    const form = {
      entityId, amount: fixed(p.amount, p.currency), currency: p.currency, paymentType: 'DB', merchantTransactionId: p.token,
      'customer.email': p.customer.email, 'customer.givenName': given || 'Customer', 'customer.surname': rest.join(' ') || given || 'Customer',
      'billing.country': p.country || 'SA', 'billing.city': p.city || 'Riyadh', 'billing.street1': p.street || 'N/A', 'billing.state': p.city || 'Riyadh', 'billing.postcode': '00000',
    };
    if (p.mode !== 'live' && p.method !== 'mada') form.testMode = 'EXTERNAL';
    const r = await call(`${this.host(p.mode)}/v1/checkouts`, { auth: this.auth(cfg), form });
    const code = r.data && r.data.result && r.data.result.code;
    if (r.status >= 300 || !r.data || !r.data.id || !/^000\.200\.100/.test(code || '')) throw new GatewayError(keyFailure(r.status) || messageOf(r.data, `HyperPay returned HTTP ${r.status}.`), r.data);
    return {
      ref: r.data.id, raw: r.data,
      widget: { script: `${this.host(p.mode)}/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(r.data.id)}`, origin: new URL(this.host(p.mode)).origin, brands: p.method === 'mada' ? 'MADA' : 'VISA MASTER' },
    };
  },
  async fetch(cfg, ref, p) {
    const entityId = this.entity(cfg, p.method);
    const r = await call(`${this.host(p.mode)}/v1/checkouts/${encodeURIComponent(ref)}/payment?entityId=${encodeURIComponent(entityId || '')}`, { method: 'GET', auth: this.auth(cfg) });
    if (keyFailure(r.status) || !r.data || !r.data.result) throw new GatewayError(keyFailure(r.status) || messageOf(r.data, `HyperPay returned HTTP ${r.status}.`), r.data);
    const code = String(r.data.result.code || '');
    const status = HP_SUCCESS.test(code) ? 'paid' : HP_PENDING.test(code) ? 'pending' : 'failed';
    return {
      status, amount: Number(r.data.amount), currency: String(r.data.currency || '').toUpperCase(),
      reason: status === 'paid' ? null : `${code} ${r.data.result.description || ''}`.trim().slice(0, 250), reference: r.data.id || ref, raw: r.data,
    };
  },
  async test(cfg, mode) {
    const r = await call(`${this.host(mode)}/v1/checkouts`, { auth: this.auth(cfg), form: { entityId: cfg.entity_card, amount: '1.00', currency: 'SAR', paymentType: 'DB' } });
    const code = r.data && r.data.result && r.data.result.code;
    if (!/^000\.200\.100/.test(code || '')) throw new GatewayError(keyFailure(r.status) || messageOf(r.data, `HyperPay returned HTTP ${r.status}.`));
    return true;
  },
};

// ---------- PayTabs (hosted payment page) ----------
const paytabs = {
  label: 'PayTabs',
  fields: ['server_key', 'profile_id', 'region'],
  secretFields: ['server_key'],
  webhookRefs: (b) => [b && b.tran_ref, b && b.tranRef],
  host: (cfg) => base(PAYTABS_REGIONS[cfg.region] || PAYTABS_REGIONS.sa),
  validate(cfg) {
    const e = {};
    if (!cfg.server_key || cfg.server_key.length < 20) e.server_key = 'Enter the server key.';
    if (!/^\d{1,10}$/.test(String(cfg.profile_id || ''))) e.profile_id = 'Enter the profile ID (numbers only).';
    if (!PAYTABS_REGIONS[cfg.region]) e.region = 'Choose the region of your PayTabs account.';
    return e;
  },
  async create(cfg, p) {
    const r = await call(`${this.host(cfg)}/payment/request`, {
      auth: cfg.server_key,
      json: {
        profile_id: Number(cfg.profile_id), tran_type: 'sale', tran_class: 'ecom', cart_id: p.token,
        cart_currency: p.currency, cart_amount: Number(fixed(p.amount, p.currency)), cart_description: p.description,
        paypage_lang: p.locale === 'ar' ? 'ar' : 'en', callback: p.webhookUrl, return: p.returnUrl, hide_shipping: true,
      },
    });
    if (r.status >= 300 || !r.data || !r.data.tran_ref || !r.data.redirect_url) throw new GatewayError(keyFailure(r.status) || messageOf(r.data, `PayTabs returned HTTP ${r.status}.`), r.data);
    return { ref: r.data.tran_ref, url: r.data.redirect_url, raw: r.data };
  },
  async fetch(cfg, ref) {
    const r = await call(`${this.host(cfg)}/payment/query`, { auth: cfg.server_key, json: { profile_id: Number(cfg.profile_id), tran_ref: ref } });
    const res = r.data && r.data.payment_result;
    if (r.status >= 300 || !res) throw new GatewayError(keyFailure(r.status) || messageOf(r.data, `PayTabs returned HTTP ${r.status}.`), r.data);
    const s = String(res.response_status || '');
    const status = s === 'A' ? 'paid' : ['H', 'P'].includes(s) ? 'pending' : 'failed';
    return {
      status, amount: Number(r.data.cart_amount), currency: String(r.data.cart_currency || '').toUpperCase(),
      reason: status === 'paid' ? null : String(res.response_message || s).slice(0, 250), reference: r.data.tran_ref || ref, raw: r.data,
    };
  },
  async test(cfg) {
    const r = await call(`${this.host(cfg)}/payment/query`, { auth: cfg.server_key, json: { profile_id: Number(cfg.profile_id), tran_ref: 'TST0000000000000' } });
    if (keyFailure(r.status) || (r.data && Number(r.data.code) === 1)) throw new GatewayError(messageOf(r.data, 'PayTabs rejected the server key or profile ID.'));
    if (r.status >= 500) throw new GatewayError(`PayTabs returned HTTP ${r.status}.`);
    return true;
  },
};

const GATEWAYS = { moyasar, tap, hyperpay, paytabs };

module.exports = { GATEWAYS, GatewayError, PAYTABS_REGIONS, toMinor, fromMinor, minorUnits };
