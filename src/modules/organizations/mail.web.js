// Settings → Email (the company's own mailbox, any SMTP server).
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { E } = require('../../core/errors');
const mailer = require('../../core/mailer');
const smtp = require('../../core/smtp');
const mail = require('./mail.service');

const router = express.Router();
router.use((req, res, next) => { res.locals.section = 'email'; next(); });
router.use(can('organization.manage')); // mailbox settings and credentials are for company admins only

const render = async (req, res, extra = {}) => res.page('pages/settings/email', {
  title: req.t('orgmail.title'), cfg: await mail.get(req.ctx.organizationId), required: await mailer.requireCompanyEmail(),
  PRESETS: smtp.PRESETS, events: await smtp.recentEvents({ scope: 'company', organizationId: req.ctx.organizationId, limit: 10 }), ...extra,
});
const wantsJson = (req) => String(req.get('accept') || '').includes('application/json');
const recipient = (req) => {
  const to = String(req.body.test_to || req.user.email).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw E.validation({ test_to: 'Enter the email address that should receive the test.' });
  return to;
};

router.get('/', wrap((req, res) => render(req, res)));
// JSON: never the password.
router.get('/settings', wrap(async (req, res) => {
  const cfg = await mail.get(req.ctx.organizationId);
  res.set('Cache-Control', 'no-store').json({ success: true, data: { enabled: Boolean(cfg && cfg.enabled), settings: cfg ? smtp.masked(cfg, { hasPassword: cfg.hasPassword }) : null, presets: smtp.PRESETS } });
}));
router.post('/', form(async (req, res) => {
  const r = await mail.save(req.ctx, req.body, { testTo: recipient(req), locale: req.locale });
  if (r.ok) {
    flash(req, 'success', req.t('orgmail.connected', { email: recipient(req) }));
    if (r.warnings.length) flash(req, 'warning', r.warnings.map((w) => req.t(`smtp.warn_${w}`)).join(' '));
    return res.redirect('/app/settings/email');
  }
  return render(req, res, { old: req.body, testResult: { action: 'email', to: recipient(req), ...r.result, settings: smtp.masked(r.result.settings) }, warnings: r.warnings });
}, render));
router.post('/test-connection', form(async (req, res) => {
  const r = await mail.testConnection(req.ctx, req.body);
  if (wantsJson(req)) return res.json({ success: r.ok, data: { ok: r.ok, ms: r.ms, error: r.error || null, warnings: r.warnings } });
  return render(req, res, { old: req.body, testResult: { action: 'connection', ...r, settings: smtp.masked(r.settings) }, warnings: r.warnings });
}, render));
router.post('/test', form(async (req, res) => {
  const to = recipient(req);
  const r = await mail.testEmail(req.ctx, req.body, to, { locale: req.locale });
  if (wantsJson(req)) return res.json({ success: r.ok, data: { ok: r.ok, stage: r.stage, to, error: r.error || null, warnings: r.warnings } });
  return render(req, res, { old: req.body, testResult: { action: 'email', to, ...r, settings: smtp.masked(r.settings) }, warnings: r.warnings });
}, render));
router.post('/remove', wrap(async (req, res) => {
  await mail.remove(req.ctx);
  flash(req, 'success', req.t('orgmail.removed'));
  res.redirect('/app/settings/email');
}));

module.exports = router;
