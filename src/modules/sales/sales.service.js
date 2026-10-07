// Sales documents for the RemoteWay team: the seller details printed on documents, quotations (line items,
// discount, VAT, a customer link to view, print and accept), files to send (company profile…), share links
// for invoices, and a log of every send by email or WhatsApp — also written to the CRM timeline.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const cache = require('../../core/cache');
const storage = require('../../core/storage');
const mailer = require('../../core/mailer');
const messages = require('../../core/messages');
const config = require('../../config');
const money = require('../../core/money');
const { formatMoney, formatDate, toDateInput } = require('../../core/format');
const { randomToken } = require('../../core/tokens');
const { normalizePhone } = require('../integrations/messaging.service');
const { E, AppError } = require('../../core/errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const parse = (v) => { if (!v) return {}; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return {}; } };
const today = () => toDateInput(new Date());
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// ---------- Seller details (printed on quotations and shared invoices) ----------
const PROFILE_FIELDS = {
  legal_name_ar: 150, legal_name_en: 150, vat_number: 40, cr_number: 40, address_ar: 255, address_en: 255, phone: 40, email: 190, website: 190,
  bank_name: 120, account_name: 150, iban: 40, terms_ar: 3000, terms_en: 3000,
};
const profile = () => cache.remember('sales:profile', async () => {
  const row = await knex('platform_settings').where({ key: 'sales_profile' }).first();
  const p = row ? parse(row.value) : {};
  return { valid_days: 30, tax_rate: 15, currency: 'SAR', ...p };
}, 30_000);

async function saveProfile(ctx, body) {
  const p = {};
  for (const [k, n] of Object.entries(PROFILE_FIELDS)) p[k] = str(body[k], n);
  const errors = {};
  if (p.email && !EMAIL_RE.test(p.email)) errors.email = 'Enter a valid email address.';
  if (p.vat_number && !/^\d{15}$/.test(p.vat_number)) errors.vat_number = 'A Saudi VAT number has 15 digits.';
  p.iban = p.iban.replace(/\s+/g, '').toUpperCase();
  if (p.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(p.iban)) errors.iban = 'Enter a valid IBAN (e.g. SA03 8000 …).';
  p.valid_days = Math.min(365, Math.max(1, Number.parseInt(body.valid_days, 10) || 30));
  p.tax_rate = Math.min(100, Math.max(0, Number(body.tax_rate)));
  if (!Number.isFinite(p.tax_rate)) errors.tax_rate = 'Enter the VAT rate (e.g. 15).';
  p.currency = /^[A-Z]{3}$/.test(String(body.currency || '').toUpperCase()) ? String(body.currency).toUpperCase() : 'SAR';
  if (Object.keys(errors).length) throw E.validation(errors);
  const value = JSON.stringify(p);
  await knex('platform_settings').insert({ key: 'sales_profile', value }).onConflict('key').merge({ value, updated_at: new Date() });
  cache.forgetPrefix('sales:');
  await audit.record(ctx, 'platform.sales_profile_updated', { entityType: 'platform' });
}

/** The seller name used in texts, in the customer's language. */
const sellerName = (p, locale) => (locale === 'ar' ? p.legal_name_ar || p.legal_name_en : p.legal_name_en || p.legal_name_ar) || 'RemoteWay';

// ---------- Quotations ----------
/** Line items from the form (parallel arrays), with amounts; empty rows are skipped. */
function readItems(body, currency) {
  const list = (k) => [].concat(body[k] === undefined ? [] : body[k]);
  const desc = list('item_description'); const qty = list('item_quantity'); const price = list('item_price'); const svc = list('item_service_id');
  const items = []; const errors = {};
  for (let i = 0; i < desc.length && items.length < 50; i += 1) {
    const d = str(desc[i], 500);
    if (!d && !String(price[i] || '').trim()) continue; // eslint-disable-line no-continue
    const q = Number(String(qty[i] ?? '1').replace(/,/g, '')); const p = Number(String(price[i] ?? '0').replace(/,/g, ''));
    if (!d) errors.items = 'Every line needs a description.';
    else if (!Number.isFinite(q) || q <= 0 || q > 100000) errors.items = 'Quantities must be more than zero.';
    else if (!Number.isFinite(p) || p < 0 || p > 100000000) errors.items = 'Prices must be zero or more.';
    const amount = money.roundMils(money.toMils(p) * (Number.isFinite(q) ? q : 0), currency);
    items.push({ description: d, quantity: q, unit_price: p, amountMils: amount, sort: items.length, service_id: Number(svc[i]) || null });
  }
  if (!items.length) errors.items = 'Add at least one line.';
  return { items, errors };
}

function totals(items, { discount, taxRate, currency }) {
  const subtotal = items.reduce((s, i) => s + i.amountMils, 0);
  const disc = Math.min(subtotal, Math.max(0, money.toMils(discount)));
  const tax = money.roundMils(((subtotal - disc) * taxRate) / 100, currency);
  return { subtotal: money.fromMils(subtotal), discount: money.fromMils(disc), tax: money.fromMils(tax), total: money.fromMils(subtotal - disc + tax) };
}

async function nextQuoteNumber(trx) {
  const prefix = `Q-${new Date().getUTCFullYear()}-`;
  const last = await trx('quotes').where('number', 'like', `${prefix}%`).orderBy('id', 'desc').forUpdate().first('number');
  const seq = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

/** Customer, dates, money and items from the form. */
async function readQuote(body) {
  const p = await profile();
  const errors = {};
  const v = {
    contact_id: Number(body.contact_id) || null,
    customer_name: str(body.customer_name, 150), customer_company: str(body.customer_company, 150) || null,
    customer_email: str(body.customer_email, 190).toLowerCase() || null, customer_phone: str(body.customer_phone, 40) || null,
    customer_vat: str(body.customer_vat, 40) || null, customer_address: str(body.customer_address, 255) || null,
    locale: body.locale === 'en' ? 'en' : 'ar', currency: /^[A-Z]{3}$/.test(String(body.currency || '')) ? body.currency : p.currency,
    issue_date: /^\d{4}-\d{2}-\d{2}$/.test(body.issue_date || '') ? body.issue_date : today(),
    notes: str(body.notes, 3000) || null, terms: str(body.terms, 5000) || null,
  };
  v.valid_until = /^\d{4}-\d{2}-\d{2}$/.test(body.valid_until || '') ? body.valid_until : addDays(v.issue_date, p.valid_days);
  if (!v.customer_name) errors.customer_name = 'Enter the customer name.';
  if (v.customer_email && !EMAIL_RE.test(v.customer_email)) errors.customer_email = 'Enter a valid email address.';
  if (v.customer_phone && !normalizePhone(v.customer_phone)) errors.customer_phone = 'Enter a valid mobile number (e.g. 05xxxxxxxx or +9665xxxxxxxx).';
  else if (v.customer_phone) v.customer_phone = `+${normalizePhone(v.customer_phone)}`; // one clean format (+9665…)
  if (v.valid_until < v.issue_date) errors.valid_until = 'The quotation must be valid on or after its date.';
  if (v.contact_id && !(await knex('crm_contacts').where({ id: v.contact_id }).first('id'))) v.contact_id = null;
  const taxRate = body.tax_rate === undefined || body.tax_rate === '' ? Number(p.tax_rate) : Number(body.tax_rate);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) errors.tax_rate = 'Enter the VAT rate (e.g. 15).';
  const discount = Number(String(body.discount || '0').replace(/,/g, ''));
  if (!Number.isFinite(discount) || discount < 0) errors.discount = 'The discount must be zero or more.';
  const { items, errors: itemErrors } = readItems(body, v.currency);
  Object.assign(errors, itemErrors);
  if (Object.keys(errors).length) throw E.validation(errors);
  return { v: { ...v, tax_rate: taxRate, ...totals(items, { discount, taxRate, currency: v.currency }) }, items };
}

const itemRows = (quoteId, items) => items.map((i) => ({ quote_id: quoteId, description: i.description, quantity: i.quantity, unit_price: i.unit_price, amount: money.fromMils(i.amountMils), sort: i.sort, service_id: i.service_id || null }));

async function createQuote(ctx, body) {
  const { v, items } = await readQuote(body);
  const id = await knex.transaction(async (trx) => {
    const [qid] = await trx('quotes').insert({ ...v, number: await nextQuoteNumber(trx), token: randomToken(24), created_by: ctx.userId });
    await trx('quote_items').insert(itemRows(qid, items));
    return qid;
  });
  await audit.record(ctx, 'platform.quote_created', { entityType: 'quote', entityId: id, newValues: { total: v.total, customer: v.customer_name } });
  return id;
}

async function getQuote(id) {
  const q = await knex('quotes').where({ id: Number(id) }).first();
  if (!q) throw E.notFound('Quotation');
  q.items = await knex('quote_items').where({ quote_id: q.id }).orderBy('sort');
  return q;
}

async function updateQuote(ctx, id, body) {
  const q = await getQuote(id);
  if (['accepted', 'declined'].includes(q.status)) throw E.conflict('QUOTE_CLOSED', 'This quotation was already answered by the customer. Duplicate it to make a new one.');
  const { v, items } = await readQuote(body);
  await knex.transaction(async (trx) => {
    await trx('quotes').where({ id: q.id }).update({ ...v, updated_at: new Date() });
    await trx('quote_items').where({ quote_id: q.id }).del();
    await trx('quote_items').insert(itemRows(q.id, items));
  });
  await audit.record(ctx, 'platform.quote_updated', { entityType: 'quote', entityId: q.id, newValues: { total: v.total } });
  return q;
}

async function duplicateQuote(ctx, id) {
  const q = await getQuote(id);
  const p = await profile();
  const newId = await knex.transaction(async (trx) => {
    const DROP = ['id', 'number', 'token', 'status', 'sent_at', 'first_viewed_at', 'last_viewed_at', 'view_count', 'responded_at', 'response_name', 'response_note', 'created_at', 'updated_at', 'items',
      'revision', 'signer_title', 'signature_key', 'stamp_key', 'signed_file_key', 'signed_file_mime', 'signed_file_name', 'decline_reason', 'response_ip'];
    const rest = Object.fromEntries(Object.entries(q).filter(([k]) => !DROP.includes(k)));
    const { items } = q;
    const [qid] = await trx('quotes').insert({ ...rest, issue_date: today(), valid_until: addDays(today(), p.valid_days), number: await nextQuoteNumber(trx), token: randomToken(24), created_by: ctx.userId });
    await trx('quote_items').insert(items.map((i) => ({ quote_id: qid, description: i.description, quantity: i.quantity, unit_price: i.unit_price, amount: i.amount, sort: i.sort, service_id: i.service_id })));
    return qid;
  });
  await audit.record(ctx, 'platform.quote_created', { entityType: 'quote', entityId: newId, newValues: { from: q.number } });
  return newId;
}

async function removeQuote(ctx, id) {
  const q = await getQuote(id);
  if (q.status !== 'draft') throw E.conflict('QUOTE_SENT', 'Only draft quotations can be deleted. A sent quotation stays for the record.');
  await knex('quotes').where({ id: q.id }).del();
  await audit.record(ctx, 'platform.quote_deleted', { entityType: 'quote', entityId: q.id, oldValues: { number: q.number } });
}

/** What the customer and the team see: draft, sent, viewed, accepted, declined or expired. */
function quoteState(q) {
  if (q.status === 'accepted' || q.status === 'declined') return q.status;
  if (toDateInput(q.valid_until) < today()) return 'expired';
  if (q.status === 'negotiating') return 'negotiating';
  if (q.first_viewed_at) return 'viewed';
  return q.status;
}

async function listQuotes({ state } = {}) {
  const rows = await knex('quotes as q').leftJoin('users as u', 'u.id', 'q.created_by').select('q.*', 'u.name as created_by_name').orderBy('q.id', 'desc').limit(500);
  const out = rows.map((q) => ({ ...q, state: quoteState(q) }));
  return state ? out.filter((q) => q.state === state) : out;
}

/** Totals for the list header: open (sent/viewed, not expired) and accepted this year. */
function quoteSummary(rows) {
  const year = String(new Date().getUTCFullYear());
  const sum = (list) => list.reduce((s, q) => s + Number(q.total), 0);
  const open = rows.filter((q) => ['sent', 'viewed', 'negotiating'].includes(q.state));
  const won = rows.filter((q) => q.state === 'accepted' && toDateInput(q.responded_at || q.updated_at).startsWith(year));
  return { open: open.length, openTotal: sum(open), won: won.length, wonTotal: sum(won), drafts: rows.filter((q) => q.state === 'draft').length };
}

/** The customer's link. Views by the RemoteWay team (signed in to the admin) are not counted. */
async function quoteByToken(token, { count = true } = {}) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) throw E.notFound('Quotation');
  const q = await knex('quotes').where({ token }).first();
  if (!q) throw E.notFound('Quotation');
  if (count) {
    const now = new Date();
    await knex('quotes').where({ id: q.id }).update({ view_count: knex.raw('view_count + 1'), last_viewed_at: now, first_viewed_at: q.first_viewed_at || now });
    if (!q.first_viewed_at && q.contact_id) {
      await require('../crm/crm.service').addActivity(q.contact_id, { type: 'quote_viewed', channel: 'platform', subject: q.number, body: `${q.number} · ${formatMoney(q.total, q.currency, 'en')}`, meta: { quote_id: q.id } }); // eslint-disable-line global-require
    }
    Object.assign(q, { first_viewed_at: q.first_viewed_at || now });
  }
  q.items = await knex('quote_items').where({ quote_id: q.id }).orderBy('sort');
  return q;
}

// ---------- Services catalog (ticked into quotations, priced per customer) ----------
const listServices = ({ activeOnly = false } = {}) => {
  const q = knex('sales_services').orderBy('sort').orderBy('id');
  return activeOnly ? q.where({ active: true }) : q;
};
/** The line text for a quotation in its language: name (unit) and the description below it. */
function serviceText(sv, locale) {
  const en = locale === 'en';
  const name = (en ? sv.name_en || sv.name_ar : sv.name_ar || sv.name_en) || '';
  const unit = en ? sv.unit_en || sv.unit_ar : sv.unit_ar || sv.unit_en;
  const desc = en ? sv.description_en || sv.description_ar : sv.description_ar || sv.description_en;
  return `${name}${unit ? ` (${unit})` : ''}${desc ? `\n${desc}` : ''}`.slice(0, 500);
}
async function saveService(ctx, id, body) {
  const v = {
    name_ar: str(body.name_ar, 200), name_en: str(body.name_en, 200) || null, description_ar: str(body.description_ar, 1000) || null, description_en: str(body.description_en, 1000) || null,
    unit_ar: str(body.unit_ar, 60) || null, unit_en: str(body.unit_en, 60) || null, price: Number(String(body.price || '0').replace(/,/g, '')), active: body.active !== '0', sort: Number.parseInt(body.sort, 10) || 0,
  };
  const errors = {};
  if (!v.name_ar && !v.name_en) errors.name_ar = 'Enter the service name.';
  if (!v.name_ar) v.name_ar = v.name_en || '';
  if (!Number.isFinite(v.price) || v.price < 0) errors.price = 'Prices must be zero or more.';
  if (Object.keys(errors).length) throw E.validation(errors);
  if (id) {
    if (!(await knex('sales_services').where({ id: Number(id) }).first('id'))) throw E.notFound('Service');
    await knex('sales_services').where({ id: Number(id) }).update({ ...v, updated_at: new Date() });
  } else [id] = await knex('sales_services').insert(v); // eslint-disable-line no-param-reassign
  await audit.record(ctx, 'platform.sales_service_saved', { entityType: 'sales_service', entityId: Number(id), newValues: { name: v.name_ar, price: v.price } });
  return Number(id);
}
/** Services used in quotations are switched off instead (old quotations keep their lines). */
async function removeService(ctx, id) {
  const used = await knex('quote_items').where({ service_id: Number(id) }).first('id');
  if (used) await knex('sales_services').where({ id: Number(id) }).update({ active: false, updated_at: new Date() });
  else await knex('sales_services').where({ id: Number(id) }).del();
  return used ? 'deactivated' : 'deleted';
}

// ---------- Files to send (company profile, brochures…) ----------
const FILE_TYPES = {
  pdf: { mime: 'application/pdf', sig: (b) => b.slice(0, 4).toString('latin1') === '%PDF' },
  png: { mime: 'image/png', sig: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: 'image/jpeg', sig: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  // Office files are zip packages: the extension decides which one.
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sig: (b) => b.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sig: (b) => b.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sig: (b) => b.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
};
FILE_TYPES.jpeg = FILE_TYPES.jpg;

async function uploadFile(ctx, file, body) {
  if (!file || !file.buffer || !file.buffer.length) throw E.validation({ file: 'Choose a file.' });
  const ext = String(file.originalname || '').toLowerCase().split('.').pop();
  const type = FILE_TYPES[ext];
  if (!type || !type.sig(file.buffer)) throw E.validation({ file: 'Upload a PDF, an image (PNG/JPG) or an Office file (Word, PowerPoint, Excel).' });
  const title = str(body.title, 150) || str(String(file.originalname).replace(/\.[^.]+$/, ''), 150);
  const key = `platform/sales-files/${randomToken(18).replace(/[^a-z0-9]/gi, '')}`;
  await storage.put(key, file.buffer);
  const safeName = `${title.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 120) || 'file'}.${ext === 'jpeg' ? 'jpg' : ext}`;
  const [id] = await knex('sales_files').insert({ title, description: str(body.description, 500) || null, storage_key: key, filename: safeName, mime: type.mime, size: file.buffer.length, token: randomToken(24), created_by: ctx.userId });
  await audit.record(ctx, 'platform.sales_file_added', { entityType: 'sales_file', entityId: id, newValues: { title } });
  return id;
}

const listFiles = () => knex('sales_files as f').leftJoin('crm_contacts as c', 'c.id', 'f.contact_id').leftJoin('document_templates as t', 't.id', 'f.template_id')
  .select('f.*', 'c.name as contact_name', 'c.company_name as contact_company', 't.name as template_name').orderBy('f.active', 'desc').orderBy('f.id', 'desc');
async function getFile(id) {
  const f = await knex('sales_files').where({ id: Number(id) }).first();
  if (!f) throw E.notFound('File');
  return f;
}
async function updateFile(ctx, id, body) {
  const f = await getFile(id);
  const title = str(body.title, 150);
  if (!title) throw E.validation({ title: 'Enter a title.' });
  await knex('sales_files').where({ id: f.id }).update({ title, description: str(body.description, 500) || null, active: body.active !== '0', updated_at: new Date() });
}
async function removeFile(ctx, id) {
  const f = await getFile(id);
  await knex('sales_files').where({ id: f.id }).del();
  if (f.storage_key) await storage.remove(f.storage_key).catch(() => {});
  await audit.record(ctx, 'platform.sales_file_deleted', { entityType: 'sales_file', entityId: f.id, oldValues: { title: f.title } });
}
async function fileByToken(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) throw E.notFound('File');
  const f = await knex('sales_files').where({ token, active: true }).first();
  if (!f) throw E.notFound('File');
  return f;
}
const countOpen = (f) => knex('sales_files').where({ id: f.id }).update({ open_count: knex.raw('open_count + 1'), last_opened_at: new Date() });

// ---------- Invoices: a link for the customer ----------
async function invoiceShareToken(invoiceId) {
  const inv = await knex('invoices').where({ id: Number(invoiceId) }).first('id', 'share_token');
  if (!inv) throw E.notFound('Invoice');
  if (inv.share_token) return inv.share_token;
  const token = randomToken(24);
  await knex('invoices').where({ id: inv.id }).whereNull('share_token').update({ share_token: token });
  return (await knex('invoices').where({ id: inv.id }).first('share_token')).share_token;
}
async function invoiceByToken(token, { count = true } = {}) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) throw E.notFound('Invoice');
  const inv = await knex('invoices as i').join('organizations as o', 'o.id', 'i.organization_id')
    .where('i.share_token', token).whereNot('i.status', 'void').select('i.*', 'o.name as org_name', 'o.address as org_address', 'o.country_code').first();
  if (!inv) throw E.notFound('Invoice');
  if (count) await knex('invoices').where({ id: inv.id }).update({ view_count: knex.raw('view_count + 1'), last_viewed_at: new Date() });
  inv.items = await knex('invoice_items').where({ invoice_id: inv.id });
  return inv;
}

/** The company's owner: who an invoice goes to. */
async function invoiceRecipient(organizationId) {
  const org = await knex('organizations').where({ id: organizationId }).first('id', 'name', 'phone', 'locale');
  const owner = await knex('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').join('users as u', 'u.id', 'ur.user_id')
    .where({ 'ur.organization_id': organizationId, 'r.key': 'owner' }).first('u.name', 'u.email', 'u.locale');
  return { org, name: owner ? owner.name : org.name, email: owner ? owner.email : null, phone: org.phone || null, locale: (owner && owner.locale) || org.locale || 'ar' };
}

// ---------- Sending (email, WhatsApp link) ----------
const DOC_TYPES = ['quote', 'invoice', 'file'];

/**
 * Everything needed to send one document: who to (defaults), the customer link and the placeholder values.
 * `extra` = { contactId, name, email, phone, locale } chosen on the page (a file can go to anyone).
 */
async function sendable(type, id, base, extra = {}) {
  const p = await profile();
  const root = String(base || config.appUrl).replace(/\/+$/, '');
  if (type === 'quote') {
    const q = await getQuote(id);
    const locale = extra.locale || q.locale;
    return {
      type, id: q.id, label: q.number, locale, contactId: q.contact_id, name: q.customer_name, email: q.customer_email, phone: q.customer_phone, link: `${root}/quote/${q.token}`, quote: q,
      vars: { customer: q.customer_name, number: q.number, total: formatMoney(q.total, q.currency, locale), valid_until: formatDate(q.valid_until, locale), seller: sellerName(p, locale) },
    };
  }
  if (type === 'invoice') {
    const inv = await knex('invoices').where({ id: Number(id) }).first();
    if (!inv) throw E.notFound('Invoice');
    if (inv.status === 'void') throw E.conflict('INVOICE_VOID', 'This invoice was voided and cannot be sent.');
    const r = await invoiceRecipient(inv.organization_id);
    const locale = extra.locale || r.locale;
    const contact = await knex('crm_contacts').where({ organization_id: inv.organization_id }).orderBy('id').first('id').catch(() => null);
    return {
      type, id: inv.id, label: inv.number, locale, contactId: contact ? contact.id : null, name: r.name, email: r.email, phone: r.phone, link: `${root}/invoice/${await invoiceShareToken(inv.id)}`, invoice: inv, org: r.org,
      vars: { customer: r.name, number: inv.number, total: formatMoney(inv.total, inv.currency, locale), due_date: formatDate(inv.due_date, locale), seller: sellerName(p, locale) },
    };
  }
  if (type === 'file') {
    const f = await getFile(id);
    const cid = extra.contactId || f.contact_id;
    const c = cid ? await knex('crm_contacts').where({ id: Number(cid) }).first() : null;
    const locale = extra.locale || (c && c.locale) || 'ar';
    return {
      type, id: f.id, label: f.title, locale, contactId: c ? c.id : null, name: c ? c.name : '', email: c ? c.email : '', phone: c ? c.phone : '', link: `${root}/file/${f.token}`, file: f,
      vars: { customer: c ? c.name : '', title: f.title, seller: sellerName(p, locale) },
    };
  }
  throw E.notFound('Document');
}

/** Ready texts for the send panel, in the chosen language (the team can still edit them). */
async function drafts(doc) {
  const vars = { ...doc.vars, link: doc.link };
  const [mail, wa] = await Promise.all([messages.compose(`${doc.type}_email`, doc.locale, vars), messages.compose(`${doc.type}_whatsapp`, doc.locale, vars)]);
  return { email: mail, whatsapp: wa.text };
}

async function logSend(ctx, doc, { channel, recipient, status, error, subject, body }) {
  await knex('document_sends').insert({ doc_type: doc.type, doc_id: doc.id, channel, recipient: str(recipient, 190), contact_id: doc.contactId || null, status, error: error ? str(error, 500) : null, subject: subject ? str(subject, 200) : null, body: body ? String(body).slice(0, 10000) : null, user_id: ctx.userId });
  if (doc.contactId) {
    await require('../crm/crm.service').addActivity(doc.contactId, { // eslint-disable-line global-require
      type: channel, direction: 'out', channel, subject: subject || doc.label, body, status: status === 'opened' ? 'sent' : status, userId: ctx.userId,
      meta: { document: doc.type, document_id: doc.id, via: channel === 'whatsapp' ? 'link' : 'email', error: error ? str(error, 300) : undefined },
    });
  }
  if (doc.type === 'quote' && status !== 'failed' && doc.quote.status === 'draft') await knex('quotes').where({ id: doc.id }).update({ status: 'sent', sent_at: new Date() });
}

/** Sends the document by email: the customer link as a button, and the file itself attached for files. */
async function sendEmail(ctx, type, id, body, base) {
  const doc = await sendable(type, id, base, { locale: body.locale === 'en' ? 'en' : body.locale === 'ar' ? 'ar' : undefined, contactId: body.contact_id });
  const to = str(body.to, 190).toLowerCase();
  const subject = str(body.subject, 200).replace(/[\r\n]+/g, ' ');
  const text = String(body.body || '').replace(/\r\n/g, '\n').trim().slice(0, 8000);
  const errors = {};
  if (!EMAIL_RE.test(to)) errors.to = 'Enter a valid email address.';
  if (!subject) errors.subject = 'Write a subject.';
  if (!text) errors.body = 'Write the message.';
  if (Object.keys(errors).length) throw E.validation(errors);
  if (!config.isTest && !mailer.enabled()) throw E.conflict('MAIL_OFF', 'Email is not set up yet (Super Admin → Email). Use WhatsApp or copy the link meanwhile.');
  const d = await drafts(doc);
  const attachments = [];
  if (type === 'file' && body.attach === '1' && doc.file.storage_key && doc.file.size <= 10 * 1024 * 1024) attachments.push({ filename: doc.file.filename, content: await storage.read(doc.file.storage_key), contentType: doc.file.mime });
  const sender = await knex('users').where({ id: ctx.userId }).first('name');
  let status = 'sent'; let error = null;
  try {
    const sent = await mailer.send({ kind: type, to, subject, html: mailer.layout({ locale: doc.locale, title: d.email.title, body: text, cta: d.email.cta, href: doc.link }), attachments: attachments.length ? attachments : undefined, fromName: sender ? `${sender.name} · ${sellerName(await profile(), doc.locale)}` : undefined });
    if (!sent && !config.isTest) { status = 'failed'; error = 'The email was not sent (email settings).'; }
  } catch (e) { status = 'failed'; error = e.message; }
  await logSend(ctx, doc, { channel: 'email', recipient: to, status, error, subject, body: text });
  if (status === 'failed') throw new AppError('SEND_FAILED', error, 502, { reason: error });
  return doc;
}

/** The wa.me link with the text ready; WhatsApp opens on the team member's phone or computer. */
function whatsappLink(phone, text) {
  const n = normalizePhone(phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}

/** Records that WhatsApp was opened with the text for this customer (the team presses Send in WhatsApp). */
async function logWhatsApp(ctx, type, id, body, base) {
  const doc = await sendable(type, id, base, { locale: body.locale === 'en' ? 'en' : body.locale === 'ar' ? 'ar' : undefined, contactId: body.contact_id });
  const n = normalizePhone(body.phone);
  if (!n) throw E.validation({ phone: 'Enter a valid mobile number (e.g. 05xxxxxxxx or +9665xxxxxxxx).' });
  const text = String(body.text || '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
  if (!text) throw E.validation({ text: 'Write the message.' });
  await logSend(ctx, doc, { channel: 'whatsapp', recipient: `+${n}`, status: 'opened', body: text });
  return whatsappLink(n, text);
}

const sendsFor = (type, id) => knex('document_sends as s').leftJoin('users as u', 'u.id', 's.user_id').where({ 's.doc_type': type, 's.doc_id': Number(id) })
  .select('s.*', 'u.name as user_name').orderBy('s.id', 'desc').limit(50);

module.exports = {
  listServices, serviceText, saveService, removeService,
  profile, saveProfile, sellerName, PROFILE_FIELDS,
  createQuote, getQuote, updateQuote, duplicateQuote, removeQuote, listQuotes, quoteSummary, quoteState, quoteByToken, readItems, totals,
  uploadFile, listFiles, getFile, updateFile, removeFile, fileByToken, countOpen,
  invoiceShareToken, invoiceByToken, invoiceRecipient,
  DOC_TYPES, sendable, drafts, sendEmail, logWhatsApp, whatsappLink, sendsFor,
};
