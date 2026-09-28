// Compliance (/app/compliance): score, checks with affected employees, upcoming expiries, rules, fixes.
const express = require('express');
const csv = require('../../core/csv');
const charts = require('../../core/charts');
const { wrap, form, flash } = require('../../routes/helpers');
const { can, feature } = require('../../middleware/context');
const fmtCore = require('../../core/format');
const compliance = require('./compliance.service');

const router = express.Router();
router.use(feature('compliance'));
router.use(can('compliance.view'));

/** One human-readable line per affected item (translated here so CSV and page agree). */
function describe(req, it) {
  const p = { ...it.params };
  if (p.category) p.category = req.t(`documents.cat_${p.category}`);
  for (const k of ['date', 'since']) if (p[k]) p[k] = fmtCore.formatDate(p[k], req.locale);
  return req.t(`compliance.reason_${it.reason}`, p);
}

router.get('/', wrap(async (req, res) => {
  const result = await compliance.evaluate(req.ctx);
  if (req.query.format === 'csv') {
    const rows = [];
    for (const ch of result.checks.filter((c) => c.items.length)) {
      for (const it of ch.items) rows.push([req.t(`compliance.check_${ch.key}`), req.t(`compliance.sev_${ch.severity}`), it.name, describe(req, it)]);
    }
    return csv.send(res, `compliance-${result.today}.csv`, [req.t('compliance.check'), req.t('compliance.severity'), req.t('analytics.employee'), req.t('compliance.issue')], rows);
  }
  const [hist, upcoming] = await Promise.all([compliance.history(req.ctx.organizationId), compliance.upcoming(req.ctx)]);
  const loc = req.locale === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB';
  const day = (d) => new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${String(d instanceof Date ? d.toISOString() : d).slice(0, 10)}T00:00:00Z`));
  const trend = hist.length >= 2
    ? charts.line({ points: hist.map((h) => ({ label: day(h.day), short: day(h.day), value: Number(h.score) })), title: req.t('compliance.trend'), fmt: (v) => `${Math.round(v * 10) / 10}%`, yMax: 100, width: 640, height: 200 })
    : null;
  const order = { fail: 0, warn: 1, pass: 2, na: 3, off: 4 };
  const checks = [...result.checks].sort((a, b) => order[a.status] - order[b.status] || (compliance.WEIGHT[b.severity] || 0) - (compliance.WEIGHT[a.severity] || 0))
    .map((ch) => ({ ...ch, lines: ch.items.slice(0, 100).map((it) => ({ ...it, text: describe(req, it) })) }));
  return res.page('pages/compliance/index', { printable: true, title: req.t('compliance.title'), result, checks, trend, upcoming, hist });
}));

const renderSettings = async (req, res, extra = {}) => res.page('pages/compliance/settings', {
  title: req.t('compliance.settings'), s: await compliance.settings(req.ctx.organizationId), CHECKS: compliance.CHECKS, DOC_CATEGORIES: compliance.DOC_CATEGORIES, APPLIES: compliance.APPLIES, ...extra,
});
router.get('/settings', can('compliance.manage'), wrap((req, res) => renderSettings(req, res)));
router.post('/settings', can('compliance.manage'), form(async (req, res) => {
  await compliance.saveSettings(req.ctx, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/compliance');
}, renderSettings));

router.post('/fix/annual-leave', can('compliance.manage'), wrap(async (req, res) => {
  const n = await compliance.fixAnnualLeave(req.ctx, req.body.employee_id);
  flash(req, 'success', req.t('compliance.fixed_leave', { n }));
  res.redirect('/app/compliance#check-annual_leave');
}));

module.exports = router;
