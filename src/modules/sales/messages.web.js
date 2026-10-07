// Super Admin → Message texts: the wording of account emails and of the texts used to send quotes,
// invoices and files (email and WhatsApp), in Arabic and English.
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { E } = require('../../core/errors');
const messages = require('../../core/messages');
const mailer = require('../../core/mailer');
const audit = require('../../core/audit');
const config = require('../../config');

const router = express.Router();

/** The email as it will look (body of the email document), with sample values. */
async function preview(key, locale) {
  const def = messages.DEFS.find((d) => d.key === key);
  const m = await messages.compose(key, locale, messages.sample(key, locale));
  if (def.kind !== 'email') return { kind: 'text', text: m.text };
  const html = mailer.layout({ locale, title: m.title, body: m.body, cta: m.cta, href: config.appUrl });
  return { kind: 'email', subject: m.subject, html: (html.match(/<body[^>]*>([\s\S]*)<\/body>/) || [null, html])[1] };
}

router.get('/', wrap(async (req, res) => {
  res.page('pages/admin/sales/messages', { layout: 'admin', title: req.t('msgs.title'), list: await messages.list() });
}));

const renderEdit = async (req, res, extra = {}) => {
  const m = await messages.describe(req.params.key);
  if (!m) throw E.notFound('Message');
  const lang = ['ar', 'en'].includes(req.query.lang_preview) ? req.query.lang_preview : (req.locale === 'ar' ? 'ar' : 'en');
  res.page('pages/admin/sales/message-edit', { layout: 'admin', title: req.t(`msgs.m_${m.key}`), m, previews: { ar: await preview(m.key, 'ar'), en: await preview(m.key, 'en') }, lang, ...extra });
};
router.get('/:key', wrap(renderEdit));

router.post('/:key', form(async (req, res) => {
  const r = await messages.save(req.params.key, req.body);
  if (!r) throw E.notFound('Message');
  if (Object.keys(r.errors).length) throw E.validation(r.errors);
  await audit.record(req.ctx, 'platform.message_text_updated', { entityType: 'platform', newValues: { message: req.params.key } });
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/admin/messages/${req.params.key}`);
}, renderEdit));

router.post('/:key/reset', wrap(async (req, res) => {
  await messages.reset(req.params.key);
  await audit.record(req.ctx, 'platform.message_text_updated', { entityType: 'platform', newValues: { message: req.params.key, reset: true } });
  flash(req, 'success', req.t('msgs.reset_done'));
  res.redirect(`/admin/messages/${req.params.key}`);
}));

/** Sends the saved email texts (with sample values) to the signed-in admin. */
router.post('/:key/test', wrap(async (req, res) => {
  const def = messages.DEFS.find((d) => d.key === req.params.key);
  if (!def || def.kind !== 'email') throw E.notFound('Message');
  const locale = req.body.locale === 'ar' ? 'ar' : 'en';
  if (!config.isTest && !mailer.enabled()) {
    flash(req, 'warning', req.t('msgs.test_off'));
  } else {
    const m = await messages.compose(def.key, locale, messages.sample(def.key, locale));
    await mailer.send({ to: req.user.email, subject: `[TEST] ${m.subject}`, html: mailer.layout({ locale, title: m.title, body: m.body, cta: m.cta, href: config.appUrl }) });
    flash(req, 'success', req.t('msgs.test_sent', { email: req.user.email }));
  }
  res.redirect(`/admin/messages/${def.key}`);
}));

module.exports = router;
