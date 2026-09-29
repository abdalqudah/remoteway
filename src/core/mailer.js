// Email via SMTP (cPanel mail works: SMTP_HOST=mail.your-domain.com, port 465, a mailbox user/password).
// Disabled unless SMTP_HOST is set — the UI then tells admins to share links manually.
const knex = require('../db/knex');
const config = require('../config');
const { translator } = require('./i18n');
const secrets = require('./secrets');

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
    dbSettings = value && value.host ? { ...value, password: value.password_enc ? secrets.decrypt(value.password_enc) : null } : null;
  } catch {
    dbSettings = null; // table not there yet (before migrations)
  }
  loadedAt = Date.now();
  return dbSettings;
}

function currentConfig() {
  if (Date.now() - loadedAt > 60_000) { loadedAt = Date.now(); refresh().catch(() => {}); }
  if (dbSettings && dbSettings.host) return { source: 'admin', ...dbSettings };
  if (process.env.SMTP_HOST) {
    return { source: 'env', host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465), user: process.env.SMTP_USER, password: process.env.SMTP_PASSWORD, from: process.env.MAIL_FROM };
  }
  return null;
}

function getTransport() {
  const cfg = currentConfig();
  const k = cfg ? JSON.stringify([cfg.host, cfg.port, cfg.user, cfg.password]) : null;
  if (k === transportKey && transport !== undefined) return transport;
  transportKey = k;
  if (!cfg) { transport = null; return transport; }
  try {
    // eslint-disable-next-line global-require
    const nodemailer = require('nodemailer');
    const port = Number(cfg.port || 465);
    transport = nodemailer.createTransport({ host: cfg.host, port, secure: port === 465, auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined });
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

function transportFor(cfg) {
  // eslint-disable-next-line global-require
  const nodemailer = require('nodemailer');
  const port = Number(cfg.port || 465);
  return nodemailer.createTransport({
    host: cfg.host, port, secure: port === 465, requireTLS: port === 587, auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
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
    if (r) cfg = { host: r.host, port: r.port, user: r.username, password: r.password_enc ? secrets.decrypt(r.password_enc) : null, fromEmail: r.from_email, fromName: r.from_name };
  } catch { cfg = null; }
  const key = cfg ? JSON.stringify([cfg.host, cfg.port, cfg.user, cfg.password]) : null;
  const prev = orgCache.get(organizationId);
  orgCache.set(organizationId, { at: Date.now(), cfg, key, transport: prev && prev.key === key ? prev.transport : null });
  return cfg;
}
const forgetOrg = (organizationId) => orgCache.delete(organizationId);

/** Whether an email for this company would be sent at all (company mailbox, or the platform's when allowed). */
async function canSendFor(organizationId) {
  if (organizationId && await orgMail(organizationId)) return true;
  if (organizationId && await requireCompanyEmail()) return false;
  return platformEnabled();
}
const enabled = () => platformEnabled();
const from = () => { const cfg = currentConfig() || {}; return cfg.from || `RemoteWay <${cfg.user || 'no-reply@localhost'}>`; };

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
<div style="padding:24px"><h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(title)}</h2><p style="line-height:1.7;margin:0 0 20px">${escapeHtml(body)}</p>
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
async function send({ to, subject, html, attachments, fromName, organizationId }) {
  const company = organizationId ? await orgMail(organizationId) : null;
  const blocked = !company && organizationId && await requireCompanyEmail();
  if (config.isTest) {
    const via = company ? 'company' : blocked ? 'blocked' : 'platform';
    const fromAddr = company ? `${quoteName(company.fromName || fromName || 'RemoteWay')} <${company.fromEmail}>` : (fromName ? fromWithName(fromName) : undefined);
    testOutbox.push({ to, subject, html, attachments, from: fromAddr, via, organizationId });
    return false;
  }
  if (company) {
    const hit = orgCache.get(organizationId);
    if (!hit.transport) hit.transport = transportFor(company);
    try {
      await hit.transport.sendMail({ from: `${quoteName(company.fromName || fromName || 'RemoteWay')} <${company.fromEmail}>`, to, subject, html, attachments });
      return true;
    } catch (e) {
      // Recorded for the company's settings page; the job queue retries notification emails.
      await knex('organization_mail').where({ organization_id: organizationId }).update({ last_error: String(e.message).slice(0, 500), last_error_at: new Date() }).catch(() => {});
      throw e;
    }
  }
  if (blocked) return false;
  const t = getTransport();
  if (!t) return false;
  await t.sendMail({ from: fromWithName(fromName), to, subject, html, attachments });
  return true;
}

async function sendInvitation({ email, link, organizationName, roleName, locale = 'en', organizationId }) {
  const t = translator(locale);
  const brand = await require('../modules/branding/branding.service').forEmail(organizationId); // eslint-disable-line global-require
  const href = brand && brand.base && link.startsWith(config.appUrl) ? brand.base + link.slice(config.appUrl.replace(/\/+$/, '').length) : link;
  return send({
    to: email,
    subject: t('mail.invite_subject', { org: organizationName, app: brand ? brand.name : 'RemoteWay' }),
    html: layout({ locale, title: t('mail.invite_subject', { org: organizationName, app: brand ? brand.name : 'RemoteWay' }), body: t('mail.invite_body', { org: organizationName, role: roleName }), cta: t('auth.invite_join'), href, brand }),
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
  return send({
    to: u.email,
    subject: `${brand ? brand.name : 'RemoteWay'} — ${text}`,
    html: layout({ locale: u.locale, title: text, body: t('mail.notification_body', { app: brand ? brand.name : 'RemoteWay' }), cta: t('mail.open', { app: brand ? brand.name : 'RemoteWay' }), href: link ? `${base}${link}` : base, brand }),
    fromName: brand ? brand.senderName : null, organizationId,
  });
}

/** Sends a test message with the given (unsaved) settings; throws with the SMTP error on failure. */
async function sendTest(settings, to) {
  // eslint-disable-next-line global-require
  const nodemailer = require('nodemailer');
  const port = Number(settings.port || 465);
  const t = nodemailer.createTransport({ host: settings.host, port, secure: port === 465, requireTLS: port === 587, auth: settings.user ? { user: settings.user, pass: settings.password } : undefined, connectionTimeout: 15_000, greetingTimeout: 15_000 });
  await t.sendMail({ from: settings.from || `RemoteWay <${settings.user}>`, to, subject: settings.subject || 'RemoteWay — test email', html: layout({ locale: settings.locale || 'en', title: settings.title || 'Email is working', body: settings.body || 'This is a test message from RemoteWay. Your SMTP settings are correct.' }) });
}

async function sendNotificationEmails(organizationId, userIds, type, data, link) {
  const users = await knex('users').whereIn('id', userIds).where({ status: 'active' }).select('email', 'locale');
  for (const u of users) {
    const t = translator(u.locale);
    const text = t(`notif.${type}`, data);
    await send({
      to: u.email,
      subject: `RemoteWay — ${text}`,
      html: layout({ locale: u.locale, title: text, body: t('mail.notification_body', { app: 'RemoteWay' }), cta: t('mail.open', { app: 'RemoteWay' }), href: link ? `${config.appUrl}${link}` : config.appUrl }),
      organizationId,
    });
  }
}

module.exports = { canSendFor, orgMail, forgetOrg, requireCompanyEmail, forgetPolicy, testOutbox, layout, enabled, send, sendInvitation, sendNotificationEmails, sendNotificationEmail, sendTest, refresh, currentConfig };
