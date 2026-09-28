const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { feature } = require('../../middleware/context');
const { singleFile } = require('../../middleware/upload');
const documents = require('./document.service');
const employees = require('../workforce/employee.service');
const ai = require('../ai/ai.service');

const router = express.Router();
router.use(feature('documents'));

const renderList = async (req, res, extra = {}) => {
  const [rows, people] = await Promise.all([
    documents.list(req.ctx, req.query),
    req.ctx.permissions.has('documents.manage') ? employees.options(req.ctx.organizationId) : [],
  ]);
  res.page('pages/documents/index', { title: req.t('nav.documents'), rows, people, categories: documents.CATEGORIES, ...extra });
};

router.get('/', wrap((req, res) => renderList(req, res)));

router.post('/', ...singleFile('file'), form(async (req, res) => {
  const id = await documents.upload(req.ctx, req.body, req.file);
  flash(req, 'success', req.t('documents.uploaded'));
  res.redirect(req.body.return_to === 'employee' && req.body.employee_id ? `/app/employees/${Number(req.body.employee_id)}?tab=documents` : `/app/documents/${id}`);
}, (req, res, extra) => renderList(req, res, { ...extra, openDialog: 'upload' })));

const renderShow = async (req, res, extra = {}) => {
  const doc = await documents.get(req.ctx, Number(req.params.id));
  const aiDoc = res.locals.aiOn('documents') ? await ai.latestInsight(req.ctx.organizationId, 'document_summary', 'document', doc.id) : null;
  res.page('pages/documents/show', { title: doc.title, doc, categories: documents.CATEGORIES, aiDoc, ...extra });
};

router.get('/:id', wrap((req, res) => renderShow(req, res)));

router.post('/:id', form(async (req, res) => {
  await documents.updateMeta(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/app/documents/${req.params.id}`);
}, renderShow));

router.post('/:id/versions', ...singleFile('file'), form(async (req, res) => {
  await documents.addVersion(req.ctx, Number(req.params.id), req.file);
  flash(req, 'success', req.t('documents.version_added'));
  res.redirect(`/app/documents/${req.params.id}`);
}, renderShow));

router.post('/:id/delete', form(async (req, res) => {
  await documents.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect('/app/documents');
}, renderShow));

// Files are streamed only after the permission check; never exposed as static URLs.
router.get('/:id/download', wrap(async (req, res) => {
  const f = await documents.openFile(req.ctx, Number(req.params.id), req.query.v);
  const inline = req.query.inline === '1' && f.inline;
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Length', f.size);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  f.stream.on('error', () => res.destroy());
  f.stream.pipe(res);
}));

module.exports = router;
