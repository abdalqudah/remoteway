// Super Admin → CRM (RemoteWay's internal CRM). Mounted inside the admin router, so only the platform
// team reaches it, and the section guard in admin/web.js applies (owner, admin, sales, support).
const express = require('express');
const knex = require('../../db/knex');
const rateLimit = require('express-rate-limit');
const { wrap, form, flash } = require('../../routes/helpers');
const { E } = require('../../core/errors');
const csv = require('../../core/csv');
const access = require('../admin/access');
const crm = require('./crm.service');
const comms = require('./comms.service');
const insights = require('./insights.service');
const { SMS_PROVIDERS } = require('../integrations/catalog');

const router = express.Router();
const aiLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(E.rateLimited()) });
const managerOnly = (req, res, next) => (['owner', 'admin'].includes(access.roleOf(req.user)) ? next() : next(E.forbidden('crm.settings')));
const filtersOf = (q) => ({ q: q.q, stage_id: q.stage_id, owner: q.owner, source: q.source, kind: q.kind, from: q.from, to: q.to, follow: q.follow, sort: q.sort });

router.use(wrap(async (req, res, next) => {
  await crm.ensureSynced();
  const [stages, team] = await Promise.all([crm.stages(), crm.team()]);
  Object.assign(res.locals, { crmStages: stages, crmTeam: team, crmSources: crm.SOURCES, crmKinds: crm.KINDS, crmCanManage: ['owner', 'admin'].includes(access.roleOf(req.user)), stName: (s) => (req.locale === 'ar' && s.name_ar ? s.name_ar : s.name) });
  next();
}));

// ---------- Dashboard ----------
router.get('/', wrap(async (req, res) => {
  const f = { from: req.query.from, to: req.query.to, owner: req.query.owner, stage_id: req.query.stage_id, source: req.query.source };
  const [dash, rules, aiLast, mine] = await Promise.all([insights.dashboard(f), insights.ruleInsights(), insights.lastAiInsights(), crm.followUps({ assignedTo: req.user.id, scope: 'open' })]);
  const charts = require('../../core/charts'); // eslint-disable-line global-require
  const ar = req.locale === 'ar';
  const weekly = charts.columns({ points: dash.weeks, title: req.t('crm.chart_weekly'), fmt: (v) => String(Math.round(v)) });
  const stageBars = charts.bars({ items: dash.byStage.filter((s) => s.is_active).map((s) => ({ label: ar && s.name_ar ? s.name_ar : s.name, value: s.value })) });
  res.page('pages/admin/crm/dashboard', { layout: 'admin', title: req.t('crm.title'), crmTab: 'dashboard', dash, rules, aiLast, mine: mine.slice(0, 8), f, weekly, stageBars });
}));
router.post('/insights', aiLimiter, form(async (req, res) => {
  await insights.aiInsights(req.ctx, req.locale);
  res.redirect('/admin/crm#ai');
}, async (req, res, extra) => { flash(req, 'error', extra.formError.message); res.redirect('/admin/crm#ai'); }));
router.post('/sync', wrap(async (req, res) => {
  const n = await crm.syncAll();
  flash(req, 'success', req.t('crm.synced', { n }));
  res.redirect('/admin/crm/contacts');
}));

// ---------- Contacts ----------
const renderContacts = async (req, res, extra = {}) => {
  const f = filtersOf(req.query);
  const page = Math.max(1, Number(req.query.page) || 1);
  res.page('pages/admin/crm/contacts', { layout: 'admin', title: req.t('crm.contacts'), crmTab: 'contacts', result: await crm.list(f, { page }), f, ...extra });
};
router.get('/contacts', wrap(async (req, res) => {
  if (req.query.format === 'csv') {
    const r = await crm.list(filtersOf(req.query), { page: 1, perPage: 10000 });
    return csv.send(res, 'crm-contacts.csv', ['Name', 'Email', 'Phone', 'Company', 'Kind', 'Source', 'Stage', 'Owner', 'Registered', 'Last contact', 'Last contact by', 'Next follow-up', 'Created'],
      r.items.map((c) => [c.name, c.email, c.phone ? `+${c.phone}` : '', c.company_name, c.kind, c.source, c.stage_name, c.owner_name, c.registered_at, c.last_contact_at, c.last_contact_by_name, c.next_follow_up_at, c.created_at]));
  }
  return renderContacts(req, res);
}));
const renderNew = (req, res, extra = {}) => res.page('pages/admin/crm/contact-form', { layout: 'admin', title: req.t('crm.new_contact'), crmTab: 'contacts', c: null, ...extra });
router.get('/contacts/new', (req, res) => renderNew(req, res));
router.post('/contacts', form(async (req, res) => {
  const id = await crm.create(req.ctx, req.body);
  flash(req, 'success', req.t('crm.contact_created'));
  res.redirect(`/admin/crm/contacts/${id}`);
}, renderNew));

const renderContact = async (req, res, extra = {}) => {
  const c = await crm.get(Number(req.params.id));
  const [channels, templates] = await Promise.all([comms.status(), comms.templates()]);
  // Quotations for this contact and the files the team can send them (Super Admin → Quotations / Files).
  const sales = require('../sales/sales.service'); // eslint-disable-line global-require
  const quotes = (await knex('quotes').where({ contact_id: c.id }).orderBy('id', 'desc').limit(20)).map((q) => ({ ...q, state: sales.quoteState(q) }));
  const files = await knex('sales_files').where({ active: true }).orderBy('id', 'desc').select('id', 'title');
  res.page('pages/admin/crm/contact', { layout: 'admin', title: c.name, crmTab: 'contacts', c, channels, templates, waWindow: comms.inWindow(c), tab: req.query.tab || extra.tab || 'email', quotes, salesFiles: files, ...extra });
};
router.get('/contacts/:id', wrap((req, res) => renderContact(req, res)));
router.get('/contacts/:id/edit', wrap(async (req, res) => res.page('pages/admin/crm/contact-form', { layout: 'admin', title: req.t('common.edit'), crmTab: 'contacts', c: await crm.get(Number(req.params.id)) })));
router.post('/contacts/:id', form(async (req, res) => {
  await crm.update(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/admin/crm/contacts/${req.params.id}`);
}, async (req, res, extra) => res.page('pages/admin/crm/contact-form', { layout: 'admin', title: req.t('common.edit'), crmTab: 'contacts', c: await crm.get(Number(req.params.id)), ...extra })));
router.post('/contacts/:id/delete', managerOnly, wrap(async (req, res) => {
  await crm.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('crm.contact_deleted'));
  res.redirect('/admin/crm/contacts');
}));

// Stage changes: a form post, or JSON from the pipeline board (drag & drop)
router.post('/contacts/:id/stage', wrap(async (req, res) => {
  const json = req.get('x-requested-with') === 'fetch';
  try {
    await crm.changeStage(req.ctx, Number(req.params.id), Number(req.body.stage_id), { note: req.body.note });
  } catch (e) {
    if (json) return res.status(e.status || 500).json({ success: false, error: { code: e.code, message: e.message } });
    throw e;
  }
  if (json) return res.json({ success: true });
  flash(req, 'success', req.t('crm.stage_changed'));
  return res.redirect(`/admin/crm/contacts/${req.params.id}`);
}));
const back = (req) => `/admin/crm/contacts/${Number(req.params.id)}`;
const act = (fn, msg, tab) => form(async (req, res) => { await fn(req); flash(req, 'success', req.t(msg)); res.redirect(back(req) + (tab ? `?tab=${tab}` : '')); },
  (req, res, extra) => renderContact(req, res, { ...extra, tab: tab || 'email' }));
router.post('/contacts/:id/assign', act((req) => crm.assign(req.ctx, Number(req.params.id), req.body.owner_user_id || null), 'crm.assigned'));
router.post('/contacts/:id/note', act((req) => crm.addNote(req.ctx, Number(req.params.id), req.body), 'crm.logged_ok', 'note'));
router.post('/contacts/:id/followups', act((req) => crm.addFollowUp(req.ctx, Number(req.params.id), req.body), 'crm.followup_added', 'followup'));
router.post('/contacts/:id/email', act((req) => comms.sendEmail(req.ctx, Number(req.params.id), req.body), 'crm.sent_ok', 'email'));
router.post('/contacts/:id/sms', act((req) => comms.sendSms(req.ctx, Number(req.params.id), req.body), 'crm.sent_ok', 'sms'));
router.post('/contacts/:id/whatsapp', act((req) => comms.sendWhatsApp(req.ctx, Number(req.params.id), req.body), 'crm.sent_ok', 'whatsapp'));
router.post('/contacts/:id/summary', aiLimiter, form(async (req, res) => {
  await insights.summarizeContact(req.ctx, Number(req.params.id), req.locale);
  res.redirect(`${back(req)}#ai`);
}, async (req, res, extra) => { flash(req, 'error', extra.formError.message); res.redirect(`${back(req)}#ai`); }));
router.post('/followups/:fid/status', wrap(async (req, res) => {
  await crm.setFollowUpStatus(req.ctx, Number(req.params.fid), req.body.status, req.body.note);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(String(req.body.back || '').startsWith('/admin/crm') ? String(req.body.back) : '/admin/crm/followups');
}));

// ---------- Pipeline board ----------
router.get('/pipeline', wrap(async (req, res) => {
  const f = { owner: req.query.owner, source: req.query.source, q: req.query.q };
  const cols = [];
  for (const s of res.locals.crmStages) {
    const r = await crm.list({ ...f, stage_id: s.id }, { page: 1, perPage: 60 });
    cols.push({ stage: s, total: r.total, items: r.items });
  }
  res.page('pages/admin/crm/pipeline', { layout: 'admin', title: req.t('crm.pipeline'), crmTab: 'pipeline', cols, f });
}));

// ---------- Follow-ups ----------
router.get('/followups', wrap(async (req, res) => {
  const scope = ['open', 'overdue', 'all'].includes(req.query.scope) ? req.query.scope : 'open';
  const who = req.query.who === 'all' ? null : req.user.id;
  res.page('pages/admin/crm/followups', { layout: 'admin', title: req.t('crm.followups'), crmTab: 'followups', list: await crm.followUps({ assignedTo: who, scope }), scope, who: who ? 'me' : 'all' });
}));

// ---------- Settings: stages, channels, templates (owners and admins) ----------
const renderSettings = async (req, res, extra = {}) => {
  const [all, raw, templates] = await Promise.all([crm.stages({ all: true }), comms.rawSettings(), comms.templates()]);
  res.page('pages/admin/crm/settings', { layout: 'admin', title: req.t('crm.settings'), crmTab: 'settings', allStages: all, raw, templates, smsProviders: SMS_PROVIDERS, webhookUrl: `${res.locals.baseUrl}/webhooks/crm/whatsapp`, ...extra });
};
router.get('/settings', managerOnly, wrap((req, res) => renderSettings(req, res)));
router.post('/settings/stages', managerOnly, form(async (req, res) => { await crm.saveStage(req.ctx, req.body.id ? Number(req.body.id) : null, req.body); flash(req, 'success', req.t('common.saved')); res.redirect('/admin/crm/settings#stages'); }, renderSettings));
router.post('/settings/stages/order', managerOnly, wrap(async (req, res) => { await crm.reorderStages(req.ctx, [].concat(req.body.ids || [])); res.redirect('/admin/crm/settings#stages'); }));
router.post('/settings/stages/:sid/delete', managerOnly, form(async (req, res) => { await crm.deleteStage(req.ctx, Number(req.params.sid)); flash(req, 'success', req.t('common.saved')); res.redirect('/admin/crm/settings#stages'); }, renderSettings));
router.post('/settings/channels/:channel', managerOnly, form(async (req, res) => { await comms.saveChannel(req.ctx, req.params.channel, req.body); flash(req, 'success', req.t('common.saved')); res.redirect(`/admin/crm/settings#${req.params.channel}`); }, (req, res, extra) => renderSettings(req, res, { ...extra, errorChannel: req.params.channel })));
router.post('/settings/templates', managerOnly, form(async (req, res) => { await comms.saveTemplate(req.ctx, req.body.id ? Number(req.body.id) : null, req.body); flash(req, 'success', req.t('common.saved')); res.redirect('/admin/crm/settings#templates'); }, renderSettings));
router.post('/settings/templates/:tid/delete', managerOnly, wrap(async (req, res) => { await require('../../db/knex')('crm_templates').where({ id: Number(req.params.tid) }).del(); res.redirect('/admin/crm/settings#templates'); })); // eslint-disable-line global-require

module.exports = router;
