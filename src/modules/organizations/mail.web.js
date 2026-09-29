// Settings → Email (the company's own mailbox).
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const mailer = require('../../core/mailer');
const mail = require('./mail.service');
const { dictionaries } = require('../../core/i18n');

const router = express.Router();
router.use((req, res, next) => { res.locals.section = 'email'; next(); });
const tm = (req, m) => (!m || req.locale === 'en' ? m : ((dictionaries[req.locale] && dictionaries[req.locale].vmsg) || {})[m] || m);

const render = async (req, res, extra = {}) => res.page('pages/settings/email', {
  title: req.t('orgmail.title'), cfg: await mail.get(req.ctx.organizationId), required: await mailer.requireCompanyEmail(),
  PRESETS: mail.PRESETS, tm: (m) => tm(req, m), ...extra,
});
router.get('/', can('organization.manage'), wrap((req, res) => render(req, res)));
router.post('/', can('organization.manage'), form(async (req, res) => {
  const r = await mail.save(req.ctx, req.body, { testTo: req.user.email, locale: req.locale });
  flash(req, r.ok ? 'success' : 'error', r.ok ? req.t('orgmail.connected', { email: req.user.email }) : `${req.t('orgmail.test_failed')} ${tm(req, r.error)}`);
  res.redirect('/app/settings/email');
}, render));
router.post('/remove', can('organization.manage'), wrap(async (req, res) => {
  await mail.remove(req.ctx);
  flash(req, 'success', req.t('orgmail.removed'));
  res.redirect('/app/settings/email');
}));

module.exports = router;
