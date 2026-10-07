// Public entry points of the internal CRM: the website "book a demo" form and the WhatsApp webhook.
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const knex = require('../../db/knex');
const mailer = require('../../core/mailer');
const { form, wrap } = require('../../routes/helpers');
const crm = require('./crm.service');
const comms = require('./comms.service');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isTest ? 1000 : 10, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(require('../../core/errors').E.rateLimited()) });

const renderDemo = (req, res, extra = {}) => res.page('pages/site/demo', { layout: 'public', title: req.t('crm.demo_title'), sent: false, ...extra });
router.get('/demo', (req, res) => renderDemo(req, res));
router.post('/demo', limiter, form(async (req, res) => {
  if (req.body.website) return renderDemo(req, res, { sent: true }); // honeypot: bots fill every field
  const id = await crm.demoRequest(req.body, { ip: req.ip });
  if (mailer.enabled()) {
    const team = await knex('users').where({ is_super_admin: true, status: 'active' }).whereIn('platform_role', ['owner', 'admin', 'sales']).pluck('email');
    for (const to of team) {
      await mailer.send({ kind: 'demo_request', to, subject: `New demo request: ${String(req.body.name || '').slice(0, 80)}`, html: mailer.layout({ locale: 'en', title: 'New demo request', body: `${req.body.name} · ${req.body.company_name || ''} · ${req.body.email || ''}`, cta: 'Open in CRM', href: `${config.appUrl}/admin/crm/contacts/${id}` }) }).catch(() => {});
    }
  }
  res.locals.pixelEventNow = 'lead'; // reported on this confirmation page
  return renderDemo(req, res, { sent: true });
}, renderDemo));

// WhatsApp Business (Meta Cloud API) webhook
router.get('/webhooks/crm/whatsapp', wrap(async (req, res) => {
  const challenge = await comms.verifyWebhook(req.query);
  if (challenge === null) return res.sendStatus(403);
  return res.type('text/plain').send(challenge);
}));
router.post('/webhooks/crm/whatsapp', wrap(async (req, res) => {
  const r = await comms.receiveWebhook(req.rawBody, req.get('x-hub-signature-256'));
  if (!r.ok) return res.sendStatus(r.reason === 'bad_signature' ? 401 : 404);
  return res.json({ received: r.received });
}));

module.exports = router;
