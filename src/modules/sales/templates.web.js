// Super Admin → Document templates: Word templates and documents written online, filled for a customer
// and saved as files to send.
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { singleFile } = require('../../middleware/upload');
const { AppError } = require('../../core/errors');
const { translateMessage } = require('../../core/i18n');
const knex = require('../../db/knex');
const storage = require('../../core/storage');
const templates = require('./templates.service');

const router = express.Router();
const contactsFor = () => knex('crm_contacts').orderBy('updated_at', 'desc').limit(300).select('id', 'name', 'company_name');
const errMsg = (req, e) => (e.details ? Object.values(e.details).map((m) => translateMessage(req.locale, m)).join(' ') : translateMessage(req.locale, e.message));

const renderList = async (req, res, extra = {}) => {
  res.page('pages/admin/sales/templates', { layout: 'admin', title: req.t('tpl.title'), list: await templates.list(), known: Object.keys(templates.KNOWN), ...extra });
};
router.get('/', wrap(renderList));
router.post('/', singleFile('file'), form(async (req, res) => {
  const id = await templates.createDocx(req.ctx, req.file, req.body);
  flash(req, 'success', req.t('tpl.saved'));
  res.redirect(`/admin/templates/${id}`);
}, renderList));

const renderEditor = async (req, res, extra = {}) => {
  const t = req.params.id ? await templates.get(req.params.id) : null;
  res.page('pages/admin/sales/template-editor', { layout: 'admin', title: t ? t.name : req.t('tpl.new_online'), tp: t, known: templates.MAIN_FIELDS, ...extra });
};
router.get('/new', wrap(renderEditor));
router.post('/html', form(async (req, res) => {
  const id = await templates.saveHtml(req.ctx, null, req.body);
  flash(req, 'success', req.t('tpl.saved'));
  res.redirect(`/admin/templates/${id}`);
}, renderEditor));

const renderTemplate = async (req, res, extra = {}) => {
  const t = await templates.get(req.params.id);
  const contact = req.query.contact ? await knex('crm_contacts').where({ id: Number(req.query.contact) }).first() : null;
  res.page('pages/admin/sales/template', {
    layout: 'admin', title: t.name, tp: t, contact, contacts: await contactsFor(), values: await templates.suggestions(t, contact, req.query.lang === 'en' ? 'en' : 'ar'),
    made: await knex('sales_files as f').leftJoin('crm_contacts as c', 'c.id', 'f.contact_id').where('f.template_id', t.id).orderBy('f.id', 'desc').limit(20).select('f.id', 'f.title', 'f.created_at', 'c.name as contact_name'),
    ...extra,
  });
};
router.get('/:id', wrap(renderTemplate));
router.get('/:id/edit', wrap(renderEditor));
router.post('/:id', form(async (req, res) => {
  const t = await templates.get(req.params.id);
  if (t.kind === 'html' && req.body.body_html !== undefined) await templates.saveHtml(req.ctx, t.id, req.body);
  else await templates.rename(req.ctx, t.id, req.body);
  flash(req, 'success', req.t('tpl.saved'));
  res.redirect(`/admin/templates/${t.id}`);
}, async (req, res, extra) => ((await templates.get(req.params.id)).kind === 'html' ? renderEditor(req, res, extra) : renderTemplate(req, res, extra))));
router.post('/:id/file', singleFile('file'), wrap(async (req, res) => {
  try {
    await templates.replaceDocx(req.ctx, req.params.id, req.file);
    flash(req, 'success', req.t('tpl.saved'));
  } catch (e) { if (!(e instanceof AppError)) throw e; flash(req, 'error', errMsg(req, e)); }
  res.redirect(`/admin/templates/${Number(req.params.id)}`);
}));
router.get('/:id/download', wrap(async (req, res) => {
  const t = await templates.get(req.params.id);
  if (t.kind !== 'docx') return res.redirect(`/admin/templates/${t.id}`);
  res.set('Content-Type', templates.DOCX_MIME);
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(t.filename || `${t.name}.docx`)}`);
  return storage.createReadStream(t.storage_key).on('error', () => res.status(404).end()).pipe(res);
}));
router.post('/:id/delete', wrap(async (req, res) => {
  await templates.remove(req.ctx, req.params.id);
  flash(req, 'success', req.t('tpl.deleted'));
  res.redirect('/admin/templates');
}));
router.post('/:id/generate', form(async (req, res) => {
  const r = await templates.generate(req.ctx, req.params.id, req.body);
  flash(req, 'success', req.t('tpl.generated'));
  res.redirect(`/admin/files/${r.fileId}${r.contactId ? `?contact=${r.contactId}` : ''}#send`);
}, renderTemplate));

module.exports = router;
