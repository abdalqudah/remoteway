const express = require('express');
const knex = require('../../db/knex');
const { z, validate, optionalString, emptyToUndefined } = require('../../core/validate');
const { wrap, form, flash } = require('../../routes/helpers');
const { LIMIT_KEYS } = require('../../db/catalog');
const admin = require('./admin.service');
const subscriptions = require('../billing/subscription.service');
const auditLog = require('../organizations/audit.service');
const audit = require('../../core/audit');
const bcrypt = require('bcryptjs');
const { E, AppError } = require('../../core/errors');
const { singleFile } = require('../../middleware/upload');
const updater = require('./updater.service');

const router = express.Router();

const access = require('./access');
const team = require('./team.service');
const security = require('../auth/security.service');

router.use((req, res, next) => {
  req.ctx = { userId: req.user.id, organizationId: null, permissions: new Set(), ip: req.ip, userAgent: req.get('user-agent') };
  const section = req.path.split('/')[1] || 'overview';
  res.locals.adminSection = section;
  res.locals.adminCan = (s, write = false) => access.can(req.user, s, write);
  res.locals.platformRole = access.roleOf(req.user);
  // Links in emails, password resets and sign-in providers need the real site address (APP_URL).
  const { isLocalUrl } = require('../../middleware/web'); // eslint-disable-line global-require
  const cfgUrl = require('../../config').appUrl; // eslint-disable-line global-require
  if ((!process.env.APP_URL || isLocalUrl(cfgUrl)) && !/^(localhost|127\.|\[::1\])/i.test(req.hostname || '')) res.locals.appUrlWarning = { current: process.env.APP_URL || '', suggested: `https://${req.hostname}` };
  // Each platform role opens only its sections; changing things may need a narrower role.
  if (!access.can(req.user, section, !['GET', 'HEAD'].includes(req.method))) return next(E.forbidden(`platform.${section}`));
  return next();
});

// When the platform requires it, the team must turn on two-factor sign-in before using the panel.
router.use(wrap(async (req, res, next) => {
  if (security.hasTwoFactor(req.user) || !(await security.requireAdmin2fa())) return next();
  req.session.securityBack = '/admin';
  return res.redirect('/security?required=1');
}));

router.get('/', wrap(async (req, res) => {
  res.page('pages/admin/overview', { layout: 'admin', title: req.t('admin.title'), stats: await admin.overview(), orgs: (await admin.listOrganizations()).slice(0, 8) });
}));

router.get('/organizations', wrap(async (req, res) => {
  res.page('pages/admin/organizations', { layout: 'admin', title: req.t('admin.organizations'), orgs: await admin.listOrganizations({ q: req.query.q }) });
}));

const orgUsers = (orgId) => knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where('m.organization_id', orgId).whereNull('u.deleted_at')
  .select('u.id', 'u.name', 'u.email', 'u.status', 'u.last_login_at', 'u.email_verified_at', 'u.two_factor_enabled_at', 'm.status as member_status').orderBy('u.name').limit(200);
const renderOrg = async (req, res, extra = {}) => {
  const [org, plans, addons, features] = await Promise.all([admin.getOrganization(Number(req.params.id)), knex('plans').orderBy('sort_order'),
    knex('addons').where({ is_active: true }).orderBy('sort_order'), knex('features').orderBy('sort_order')]);
  const resetLink = req.session.lastResetLink;
  delete req.session.lastResetLink;
  res.page('pages/admin/organization', { layout: 'admin', title: org.name, org, plans, addons, features, limitKeys: LIMIT_KEYS, users: await orgUsers(org.id), resetLink, ...extra });
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
    current_period_end: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
    billing_cycle: z.enum(['monthly', 'yearly']).default('monthly'),
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
    billing_cycle: data.billing_cycle, current_period_end: data.current_period_end ?? null,
  });
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/admin/organizations/${req.params.id}`);
}, renderOrg));

router.post('/organizations/:id/addons', form(async (req, res) => {
  await admin.setAddons(req.ctx, Number(req.params.id), req.body.addons && typeof req.body.addons === 'object' ? req.body.addons : {});
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/admin/organizations/${req.params.id}#addons`);
}, renderOrg));
router.post('/organizations/:id/features', form(async (req, res) => {
  const keys = Array.isArray(req.body.features) ? req.body.features : req.body.features ? [req.body.features] : [];
  await admin.setCustomFeatures(req.ctx, Number(req.params.id), keys);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/admin/organizations/${req.params.id}#features`);
}, renderOrg));
router.post('/organizations/:id/invoice', form(async (req, res) => {
  const id = await admin.issueInvoice(req.ctx, Number(req.params.id), { amount: req.body.amount, description: req.body.description });
  flash(req, 'success', req.t('admin.invoice_issued'));
  res.redirect(`/admin/organizations/${req.params.id}#invoices`);
  return id;
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

router.post('/invoices/:id/void', form(async (req, res) => {
  await admin.voidInvoice(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('admin.invoice_voided'));
  res.redirect(req.body.back === 'org' ? `/admin/organizations/${Number(req.body.org)}#invoices` : '/admin/invoices');
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

const smtp = require('../../core/smtp');

async function smtpSetting() {
  const row = await knex('platform_settings').where({ key: 'smtp' }).first();
  return row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : null;
}
/** Saved platform SMTP, normalized (legacy host/port/user/from rows included). Never the password. */
async function savedSmtp() {
  const raw = await smtpSetting();
  if (!raw) return null;
  return { ...smtp.normalize(raw), password: '', hasPassword: Boolean(raw.password_enc) };
}

const renderEmail = async (req, res, extra = {}) => {
  const [saved, requireCompany, [{ n: connected }], [{ n: companies }], events] = await Promise.all([
    savedSmtp(), mailer.requireCompanyEmail(),
    knex('organization_mail').where({ enabled: true }).count({ n: '*' }),
    knex('organizations').where({ status: 'active' }).count({ n: '*' }),
    smtp.recentEvents({ scope: 'platform', limit: 10 }),
  ]);
  const current = mailer.currentConfig();
  res.page('pages/admin/email', {
    layout: 'admin', title: req.t('admin.email'), saved, source: current ? current.source : null, envSet: Boolean(process.env.SMTP_HOST),
    requireCompany, connected: Number(connected), companies: Number(companies), events, PRESETS: smtp.PRESETS, ...extra,
  });
};
// Whether companies must connect their own mailbox before RemoteWay emails their people.
router.post('/email/policy', wrap(async (req, res) => {
  const value = JSON.stringify({ require_company_email: req.body.require_company_email === '1' });
  await knex('platform_settings').insert({ key: 'mail_policy', value }).onConflict('key').merge({ value, updated_at: new Date() });
  mailer.forgetPolicy();
  await require('../../core/audit').record(req.ctx, 'platform.mail_policy_updated', { newValues: JSON.parse(value) }); // eslint-disable-line global-require
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/admin/email');
}));
router.get('/email', wrap((req, res) => renderEmail(req, res)));
// JSON for scripts and the UI: never the password (masked when one is stored).
router.get('/email/settings', wrap(async (req, res) => {
  const saved = await savedSmtp();
  const current = mailer.currentConfig();
  res.set('Cache-Control', 'no-store').json({
    success: true,
    data: { source: current ? current.source : null, settings: saved ? smtp.masked(saved, { hasPassword: saved.hasPassword }) : null, presets: smtp.PRESETS },
  });
}));

/**
 * Settings from the form. An empty password keeps the stored one (same username), so saving or testing
 * without retyping it works; with "None / relay" no username or password is used at all.
 */
async function smtpFromForm(body) {
  const raw = await smtpSetting();
  const stored = raw ? smtp.normalize({ ...raw, password: raw.password_enc ? secrets.decrypt(raw.password_enc) : '' }) : null;
  const input = smtp.normalize({
    provider: body.provider, host: body.host, port: body.port, security: body.security, authentication: body.authentication,
    username: body.username, password: body.password, fromEmail: body.from_email, fromName: body.from_name, replyTo: body.reply_to,
  });
  const keep = !input.password && stored && stored.password && stored.username === input.username;
  if (keep) input.password = stored.password;
  const v = smtp.validate(input, { passwordKnown: Boolean(keep) });
  if (Object.keys(v.errors).length) throw E.validation(v.errors);
  return { settings: v.settings, warnings: v.warnings };
}
const wantsJson = (req) => String(req.get('accept') || '').includes('application/json');
const testRecipient = (req) => {
  const to = String(req.body.test_to || req.user.email).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw E.validation({ test_to: 'Enter the email address that should receive the test.' });
  return to;
};

router.post('/email', form(async (req, res) => {
  if (req.body.action === 'clear') {
    await knex('platform_settings').where({ key: 'smtp' }).del();
  } else {
    const { settings: c, warnings } = await smtpFromForm(req.body);
    const value = JSON.stringify({
      provider: c.provider, host: c.host, port: c.port, security: c.security, authentication: c.authentication,
      user: c.authentication === 'password' ? c.username : '', password_enc: c.authentication === 'password' && c.password ? secrets.encrypt(c.password) : null,
      from_email: c.fromEmail, from_name: c.fromName, reply_to: c.replyTo,
      from: c.fromName ? `${c.fromName} <${c.fromEmail}>` : c.fromEmail, // older versions read this
    });
    await knex('platform_settings').insert({ key: 'smtp', value }).onConflict('key').merge({ value, updated_at: new Date() });
    if (warnings.length) flash(req, 'warning', warnings.map((w) => req.t(`smtp.warn_${w}`)).join(' '));
  }
  await mailer.refresh();
  await require('../../core/audit').record(req.ctx, 'platform.email_updated', { entityType: 'platform' }); // eslint-disable-line global-require
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/admin/email');
}, renderEmail));

// Connection test: connects, starts TLS, logs in — sends nothing.
router.post('/email/test-connection', form(async (req, res) => {
  const { settings: c, warnings } = await smtpFromForm(req.body);
  const r = await smtp.verifyConnection(c);
  await smtp.logEvent({ scope: 'platform', action: 'test_connection', settings: c, ok: r.ok, error: r.error, ms: r.ms, userId: req.user.id });
  if (wantsJson(req)) return res.json({ success: r.ok, data: { ok: r.ok, ms: r.ms, error: r.error || null, warnings } });
  return renderEmail(req, res, { old: req.body, testResult: { action: 'connection', ...r, settings: smtp.masked(c) }, warnings });
}, renderEmail));

// Test email: validate → connect → send; shows exactly where it failed.
router.post('/email/test', form(async (req, res) => {
  const { settings: c, warnings } = await smtpFromForm(req.body);
  const to = testRecipient(req);
  const r = await mailer.sendTest(c, to, { locale: req.locale });
  await smtp.logEvent({ scope: 'platform', action: 'test_email', settings: c, ok: r.ok, error: r.error, userId: req.user.id });
  if (wantsJson(req)) return res.json({ success: r.ok, data: { ok: r.ok, stage: r.stage, to, error: r.error || null, warnings } });
  return renderEmail(req, res, { old: req.body, testResult: { action: 'email', to, ...r, settings: smtp.masked(c) }, warnings });
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
  const personal = body.personal_daily_limit === undefined || body.personal_daily_limit === '' ? 10 : Number(body.personal_daily_limit);
  if (!Number.isInteger(personal) || personal < 0 || personal > 200) errors.personal_daily_limit = 'Use a number between 0 and 200.';
  if (Object.keys(errors).length) throw E.validation(errors);
  return {
    provider, model: provider === 'azure' ? (model || deployment) : model, deployment: provider === 'azure' ? deployment : null, endpoint: provider === 'azure' ? endpoint : null,
    api_version: provider === 'azure' ? (String(body.api_version || '').trim() || '2024-10-21') : null, apiKey, price_in: priceIn, price_out: priceOut, max_tokens: maxTokens, personal_daily_limit: personal,
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

// ---------- Internal CRM ----------
router.use('/crm', require('../crm/web'));

// ---------- Database backups ----------
const backups = require('./backup.service');
const errorLog = require('./errors.service');
const demo = require('./demo.service');
const renderBackups = async (req, res, extra = {}) => res.page('pages/admin/backups', {
  layout: 'admin', title: req.t('admin.backups'), list: backups.list(), settings: await backups.settings(), backupDir: backups.DIR, inlineFormError: true, ...extra,
});
router.get('/backups', wrap((req, res) => renderBackups(req, res)));
router.post('/backups', form(async (req, res) => {
  const r = await backups.create(req.ctx, { label: 'manual' });
  flash(req, 'success', req.t('admin.backup_created', { name: r.name }));
  res.redirect('/admin/backups');
}, renderBackups));
router.post('/backups/settings', form(async (req, res) => {
  await backups.saveSettings(req.ctx, { enabled: req.body.enabled === '1', hour: req.body.hour, keep: req.body.keep });
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/admin/backups');
}, renderBackups));
router.post('/backups/import', ...singleFile('file', { big: true }), form(async (req, res) => {
  const name = await backups.importFile(req.ctx, req.file?.buffer);
  flash(req, 'success', req.t('admin.backup_imported', { name }));
  res.redirect('/admin/backups');
}, renderBackups));
router.get('/backups/:name/download', wrap(async (req, res) => {
  const stream = backups.openRead(req.params.name);
  await audit.record(req.ctx, 'platform.backup_downloaded', { newValues: { name: req.params.name } });
  res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${req.params.name}"`, 'Cache-Control': 'no-store' });
  stream.pipe(res);
}));
router.post('/backups/:name/restore', form(async (req, res) => {
  const r = await backups.restore(req.ctx, req.params.name, req.body.password);
  // The restored database has its own sessions table: sign in again.
  req.session.destroy(() => {});
  res.clearCookie('rw.sid');
  res.redirect(`/login?restored=1&safety=${encodeURIComponent(r.safety)}`);
}, (req, res, extra) => renderBackups(req, res, { ...extra, restoreName: req.params.name })));
router.post('/backups/:name/delete', form(async (req, res) => {
  await backups.remove(req.ctx, req.params.name);
  flash(req, 'success', req.t('admin.backup_deleted'));
  res.redirect('/admin/backups');
}, renderBackups));

// ---------- Users: find any account, create a password reset link ----------
router.get('/users', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const list = q ? await knex('users as u').whereNull('u.deleted_at').where((w) => w.where('u.email', 'like', `%${q.replace(/[%_]/g, '\\$&')}%`).orWhere('u.name', 'like', `%${q.replace(/[%_]/g, '\\$&')}%`))
    .select('u.id', 'u.name', 'u.email', 'u.status', 'u.is_super_admin', 'u.last_login_at', 'u.email_verified_at', 'u.two_factor_enabled_at',
      knex.raw('(SELECT GROUP_CONCAT(o.name SEPARATOR \', \') FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = u.id) AS orgs'))
    .orderBy('u.name').limit(50) : [];
  const resetLink = req.session.lastResetLink;
  delete req.session.lastResetLink;
  res.page('pages/admin/users', { layout: 'admin', title: req.t('admin.users'), q, list, resetLink });
}));
router.post('/users/:id/reset-link', wrap(async (req, res) => {
  const back = String(req.body.back || '');
  const to = /^\/admin\/(users|organizations\/\d+)(\?[\w=&%.@+-]*)?$/.test(back) ? back : '/admin/users';
  try {
    const r = await security.adminResetLink(req.ctx, Number(req.params.id));
    if (r.emailed) flash(req, 'success', req.t('auth.reset_link_emailed', { email: r.email }));
    else req.session.lastResetLink = { link: r.link, email: r.email };
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    flash(req, 'error', req.t(`errors.${e.code}`) !== `errors.${e.code}` ? req.t(`errors.${e.code}`) : e.message);
  }
  res.redirect(to);
}));

router.use('/', require('./growth.web')); // SEO/AEO/GEO, marketing, Google sign-in, custom domains

// ---------- Landing page editor ----------
const site = require('../site/content.service');
const siteFeatures = () => knex('features').orderBy('sort_order').select('key', 'name');
router.get('/site', wrap(async (req, res) => {
  res.page('pages/admin/site/index', { layout: 'admin', title: req.t('siteed.title'), content: await site.get(), types: Object.keys(site.TYPES), customised: await site.isCustomised() });
}));
router.post('/site/sections', wrap(async (req, res) => {
  try {
    const id = await site.addSection(req.ctx, String(req.body.type || ''), String(req.body.after || ''));
    flash(req, 'success', req.t('siteed.added'));
    return res.redirect(`/admin/site/sections/${id}`);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    flash(req, 'error', req.t('siteed.choose_type'));
    return res.redirect('/admin/site');
  }
}));
const renderSection = async (req, res, extra = {}) => {
  const content = await site.get();
  const s = content.sections.find((x) => x.id === req.params.id);
  if (!s) throw E.notFound('Section');
  res.page('pages/admin/site/edit', { layout: 'admin', title: req.t('siteed.edit_section'), kind: 'section', s, schema: site.TYPES[s.type], data: s.data, design: s.design || {}, DESIGN: site.DESIGN, media: await require('../site/media.service').list(), icons: site.ICONS, features: await siteFeatures(), action: `/admin/site/sections/${s.id}`, ...extra }); // eslint-disable-line global-require
};
router.get('/site/sections/:id', wrap((req, res) => renderSection(req, res)));
router.post('/site/sections/:id', wrap(async (req, res) => {
  await site.updateSection(req.ctx, req.params.id, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(req.body.stay === '1' ? `/admin/site/sections/${req.params.id}` : '/admin/site');
}));
for (const [path, fn] of [['move', (ctx, id, b) => site.moveSection(ctx, id, b.dir === 'down' ? 'down' : 'up')], ['toggle', (ctx, id) => site.toggleSection(ctx, id)], ['delete', (ctx, id) => site.removeSection(ctx, id)], ['duplicate', (ctx, id) => site.duplicateSection(ctx, id)]]) {
  router.post(`/site/sections/:id/${path}`, wrap(async (req, res) => {
    await fn(req.ctx, req.params.id, req.body);
    if (path !== 'move') flash(req, 'success', req.t(`siteed.done_${path}`));
    res.redirect(`/admin/site#s-${req.params.id}`);
  }));
}
for (const which of ['header', 'footer']) {
  router.get(`/site/${which}`, wrap(async (req, res) => {
    const content = await site.get();
    res.page('pages/admin/site/edit', { layout: 'admin', title: req.t(`siteed.${which}`), kind: which, s: null, schema: which === 'header' ? site.HEADER : site.FOOTER, data: content[which], design: {}, DESIGN: [], media: [], icons: site.ICONS, features: [], action: `/admin/site/${which}` });
  }));
  router.post(`/site/${which}`, wrap(async (req, res) => {
    await site.updateBlock(req.ctx, which, req.body);
    flash(req, 'success', req.t('common.saved'));
    res.redirect('/admin/site');
  }));
}
// Media library (images, videos, YouTube/Vimeo links)
const siteMediaSvc = require('../site/media.service');
const mediaBack = (req) => (/^\/admin\/site(\/sections\/[a-z0-9-]+|\/media|\/header|\/footer)?$/.test(String(req.body.back || '')) ? req.body.back : '/admin/site/media');
router.get('/site/media', wrap(async (req, res) => {
  res.page('pages/admin/site/media', { layout: 'admin', title: req.t('siteed.media'), list: await siteMediaSvc.list() });
}));
router.post('/site/media', ...singleFile('file', { big: true }), wrap(async (req, res) => {
  try {
    await siteMediaSvc.upload(req.ctx, req.file, req.body.name);
    flash(req, 'success', req.t('siteed.media_uploaded'));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    flash(req, 'error', Object.values(e.details || {})[0] ? require('../../core/i18n').translateMessage(req.locale, Object.values(e.details)[0]) : e.message); // eslint-disable-line global-require
  }
  res.redirect(mediaBack(req));
}));
router.post('/site/media/embed', wrap(async (req, res) => {
  try {
    await siteMediaSvc.addEmbed(req.ctx, req.body.url, req.body.name);
    flash(req, 'success', req.t('siteed.media_uploaded'));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    flash(req, 'error', req.t('siteed.embed_invalid'));
  }
  res.redirect(mediaBack(req));
}));
router.post('/site/media/:id/delete', wrap(async (req, res) => {
  await siteMediaSvc.remove(req.ctx, req.params.id);
  flash(req, 'success', req.t('siteed.media_deleted'));
  res.redirect('/admin/site/media');
}));
router.post('/site/reset', wrap(async (req, res) => {
  await site.reset(req.ctx);
  flash(req, 'success', req.t('siteed.reset_done'));
  res.redirect('/admin/site');
}));

// ---------- Launch readiness ----------
const renderLaunch = async (req, res, extra = {}) => res.page('pages/admin/launch', {
  layout: 'admin', title: req.t('admin.launch'), result: await require('./launch.service').run(req.user), demo: await demo.preview(), inlineFormError: true, ...extra, // eslint-disable-line global-require
});
router.get('/launch', wrap((req, res) => renderLaunch(req, res)));
router.post('/launch/remove-demo', form(async (req, res) => {
  const r = await demo.remove(req.ctx, req.body.password);
  flash(req, 'success', req.t('launch.demo_removed', { companies: r.companies, users: r.users, backup: r.safety }));
  res.redirect('/admin/launch');
}, (req, res, extra) => renderLaunch(req, res, { ...extra, demoOpen: true })));

// ---------- Privacy policy & terms ----------
const legal = require('../site/legal.service');
const renderLegal = async (req, res, extra = {}) => {
  const d = await legal.details();
  const text = (kind, lang) => d.custom[kind][lang] || legal.DEFAULTS[kind][lang];
  res.page('pages/admin/legal', { layout: 'admin', title: req.t('admin.legal'), d, text, ...extra });
};
router.get('/legal', wrap((req, res) => renderLegal(req, res)));
router.post('/legal', form(async (req, res) => {
  await legal.save(req.ctx, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/admin/legal');
}, renderLegal));

// ---------- Error log ----------
router.get('/errors', wrap(async (req, res) => {
  const q = String(req.query.q || '').slice(0, 100);
  res.page('pages/admin/errors', { layout: 'admin', title: req.t('admin.errors'), q, list: await errorLog.list({ q }), groups: await errorLog.groups(7), counts: await errorLog.counts() });
}));
router.post('/errors/clear', wrap(async (req, res) => {
  await errorLog.clear();
  await audit.record(req.ctx, 'platform.errors_cleared', {});
  flash(req, 'success', req.t('admin.errors_cleared'));
  res.redirect('/admin/errors');
}));

// ---------- Platform team ----------
const renderTeam = async (req, res, extra = {}) => res.page('pages/admin/team', {
  layout: 'admin', title: req.t('admin.team'), members: await team.list(), roles: access.ROLES, sections: access.SECTIONS, require2fa: await security.requireAdmin2fa(), ...extra,
});
router.post('/team/security', form(async (req, res) => {
  await security.setRequireAdmin2fa(req.ctx, req.body.require_admin_2fa === '1');
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/admin/team');
}, renderTeam));
router.post('/team/:id/reset-2fa', form(async (req, res) => {
  await security.resetForUser(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('admin.team_2fa_reset_done'));
  res.redirect('/admin/team');
}, renderTeam));
router.get('/team', wrap((req, res) => renderTeam(req, res)));
router.post('/team', form(async (req, res) => {
  await team.add(req.ctx, { name: req.body.name, email: req.body.email, role: req.body.role, password: req.body.password });
  flash(req, 'success', req.t('admin.team_added'));
  res.redirect('/admin/team');
}, renderTeam));
router.post('/team/:id/role', form(async (req, res) => {
  await team.setRole(req.ctx, Number(req.params.id), String(req.body.role || ''));
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/admin/team');
}, renderTeam));
router.post('/team/:id/remove', form(async (req, res) => {
  await team.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('admin.team_removed'));
  res.redirect('/admin/team');
}, renderTeam));

// ---------- Online payments (Saudi gateways) ----------
const payments = require('../payments/payments.service');
const { GATEWAYS, PAYTABS_REGIONS } = require('../payments/gateways');

const renderPayments = async (req, res, extra = {}) => {
  const baseUrl = res.locals.baseUrl;
  res.page('pages/admin/payments', {
    layout: 'admin', title: req.t('admin.payments'), saved: await payments.rawConfig(), gateways: GATEWAYS, regions: Object.keys(PAYTABS_REGIONS),
    list: await payments.adminList({ status: ['initiated', 'paid', 'failed', 'cancelled', 'expired'].includes(req.query.status) ? req.query.status : null }),
    webhookBase: `${baseUrl}/payments/webhook/`, inlineFormError: true, errorProvider: extra.formError ? req.params.provider || null : null, ...extra,
  });
};
router.get('/payments', wrap((req, res) => renderPayments(req, res)));
router.post('/payments/mode', form(async (req, res) => {
  await payments.setMode(req.ctx, String(req.body.mode || ''));
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/admin/payments');
}, renderPayments));
router.post('/payments/:provider', form(async (req, res) => {
  const { provider } = req.params;
  if (!GATEWAYS[provider]) throw E.notFound('Payment gateway');
  if (req.body.action === 'remove') await payments.removeProvider(req.ctx, provider);
  else await payments.saveProvider(req.ctx, provider, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/admin/payments#gw-${provider}`);
}, renderPayments));
router.post('/payments/:provider/test', form(async (req, res) => {
  const { provider } = req.params;
  if (!GATEWAYS[provider]) throw E.notFound('Payment gateway');
  const r = await payments.testProvider(req.ctx, provider, req.body);
  flash(req, 'success', req.t('admin.pay_test_ok', { gateway: GATEWAYS[provider].label, ms: r.ms }));
  res.redirect(`/admin/payments#gw-${provider}`);
}, renderPayments));

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
