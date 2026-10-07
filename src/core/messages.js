// Editable texts of the messages RemoteWay sends: account emails (invitation, email confirmation, password
// reset, notifications, talent invitations, scheduled reports) and the texts used to send quotes, invoices
// and files by email or WhatsApp. Defaults live in the translation files (msgdef.*); Super Admin → Message
// texts can replace any field per language. Placeholders are written {name} and only the listed ones work.
const knex = require('../db/knex');
const cache = require('./cache');
const { translator } = require('./i18n');

const EMAIL_FIELDS = ['subject', 'title', 'body', 'cta'];
const TEXT_FIELDS = ['text'];
const LOCALES = ['ar', 'en'];

/** kind 'email' → subject/title/body/cta; kind 'text' (WhatsApp / SMS) → text. */
const DEFS = [
  { key: 'invitation', group: 'account', kind: 'email', vars: ['org', 'role', 'app'] },
  { key: 'verify_email', group: 'account', kind: 'email', vars: ['name', 'hours', 'app'] },
  { key: 'password_reset', group: 'account', kind: 'email', vars: ['duration', 'app'] },
  { key: 'notification', group: 'account', kind: 'email', vars: ['text', 'app'] },
  { key: 'talent_invite', group: 'account', kind: 'email', vars: ['org', 'job', 'message', 'app'] },
  { key: 'report_delivery', group: 'account', kind: 'email', vars: ['report', 'rows', 'app'] },
  { key: 'quote_email', group: 'sales', kind: 'email', vars: ['customer', 'number', 'total', 'valid_until', 'seller', 'link'] },
  { key: 'quote_whatsapp', group: 'sales', kind: 'text', vars: ['customer', 'number', 'total', 'valid_until', 'seller', 'link'] },
  { key: 'invoice_email', group: 'sales', kind: 'email', vars: ['customer', 'number', 'total', 'due_date', 'seller', 'link'] },
  { key: 'invoice_whatsapp', group: 'sales', kind: 'text', vars: ['customer', 'number', 'total', 'due_date', 'seller', 'link'] },
  { key: 'file_email', group: 'sales', kind: 'email', vars: ['customer', 'title', 'seller', 'link'] },
  { key: 'file_whatsapp', group: 'sales', kind: 'text', vars: ['customer', 'title', 'seller', 'link'] },
];
const BY_KEY = Object.fromEntries(DEFS.map((d) => [d.key, d]));
const fieldsOf = (def) => (def.kind === 'email' ? EMAIL_FIELDS : TEXT_FIELDS);
const LIMITS = { subject: 200, title: 200, cta: 60, body: 4000, text: 1500 };

const parse = (v) => { if (!v) return {}; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return {}; } };
const overrides = () => cache.remember('messages:overrides', async () => {
  const row = await knex('platform_settings').where({ key: 'message_texts' }).first();
  return row ? parse(row.value) : {};
}, 30_000);

/** The default (translation file) text of one field, placeholders left in. */
function defaultText(key, locale, field) {
  return translator(LOCALES.includes(locale) ? locale : 'en')(`msgdef.${key}_${field}`);
}

function fill(text, vars) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''))
    .replace(/[ \t]+([،,.:!?؟])/g, '$1') // an empty placeholder leaves "Hello ," behind
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The texts for one message in a language, with the placeholders filled in. */
async function compose(key, locale, vars = {}) {
  const def = BY_KEY[key];
  if (!def) throw new Error(`Unknown message ${key}`);
  const lc = LOCALES.includes(locale) ? locale : 'en';
  const o = ((await overrides())[key] || {})[lc] || {};
  const out = {};
  for (const f of fieldsOf(def)) out[f] = fill(o[f] || defaultText(key, lc, f), vars);
  return out;
}

/** Everything the edit page needs: defaults, saved overrides, placeholders. */
async function describe(key) {
  const def = BY_KEY[key];
  if (!def) return null;
  const o = (await overrides())[key] || {};
  const langs = {};
  for (const lc of LOCALES) {
    langs[lc] = {};
    for (const f of fieldsOf(def)) langs[lc][f] = { default: defaultText(key, lc, f), saved: (o[lc] || {})[f] || '' };
  }
  return { ...def, fields: fieldsOf(def), langs, edited: Object.keys(o).length > 0 };
}

async function list() {
  const o = await overrides();
  return DEFS.map((d) => ({ ...d, edited: Boolean(o[d.key] && Object.values(o[d.key]).some((x) => Object.values(x || {}).some(Boolean))) }));
}

/**
 * Saves the texts of one message. A field equal to the default (or empty) is not stored, so later changes
 * to the defaults still reach it. Unknown placeholders are refused, so a typo never reaches a customer.
 */
function validate(key, body) {
  const def = BY_KEY[key];
  const errors = {}; const value = {};
  for (const lc of LOCALES) {
    for (const f of fieldsOf(def)) {
      const name = `${lc}_${f}`;
      const v = String(body[name] || '').replace(/\r\n/g, '\n').trim();
      if (!v || v === defaultText(key, lc, f)) continue; // eslint-disable-line no-continue
      if (v.length > LIMITS[f]) { errors[name] = `Keep this under ${LIMITS[f]} characters.`; continue; } // eslint-disable-line no-continue
      const unknown = [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !def.vars.includes(k));
      if (unknown.length) { errors[name] = 'A placeholder here does not exist for this message. Use only the placeholders listed.'; continue; } // eslint-disable-line no-continue
      if (f === 'subject' && /\n/.test(v)) { errors[name] = 'The subject must be one line.'; continue; } // eslint-disable-line no-continue
      value[lc] = { ...(value[lc] || {}), [f]: v };
    }
  }
  return { errors, value };
}

async function save(key, body) {
  if (!BY_KEY[key]) return null;
  const { errors, value } = validate(key, body);
  if (Object.keys(errors).length) return { errors };
  const row = await knex('platform_settings').where({ key: 'message_texts' }).first();
  const all = row ? parse(row.value) : {};
  if (Object.keys(value).length) all[key] = value; else delete all[key];
  const json = JSON.stringify(all);
  await knex('platform_settings').insert({ key: 'message_texts', value: json }).onConflict('key').merge({ value: json, updated_at: new Date() });
  cache.forgetPrefix('messages:');
  return { errors: {} };
}

async function reset(key) {
  const row = await knex('platform_settings').where({ key: 'message_texts' }).first();
  const all = row ? parse(row.value) : {};
  delete all[key];
  const json = JSON.stringify(all);
  await knex('platform_settings').insert({ key: 'message_texts', value: json }).onConflict('key').merge({ value: json, updated_at: new Date() });
  cache.forgetPrefix('messages:');
}

/** Sample values for previews and test messages. */
function sample(key, locale) {
  const ar = locale === 'ar';
  const base = {
    org: ar ? 'شركة المثال' : 'Example Co.', role: ar ? 'موظف' : 'Employee', app: 'RemoteWay', name: ar ? 'سارة' : 'Sarah', hours: 48,
    duration: ar ? 'ساعة واحدة' : '1 hour', text: ar ? 'تمت الموافقة على طلب إجازتك' : 'Your leave request was approved',
    job: ar ? 'محاسب أول' : 'Senior accountant', message: ar ? 'نود التحدث معك عن هذه الوظيفة.' : 'We would like to talk to you about this role.',
    report: ar ? 'تقرير الحضور الأسبوعي' : 'Weekly attendance', rows: 42, customer: ar ? 'أحمد' : 'Ahmed', number: key.startsWith('invoice') ? 'INV-2026-0012' : 'Q-2026-0007',
    total: ar ? '11,500.00 ر.س' : 'SAR 11,500.00', valid_until: '2026-11-30', due_date: '2026-11-15', seller: 'RemoteWay', title: ar ? 'الملف التعريفي' : 'Company profile',
    link: 'https://example.com/quote/…',
  };
  return base;
}

module.exports = { DEFS, LOCALES, fieldsOf, compose, describe, list, save, reset, sample, fill };
