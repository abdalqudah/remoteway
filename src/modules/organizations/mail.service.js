// Settings → Email: the company's own mailbox (any SMTP server), so invitations, notifications and
// reports reach employees from the company's address instead of the platform's.
// Built on core/smtp.js (presets, security modes, relay without authentication, clear errors).
// A mailbox is used only after a test message was delivered with it.
const dns = require('dns').promises;
const net = require('net');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const mailer = require('../../core/mailer');
const smtp = require('../../core/smtp');
const { isPrivateIp } = require('../../core/http');
const { E, AppError } = require('../../core/errors');

const { PRESETS } = smtp;
const allowPrivate = () => process.env.INTEGRATIONS_ALLOW_PRIVATE === 'true';

/** Saved mailbox, normalized; never the password. */
async function get(organizationId) {
  const r = await knex('organization_mail').where({ organization_id: organizationId }).first();
  if (!r) return null;
  const s = smtp.normalize({
    provider: r.provider, host: r.host, port: r.port, security: r.security || undefined, authentication: r.auth_mode || undefined,
    username: r.username, fromEmail: r.from_email, fromName: r.from_name, replyTo: r.reply_to,
  });
  return { ...s, password: '', hasPassword: Boolean(r.password_enc), enabled: Boolean(r.enabled), verified_at: r.verified_at, last_error: r.last_error, last_error_at: r.last_error_at };
}

/** A company mail server must be public: RemoteWay's own network is not reachable from here. */
async function assertPublicHost(host) {
  const list = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new AppError('MAIL_DNS', 'The mail server name could not be found.', 400); });
  if (!allowPrivate() && list.some((a) => isPrivateIp(a.address))) throw new AppError('MAIL_PRIVATE', 'This mail server address is not reachable from RemoteWay.', 400);
}

/** Settings from the form; an empty password keeps the stored one (same username). */
async function fromForm(organizationId, body) {
  const r = await knex('organization_mail').where({ organization_id: organizationId }).first();
  const org = await knex('organizations').where({ id: organizationId }).first('name');
  const input = smtp.normalize({
    provider: body.provider, host: String(body.host || '').toLowerCase(), port: body.port, security: body.security, authentication: body.authentication,
    username: body.username, password: body.password, fromEmail: body.from_email, fromName: body.from_name, replyTo: body.reply_to,
  });
  const storedPassword = r && r.password_enc ? secrets.decrypt(r.password_enc) : '';
  const keep = !input.password && storedPassword && r.username === input.username && input.authentication === 'password';
  if (keep) input.password = storedPassword;
  if (!input.fromName) input.fromName = org.name;
  const v = smtp.validate(input, { passwordKnown: Boolean(keep) });
  if (Object.keys(v.errors).length) throw E.validation(v.errors);
  await assertPublicHost(v.settings.host);
  return { settings: v.settings, warnings: v.warnings, orgName: org.name };
}

function testContent(orgName, locale) {
  const ar = locale === 'ar';
  return {
    locale, fallbackName: orgName,
    subject: ar ? `${orgName} — رسالة تجربة من RemoteWay` : `${orgName} — RemoteWay test email`,
    title: ar ? 'بريد المنشأة يعمل' : 'Your company email works',
    body: ar ? 'ستصل رسائل RemoteWay إلى موظفيكم من هذا العنوان.' : 'RemoteWay emails to your people will now come from this address.',
  };
}

/** Connection only (no email): connect, TLS, login. */
async function testConnection(ctx, body) {
  const { settings, warnings } = await fromForm(ctx.organizationId, body);
  const r = await smtp.verifyConnection(settings);
  await smtp.logEvent({ scope: 'company', organizationId: ctx.organizationId, action: 'test_connection', settings, ok: r.ok, error: r.error, ms: r.ms, userId: ctx.userId });
  return { ...r, settings, warnings };
}

/** Connection + one test email to `to`, without saving. */
async function testEmail(ctx, body, to, { locale } = {}) {
  const { settings, warnings, orgName } = await fromForm(ctx.organizationId, body);
  const r = await mailer.sendTest(settings, to, testContent(orgName, locale));
  await smtp.logEvent({ scope: 'company', organizationId: ctx.organizationId, action: 'test_email', settings, ok: r.ok, error: r.error, userId: ctx.userId });
  return { ...r, settings, warnings };
}

/** Saves the mailbox and sends a test message to `testTo`. The mailbox is used only when the test works. */
async function save(ctx, body, { testTo, locale } = {}) {
  const { settings: s, warnings, orgName } = await fromForm(ctx.organizationId, body);
  const values = {
    provider: s.provider, host: s.host, port: s.port, security: s.security, auth_mode: s.authentication,
    username: s.authentication === 'password' ? s.username : null,
    password_enc: s.authentication === 'password' && s.password ? secrets.encrypt(s.password) : null,
    from_email: s.fromEmail, from_name: s.fromName, reply_to: s.replyTo || null, updated_by: ctx.userId, updated_at: new Date(),
  };
  await knex('organization_mail').insert({ organization_id: ctx.organizationId, ...values, enabled: false }).onConflict('organization_id').merge(values);
  const r = await mailer.sendTest(s, testTo, testContent(orgName, locale));
  await smtp.logEvent({ scope: 'company', organizationId: ctx.organizationId, action: 'test_email', settings: s, ok: r.ok, error: r.error, userId: ctx.userId });
  const error = r.ok ? null : `${r.error.message}${r.error.code ? ` (${r.error.code})` : ''}`;
  await knex('organization_mail').where({ organization_id: ctx.organizationId }).update(r.ok
    ? { enabled: true, verified_at: new Date(), last_error: null, last_error_at: null }
    : { enabled: false, last_error: error, last_error_at: new Date() });
  mailer.forgetOrg(ctx.organizationId);
  await audit.record(ctx, r.ok ? 'mail.connected' : 'mail.test_failed', { entityType: 'organization', entityId: ctx.organizationId, newValues: { host: s.host, port: s.port, security: s.security, auth: s.authentication, from: s.fromEmail, error } });
  return { ok: r.ok, error, result: { ...r, settings: s }, warnings };
}

async function remove(ctx) {
  await knex('organization_mail').where({ organization_id: ctx.organizationId }).del();
  mailer.forgetOrg(ctx.organizationId);
  await audit.record(ctx, 'mail.disconnected', { entityType: 'organization', entityId: ctx.organizationId });
}

/** Kept for older callers: a readable reason from an SMTP error. */
const reason = (e) => smtp.explain(e).message;

module.exports = { PRESETS, get, save, remove, testConnection, testEmail, reason };
