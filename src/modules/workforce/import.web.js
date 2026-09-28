// Employee CSV import wizard: 1 upload → 2 map columns → 3 preview/validate → 4 import & results.
// The parsed file is kept in the (MySQL-backed) session between steps.
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { singleFile } = require('../../middleware/upload');
const importer = require('./import.service');

const router = express.Router();
router.use(can('employees.create'));

const state = (req) => req.session.employeeImport;

router.get('/template.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="remoteway-employees-template.csv"');
  res.send(`﻿${importer.TEMPLATE}`);
});

const renderUpload = (req, res, extra = {}) => res.page('pages/employees/import', { title: req.t('import.title'), step: 'upload', fields: importer.FIELDS, ...extra });

router.get('/', (req, res) => {
  const s = state(req);
  if (req.query.reset || !s) {
    delete req.session.employeeImport;
    return renderUpload(req, res);
  }
  return res.page('pages/employees/import', {
    title: req.t('import.title'), step: 'map', fields: importer.FIELDS, required: importer.REQUIRED, parsed: s, sample: s.rows.slice(0, 3),
  });
});

router.post('/', ...singleFile('file'), form(async (req, res) => {
  const parsed = importer.parseUpload(req.file);
  req.session.employeeImport = { ...parsed, fileName: req.file.originalname };
  res.redirect('/app/employees/import');
}, renderUpload));

function readMapping(req) {
  const s = state(req);
  const mapping = {};
  for (const f of importer.FIELDS) {
    const v = req.body[`map_${f}`];
    mapping[f] = v === '' || v === undefined ? '' : Math.max(0, Math.min(s.headers.length - 1, Number(v)));
  }
  s.mapping = mapping;
  s.createMissing = req.body.create_missing === 'on';
  return s;
}

router.post('/preview', wrap(async (req, res) => {
  if (!state(req)) return res.redirect('/app/employees/import');
  const s = readMapping(req);
  try {
    const result = await importer.preview(req.ctx, s, { createMissing: s.createMissing });
    return res.page('pages/employees/import', { title: req.t('import.title'), step: 'preview', parsed: s, result, fields: importer.FIELDS });
  } catch (err) {
    if (err.code !== 'VALIDATION_FAILED') throw err;
    return res.status(422).page('pages/employees/import', {
      title: req.t('import.title'), step: 'map', fields: importer.FIELDS, required: importer.REQUIRED, parsed: s, sample: s.rows.slice(0, 3), errors: err.details,
    });
  }
}));

router.post('/run', form(async (req, res) => {
  const s = state(req);
  if (!s?.mapping) return res.redirect('/app/employees/import');
  const result = await importer.run(req.ctx, s, { createMissing: s.createMissing });
  delete req.session.employeeImport;
  return res.page('pages/employees/import', { title: req.t('import.title'), step: 'done', done: result });
}, async (req, res, extra) => {
  const s = state(req);
  const result = await importer.preview(req.ctx, s, { createMissing: s.createMissing });
  res.page('pages/employees/import', { title: req.t('import.title'), step: 'preview', parsed: s, result, fields: importer.FIELDS, ...extra });
}));

module.exports = router;
