// Settings → Integrations (hub, webhooks, SMS, chat) and Settings → Calendar (personal feeds).
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can, feature } = require('../../middleware/context');
const mailer = require('../../core/mailer');
const webhooks = require('./webhooks.service');
const messaging = require('./messaging.service');
const calendar = require('./calendar.service');
const { EVENT_GROUPS, SMS_EVENTS, SMS_PROVIDERS, CHAT_PROVIDERS } = require('./catalog');

const router = express.Router();
router.use((req, res, next) => { res.locals.section = req.baseUrl.endsWith('/calendar') ? 'calendar' : 'integrations'; next(); });

// ---------- Personal calendar feeds (mounted at /app/settings/calendar) ----------
const calendarRouter = express.Router();
calendarRouter.use((req, res, next) => { res.locals.section = 'calendar'; next(); });
calendarRouter.use(feature('integrations'));
calendarRouter.get('/', wrap(async (req, res) => {
  res.page('pages/settings/calendar', { title: req.t('integrations.calendar'), feeds: await calendar.feeds(req.ctx),
    canCompany: req.ctx.permissions.has('leave.view') || req.ctx.permissions.has('employees.view') });
}));
calendarRouter.post('/:kind', wrap(async (req, res) => {
  if (req.body.action === 'revoke') await calendar.revoke(req.ctx, req.params.kind);
  else await calendar.generate(req.ctx, req.params.kind);
  flash(req, 'success', req.t(req.body.action === 'revoke' ? 'integrations.feed_revoked' : 'integrations.feed_created'));
  res.redirect('/app/settings/calendar');
}));

// ---------- Hub ----------
router.use(can('integrations.manage'));
router.get('/', wrap(async (req, res) => {
  const [hooks, sms, chat] = await Promise.all([webhooks.list(req.ctx), messaging.view(req.ctx, 'sms'), messaging.view(req.ctx, 'chat')]);
  res.page('pages/settings/integrations', { title: req.t('integrations.title'), hooks, sms, chat, emailOn: (await mailer.canSendFor(req.ctx.organizationId)) || Boolean(mailer.currentConfig()) });
}));

// ---------- Webhooks ----------
router.use('/webhooks', feature('integrations'));
const renderNewHook = async (req, res, extra = {}) => res.page('pages/settings/webhook-form', { title: req.t('integrations.new_webhook'), hook: null, groups: EVENT_GROUPS, ...extra });
router.get('/webhooks/new', wrap((req, res) => renderNewHook(req, res)));
router.post('/webhooks', form(async (req, res) => {
  const id = await webhooks.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('integrations.webhook_created'));
  res.redirect(`/app/settings/integrations/webhooks/${id}?reveal=1`);
}, renderNewHook));
const renderHook = async (req, res, extra = {}) => {
  const hook = await webhooks.get(req.ctx, Number(req.params.id));
  res.page('pages/settings/webhook', { title: hook.url, hook, groups: EVENT_GROUPS, reveal: req.query.reveal === '1', ...extra });
};
router.get('/webhooks/:id', wrap((req, res) => renderHook(req, res)));
router.post('/webhooks/:id', form(async (req, res) => {
  await webhooks.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/app/settings/integrations/webhooks/${req.params.id}`);
}, (req, res, extra) => renderHook(req, res, { ...extra, openDialog: 'edit' })));
router.post('/webhooks/:id/test', wrap(async (req, res) => {
  await webhooks.sendTest(req.ctx, Number(req.params.id));
  await require('../../core/jobs').runDue({ limit: 10 }); // send right away so the result shows below
  flash(req, 'success', req.t('integrations.test_sent'));
  res.redirect(`/app/settings/integrations/webhooks/${req.params.id}`);
}));
router.post('/webhooks/:id/rotate', wrap(async (req, res) => {
  await webhooks.rotateSecret(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('integrations.secret_rotated'));
  res.redirect(`/app/settings/integrations/webhooks/${req.params.id}?reveal=1`);
}));
router.post('/webhooks/:id/delete', wrap(async (req, res) => {
  await webhooks.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect('/app/settings/integrations');
}));
router.post('/webhooks/:id/deliveries/:did/redeliver', wrap(async (req, res) => {
  await webhooks.redeliver(req.ctx, Number(req.params.id), Number(req.params.did));
  await require('../../core/jobs').runDue({ limit: 10 });
  res.redirect(`/app/settings/integrations/webhooks/${req.params.id}`);
}));

// ---------- SMS & chat ----------
const renderSms = async (req, res, extra = {}) => res.page('pages/settings/integration-sms', {
  title: req.t('integrations.sms'), setting: await messaging.view(req.ctx, 'sms'), providers: SMS_PROVIDERS, smsEvents: SMS_EVENTS, logs: await messaging.logs(req.ctx, 'sms'), ...extra,
});
router.get('/sms', feature('integrations'), wrap((req, res) => renderSms(req, res)));
router.post('/sms', feature('integrations'), form(async (req, res) => {
  if (req.body.action === 'remove') await messaging.disable(req.ctx, 'sms');
  else await messaging.saveSms(req.ctx, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/settings/integrations/sms');
}, renderSms));
router.post('/sms/test', feature('integrations'), form(async (req, res) => {
  const r = await messaging.testSms(req.ctx, req.body.phone);
  flash(req, r.ok ? 'success' : 'error', r.ok ? req.t('integrations.test_sms_ok') : req.t('integrations.test_failed', { error: r.error }));
  res.redirect('/app/settings/integrations/sms');
}, renderSms));

const renderChat = async (req, res, extra = {}) => res.page('pages/settings/integration-chat', {
  title: req.t('integrations.chat'), setting: await messaging.view(req.ctx, 'chat'), providers: CHAT_PROVIDERS, groups: EVENT_GROUPS, logs: await messaging.logs(req.ctx, 'chat'), ...extra,
});
router.get('/chat', feature('integrations'), wrap((req, res) => renderChat(req, res)));
router.post('/chat', feature('integrations'), form(async (req, res) => {
  if (req.body.action === 'remove') await messaging.disable(req.ctx, 'chat');
  else await messaging.saveChat(req.ctx, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/settings/integrations/chat');
}, renderChat));
router.post('/chat/test', feature('integrations'), form(async (req, res) => {
  const r = await messaging.testChat(req.ctx);
  flash(req, r.ok ? 'success' : 'error', r.ok ? req.t('integrations.test_chat_ok') : req.t('integrations.test_failed', { error: r.error }));
  res.redirect('/app/settings/integrations/chat');
}, renderChat));

// ---------- Public calendar feed: /calendar/<token>.ics ----------
const feedRouter = express.Router();
feedRouter.get('/:file', wrap(async (req, res, next) => {
  const m = String(req.params.file).match(/^(cal_[A-Za-z0-9_-]+)\.ics$/);
  const base = `${req.protocol}://${req.get('host')}`;
  const ics = m ? await calendar.render(m[1], process.env.APP_URL ? require('../../config').appUrl.replace(/\/+$/, '') : base) : null;
  if (!ics) return next();
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Content-Disposition', 'inline; filename="remoteway.ics"');
  return res.send(ics);
}));

module.exports = { router, calendarRouter, feedRouter };
