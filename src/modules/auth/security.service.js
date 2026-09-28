// Account security: password reset by email and two-factor authentication (TOTP + recovery codes).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const secrets = require('../../core/secrets');
const totp = require('../../core/totp');
const { translator } = require('../../core/i18n');
const { sha256 } = require('../../core/tokens');
const { AppError, E } = require('../../core/errors');

const RESET_MINUTES = 60;

// ---------- Password reset ----------
/** Always behaves the same whether or not the email exists (no account enumeration). */
async function requestReset(email, { ip, locale } = {}) {
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw E.validation({ email: 'Enter a valid email address.' });
  const user = await knex('users').where({ email: mail, status: 'active' }).whereNull('deleted_at').first('id', 'name', 'locale');
  if (!user) return;
  // At most 3 requests per hour per account
  const [{ n }] = await knex('password_resets').where({ user_id: user.id }).where('created_at', '>=', new Date(Date.now() - 3600_000)).count({ n: '*' });
  if (Number(n) >= 3) return;
  const token = crypto.randomBytes(32).toString('hex');
  await knex('password_resets').insert({ user_id: user.id, token_hash: sha256(token), expires_at: new Date(Date.now() + RESET_MINUTES * 60_000), ip: ip ? String(ip).slice(0, 64) : null });
  const t = translator(user.locale || locale || 'en');
  await mailer.send({
    to: mail, subject: `RemoteWay — ${t('auth.reset_subject')}`,
    html: mailer.layout({ locale: user.locale || locale, title: t('auth.reset_subject'), body: t('auth.reset_body', { minutes: RESET_MINUTES }), cta: t('auth.reset_cta'), href: `${config.appUrl.replace(/\/+$/, '')}/reset/${token}` }),
  }).catch((e) => console.error('[mail] reset failed:', e.message)); // eslint-disable-line no-console
  await audit.record({ userId: user.id, ip }, 'auth.password_reset_requested', { entityType: 'user', entityId: user.id });
}

async function findReset(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  const r = await knex('password_resets').where({ token_hash: sha256(token) }).whereNull('used_at').where('expires_at', '>', new Date()).first();
  return r || null;
}

/** Ends every session of a user (after a password reset, or when their access is removed). */
async function endSessions(userId, exceptSid) {
  const rows = await knex('sessions').where('sess', 'like', `%"userId":${Number(userId)},%`).orWhere('sess', 'like', `%"userId":${Number(userId)}}%`).select('sid');
  const ids = rows.map((r) => r.sid).filter((sid) => sid !== exceptSid);
  if (ids.length) await knex('sessions').whereIn('sid', ids).del();
  return ids.length;
}

async function resetPassword(token, password, confirm, { ip } = {}) {
  const r = await findReset(token);
  if (!r) throw new AppError('RESET_INVALID', 'This link has expired or was already used. Request a new one.', 404);
  if (String(password || '').length < 8) throw E.validation({ password: 'Password must be at least 8 characters.' });
  if (password !== confirm) throw E.validation({ password_confirm: 'The passwords do not match.' });
  await knex.transaction(async (trx) => {
    await trx('users').where({ id: r.user_id }).update({ password_hash: await bcrypt.hash(password, config.bcryptRounds), password_changed_at: new Date() });
    await trx('password_resets').where({ user_id: r.user_id }).whereNull('used_at').update({ used_at: new Date() });
  });
  await endSessions(r.user_id);
  await audit.record({ userId: r.user_id, ip }, 'auth.password_reset', { entityType: 'user', entityId: r.user_id });
}

// ---------- Two-factor authentication ----------
const hasTwoFactor = (user) => Boolean(user && user.two_factor_enabled_at && user.two_factor_secret_enc);

async function setupData(user, secret) {
  const url = totp.otpauthUrl(secret, user.email);
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 200, errorCorrectionLevel: 'M' });
  return { secret, url, svg };
}

function newRecoveryCodes() {
  return Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').replace(/(.{5})(.{5})/, '$1-$2'));
}

async function enable(user, secret, code) {
  if (hasTwoFactor(user)) throw E.conflict('TWO_FACTOR_ON', 'Two-factor authentication is already on.');
  const step = totp.verify(secret, code);
  if (step === null) throw E.validation({ code: 'That code is not right. Check the time on your phone and try again.' });
  const codes = newRecoveryCodes();
  await knex('users').where({ id: user.id }).update({
    two_factor_secret_enc: secrets.encrypt(secret), two_factor_enabled_at: new Date(), two_factor_last_step: step,
    two_factor_recovery: JSON.stringify(codes.map((c) => sha256(c))),
  });
  await audit.record({ userId: user.id }, 'auth.2fa_enabled', { entityType: 'user', entityId: user.id });
  return codes;
}

async function disable(user, password, { byAdmin } = {}) {
  if (!byAdmin && !(await bcrypt.compare(String(password || ''), user.password_hash))) throw E.validation({ password: 'Current password is incorrect.' });
  await knex('users').where({ id: user.id }).update({ two_factor_secret_enc: null, two_factor_enabled_at: null, two_factor_recovery: null, two_factor_last_step: null });
  await audit.record({ userId: byAdmin || user.id }, 'auth.2fa_disabled', { entityType: 'user', entityId: user.id });
}

/** Checks a 6-digit code or a one-time recovery code at sign-in. */
async function verifyLogin(userId, input) {
  const user = await knex('users').where({ id: userId }).first();
  if (!hasTwoFactor(user)) return true;
  // Per account (not only per IP): 5 wrong codes lock the second step for 15 minutes.
  const [{ n }] = await knex('audit_logs').where({ user_id: user.id, action: 'auth.2fa_failed' }).where('created_at', '>=', new Date(Date.now() - 15 * 60_000)).count({ n: '*' });
  if (Number(n) >= 5) throw new AppError('TOO_MANY_ATTEMPTS', 'Too many wrong codes. Wait 15 minutes and try again.', 429);
  const raw = String(input || '').trim();
  const secret = secrets.decrypt(user.two_factor_secret_enc);
  const step = secret ? totp.verify(secret, raw) : null;
  if (step !== null) {
    if (user.two_factor_last_step != null && step <= Number(user.two_factor_last_step)) throw E.validation({ code: 'This code was already used. Wait for the next one.' });
    await knex('users').where({ id: user.id }).update({ two_factor_last_step: step });
    return true;
  }
  const hashes = (typeof user.two_factor_recovery === 'string' ? JSON.parse(user.two_factor_recovery) : user.two_factor_recovery) || [];
  const h = sha256(raw.toLowerCase());
  if (/^[a-f0-9]{5}-[a-f0-9]{5}$/i.test(raw) && hashes.includes(h)) {
    await knex('users').where({ id: user.id }).update({ two_factor_recovery: JSON.stringify(hashes.filter((x) => x !== h)) });
    await audit.record({ userId: user.id }, 'auth.2fa_recovery_used', { entityType: 'user', entityId: user.id, newValues: { remaining: hashes.length - 1 } });
    return true;
  }
  await audit.record({ userId: user.id }, 'auth.2fa_failed', { entityType: 'user', entityId: user.id });
  throw E.validation({ code: 'That code is not right.' });
}

async function setRequireAdmin2fa(ctx, on) {
  const value = JSON.stringify({ require_admin_2fa: Boolean(on) });
  await knex('platform_settings').insert({ key: 'security', value }).onConflict('key').merge({ value, updated_at: new Date() });
  await audit.record(ctx, 'platform.security_updated', { newValues: { require_admin_2fa: Boolean(on) } });
}

/** A teammate lost their phone: the platform owner turns their 2FA off so they can set it up again. */
async function resetForUser(ctx, userId) {
  const user = await knex('users').where({ id: userId, is_super_admin: true }).first();
  if (!user) throw E.notFound('User');
  await disable(user, null, { byAdmin: true });
  await endSessions(user.id);
  await audit.record(ctx, 'auth.2fa_reset', { entityType: 'user', entityId: user.id });
}

async function requireAdmin2fa() {
  const row = await knex('platform_settings').where({ key: 'security' }).first();
  const v = row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : {};
  return Boolean(v.require_admin_2fa);
}

module.exports = { requestReset, findReset, resetPassword, endSessions, hasTwoFactor, setupData, enable, disable, verifyLogin, requireAdmin2fa, setRequireAdmin2fa, resetForUser, generateSecret: totp.generateSecret };
