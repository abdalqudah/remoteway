// Settings → Your database: a copy of the company's data in its own MySQL/PostgreSQL database.
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const ent = require('../billing/entitlements.service');
const sync = require('./datasync.service');
const { dictionaries } = require('../../core/i18n');

// Connection problems are written in English; show the Arabic text when there is one, else the original.
const tm = (req) => (m) => (!m || req.locale === 'en' ? m : ((dictionaries[req.locale] && dictionaries[req.locale].vmsg) || {})[m] || m);

const router = express.Router();
router.use((req, res, next) => { res.locals.section = 'database'; next(); });

const render = async (req, res, extra = {}) => {
  const orgId = req.ctx.organizationId;
  const [cfg, allowed, hasPlan, runs] = await Promise.all([sync.get(orgId), sync.available(req.ctx), ent.hasFeature(orgId, 'white_label'), sync.runs(orgId)]);
  res.page('pages/settings/database', { title: req.t('datasync.title'), cfg, allowed, hasPlan, runs, DATASETS: sync.DATASETS, DRIVERS: sync.DRIVERS, FREQUENCIES: Object.keys(sync.FREQUENCIES), tm: tm(req), ...extra });
};
router.get('/', can('organization.manage'), wrap((req, res) => render(req, res)));
router.post('/', can('organization.manage'), form(async (req, res) => {
  await sync.save(req.ctx, req.body);
  // Check the connection straight away so mistakes show up now, not at the first scheduled copy.
  const t = await sync.test(req.ctx);
  flash(req, t.ok ? 'success' : 'error', t.ok ? req.t('datasync.saved_ok') : `${req.t('datasync.saved_fail')} ${tm(req)(t.error)}`);
  res.redirect('/app/settings/database');
}, render));
router.post('/test', can('organization.manage'), wrap(async (req, res) => {
  const t = await sync.test(req.ctx);
  flash(req, t.ok ? 'success' : 'error', t.ok ? req.t('datasync.test_ok') : `${req.t('datasync.test_fail')} ${tm(req)(t.error)}`);
  res.redirect('/app/settings/database');
}));
router.post('/run', can('organization.manage'), wrap(async (req, res) => {
  try {
    await ent.assertFeature(req.ctx.organizationId, 'white_label');
    const r = await sync.run(req.ctx.organizationId, { trigger: 'manual', userId: req.ctx.userId });
    const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
    flash(req, r.ok ? 'success' : 'error', r.ok ? req.t('datasync.run_ok', { n: total }) : `${req.t('datasync.run_fail')} ${tm(req)(r.error)}`);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    const tr = req.t(`errors.${e.code}`);
    flash(req, 'error', tr !== `errors.${e.code}` ? tr : e.message);
  }
  res.redirect('/app/settings/database');
}));
router.post('/remove', can('organization.manage'), wrap(async (req, res) => {
  await sync.remove(req.ctx);
  flash(req, 'success', req.t('datasync.removed'));
  res.redirect('/app/settings/database');
}));

module.exports = router;
