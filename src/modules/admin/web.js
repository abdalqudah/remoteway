const express = require('express');
const knex = require('../../db/knex');
const { z, validate, optionalString, emptyToUndefined } = require('../../core/validate');
const { wrap, form, flash } = require('../../routes/helpers');
const { LIMIT_KEYS } = require('../../db/catalog');
const admin = require('./admin.service');
const subscriptions = require('../billing/subscription.service');
const auditLog = require('../organizations/audit.service');
const bcrypt = require('bcryptjs');
const { E } = require('../../core/errors');
const { singleFile } = require('../../middleware/upload');
const updater = require('./updater.service');

const router = express.Router();

router.use((req, res, next) => {
  req.ctx = { userId: req.user.id, organizationId: null, permissions: new Set(), ip: req.ip, userAgent: req.get('user-agent') };
  res.locals.adminSection = req.path.split('/')[1] || 'overview';
  next();
});

router.get('/', wrap(async (req, res) => {
  res.page('pages/admin/overview', { layout: 'admin', title: req.t('admin.title'), stats: await admin.overview(), orgs: (await admin.listOrganizations()).slice(0, 8) });
}));

router.get('/organizations', wrap(async (req, res) => {
  res.page('pages/admin/organizations', { layout: 'admin', title: req.t('admin.organizations'), orgs: await admin.listOrganizations({ q: req.query.q }) });
}));

const renderOrg = async (req, res, extra = {}) => {
  const [org, plans] = await Promise.all([admin.getOrganization(Number(req.params.id)), knex('plans').orderBy('sort_order')]);
  res.page('pages/admin/organization', { layout: 'admin', title: org.name, org, plans, limitKeys: LIMIT_KEYS, ...extra });
};
router.get('/organizations/:id', wrap((req, res) => renderOrg(req, res)));
router.post('/organizations/:id/status', wrap(async (req, res) => {
  await admin.setOrganizationStatus(req.ctx, Number(req.params.id), req.body.status);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/admin/organizations/${req.params.id}`);
}));
const limitValue = z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional());
router.post('/organizations/:id/subscription', form(async (req, res) => {
  const data = validate(z.object({
    plan_id: z.coerce.number().int().positive(),
    status: z.enum(['trial', 'active', 'past_due', 'suspended', 'cancelled']),
    trial_ends_at: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
    custom: z.object(Object.fromEntries(LIMIT_KEYS.map((k) => [k, limitValue]))).partial().default({}),
    custom_unlimited: z.preprocess((v) => (Array.isArray(v) ? v : v ? [v] : []), z.array(z.enum(LIMIT_KEYS))),
  }), req.body);
  const custom = {};
  for (const k of LIMIT_KEYS) {
    if (data.custom_unlimited.includes(k)) custom[k] = null;
    else if (data.custom[k] !== undefined) custom[k] = data.custom[k];
  }
  await admin.updateSubscription(req.ctx, Number(req.params.id), {
    plan_id: data.plan_id, status: data.status, trial_ends_at: data.trial_ends_at ?? null, custom_limits: Object.keys(custom).length ? custom : null,
  });
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/admin/organizations/${req.params.id}`);
}, renderOrg));

// ---------- Plans ----------
const renderPlans = async (req, res, extra = {}) => res.page('pages/admin/plans', {
  layout: 'admin', title: req.t('admin.plans'), plans: await admin.listPlans(), features: await knex('features').orderBy('sort_order'), limitKeys: LIMIT_KEYS, ...extra,
});
router.get('/plans', wrap((req, res) => renderPlans(req, res)));
const money = z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(9_999_999).optional());
router.post('/plans/:id', form(async (req, res) => {
  const data = validate(z.object({
    name: z.string().trim().min(2).max(80),
    tagline: optionalString(255),
    tagline_ar: optionalString(255),
    price_monthly: money,
    price_yearly: money,
    trial_days: z.coerce.number().int().min(0).max(365),
    is_public: z.preprocess((v) => v === 'on', z.boolean()),
    is_active: z.preprocess((v) => v === 'on', z.boolean()),
    limits: z.object(Object.fromEntries(LIMIT_KEYS.map((k) => [k, limitValue]))).partial().default({}),
    feature_ids: z.preprocess((v) => (Array.isArray(v) ? v : v ? [v] : []), z.array(z.coerce.number().int().positive())),
  }), req.body);
  await admin.updatePlan(req.ctx, Number(req.params.id), data);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/admin/plans#plan-${req.params.id}`);
}, renderPlans));

// ---------- Invoices ----------
router.get('/invoices', wrap(async (req, res) => {
  res.page('pages/admin/invoices', { layout: 'admin', title: req.t('admin.invoices'), invoices: await admin.listInvoices(req.query.status) });
}));
router.post('/invoices/:id/paid', form(async (req, res) => {
  await subscriptions.markInvoicePaid(req.ctx, Number(req.params.id), String(req.body.reference || '').slice(0, 120));
  flash(req, 'success', req.t('admin.invoice_paid'));
  res.redirect('/admin/invoices');
}, async (req, res, extra) => {
  flash(req, 'error', extra.formError.message);
  res.redirect('/admin/invoices');
}));

// ---------- System update (no server access needed) ----------
const renderSystem = async (req, res, extra = {}) => {
  const [[{ v: dbVersion }]] = await knex.raw('SELECT VERSION() AS v');
  res.page('pages/admin/system', {
    layout: 'admin', title: req.t('admin.system'), current: updater.currentVersion(), backups: updater.listBackups(), log: updater.readLog(),
    dbVersion, workRoot: updater.WORK_ROOT, updated: req.query.updated, ...extra,
  });
};
router.get('/system', wrap((req, res) => renderSystem(req, res)));

async function confirmPassword(req) {
  if (!(await bcrypt.compare(String(req.body.password || ''), req.user.password_hash))) {
    throw E.validation({ password: 'Current password is incorrect.' });
  }
}

router.post('/system/update', ...singleFile('file', { big: true }), form(async (req, res) => {
  await confirmPassword(req);
  const result = await updater.apply({ ...req.ctx, userEmail: req.user.email }, req.file?.buffer, req.file?.originalname);
  res.redirect(`/admin/system?updated=${encodeURIComponent(result.to)}`);
}, renderSystem));

router.post('/system/restore', form(async (req, res) => {
  await confirmPassword(req);
  const result = await updater.restore({ ...req.ctx, userEmail: req.user.email }, req.body.backup);
  res.redirect(`/admin/system?updated=${encodeURIComponent(result.to)}`);
}, renderSystem));

// ---------- Email (SMTP) ----------
const mailer = require('../../core/mailer');
const secrets = require('../../core/secrets');
const jobs = require('../../core/jobs');

async function smtpSetting() {
  const row = await knex('platform_settings').where({ key: 'smtp' }).first();
  return row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : null;
}
const renderEmail = async (req, res, extra = {}) => {
  const saved = await smtpSetting();
  const current = mailer.currentConfig();
  res.page('pages/admin/email', { layout: 'admin', title: req.t('admin.email'), saved, source: current ? current.source : null, envSet: Boolean(process.env.SMTP_HOST), ...extra });
};
router.get('/email', wrap((req, res) => renderEmail(req, res)));

function smtpInput(body, saved) {
  const errors = {};
  const host = String(body.host || '').trim();
  const port = Number(body.port || 465);
  const user = String(body.user || '').trim();
  const from = String(body.from || '').trim();
  let password = String(body.password || '');
  if (!password && saved && saved.password_enc) password = secrets.decrypt(saved.password_enc) || '';
  if (!/^[a-z0-9.-]{3,190}$/i.test(host)) errors.host = 'Enter the mail server name, e.g. mail.your-domain.com';
  if (![25, 465, 587, 2525].includes(port)) errors.port = 'Use 465 (SSL) or 587 (STARTTLS).';
  if (from && !/^[^<>]*<?[^@\s<>]+@[^@\s<>]+>?$/.test(from)) errors.from = 'Use: RemoteWay <no-reply@your-domain.com>';
  if (Object.keys(errors).length) throw E.validation(errors);
  return { host, port, user, password, from };
}

router.post('/email', form(async (req, res) => {
  if (req.body.action === 'clear') {
    await knex('platform_settings').where({ key: 'smtp' }).del();
  } else {
    const cfg = smtpInput(req.body, await smtpSetting());
    const value = JSON.stringify({ host: cfg.host, port: cfg.port, user: cfg.user, from: cfg.from, password_enc: cfg.password ? secrets.encrypt(cfg.password) : null });
    await knex('platform_settings').insert({ key: 'smtp', value }).onConflict('key').merge({ value, updated_at: new Date() });
  }
  await mailer.refresh();
  await require('../../core/audit').record(req.ctx, 'platform.email_updated', { entityType: 'platform' });
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/admin/email');
}, renderEmail));

router.post('/email/test', form(async (req, res) => {
  const cfg = smtpInput(req.body, await smtpSetting());
  const to = String(req.body.to || req.user.email).trim();
  try {
    await mailer.sendTest(cfg, to);
    flash(req, 'success', req.t('admin.email_test_ok', { to }));
  } catch (err) {
    flash(req, 'error', req.t('admin.email_test_failed', { error: String(err.message).slice(0, 300) }));
  }
  res.redirect('/admin/email');
}, renderEmail));

// ---------- AI provider ----------
const aiService = require('../ai/ai.service');
const { PROVIDERS } = require('../ai/providers');
const { validateUrl } = require('../../core/http');

const renderAi = async (req, res, extra = {}) => res.page('pages/admin/ai', {
  layout: 'admin', title: req.t('admin.ai'), saved: await aiService.rawConfig(), providers: PROVIDERS, usage: await aiService.platformUsage(), ...extra,
});
router.get('/ai', wrap((req, res) => renderAi(req, res)));

function aiInput(body, saved) {
  const errors = {};
  const provider = String(body.provider || '');
  if (!PROVIDERS[provider]) errors.provider = 'Choose a provider.';
  const model = String(body.model || '').trim().slice(0, 120);
  const deployment = String(body.deployment || '').trim().slice(0, 120);
  const endpoint = String(body.endpoint || '').trim().replace(/\/+$/, '');
  let apiKey = String(body.api_key || '').trim();
  const keepKey = !apiKey && saved && saved.api_key_enc && saved.provider === provider;
  if (keepKey) apiKey = secrets.decrypt(saved.api_key_enc) || '';
  if (!apiKey) errors.api_key = 'Enter the API key.';
  if (provider === 'azure') {
    if (!deployment) errors.deployment = 'Enter the deployment name.';
    const u = validateUrl(endpoint);
    if (!endpoint || u.error) errors.endpoint = u.error || 'Enter the endpoint URL.';
  } else if (!/^[A-Za-z0-9._:\/-]{2,120}$/.test(model)) errors.model = 'Enter the model name exactly as the provider lists it.';
  const num = (v, max) => { if (v === undefined || v === '') return null; const x = Number(v); return Number.isFinite(x) && x >= 0 && x <= max ? x : NaN; };
  const priceIn = num(body.price_in, 1000); const priceOut = num(body.price_out, 1000);
  if (Number.isNaN(priceIn)) errors.price_in = 'Enter a price between 0 and 1000.';
  if (Number.isNaN(priceOut)) errors.price_out = 'Enter a price between 0 and 1000.';
  const maxTokens = Number(body.max_tokens || 1500);
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 8000) errors.max_tokens = 'Use a number between 256 and 8000.';
  if (Object.keys(errors).length) throw E.validation(errors);
  return {
    provider, model: provider === 'azure' ? (model || deployment) : model, deployment: provider === 'azure' ? deployment : null, endpoint: provider === 'azure' ? endpoint : null,
    api_version: provider === 'azure' ? (String(body.api_version || '').trim() || '2024-10-21') : null, apiKey, price_in: priceIn, price_out: priceOut, max_tokens: maxTokens,
    enabled: body.enabled === 'on',
  };
}

router.post('/ai', form(async (req, res) => {
  if (req.body.action === 'clear') {
    await knex('platform_settings').where({ key: 'ai' }).del();
  } else {
    const c = aiInput(req.body, await aiService.rawConfig());
    const { apiKey, ...rest } = c;
    const value = JSON.stringify({ ...rest, api_key_enc: secrets.encrypt(apiKey), api_key_hint: secrets.mask ? secrets.mask(apiKey) : null });
    await knex('platform_settings').insert({ key: 'ai', value }).onConflict('key').merge({ value, updated_at: new Date() });
  }
  aiService.invalidateConfig();
  await require('../../core/audit').record(req.ctx, 'platform.ai_updated', { entityType: 'platform' });
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/admin/ai');
}, renderAi));

router.post('/ai/test', form(async (req, res) => {
  const c = aiInput(req.body, await aiService.rawConfig());
  try {
    const r = await aiService.testConnection({ provider: c.provider, model: c.model, apiKey: c.apiKey, endpoint: c.endpoint, deployment: c.deployment, apiVersion: c.api_version });
    flash(req, 'success', req.t('admin.ai_test_ok', { ms: r.latency }));
  } catch (err) {
    flash(req, 'error', req.t('admin.ai_test_failed', { error: String(err.message).slice(0, 300) }));
  }
  res.redirect('/admin/ai');
}, renderAi));

// ---------- Support inbox (client success) ----------
const support = require('../support/support.service');
router.get('/support', wrap(async (req, res) => {
  const [tickets, stats] = await Promise.all([support.adminList({ status: req.query.status || 'active', q: req.query.q }), support.adminStats()]);
  res.page('pages/admin/support', { layout: 'admin', title: req.t('admin.support'), tickets, stats, status: req.query.status || 'active', q: req.query.q || '', STATUSES: support.STATUSES });
}));
const renderTicket = async (req, res, extra = {}) => {
  const [ticket, staff] = await Promise.all([support.adminGet(Number(req.params.id)), knex('users').where({ is_super_admin: true, status: 'active' }).select('id', 'name')]);
  res.page('pages/admin/support-ticket', { layout: 'admin', title: ticket.subject, ticket, staff, STATUSES: support.STATUSES, ...extra });
};
router.get('/support/:id', wrap((req, res) => renderTicket(req, res)));
router.post('/support/:id/reply', form(async (req, res) => {
  await support.adminReply(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/admin/support/${req.params.id}`);
}, renderTicket));
router.post('/support/:id/assign', wrap(async (req, res) => {
  await support.assign(req.ctx, Number(req.params.id), Number(req.body.user_id) || null);
  res.redirect(`/admin/support/${req.params.id}`);
}));

// ---------- Background jobs ----------
router.get('/jobs', wrap(async (req, res) => {
  const [stat, failed, recent] = await Promise.all([
    jobs.stats(),
    knex('background_jobs as j').leftJoin('organizations as o', 'o.id', 'j.organization_id').where('j.status', 'dead').orderBy('j.id', 'desc').limit(30).select('j.*', 'o.name as organization_name'),
    knex('background_jobs as j').leftJoin('organizations as o', 'o.id', 'j.organization_id').orderBy('j.id', 'desc').limit(30).select('j.*', 'o.name as organization_name'),
  ]);
  res.page('pages/admin/jobs', { layout: 'admin', title: req.t('admin.jobs'), stat, failed, recent });
}));
router.post('/jobs/run', wrap(async (req, res) => {
  const r = await jobs.runDue({ limit: 100 });
  flash(req, 'success', req.t('admin.jobs_ran', { done: r.done || 0, retry: r.retry || 0, dead: r.dead || 0 }));
  res.redirect('/admin/jobs');
}));
router.post('/jobs/:id/retry', wrap(async (req, res) => {
  await knex('background_jobs').where({ id: Number(req.params.id), status: 'dead' }).update({ status: 'pending', run_at: new Date(), attempts: 0, max_attempts: 1, last_error: null });
  res.redirect('/admin/jobs');
}));

// ---------- Platform audit log ----------
router.get('/audit', wrap(async (req, res) => {
  const result = await auditLog.list(null, { page: Number(req.query.page) || 1, action: req.query.action, perPage: 50 });
  res.page('pages/admin/audit', { layout: 'admin', title: req.t('admin.audit'), result });
}));

module.exports = router;
