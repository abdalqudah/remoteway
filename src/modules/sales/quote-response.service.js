// The customer's answer to a quotation, from their link: accept with name, drawn signature and company stamp
// (or by uploading the quotation already signed and stamped), decline with a reason, or ask to negotiate the
// amount. The team replies and sends a revised quotation on the same link. Everything is kept on the quotation,
// written to the CRM timeline and emailed to the team (and a signed copy to the customer).
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const storage = require('../../core/storage');
const mailer = require('../../core/mailer');
const config = require('../../config');
const { randomToken } = require('../../core/tokens');
const { formatMoney } = require('../../core/format');
const { E } = require('../../core/errors');
const sales = require('./sales.service');

const DECLINE_REASONS = ['price', 'timing', 'other_provider', 'not_needed', 'other'];
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE = { png: (b) => b.slice(0, 8).equals(PNG), jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff };
const crm = () => require('../crm/crm.service'); // eslint-disable-line global-require

async function openQuote(token) {
  const q = await sales.quoteByToken(token, { count: false });
  const state = sales.quoteState(q);
  if (['accepted', 'declined'].includes(state)) throw E.conflict('QUOTE_ANSWERED', 'This quotation was already answered.');
  if (state === 'expired') throw E.conflict('QUOTE_EXPIRED', 'This quotation has expired. Please ask us for an updated one.');
  return q;
}

/** The team: whoever made the quotation, plus the sales email in the company details. */
async function teamRecipients(q) {
  const out = [];
  const owner = q.created_by ? await knex('users').where({ id: q.created_by }).first('email', 'locale') : null;
  if (owner) out.push(owner);
  const p = await sales.profile();
  if (p.email && !out.some((x) => x.email.toLowerCase() === p.email.toLowerCase())) out.push({ email: p.email, locale: 'ar' });
  return out;
}
async function tellTeam(q, { ar, en, body }) {
  for (const r of await teamRecipients(q)) {
    const title = r.locale === 'ar' ? `${q.number}: ${ar}` : `${q.number}: ${en}`;
    await mailer.send({ kind: 'quote_answer', to: r.email, subject: title, html: mailer.layout({ locale: r.locale, title, body: `${q.customer_name}${q.customer_company ? ` · ${q.customer_company}` : ''}\n${body || ''}`, cta: r.locale === 'ar' ? 'فتح العرض' : 'Open quotation', href: `${config.appUrl}/admin/quotes/${q.id}` }) }).catch(() => {});
  }
}
const event = (q, e) => knex('quote_events').insert({ quote_id: q.id, revision: q.revision, ...e });

/** A drawn signature arrives as a PNG data URL from the canvas. */
function readSignature(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (!IMAGE.png(buf) || buf.length > 400 * 1024) return null;
  return buf;
}
function readImage(file) {
  if (!file || !file.buffer || !file.buffer.length) return null;
  const ext = IMAGE.png(file.buffer) ? 'png' : IMAGE.jpg(file.buffer) ? 'jpg' : null;
  return ext ? { buf: file.buffer, ext } : null;
}
function readSignedFile(file) {
  if (!file || !file.buffer || !file.buffer.length) return null;
  const b = file.buffer;
  if (b.slice(0, 4).toString('latin1') === '%PDF') return { buf: b, mime: 'application/pdf', ext: 'pdf' };
  const img = readImage(file);
  return img ? { buf: b, mime: img.ext === 'png' ? 'image/png' : 'image/jpeg', ext: img.ext } : null;
}
async function store(q, buf, name) {
  const key = `platform/quotes/${q.id}/${name}-${randomToken(12).replace(/[^a-z0-9]/gi, '')}`;
  await storage.put(key, buf);
  return key;
}

/**
 * Accept: name is required, and either a drawn signature with the company stamp, or the quotation uploaded
 * already signed and stamped.
 */
async function accept(token, body, files = {}, { ip, base } = {}) {
  const q = await openQuote(token);
  const name = str(body.name, 150);
  const signature = readSignature(body.signature);
  const stamp = readImage(files.stamp);
  const signed = readSignedFile(files.signed_file);
  const errors = {};
  if (!name) errors.name = 'Enter your name to accept.';
  if (files.stamp && !stamp) errors.stamp = 'The stamp must be a PNG or JPG image.';
  if (files.signed_file && !signed) errors.signed_file = 'Upload the signed quotation as a PDF or an image.';
  if (!signed && !errors.stamp && !errors.signed_file) {
    if (!signature) errors.signature = 'Sign in the box (or upload the quotation already signed and stamped).';
    if (!stamp) errors.stamp = 'Add the company stamp (or upload the quotation already signed and stamped).';
  }
  if (Object.keys(errors).length) throw E.validation(errors);
  const v = { status: 'accepted', responded_at: new Date(), response_name: name, signer_title: str(body.title, 120) || null, response_note: str(body.note, 500) || null, response_ip: ip ? String(ip).slice(0, 64) : null, updated_at: new Date() };
  if (signature) v.signature_key = await store(q, signature, 'signature');
  if (stamp) v.stamp_key = await store(q, stamp.buf, `stamp-${stamp.ext}`);
  if (signed) Object.assign(v, { signed_file_key: await store(q, signed.buf, `signed-${signed.ext}`), signed_file_mime: signed.mime, signed_file_name: `${q.number}-signed.${signed.ext}` });
  await knex('quotes').where({ id: q.id }).update(v);
  await event(q, { type: 'accepted', by: 'customer', name, amount: q.total, message: v.response_note });
  if (q.contact_id) await crm().addActivity(q.contact_id, { type: 'quote_accepted', direction: 'in', channel: 'platform', subject: q.number, body: [name, v.signer_title, v.response_note].filter(Boolean).join(' · '), status: 'received', meta: { quote_id: q.id } });
  await audit.record({ userId: null }, 'platform.quote_accepted', { entityType: 'quote', entityId: q.id, newValues: { by: name, signed: Boolean(signature), stamp: Boolean(stamp), file: Boolean(signed) } });
  await tellTeam(q, { ar: 'وافق العميل ووقّع عرض السعر', en: 'accepted and signed by the customer', body: [name, v.signer_title, formatMoney(q.total, q.currency, 'en'), v.response_note].filter(Boolean).join('\n') });
  if (q.customer_email) await sendSignedCopy(q, q.customer_email, base).catch(() => {});
  return 'accepted';
}

async function decline(token, body) {
  const q = await openQuote(token);
  const reason = DECLINE_REASONS.includes(body.reason) ? body.reason : null;
  const note = str(body.note, 500);
  if (!reason) throw E.validation({ reason: 'Choose the reason.' });
  if (reason === 'other' && !note) throw E.validation({ note: 'Tell us the reason.' });
  await knex('quotes').where({ id: q.id }).update({ status: 'declined', responded_at: new Date(), response_name: str(body.name, 150) || null, decline_reason: reason, response_note: note || null, updated_at: new Date() });
  await event(q, { type: 'declined', by: 'customer', name: str(body.name, 150) || null, message: [reason, note].filter(Boolean).join(': ') });
  if (q.contact_id) await crm().addActivity(q.contact_id, { type: 'quote_declined', direction: 'in', channel: 'platform', subject: q.number, body: [reason, note].filter(Boolean).join(' · '), status: 'received', meta: { quote_id: q.id, reason } });
  await audit.record({ userId: null }, 'platform.quote_declined', { entityType: 'quote', entityId: q.id, newValues: { reason } });
  await tellTeam(q, { ar: 'رفض العميل عرض السعر', en: 'declined by the customer', body: `${reason}${note ? `\n${note}` : ''}` });
  return 'declined';
}

/** The customer asks for a better price (optional amount) with a message; the team answers on the quotation. */
async function negotiate(token, body) {
  const q = await openQuote(token);
  const message = str(body.message, 2000);
  const raw = String(body.amount || '').replace(/[,\s]/g, '').replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));
  const amount = raw ? Number(raw) : null;
  const errors = {};
  if (!message) errors.message = 'Write your message.';
  if (raw && (!Number.isFinite(amount) || amount <= 0)) errors.amount = 'Enter the amount you propose, or leave it empty.';
  if (Object.keys(errors).length) throw E.validation(errors);
  await knex('quotes').where({ id: q.id }).update({ status: 'negotiating', updated_at: new Date() });
  await event(q, { type: 'negotiation', by: 'customer', name: str(body.name, 150) || q.customer_name, amount, message });
  if (q.contact_id) await crm().addActivity(q.contact_id, { type: 'quote_negotiation', direction: 'in', channel: 'platform', subject: q.number, body: `${amount ? `${formatMoney(amount, q.currency, 'en')} · ` : ''}${message}`, status: 'received', meta: { quote_id: q.id } });
  await tellTeam(q, { ar: 'العميل يطلب التفاوض على السعر', en: 'the customer wants to negotiate', body: `${amount ? `${formatMoney(amount, q.currency, 'en')}\n` : ''}${message}` });
}

/** The team's answer, shown on the customer's page and emailed to them when they have an email address. */
async function teamReply(ctx, id, body) {
  const q = await sales.getQuote(id);
  const message = str(body.message, 2000);
  if (!message) throw E.validation({ message: 'Write your message.' });
  await event(q, { type: 'reply', by: 'team', user_id: ctx.userId, message });
  const link = `${String(body.base || config.appUrl).replace(/\/+$/, '')}/quote/${q.token}`;
  if (q.customer_email && body.email !== '0') {
    const ar = q.locale !== 'en';
    const title = ar ? `رد بخصوص عرض السعر ${q.number}` : `About your quotation ${q.number}`;
    await mailer.send({ kind: 'quote', to: q.customer_email, subject: title, html: mailer.layout({ locale: q.locale, title, body: message, cta: ar ? 'عرض السعر' : 'View quotation', href: link }) }).catch(() => {});
  }
  if (q.contact_id) await crm().addActivity(q.contact_id, { type: 'note', direction: 'out', channel: 'platform', subject: q.number, body: message, userId: ctx.userId, meta: { quote_id: q.id } });
}

/** Called after the team edits a quotation the customer was negotiating: a new revision on the same link. */
async function markRevised(ctx, q) {
  if (q.status !== 'negotiating') return;
  await knex('quotes').where({ id: q.id }).update({ status: 'sent', revision: (q.revision || 1) + 1, updated_at: new Date() });
  const fresh = await knex('quotes').where({ id: q.id }).first();
  await event(fresh, { type: 'revised', by: 'team', user_id: ctx.userId, amount: fresh.total });
}

const events = (quoteId) => knex('quote_events as e').leftJoin('users as u', 'u.id', 'e.user_id').where('e.quote_id', quoteId).select('e.*', 'u.name as user_name').orderBy('e.id');

/** The signed copy: the customer's link (printable with the signature and stamp). */
async function sendSignedCopy(q, to, base) {
  const ar = q.locale !== 'en';
  const title = ar ? `نسختك الموقعة من عرض السعر ${q.number}` : `Your signed quotation ${q.number}`;
  const body = ar ? 'شكرًا لموافقتك. يمكنك عرض النسخة الموقعة والمختومة وطباعتها أو حفظها PDF في أي وقت من الرابط أدناه.' : 'Thank you for accepting. You can view, print or save the signed and stamped copy as PDF at any time from the link below.';
  return mailer.send({ kind: 'quote', to, subject: title, html: mailer.layout({ locale: q.locale, title, body, cta: ar ? 'النسخة الموقعة' : 'Signed copy', href: `${String(base || config.appUrl).replace(/\/+$/, '')}/quote/${q.token}` }) });
}

/** The customer asks for a copy of the signed quotation by email (from the accepted page). */
async function emailCopy(token, email, base) {
  const q = await sales.quoteByToken(token, { count: false });
  if (q.status !== 'accepted') throw E.conflict('QUOTE_NOT_ACCEPTED', 'This quotation is not accepted yet.');
  const to = str(email, 190).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw E.validation({ email: 'Enter a valid email address.' });
  const [{ n }] = await knex('email_log').where({ to_addr: to, kind: 'quote' }).where('created_at', '>=', new Date(Date.now() - 3600_000)).count({ n: '*' });
  if (Number(n) >= 3) throw E.conflict('TOO_MANY_ATTEMPTS', 'We already sent several copies. Please try again later.');
  await sendSignedCopy(q, to, base);
}

module.exports = { DECLINE_REASONS, accept, decline, negotiate, teamReply, markRevised, events, emailCopy };
