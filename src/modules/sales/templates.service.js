// Document templates for the sales team: a Word file (.docx) with {placeholders}, or a document written in
// the online editor. "Create for a customer" fills the placeholders (company name, person, date…), saves the
// result in the system as a file to send (linked to the CRM contact) and opens the send panel.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const storage = require('../../core/storage');
const docx = require('../../core/docx');
const { sanitizeHtml } = require('../../core/sanitize-html');
const { randomToken } = require('../../core/tokens');
const { formatDate } = require('../../core/format');
const { E } = require('../../core/errors');
const sales = require('./sales.service');

const str = (v, n) => String(v ?? '').trim().slice(0, n);
const parse = (v, d) => { if (!v) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const PH = () => new RegExp(docx.PLACEHOLDER.source, 'gu');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Placeholders filled automatically (English and Arabic names work). */
const KNOWN = {
  company_name: 'company', 'اسم_الشركة': 'company', company: 'company', 'الشركة': 'company',
  customer_name: 'name', 'اسم_العميل': 'name', name: 'name', 'الاسم': 'name',
  customer_email: 'email', email: 'email', 'البريد': 'email',
  customer_phone: 'phone', phone: 'phone', 'الجوال': 'phone',
  date: 'date', 'التاريخ': 'date',
  seller_name: 'seller', 'اسم_شركتنا': 'seller',
};

/** The fields offered as buttons in the editor (the other names above are aliases). */
const MAIN_FIELDS = ['company_name', 'customer_name', 'customer_email', 'customer_phone', 'date', 'seller_name'];

const fieldsFromHtml = (html) => [...new Set([...String(html || '').matchAll(PH())].map((m) => m[1]))];

async function list() {
  const rows = await knex('document_templates as t').leftJoin('sales_files as f', 'f.template_id', 't.id')
    .groupBy('t.id').select('t.*').count({ uses: 'f.id' }).orderBy('t.active', 'desc').orderBy('t.id', 'desc');
  return rows.map((r) => ({ ...r, fields: parse(r.fields, []), uses: Number(r.uses) }));
}
async function get(id) {
  const t = await knex('document_templates').where({ id: Number(id) }).first();
  if (!t) throw E.notFound('Template');
  return { ...t, fields: parse(t.fields, []) };
}

async function createDocx(ctx, file, body) {
  if (!file || !file.buffer || !file.buffer.length) throw E.validation({ file: 'Choose a file.' });
  const fields = String(file.originalname || '').toLowerCase().endsWith('.docx') ? docx.placeholders(file.buffer) : null;
  if (!fields) throw E.validation({ file: 'Upload a Word document (.docx). Older .doc files: open them in Word and “Save as” .docx.' });
  const name = str(body.name, 150) || str(String(file.originalname).replace(/\.docx$/i, ''), 150);
  const key = `platform/templates/${randomToken(18).replace(/[^a-z0-9]/gi, '')}`;
  await storage.put(key, file.buffer);
  const [id] = await knex('document_templates').insert({ name, kind: 'docx', storage_key: key, filename: str(file.originalname, 200), fields: JSON.stringify(fields), created_by: ctx.userId });
  await audit.record(ctx, 'platform.template_saved', { entityType: 'document_template', entityId: id, newValues: { name, kind: 'docx', fields } });
  return id;
}

async function replaceDocx(ctx, id, file) {
  const t = await get(id);
  if (t.kind !== 'docx') throw E.notFound('Template');
  const fields = file && file.buffer && String(file.originalname || '').toLowerCase().endsWith('.docx') ? docx.placeholders(file.buffer) : null;
  if (!fields) throw E.validation({ file: 'Upload a Word document (.docx). Older .doc files: open them in Word and “Save as” .docx.' });
  await storage.put(t.storage_key, file.buffer);
  await knex('document_templates').where({ id: t.id }).update({ filename: str(file.originalname, 200), fields: JSON.stringify(fields), updated_at: new Date() });
}

/** A document written in the online editor. */
async function saveHtml(ctx, id, body) {
  const name = str(body.name, 150);
  const html = sanitizeHtml(body.body_html);
  const errors = {};
  if (!name) errors.name = 'Enter a name.';
  if (!html.replace(/<[^>]+>/g, '').trim()) errors.body_html = 'Write the document.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const v = { name, body_html: html, fields: JSON.stringify(fieldsFromHtml(html)), active: body.active !== '0' };
  if (id) {
    const t = await get(id);
    if (t.kind !== 'html') throw E.notFound('Template');
    await knex('document_templates').where({ id: t.id }).update({ ...v, updated_at: new Date() });
  } else [id] = await knex('document_templates').insert({ ...v, kind: 'html', created_by: ctx.userId }); // eslint-disable-line no-param-reassign
  await audit.record(ctx, 'platform.template_saved', { entityType: 'document_template', entityId: Number(id), newValues: { name, kind: 'html' } });
  return Number(id);
}

async function rename(ctx, id, body) {
  const t = await get(id);
  const name = str(body.name, 150);
  if (!name) throw E.validation({ name: 'Enter a name.' });
  await knex('document_templates').where({ id: t.id }).update({ name, active: body.active !== '0', updated_at: new Date() });
}

/** Templates keep the documents already made from them (those are files of their own). */
async function remove(ctx, id) {
  const t = await get(id);
  await knex('document_templates').where({ id: t.id }).del();
  if (t.storage_key) await storage.remove(t.storage_key).catch(() => {});
  await audit.record(ctx, 'platform.template_deleted', { entityType: 'document_template', entityId: t.id, oldValues: { name: t.name } });
}

/** Suggested values for a customer: CRM contact, today's date, our company name. */
async function suggestions(t, contact, locale = 'ar') {
  const p = await sales.profile();
  const src = {
    company: contact ? contact.company_name || contact.name : '', name: contact ? contact.name : '', email: contact ? contact.email || '' : '',
    phone: contact && contact.phone ? `+${contact.phone}` : '', date: formatDate(new Date(), locale, { dateStyle: 'long' }), seller: sales.sellerName(p, locale),
  };
  return Object.fromEntries(t.fields.map((f) => [f, KNOWN[f] ? src[KNOWN[f]] : '']));
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Fills the template for one customer and saves the result as a file to send. */
async function generate(ctx, id, body) {
  const t = await get(id);
  const names = [].concat(body.field_name === undefined ? [] : body.field_name);
  const vals = [].concat(body.field_value === undefined ? [] : body.field_value);
  const values = {};
  names.forEach((n, i) => { if (t.fields.includes(n)) values[n] = str(vals[i], 2000); });
  const contact = Number(body.contact_id) ? await knex('crm_contacts').where({ id: Number(body.contact_id) }).first() : null;
  const title = str(body.title, 150) || `${t.name}${contact ? ` — ${contact.company_name || contact.name}` : ''}`.slice(0, 150);
  const safe = title.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 120) || 'document';
  const row = { title, description: null, token: randomToken(24), created_by: ctx.userId, template_id: t.id, contact_id: contact ? contact.id : null, values_json: JSON.stringify(values) };
  if (t.kind === 'docx') {
    const buf = docx.fill(await storage.read(t.storage_key), values);
    const key = `platform/sales-files/${randomToken(18).replace(/[^a-z0-9]/gi, '')}`;
    await storage.put(key, buf);
    Object.assign(row, { storage_key: key, filename: `${safe}.docx`, mime: DOCX_MIME, size: buf.length });
  } else {
    const html = sanitizeHtml(t.body_html.replace(PH(), (m, k) => (values[k] !== undefined ? escapeHtml(values[k]) : m)));
    Object.assign(row, { storage_key: null, body_html: html, filename: `${safe}.html`, mime: 'text/html', size: Buffer.byteLength(html) });
  }
  const [fid] = await knex('sales_files').insert(row);
  await audit.record(ctx, 'platform.document_generated', { entityType: 'sales_file', entityId: fid, newValues: { template: t.name, contact: contact ? contact.name : null } });
  return { fileId: fid, contactId: contact ? contact.id : null };
}

/** A document made in the editor can still be changed before sending. */
async function updateDocumentBody(ctx, fileId, body) {
  const f = await sales.getFile(fileId);
  if (!f.body_html) throw E.notFound('Document');
  const html = sanitizeHtml(body.body_html);
  if (!html.replace(/<[^>]+>/g, '').trim()) throw E.validation({ body_html: 'Write the document.' });
  await knex('sales_files').where({ id: f.id }).update({ body_html: html, size: Buffer.byteLength(html), title: str(body.title, 150) || f.title, updated_at: new Date() });
}

module.exports = { MAIN_FIELDS, KNOWN, list, get, createDocx, replaceDocx, saveHtml, rename, remove, suggestions, generate, updateDocumentBody, DOCX_MIME };
