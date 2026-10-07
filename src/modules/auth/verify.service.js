// Email verification. A new account gets a one-time link (valid 48 hours). Until the address is
// confirmed the account works, but it cannot invite people or apply to jobs, and after 7 days it
// must confirm before continuing. Following an invitation, a password-reset link or a company's
// single sign-on also proves the address.
const crypto = require('crypto');
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const messages = require('../../core/messages');
const { sha256 } = require('../../core/tokens');
const { AppError } = require('../../core/errors');

const HOURS = 48;
const GRACE_DAYS = 7;
const MAX_PER_HOUR = 3;

/** Verification only makes sense when the platform can send email. */
const required = () => config.isTest || Boolean(mailer.currentConfig());
const isVerified = (user) => Boolean(user && (user.email_verified_at || user.is_super_admin));
const graceOver = (user) => Date.now() - new Date(user.created_at || Date.now()).getTime() > GRACE_DAYS * 86400_000;
/** The account must confirm its email before going on (grace period over). */
const mustVerifyNow = (user) => Boolean(user && required() && !isVerified(user) && graceOver(user));

async function send(user, { locale } = {}) {
  if (!user || isVerified(user)) return false;
  const [{ n }] = await knex('email_verifications').where({ user_id: user.id }).where('created_at', '>=', new Date(Date.now() - 3600_000)).count({ n: '*' });
  if (Number(n) >= MAX_PER_HOUR) throw new AppError('TOO_MANY_ATTEMPTS', 'We already sent several links. Check your inbox (and spam) or try again in an hour.', 429);
  const token = crypto.randomBytes(32).toString('hex');
  await knex('email_verifications').insert({ user_id: user.id, email: user.email, token_hash: sha256(token), expires_at: new Date(Date.now() + HOURS * 3600_000) });
  const lang = user.locale || locale || 'en';
  const m = await messages.compose('verify_email', lang, { name: user.name, hours: HOURS, app: 'RemoteWay' });
  await mailer.send({ kind: 'verify_email',
    to: user.email, subject: m.subject,
    html: mailer.layout({ locale: lang, title: m.title, body: m.body, cta: m.cta, href: `${config.appUrl.replace(/\/+$/, '')}/verify-email/${token}` }),
  }).catch((e) => console.error('[mail] verification failed:', e.message)); // eslint-disable-line no-console
  return true;
}

/** Marks the address as confirmed (also used when an invitation, reset link or SSO proves it). */
async function markVerified(userId, how, trx = knex) {
  const n = await trx('users').where({ id: userId }).whereNull('email_verified_at').update({ email_verified_at: new Date() });
  if (n) await audit.record({ userId }, 'auth.email_verified', { entityType: 'user', entityId: userId, newValues: { how } }, trx);
}

/** Confirms a link. Returns the user, or throws when the link is invalid or expired. */
async function confirm(token) {
  const row = await knex('email_verifications').where({ token_hash: sha256(String(token || '')) }).whereNull('used_at').where('expires_at', '>', new Date()).first();
  const user = row && await knex('users').where({ id: row.user_id }).first();
  // The link only counts for the address it was sent to.
  if (!user || user.email.toLowerCase() !== row.email.toLowerCase()) throw new AppError('VERIFY_INVALID', 'This link has expired or was already used. Sign in and send a new one.', 404);
  await knex('email_verifications').where({ user_id: user.id }).whereNull('used_at').update({ used_at: new Date() });
  await markVerified(user.id, 'link');
  return knex('users').where({ id: user.id }).first();
}

/** Throws for actions that need a confirmed address (inviting people, applying to jobs). */
function assertVerified(user) {
  if (required() && !isVerified(user)) throw new AppError('EMAIL_NOT_VERIFIED', 'Confirm your email address first — we sent you a link. You can send a new one from the banner at the top.', 409);
}

module.exports = { required, isVerified, mustVerifyNow, send, confirm, markVerified, assertVerified, HOURS, GRACE_DAYS };
