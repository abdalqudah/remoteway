// SMTP core shared by the platform email (Super Admin → Email) and company mailboxes (Settings → Email).
// Works with any SMTP server: providers are only presets that fill the form and can be changed.
//
// Settings (normalized):
//   { provider, host, port, security: 'none'|'starttls'|'ssl', authentication: 'password'|'none',
//     username, password, fromEmail, fromName, replyTo }
// security → nodemailer:  none → secure:false, requireTLS:false
//                         starttls → secure:false, requireTLS:true
//                         ssl → secure:true
// authentication 'none' (IP allowlist / relay) → no `auth` key at all.

const PRESETS = {
  custom: { host: '', port: 587, security: 'starttls', authentication: 'password' },
  gmail: { host: 'smtp.gmail.com', port: 587, security: 'starttls', authentication: 'password' },
  google_relay: { host: 'smtp-relay.gmail.com', port: 587, security: 'starttls', authentication: 'none' },
  microsoft365: { host: 'smtp.office365.com', port: 587, security: 'starttls', authentication: 'password' },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls', authentication: 'password' },
  cpanel: { host: '', port: 465, security: 'ssl', authentication: 'password' }, // host is the hosting's mail server
};
const PROVIDERS = Object.keys(PRESETS);
const SECURITY = ['none', 'starttls', 'ssl'];
const AUTH = ['password', 'none'];
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** Security when it was never stored (settings saved before it existed): the port decides, as before. */
const securityFromPort = (port) => (Number(port) === 465 ? 'ssl' : Number(port) === 587 ? 'starttls' : 'none');

/** "Name <email>" → { name, email } (legacy `from` field). */
function parseFrom(from) {
  const s = String(from || '').trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: '', email: EMAIL_RE.test(s) ? s : '' };
}

/**
 * Canonical settings from anything stored before or now (platform JSON, company row, env).
 * Legacy keys: user → username, from → fromName/fromEmail, missing security → from port,
 * missing authentication → 'password' when a username exists, else 'none'.
 */
function normalize(raw = {}) {
  const rawPort = raw.port !== undefined && raw.port !== null && String(raw.port).trim() !== '' ? raw.port : raw.smtp_port;
  const port = rawPort === undefined || rawPort === null || String(rawPort).trim() === '' ? 587 : Number(rawPort);
  const username = String(raw.username ?? raw.user ?? '').trim();
  const legacy = parseFrom(raw.from);
  const security = SECURITY.includes(raw.security) ? raw.security : securityFromPort(port);
  const authentication = AUTH.includes(raw.authentication) ? raw.authentication : (AUTH.includes(raw.auth_mode) ? raw.auth_mode : (username ? 'password' : 'none'));
  return {
    provider: PROVIDERS.includes(raw.provider) ? raw.provider : 'custom',
    host: String(raw.host || raw.smtp_host || '').trim(),
    port,
    security,
    authentication,
    username: authentication === 'password' ? username : '',
    password: authentication === 'password' ? (raw.password || '') : '',
    fromEmail: String(raw.fromEmail || raw.from_email || legacy.email || (EMAIL_RE.test(username) ? username : '')).trim(),
    fromName: String(raw.fromName ?? raw.from_name ?? legacy.name ?? '').trim(),
    replyTo: String(raw.replyTo || raw.reply_to || '').trim(),
  };
}

/** Env fallback (used only when nothing is saved in the admin panel). */
function fromEnv(env = process.env) {
  if (!env.SMTP_HOST) return null;
  return normalize({
    provider: 'custom',
    host: env.SMTP_HOST,
    port: env.SMTP_PORT || 465,
    security: String(env.SMTP_SECURITY || '').toLowerCase().replace('ssl/tls', 'ssl').replace('tls', 'ssl') || undefined,
    authentication: env.SMTP_AUTH ? (/^(none|relay|ip)$/i.test(env.SMTP_AUTH) ? 'none' : 'password') : undefined,
    username: env.SMTP_USERNAME || env.SMTP_USER || '',
    password: env.SMTP_PASSWORD || '',
    from: env.SMTP_FROM || env.MAIL_FROM || '',
    fromName: env.SMTP_FROM_NAME || undefined,
    replyTo: env.SMTP_REPLY_TO || '',
  });
}

/** nodemailer options for these settings (no `auth` key at all without authentication). */
function transportOptions(settings, { timeoutMs = 15_000 } = {}) {
  const s = normalize(settings);
  const opts = {
    host: s.host,
    port: s.port,
    secure: s.security === 'ssl',
    requireTLS: s.security === 'starttls',
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs * 2,
    tls: { servername: HOST_RE.test(s.host) && !/^\d+\.\d+\.\d+\.\d+$/.test(s.host) ? s.host : undefined },
  };
  if (s.authentication === 'password' && s.username) opts.auth = { user: s.username, pass: s.password || '' };
  return opts;
}

function createSmtpTransporter(settings, opts) {
  // eslint-disable-next-line global-require
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport(transportOptions(settings, opts));
}

/** "Name" <email> header from the settings (display name quoted and cleaned). */
function fromHeader(settings, fallbackName = '') {
  const s = normalize(settings);
  const name = String(s.fromName || fallbackName || '').replace(/["\\\r\n<>]/g, '').slice(0, 120);
  return name ? `"${name}" <${s.fromEmail}>` : s.fromEmail;
}

/**
 * Checks what is typed in the form. Returns { errors, warnings } (warnings never block saving).
 */
function validate(input, { requireFrom = true, passwordKnown = false } = {}) {
  const s = normalize(input);
  const errors = {};
  const warnings = [];
  if (!HOST_RE.test(s.host) && !/^\[?[0-9a-f:.]+\]?$/i.test(s.host)) errors.host = 'Enter the SMTP server name, e.g. smtp.example.com.';
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) errors.port = 'Enter a port between 1 and 65535 (usually 25, 465 or 587).';
  if (s.authentication === 'password') {
    if (!s.username) errors.username = 'Enter the SMTP username (usually the full email address).';
    if (!s.password && !passwordKnown) errors.password = 'Enter the SMTP password or app password.';
  }
  if (requireFrom && !EMAIL_RE.test(s.fromEmail)) errors.from_email = 'Enter the address emails are sent from, e.g. no-reply@example.com.';
  if (s.replyTo && !EMAIL_RE.test(s.replyTo)) errors.reply_to = 'Enter a valid Reply-To address or leave it empty.';
  if (s.security === 'ssl' && s.port === 587) warnings.push('port587_ssl');
  if (s.security !== 'ssl' && s.port === 465) warnings.push('port465_not_ssl');
  if (s.security === 'none' && s.authentication === 'password') warnings.push('password_without_tls');
  if (s.authentication === 'password' && s.username && EMAIL_RE.test(s.username) && s.fromEmail && s.fromEmail.toLowerCase() !== s.username.toLowerCase()) warnings.push('from_differs');
  return { errors, warnings, settings: s };
}

/**
 * Turns an SMTP/network error into something an admin can act on.
 * Returns { kind, code, message, hints[], detail } — `detail` is the server's own text (no secrets).
 */
function explain(err, settings = {}) {
  const e = err || {};
  const rc = Number(e.responseCode || 0);
  const text = `${e.message || ''} ${e.response || ''}`;
  // Nodemailer wraps network errors as ESOCKET / ECONNECTION: report the underlying system code.
  const inner = (text.match(/\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EPIPE|EHOSTUNREACH|ENETUNREACH)\b/) || [])[1];
  const code = (!e.code || /^(ESOCKET|ECONNECTION|EDNS)$/.test(e.code)) && inner ? inner : String(e.code || '');
  const detail = text.replace(/(pass(word)?|pwd)\s*[:=]\s*\S+/gi, '$1=***').trim().slice(0, 400);
  const pick = (kind, message, hints) => ({ kind, code: code || (rc ? String(rc) : ''), responseCode: rc || null, message, hints, detail, host: settings.host, port: settings.port });
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo/i.test(text)) {
    return pick('dns', 'The SMTP server name could not be found.', ['Check the SMTP host for typos.', 'Make sure the domain has DNS records for this server.']);
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return pick('refused', 'Connection refused. The server rejected the TCP connection.', ['Check the SMTP host and port.', 'Check the firewall.', 'Some hosting providers block outgoing SMTP ports (25, 465, 587).']);
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timed? ?out|Greeting never received/i.test(text)) {
    return pick('timeout', 'The connection timed out.', ['The port may be blocked by a firewall or by the hosting provider.', 'Check the host and port.', 'For a relay, make sure this server’s IP is allowed.', 'If it stops after STARTTLS or SSL, the security mode may not match the port.']);
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return pick('reset', 'The server closed the connection.', ['This often means the security mode does not match the port (SSL/TLS on 465, STARTTLS on 587).', 'The server may also refuse this IP address.']);
  }
  if (/CERT|self.signed|unable to verify|altname|certificate/i.test(code + text)) {
    return pick('certificate', 'The server’s TLS certificate is not valid for this host name.', ['Use the host name written on the server’s certificate (often your hosting server name, e.g. server1.host.com).', 'Check the system clock of the server.']);
  }
  if (rc === 530 || /5\.7\.0|Must issue a STARTTLS|Authentication Required/i.test(text)) {
    return pick('auth_required', 'The server requires authentication or encryption first.', ['Choose STARTTLS or SSL/TLS.', 'Choose “Username & Password”, or add this server’s IP to the relay allowlist.']);
  }
  if (/wrong version number|unknown protocol|SSL routines|ssl3_get_record|EPROTO|TLS|STARTTLS/i.test(code + text) || code === 'ETLS') {
    return pick('tls', 'TLS connection failed.', ['Check the port and the security mode.', 'Port 465 normally uses SSL/TLS, port 587 uses STARTTLS, port 25 often none.']);
  }
  if (code === 'EAUTH' || rc === 535 || rc === 534 || /authentication|Username and Password not accepted|AUTH/i.test(text)) {
    return pick('auth', 'SMTP authentication failed.', ['Check the username and password.', 'For Google or Microsoft 365 use an app password, or allow SMTP authentication for the mailbox.', 'If the server uses an IP allowlist (relay), choose “None / IP authentication”.']);
  }
  if (rc === 550 || rc === 553 || rc === 554 || /relay|sender|not owned|not allowed to send|Mail from/i.test(text)) {
    return pick('rejected', 'The server rejected the message (sender or relay not allowed).', ['The From address must be allowed for this account (same mailbox or a verified alias).', 'For a relay, the server’s IP and the sending domain must be allowed.']);
  }
  if (code === 'EENVELOPE') return pick('envelope', 'The sender or recipient address was refused.', ['Check the From address and the test recipient.']);
  return pick('other', 'The SMTP server returned an error.', ['See the server’s message below.']);
}

/** Opens a connection and checks it (EHLO, TLS, login) without sending anything. */
async function verifyConnection(settings, opts) {
  const s = normalize(settings);
  const started = Date.now();
  const t = createSmtpTransporter(s, opts);
  // One overall limit: a host with several addresses is otherwise tried address by address.
  const limit = ((opts && opts.timeoutMs) || 15_000) * 2;
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' })), limit); });
  try {
    await Promise.race([t.verify(), deadline]);
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: explain(err, s) };
  } finally {
    clearTimeout(timer);
    t.close();
  }
}

/** Verifies the connection, then sends one test message. */
async function sendTestEmail(settings, to, content = {}, opts) {
  const s = normalize(settings);
  const conn = await verifyConnection(s, opts);
  if (!conn.ok) return { ok: false, stage: 'connect', error: conn.error };
  const t = createSmtpTransporter(s, opts);
  try {
    const info = await t.sendMail({
      from: fromHeader(s, content.fallbackName), to, replyTo: s.replyTo || undefined,
      subject: content.subject || 'SMTP test email', html: content.html || '<p>SMTP settings are working.</p>',
    });
    return { ok: true, stage: 'sent', messageId: info && info.messageId, accepted: info && info.accepted };
  } catch (err) {
    return { ok: false, stage: 'send', error: explain(err, s) };
  } finally {
    t.close();
  }
}

/** A copy safe to show or return from an API: never the password. */
function masked(settings, { hasPassword } = {}) {
  const s = normalize(settings);
  const known = hasPassword !== undefined ? hasPassword : Boolean(s.password);
  return {
    provider: s.provider, smtpHost: s.host, smtpPort: s.port, security: s.security, authentication: s.authentication,
    smtpUsername: s.username, smtpPassword: s.authentication === 'password' && known ? '********' : '', fromEmail: s.fromEmail, fromName: s.fromName, replyTo: s.replyTo,
  };
}

module.exports = { PRESETS, PROVIDERS, SECURITY, AUTH, normalize, fromEnv, transportOptions, createSmtpTransporter, fromHeader, validate, explain, verifyConnection, sendTestEmail, masked, securityFromPort, parseFrom };

// ---------- Diagnostic log (no passwords, no message contents) ----------
/** Records one SMTP check or failure; keeps the last 200 per scope/company. */
async function logEvent({ scope = 'platform', organizationId = null, action, settings = {}, ok, error, ms, userId }) {
  try {
    const knex = require('../db/knex'); // eslint-disable-line global-require
    const s = normalize(settings);
    await knex('smtp_events').insert({
      scope, organization_id: organizationId, action, provider: s.provider, host: String(s.host || '').slice(0, 190), port: s.port || null,
      security: s.security, auth_mode: s.authentication, success: Boolean(ok), error_code: error ? String(error.code || '').slice(0, 40) || null : null,
      error_kind: error ? error.kind : null, error_message: error ? String(error.detail || error.message || '').slice(0, 500) : null, duration_ms: ms || null, user_id: userId || null,
    });
    const old = await knex('smtp_events').where({ scope }).andWhere((q) => (organizationId ? q.where({ organization_id: organizationId }) : q.whereNull('organization_id')))
      .orderBy('id', 'desc').offset(200).pluck('id');
    if (old.length) await knex('smtp_events').whereIn('id', old).del();
    // eslint-disable-next-line no-console
    if (!ok) console.error(`[smtp] ${scope}${organizationId ? `#${organizationId}` : ''} ${action} ${s.host}:${s.port} ${s.security}/${s.authentication} failed: ${error ? `${error.code || error.kind} ${error.message}` : ''}`);
  } catch { /* logging must never break sending */ }
}

async function recentEvents({ scope = 'platform', organizationId = null, limit = 10 } = {}) {
  const knex = require('../db/knex'); // eslint-disable-line global-require
  return knex('smtp_events').where({ scope }).andWhere((q) => (organizationId ? q.where({ organization_id: organizationId }) : q.whereNull('organization_id')))
    .orderBy('id', 'desc').limit(limit);
}

module.exports.logEvent = logEvent;
module.exports.recentEvents = recentEvents;
