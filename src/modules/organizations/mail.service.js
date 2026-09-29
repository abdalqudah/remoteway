// Settings → Email: the company's own mailbox (SMTP), so invitations, notifications and reports reach
// employees from the company's address (e.g. hr@company.com) instead of RemoteWay's.
// A mailbox is used only after a test message was delivered with it.
const dns = require('dns').promises;
const net = require('net');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const mailer = require('../../core/mailer');
const { isPrivateIp } = require('../../core/http');
const { E, AppError } = require('../../core/errors');

const PORTS = [465, 587, 25, 2525];
// Common providers, to fill the form in one click.
const PRESETS = {
  cpanel: { host: 'mail.yourcompany.com', port: 465 },
  google: { host: 'smtp.gmail.com', port: 465 },
  microsoft: { host: 'smtp.office365.com', port: 587 },
  zoho: { host: 'smtp.zoho.com', port: 465 },
};
const allowPrivate = () => process.env.INTEGRATIONS_ALLOW_PRIVATE === 'true';

async function get(organizationId) {
  const r = await knex('organization_mail').where({ organization_id: organizationId }).first();
  return r ? { ...r, hasPassword: Boolean(r.password_enc), password_enc: undefined } : null;
}

function clean(body) {
  const errors = {};
  const host = String(body.host || '').trim().toLowerCase();
  const port = Number(body.port || 465);
  const username = String(body.username || '').trim().slice(0, 190);
  const fromEmail = String(body.from_email || username).trim().toLowerCase();
  const fromName = String(body.from_name || '').replace(/["\r\n<>]/g, '').trim().slice(0, 120);
  if (!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host) && !net.isIP(host)) errors.host = 'Enter the mail server, e.g. mail.yourcompany.com.';
  if (!PORTS.includes(port)) errors.port = 'Use port 465 (SSL) or 587 (STARTTLS).';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) errors.from_email = 'Enter the address emails are sent from, e.g. hr@yourcompany.com.';
  if (Object.keys(errors).length) throw E.validation(errors);
  return { host, port, username, fromEmail, fromName };
}

async function assertPublicHost(host) {
  const list = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new AppError('MAIL_DNS', 'The mail server name could not be found.', 400); });
  if (!allowPrivate() && list.some((a) => isPrivateIp(a.address))) throw new AppError('MAIL_PRIVATE', 'This mail server address is not reachable from RemoteWay.', 400);
}

/** Readable reason from an SMTP error. */
function reason(e) {
  if (e instanceof AppError) return e.message;
  const m = String(e && (e.response || e.message) || e);
  if (e && (e.code === 'EAUTH' || /535|534|authentication|Username and Password not accepted/i.test(m))) {
    return 'The mail server refused the username or password. For Google or Microsoft 365 accounts use an app password.';
  }
  if (e && /ECONNREFUSED|ETIMEDOUT|ESOCKET|ECONNECTION|timeout/i.test(`${e.code} ${m}`)) return 'The mail server could not be reached on this port. Check the server name and try 465 or 587.';
  if (/certificate|self.signed|TLS|SSL/i.test(m)) return 'Secure connection to the mail server failed. Use the server name on its certificate (often your hosting server name).';
  if (/550|553|554|sender|not owned|relay/i.test(m)) return 'The server refused to send from this address. The “from” address must belong to the mailbox you signed in with.';
  return m.replace(/pass(word)?[^\s,;]*/gi, 'password ***').slice(0, 240);
}

/** Saves the mailbox and sends a test message to `testTo`. The mailbox is used only when the test works. */
async function save(ctx, body, { testTo, locale } = {}) {
  const c = clean(body);
  const cur = await knex('organization_mail').where({ organization_id: ctx.organizationId }).first();
  const password = body.password ? String(body.password) : (cur && cur.password_enc ? secrets.decrypt(cur.password_enc) : '');
  if (!password && c.username) throw E.validation({ password: 'Enter the mailbox password.' });
  await assertPublicHost(c.host);
  const org = await knex('organizations').where({ id: ctx.organizationId }).first('name');
  const fromName = c.fromName || org.name;
  const values = {
    host: c.host, port: c.port, username: c.username || null, from_email: c.fromEmail, from_name: fromName,
    ...(body.password ? { password_enc: secrets.encrypt(String(body.password)) } : {}), updated_by: ctx.userId, updated_at: new Date(),
  };
  await knex('organization_mail').insert({ organization_id: ctx.organizationId, ...values, enabled: false }).onConflict('organization_id').merge(values);
  let ok = true; let error = null;
  try {
    const ar = locale === 'ar';
    await mailer.sendTest({
      host: c.host, port: c.port, user: c.username, password, from: `"${fromName}" <${c.fromEmail}>`, locale,
      subject: ar ? `${org.name} — رسالة تجربة من RemoteWay` : `${org.name} — RemoteWay test email`,
      title: ar ? 'بريد المنشأة يعمل' : 'Your company email works',
      body: ar ? 'ستصل رسائل RemoteWay إلى موظفيكم من هذا العنوان.' : 'RemoteWay emails to your people will now come from this address.',
    }, testTo);
  } catch (e) {
    ok = false; error = reason(e);
  }
  await knex('organization_mail').where({ organization_id: ctx.organizationId }).update(ok
    ? { enabled: true, verified_at: new Date(), last_error: null, last_error_at: null }
    : { enabled: false, last_error: error, last_error_at: new Date() });
  mailer.forgetOrg(ctx.organizationId);
  await audit.record(ctx, ok ? 'mail.connected' : 'mail.test_failed', { entityType: 'organization', entityId: ctx.organizationId, newValues: { host: c.host, port: c.port, from: c.fromEmail, error } });
  return { ok, error };
}

async function remove(ctx) {
  await knex('organization_mail').where({ organization_id: ctx.organizationId }).del();
  mailer.forgetOrg(ctx.organizationId);
  await audit.record(ctx, 'mail.disconnected', { entityType: 'organization', entityId: ctx.organizationId });
}

/** Test mode only: marks a mailbox as working without a real server. */
async function markVerifiedForTests(organizationId) {
  await knex('organization_mail').where({ organization_id: organizationId }).update({ enabled: true, verified_at: new Date() });
  mailer.forgetOrg(organizationId);
}

module.exports = { PORTS, PRESETS, get, save, remove, reason, markVerifiedForTests };
