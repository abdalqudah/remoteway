// Email via any SMTP server (see core/smtp.js: presets, security modes, relay without authentication).
// Platform email: Super Admin → Email (encrypted in platform_settings.smtp), falling back to .env.
// Disabled when neither is set — the UI then tells admins to share links manually.
const knex = require('../db/knex');
const config = require('../config');
const { translator } = require('./i18n');
const secrets = require('./secrets');
const smtp = require('./smtp');
const messages = require('./messages');

// SMTP settings come from Super Admin → Email (stored encrypted in the database) and fall back to .env.
let transport;
let transportKey = null;
let dbSettings = null;
let loadedAt = 0;

/** Reloads SMTP settings from the database (called on start, after saving, and at most once a minute). */
async function refresh() {
  try {
    const row = await knex('platform_settings').where({ key: 'smtp' }).first();
    const value = row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : null;
    dbSettings = value && value.host ? smtp.normalize({ ...value, password: value.password_enc ? secrets.decrypt(value.password_enc) : '' }) : null;
  } catch {
    dbSettings = null; // table not there yet (before migrations)
  }
  loadedAt = Date.now();
  return dbSettings;
}

/** Platform SMTP in use: admin panel settings first, then .env (SMTP_HOST, SMTP_PORT, SMTP_SECURITY, …). */
function currentConfig() {
  if (Date.now() - loadedAt > 60_000) { loadedAt = Date.now(); refresh().catch(() => {}); }
  if (dbSettings && dbSettings.host) return { source: 'admin', ...dbSettings };
  const env = smtp.fromEnv();
  return env ? { source: 'env', ...env } : null;
}

const settingsKey = (c) => JSON.stringify([c.host, c.port, c.security, c.authentication, c.username, c.password]);

function getTransport() {
  const cfg = currentConfig();
  const k = cfg ? settingsKey(cfg) : null;
  if (k === transportKey && transport !== undefined) return transport;
  transportKey = k;
  if (!cfg) { transport = null; return transport; }
  try {
    transport = smtp.createSmtpTransporter(cfg);
  } catch (e) {
    console.error('[mail] nodemailer unavailable:', e.message);
    transport = null;
  }
  return transport;
}

const platformEnabled = () => Boolean(getTransport()) && !config.isTest;

// ---------- Company mailboxes ----------
// A company that connected its own mailbox (Settings → Email) sends its people's emails from it.
// When the platform requires it (Super Admin → Email), company emails are not sent from RemoteWay's
// address until the company connects one; account emails (confirm address, reset password) still are.
const orgCache = new Map(); // organizationId → { at, cfg, transport, key }
let policy = { at: 0, require: null };

async function requireCompanyEmail() {
  if (Date.now() - policy.at < 60_000 && policy.require !== null) return policy.require;
  let v = null;
  try {
    const row = await knex('platform_settings').where({ key: 'mail_policy' }).first();
    const value = row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : null;
    v = value && typeof value.require_company_email === 'boolean' ? value.require_company_email : null;
  } catch { v = null; }
  policy = { at: Date.now(), require: v === null ? !config.isTest : v };
  return policy.require;
}
const forgetPolicy = () => { policy = { at: 0, require: null }; };

const transportFor = (cfg) => smtp.createSmtpTransporter(cfg);

/** Company mailbox row → SMTP settings (rows from before 1.8.2 have no security/auth columns set). */
function orgRowSettings(r) {
  return smtp.normalize({
    provider: r.provider, host: r.host, port: r.port, security: r.security || undefined, authentication: r.auth_mode || undefined,
    username: r.username, password: r.password_enc ? secrets.decrypt(r.password_enc) : '', fromEmail: r.from_email, fromName: r.from_name, replyTo: r.reply_to,
  });
}

/** The company's working mailbox, or null. */
async function orgMail(organizationId) {
  if (!organizationId) return null;
  const hit = orgCache.get(organizationId);
  if (hit && Date.now() - hit.at < 60_000) return hit.cfg;
  let cfg = null;
  try {
    const r = await knex('organization_mail').where({ organization_id: organizationId, enabled: true }).first();
    if (r) cfg = orgRowSettings(r);
  } catch { cfg = null; }
  const key = cfg ? settingsKey(cfg) : null;
  const prev = orgCache.get(organizationId);
  orgCache.set(organizationId, { at: Date.now(), cfg, key, transport: prev && prev.key === key ? prev.transport : null });
  return cfg;
}
const forgetOrg = (organizationId) => { orgCache.delete(organizationId); orgCache.delete(`sandbox:${organizationId}`); };

/** Whether an email for this company would be sent at all (company mailbox, or the platform's when allowed). */
async function canSendFor(organizationId) {
  const sb = await sandboxOf(organizationId);
  if (sb && !sb.emails) return false;
  if (organizationId && await orgMail(organizationId)) return true;
  if (sb) return platformEnabled(); // test companies may use the platform email even when mailboxes are required
  if (organizationId && await requireCompanyEmail()) return false;
  return platformEnabled();
}
const enabled = () => platformEnabled();
const from = () => {
  const cfg = currentConfig();
  if (cfg && cfg.fromEmail) return smtp.fromHeader(cfg, 'RemoteWay');
  return `RemoteWay <${(cfg && cfg.username) || 'no-reply@localhost'}>`;
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** brand (white label): { name, color, logoUrl } replaces the RemoteWay header. */
function layout({ locale, title, body, cta, href, brand }) {
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const header = brand
    ? `<div style="background:${/^#[0-9A-Fa-f]{6}$/.test(brand.color || '') ? brand.color : '#ffffff'};padding:16px 24px;border-bottom:1px solid #e2e2e2">${brand.logoUrl ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" style="max-height:40px;max-width:220px;background:#fff;border-radius:6px;padding:4px">` : `<span style="font-weight:800;font-size:18px">${escapeHtml(brand.name)}</span>`}</div>`
    : '<div style="background:#1acc6c;padding:18px 24px;font-weight:800;font-size:18px">Remote<span style="color:#fff">WAY</span></div>';
  return `<!doctype html><html dir="${dir}"><body style="margin:0;background:#f7f7f7;font-family:Tahoma,Arial,sans-serif;color:#0a0a0a">
<div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #e2e2e2;border-radius:14px;overflow:hidden">
${header}
<div style="padding:24px"><h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(title)}</h2><p style="line-height:1.7;margin:0 0 20px">${escapeHtml(body).replace(/\n/g, '<br>')}</p>
${href ? `<a href="${escapeHtml(href)}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:700">${escapeHtml(cta)}</a>` : ''}
</div></div></body></html>`;
}

const testOutbox = []; // messages "sent" while running tests

/** fromName (white label) changes only the display name; the platform's address keeps deliverability. */
function fromWithName(fromName) {
  const f = from();
  if (!fromName) return f;
  const addr = (f.match(/<([^>]+)>/) || [null, f])[1];
  return `"${String(fromName).replace(/["\\\r\n<>]/g, '').slice(0, 80)}" <${addr}>`;
}

const quoteName = (n) => `"${String(n).replace(/["\\\r\n<>]/g, '').slice(0, 80)}"`;

/**
 * Sends one email. With organizationId the company's own mailbox is used when connected; otherwise the
 * platform's (unless the platform requires company mailboxes, then nothing is sent and false is returned).
 */
/** null for a real company; { emails } for a test company (Super Admin → Test environment). */
async function sandboxOf(organizationId) {
  if (!organizationId) return null;
  const k = `sandbox:${organizationId}`;
  const hit = orgCache.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const r = await knex('organizations').where({ id: organizationId }).first('is_sandbox', 'sandbox_meta').catch(() => null);
  let v = null;
  if (r && r.is_sandbox) {
    let m = {};
    try { m = JSON.parse(r.sandbox_meta || '{}'); } catch { m = {}; }
    v = { emails: m.emails !== false };
  }
  orgCache.set(k, { at: Date.now(), v });
  return v;
}
const GENERATED = /\.sandbox\.remoteway\.local>?$/i; // test accounts' addresses: they do not exist

/**
 * Every email is written to the email log (Super Admin → Email → Email log): who it was for, what kind,
 * whether it was sent, failed (with the server's answer) or not sent and why. Never the content.
 */
async function logEmail(entry) {
  try {
    await knex('email_log').insert({
      kind: String(entry.kind || 'other').slice(0, 40), to_addr: String(entry.to || '').slice(0, 255), subject: entry.subject ? String(entry.subject).slice(0, 255) : null,
      organization_id: entry.organizationId || null, via: entry.via, status: entry.status, reason: entry.reason || null,
      error: entry.error ? String(entry.error).slice(0, 500) : null, response: entry.response ? String(entry.response).slice(0, 500) : null,
      message_id: entry.messageId ? String(entry.messageId).slice(0, 255) : null, duration_ms: entry.ms || null,
    });
    if (Math.random() < 0.02) { // keep the last 90 days
      await knex('email_log').where('created_at', '<', new Date(Date.now() - 90 * 86_400_000)).del();
    }
  } catch (e) {
    console.error('[mail] could not write the email log:', e.message); // eslint-disable-line no-console
  }
}
/** For flows that decide not to send at all (e.g. password reset for an unknown address). */
const logNotSent = (entry) => logEmail({ via: 'none', status: 'not_sent', ...entry });

async function send({ to, subject, html, attachments, fromName, organizationId, kind = 'other' }) {
  const base = { kind, to, organizationId };
  // Test companies: generated addresses do not exist (never sent to), emails can be switched off per
  // test company, and every message is marked [TEST].
  const sb = await sandboxOf(organizationId);
  if (GENERATED.test(String(to || '')) || (sb && !sb.emails)) {
    if (config.isTest) testOutbox.push({ to, subject, html, attachments, via: 'sandbox', organizationId, kind });
    await logEmail({ ...base, subject, via: 'none', status: 'not_sent', reason: GENERATED.test(String(to || '')) ? 'test_address' : 'test_company_emails_off' });
    return false;
  }
  if (sb) subject = `[TEST] ${subject}`; // eslint-disable-line no-param-reassign
  base.subject = subject;
  const company = organizationId ? await orgMail(organizationId) : null;
  const blocked = !company && organizationId && !sb && await requireCompanyEmail();
  if (config.isTest) {
    const via = company ? 'company' : blocked ? 'blocked' : 'platform';
    const fromAddr = company ? `${quoteName(company.fromName || fromName || 'RemoteWay')} <${company.fromEmail}>` : (fromName ? fromWithName(fromName) : undefined);
    const replyTo = company ? company.replyTo || undefined : ((currentConfig() || {}).replyTo || undefined);
    testOutbox.push({ to, subject, html, attachments, from: fromAddr, replyTo, via, organizationId, kind });
    await logEmail({ ...base, via: via === 'blocked' ? 'none' : via, status: via === 'blocked' ? 'not_sent' : 'sent', reason: via === 'blocked' ? 'company_mailbox_required' : 'test_mode' });
    return false;
  }
  const started = Date.now();
  if (company) {
    const hit = orgCache.get(organizationId);
    if (!hit.transport) hit.transport = transportFor(company);
    try {
      const info = await hit.transport.sendMail({ from: `${quoteName(company.fromName || fromName || 'RemoteWay')} <${company.fromEmail}>`, replyTo: company.replyTo || undefined, to, subject, html, attachments });
      await logEmail({ ...base, via: 'company', status: 'sent', response: info && info.response, messageId: info && info.messageId, ms: Date.now() - started });
      return true;
    } catch (e) {
      // Recorded for the company's settings page and the SMTP log; the job queue retries notification emails.
      const ex = smtp.explain(e, company);
      await knex('organization_mail').where({ organization_id: organizationId }).update({ last_error: `${ex.message} ${ex.code ? `(${ex.code})` : ''}`.trim().slice(0, 500), last_error_at: new Date() }).catch(() => {});
      await smtp.logEvent({ scope: 'company', organizationId, action: 'send', settings: company, ok: false, error: ex });
      await logEmail({ ...base, via: 'company', status: 'failed', error: `${ex.code ? `${ex.code}: ` : ''}${ex.message}`, response: ex.detail, ms: Date.now() - started });
      throw e;
    }
  }
  if (blocked) {
    await logEmail({ ...base, via: 'none', status: 'not_sent', reason: 'company_mailbox_required' });
    return false;
  }
  const t = getTransport();
  if (!t) {
    await logEmail({ ...base, via: 'none', status: 'not_sent', reason: 'email_not_configured' });
    return false;
  }
  const cfg = currentConfig();
  try {
    const info = await t.sendMail({ from: fromWithName(fromName), replyTo: cfg && cfg.replyTo ? cfg.replyTo : undefined, to, subject, html, attachments });
    const rejected = info && Array.isArray(info.rejected) && info.rejected.length;
    await logEmail({ ...base, via: 'platform', status: rejected ? 'failed' : 'sent', error: rejected ? `Rejected by the server: ${info.rejected.join(', ')}` : null, response: info && info.response, messageId: info && info.messageId, ms: Date.now() - started });
  } catch (e) {
    const ex = smtp.explain(e, cfg || {});
    await smtp.logEvent({ scope: 'platform', action: 'send', settings: cfg || {}, ok: false, error: ex });
    await logEmail({ ...base, via: 'platform', status: 'failed', error: `${ex.code ? `${ex.code}: ` : ''}${ex.message}`, response: ex.detail, ms: Date.now() - started });
    throw e;
  }
  return true;
}

async function sendInvitation({ email, link, organizationName, roleName, locale = 'en', organizationId }) {
  const brand = await require('../modules/branding/branding.service').forEmail(organizationId); // eslint-disable-line global-require
  const href = brand && brand.base && link.startsWith(config.appUrl) ? brand.base + link.slice(config.appUrl.replace(/\/+$/, '').length) : link;
  const m = await messages.compose('invitation', locale, { org: organizationName, role: roleName, app: brand ? brand.name : 'RemoteWay' });
  return send({
    kind: 'invitation',
    to: email,
    subject: m.subject,
    html: layout({ locale, title: m.title, body: m.body, cta: m.cta, href, brand }),
    fromName: brand ? brand.senderName : organizationName, organizationId,
  });
}

/** One notification email (used by the job queue, so failures are retried). */
async function sendNotificationEmail(userId, type, data, link, organizationId) {
  const u = await knex('users').where({ id: userId, status: 'active' }).first('email', 'locale');
  if (!u) return false;
  const t = translator(u.locale);
  const text = t(`notif.${type}`, data);
  const brand = await require('../modules/branding/branding.service').forEmail(organizationId); // eslint-disable-line global-require
  const base = brand && brand.base ? brand.base : config.appUrl;
  const m = await messages.compose('notification', u.locale, { text, app: brand ? brand.name : 'RemoteWay' });
  return send({
    kind: 'notification',
    to: u.email,
    subject: m.subject,
    html: layout({ locale: u.locale, title: m.title, body: m.body, cta: m.cta, href: link ? `${base}${link}` : base, brand }),
    fromName: brand ? brand.senderName : null, organizationId,
  });
}

/**
 * Checks the connection and sends a test message with the given (possibly unsaved) settings.
 * Returns smtp.sendTestEmail's result: { ok, stage: 'connect'|'send'|'sent', error? }.
 */
async function sendTest(settings, to, content = {}) {
  return smtp.sendTestEmail(settings, to, {
    fallbackName: content.fallbackName || 'RemoteWay',
    subject: content.subject || 'RemoteWay — test email',
    html: layout({ locale: content.locale || 'en', title: content.title || 'Email is working', body: content.body || 'This is a test message from RemoteWay. Your SMTP settings are correct.' }),
  });
}

async function sendNotificationEmails(organizationId, userIds, type, data, link) {
  const users = await knex('users').whereIn('id', userIds).where({ status: 'active' }).select('email', 'locale');
  for (const u of users) {
    const t = translator(u.locale);
    const m = await messages.compose('notification', u.locale, { text: t(`notif.${type}`, data), app: 'RemoteWay' });
    await send({
      kind: 'notification',
      to: u.email,
      subject: m.subject,
      html: layout({ locale: u.locale, title: m.title, body: m.body, cta: m.cta, href: link ? `${config.appUrl}${link}` : config.appUrl }),
      organizationId,
    });
  }
}

module.exports = { logNotSent, canSendFor, orgMail, forgetOrg, requireCompanyEmail, forgetPolicy, testOutbox, layout, enabled, send, sendInvitation, sendNotificationEmails, sendNotificationEmail, sendTest, refresh, currentConfig };
