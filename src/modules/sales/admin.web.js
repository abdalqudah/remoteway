// Super Admin → Quotations, Files to send, and sending invoices: create a quotation, send it (or a file,
// or an invoice) by email or open WhatsApp with the text and link ready.
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { singleFile } = require('../../middleware/upload');
const { E, AppError } = require('../../core/errors');
const { translateMessage } = require('../../core/i18n');
const access = require('../admin/access');
const knex = require('../../db/knex');
const storage = require('../../core/storage');
const sales = require('./sales.service');

const router = express.Router();
const STATES = ['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired'];
const sendLang = (req) => (['ar', 'en'].includes(req.query.send_lang) ? req.query.send_lang : undefined);

/** The send panel's data: recipient defaults, ready texts, WhatsApp link, history. */
async function panel(req, res, type, id, extra = {}) {
  const contactId = Number(req.query.contact || (req.body && req.body.contact_id)) || undefined;
  const doc = await sales.sendable(type, id, res.locals.baseUrl, { locale: sendLang(req), contactId });
  const d = await sales.drafts(doc);
  return { doc, drafts: d, waLink: doc.phone ? sales.whatsappLink(doc.phone, d.whatsapp) : null, sends: await sales.sendsFor(type, doc.id), ...extra };
}

/** Errors from a send are shown on the page they came from. */
const sendAct = (type, back) => wrap(async (req, res) => {
  try {
    await sales.sendEmail(req.ctx, type, req.params.id, req.body, res.locals.baseUrl);
    flash(req, 'success', req.t('sales.email_sent', { email: String(req.body.to || '') }));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    const msg = e.details && !e.details.reason ? Object.values(e.details).map((m) => translateMessage(req.locale, m)).join(' ') : `${req.t('sales.email_failed')} ${e.details && e.details.reason ? e.details.reason : translateMessage(req.locale, e.message)}`;
    flash(req, 'error', msg);
  }
  const url = back(req);
  res.redirect(`${url}${req.body.locale ? `${url.includes('?') ? '&' : '?'}send_lang=${req.body.locale === 'en' ? 'en' : 'ar'}` : ''}#send`);
});

/**
 * Logs the WhatsApp send and opens WhatsApp with the text ready (in the new tab the form targets). The
 * browser policy only lets forms post to RemoteWay, so the hand-off is a page that moves on, not a redirect.
 */
const waAct = (type, back) => wrap(async (req, res) => {
  let url;
  try {
    url = await sales.logWhatsApp(req.ctx, type, req.params.id, req.body, res.locals.baseUrl);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    flash(req, 'error', e.details ? Object.values(e.details).map((m) => translateMessage(req.locale, m)).join(' ') : translateMessage(req.locale, e.message));
    return res.redirect(`${back(req)}#send`);
  }
  res.set('Refresh', `0; url=${url}`);
  res.set('Cache-Control', 'no-store');
  return res.page('pages/admin/sales/whatsapp-redirect', { layout: 'auth', title: 'WhatsApp', url });
});

// ---------- Seller details ----------
const canSettings = (req) => ['owner', 'admin'].includes(access.roleOf(req.user));
const renderSettings = async (req, res, extra = {}) => {
  if (!canSettings(req)) throw E.forbidden('platform.quotes');
  res.page('pages/admin/sales/settings', { layout: 'admin', title: req.t('sales.settings_title'), p: await sales.profile(), ...extra });
};
router.get('/quotes/settings', wrap(renderSettings));
router.post('/quotes/settings', form(async (req, res) => {
  if (!canSettings(req)) throw E.forbidden('platform.quotes');
  await sales.saveProfile(req.ctx, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/admin/quotes/settings');
}, renderSettings));

// ---------- Quotations ----------
router.get('/quotes', wrap(async (req, res) => {
  const all = await sales.listQuotes();
  const state = STATES.includes(req.query.state) ? req.query.state : '';
  res.page('pages/admin/sales/quotes', { layout: 'admin', title: req.t('admin.quotes'), rows: state ? all.filter((q) => q.state === state) : all, state, STATES, summary: sales.quoteSummary(all), profile: await sales.profile() });
}));

const renderForm = async (req, res, extra = {}) => {
  const p = await sales.profile();
  let q = extra.q || null;
  if (!q && req.params.id) q = await sales.getQuote(req.params.id);
  let contact = null;
  const cid = Number(req.query.contact) || (q && q.contact_id);
  if (cid) contact = await knex('crm_contacts').where({ id: cid }).first();
  res.page('pages/admin/sales/quote-form', { layout: 'admin', title: q ? `${req.t('sales.edit_quote')} ${q.number}` : req.t('sales.new_quote'), q, contact, p, ...extra });
};
router.get('/quotes/new', wrap(renderForm));
router.post('/quotes', form(async (req, res) => {
  const id = await sales.createQuote(req.ctx, req.body);
  flash(req, 'success', req.t('sales.quote_saved'));
  res.redirect(`/admin/quotes/${id}`);
}, renderForm));

router.get('/quotes/:id', wrap(async (req, res) => {
  const q = await sales.getQuote(req.params.id);
  res.page('pages/admin/sales/quote', { layout: 'admin', title: q.number, q, state: sales.quoteState(q), p: await sales.profile(), ...(await panel(req, res, 'quote', q.id)) });
}));
router.get('/quotes/:id/edit', wrap(renderForm));
router.post('/quotes/:id', form(async (req, res) => {
  await sales.updateQuote(req.ctx, req.params.id, req.body);
  flash(req, 'success', req.t('sales.quote_saved'));
  res.redirect(`/admin/quotes/${Number(req.params.id)}`);
}, renderForm));
router.post('/quotes/:id/duplicate', wrap(async (req, res) => {
  const id = await sales.duplicateQuote(req.ctx, req.params.id);
  flash(req, 'success', req.t('sales.quote_duplicated'));
  res.redirect(`/admin/quotes/${id}/edit`);
}));
router.post('/quotes/:id/delete', wrap(async (req, res) => {
  try {
    await sales.removeQuote(req.ctx, req.params.id);
    flash(req, 'success', req.t('sales.quote_deleted'));
    return res.redirect('/admin/quotes');
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    flash(req, 'error', translateMessage(req.locale, e.message));
    return res.redirect(`/admin/quotes/${Number(req.params.id)}`);
  }
}));
router.post('/quotes/:id/send-email', sendAct('quote', (req) => `/admin/quotes/${Number(req.params.id)}`));
router.post('/quotes/:id/whatsapp', waAct('quote', (req) => `/admin/quotes/${Number(req.params.id)}`));

// ---------- Files to send ----------
const renderFiles = async (req, res, extra = {}) => {
  res.page('pages/admin/sales/files', { layout: 'admin', title: req.t('admin.files'), files: await sales.listFiles(), ...extra });
};
router.get('/files', wrap(renderFiles));
router.post('/files', singleFile('file'), form(async (req, res) => {
  const id = await sales.uploadFile(req.ctx, req.file, req.body);
  flash(req, 'success', req.t('sales.file_added'));
  res.redirect(`/admin/files/${id}`);
}, renderFiles));
router.get('/files/:id', wrap(async (req, res) => {
  const f = await sales.getFile(req.params.id);
  const contact = req.query.contact ? await knex('crm_contacts').where({ id: Number(req.query.contact) }).first() : null;
  res.page('pages/admin/sales/file', { layout: 'admin', title: f.title, f, contact, ...(await panel(req, res, 'file', f.id)) });
}));
router.get('/files/:id/download', wrap(async (req, res) => {
  const f = await sales.getFile(req.params.id);
  res.set('Content-Type', f.mime);
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  storage.createReadStream(f.storage_key).on('error', () => res.status(404).end()).pipe(res);
}));
router.post('/files/:id', wrap(async (req, res) => {
  try {
    await sales.updateFile(req.ctx, req.params.id, req.body);
    flash(req, 'success', req.t('common.saved'));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    flash(req, 'error', e.details ? Object.values(e.details).map((m) => translateMessage(req.locale, m)).join(' ') : translateMessage(req.locale, e.message));
  }
  res.redirect(`/admin/files/${Number(req.params.id)}`);
}));
router.post('/files/:id/delete', wrap(async (req, res) => {
  await sales.removeFile(req.ctx, req.params.id);
  flash(req, 'success', req.t('sales.file_deleted'));
  res.redirect('/admin/files');
}));
const fileBack = (req) => `/admin/files/${Number(req.params.id)}${req.body.contact_id ? `?contact=${Number(req.body.contact_id)}` : ''}`;
router.post('/files/:id/send-email', sendAct('file', fileBack));
router.post('/files/:id/whatsapp', waAct('file', fileBack));

// ---------- Invoices: send to the company ----------
router.get('/invoices/:id/send', wrap(async (req, res) => {
  const p = await panel(req, res, 'invoice', req.params.id);
  res.page('pages/admin/sales/invoice-send', { layout: 'admin', title: p.doc.label, ...p });
}));
router.post('/invoices/:id/send-email', sendAct('invoice', (req) => `/admin/invoices/${Number(req.params.id)}/send`));
router.post('/invoices/:id/whatsapp', waAct('invoice', (req) => `/admin/invoices/${Number(req.params.id)}/send`));

module.exports = router;
