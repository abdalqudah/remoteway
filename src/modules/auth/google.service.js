// Sign in with Google (OpenID Connect, Authorization Code + PKCE, ID token verified locally).
// Set up once by the platform team (Super Admin → Google sign-in) with an OAuth client from Google Cloud.
// • An existing account is found by its Google subject, else by its verified email (then linked).
// • A new address becomes an individual RemoteWay account (profile, no company), email already confirmed.
// • Two-step verification still applies; company SSO enforcement still applies; the platform team cannot use it.
const crypto = require('crypto');
const knex = require('../../db/knex');
const config = require('../../config');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const oidc = require('../sso/oidc');
const { E, AppError } = require('../../core/errors');

const ISSUER = 'https://accounts.google.com';
const redirectUri = () => `${config.appUrl.replace(/\/+$/, '')}/auth/google/callback`;

async function settings() {
  return cache.remember('google:settings', async () => {
    const row = await knex('platform_settings').where({ key: 'google' }).first();
    const v = row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : {};
    return { enabled: Boolean(v.enabled && v.client_id && v.secret_enc), client_id: v.client_id || '', secret_enc: v.secret_enc || null, allow_signup: v.allow_signup !== false };
  }, 60_000);
}
const enabled = async () => (await settings()).enabled;

async function save(ctx, body) {
  const cur = await settings();
  const clientId = String(body.client_id || '').trim();
  const secret = String(body.client_secret || '').trim();
  const on = body.enabled === '1';
  const errors = {};
  if (clientId && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) errors.client_id = 'Paste the Client ID from Google Cloud; it ends with .apps.googleusercontent.com.';
  if (on && !clientId) errors.client_id = 'Enter the Client ID to turn Google sign-in on.';
  if (on && !secret && !cur.secret_enc) errors.client_secret = 'Enter the Client secret to turn Google sign-in on.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const value = JSON.stringify({
    enabled: on, client_id: clientId, secret_enc: secret ? secrets.encrypt(secret) : (clientId ? cur.secret_enc : null), allow_signup: body.allow_signup === '1',
  });
  await knex('platform_settings').insert({ key: 'google', value }).onConflict('key').merge({ value, updated_at: new Date() });
  cache.forgetPrefix('google:');
  await audit.record(ctx, 'platform.google_updated', { newValues: { enabled: on, client_id: clientId, secret: secret ? 'changed' : 'kept' } });
}

/** Starts the Google sign-in; the returned `pending` is kept in the session until the callback. */
async function start({ intent = 'login', next = '', portal = '', as = '' } = {}) {
  const s = await settings();
  if (!s.enabled) throw new AppError('GOOGLE_OFF', 'Google sign-in is not available.', 404);
  const meta = await oidc.discover(ISSUER);
  const state = oidc.b64url(crypto.randomBytes(24));
  const nonce = oidc.b64url(crypto.randomBytes(24));
  const { verifier, challenge } = oidc.pkce();
  const url = new URL(oidc.authorizationUrl(meta, { clientId: s.client_id, redirectUri: redirectUri(), state, nonce, challenge }));
  url.searchParams.set('prompt', 'select_account');
  const safeNext = typeof next === 'string' && /^\/(?![/\\])[\w\-./?=&%]*$/.test(next) ? next.slice(0, 300) : ''; // same-site paths only
  return { url: url.toString(), pending: { state, nonce, verifier, intent: intent === 'join' ? 'join' : 'login', next: safeNext, portal: String(portal || '').slice(0, 60), as: String(as || '').slice(0, 20), createdAt: Date.now() } };
}

/** Verifies Google's answer. Returns the claims (sub, email, name) of a verified Google account. */
let testExchange = null; // tests stand in for Google's token endpoint
const setTestExchange = (fn) => { if (config.isTest) testExchange = fn; };

async function verify(pending, query, { exchange = testExchange } = {}) {
  if (!pending || !query.state || query.state !== pending.state || Date.now() - pending.createdAt > 15 * 60_000) {
    throw new AppError('GOOGLE_STATE', 'This sign-in link has expired. Please start again.', 400);
  }
  if (query.error) throw new AppError('GOOGLE_CANCELLED', 'Google sign-in was cancelled.', 400);
  const s = await settings();
  if (!s.enabled) throw new AppError('GOOGLE_OFF', 'Google sign-in is not available.', 404);
  let claims;
  try {
    if (exchange) claims = await exchange(pending, query); // tests
    else {
      const meta = await oidc.discover(ISSUER);
      const tokens = await oidc.exchangeCode(meta, { clientId: s.client_id, clientSecret: secrets.decrypt(s.secret_enc) || '', code: String(query.code || ''), redirectUri: redirectUri(), verifier: pending.verifier });
      claims = await oidc.verifyIdToken(meta, tokens.id_token, { clientId: s.client_id, nonce: pending.nonce });
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('GOOGLE_FAILED', `Google sign-in failed: ${String(e.message).slice(0, 160)}`, 400);
  }
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || !(claims.email_verified === true || claims.email_verified === 'true')) throw new AppError('GOOGLE_NO_EMAIL', 'Your Google account did not share a verified email address.', 400);
  if (!claims.sub) throw new AppError('GOOGLE_FAILED', 'Google sign-in failed: no account id.', 400);
  return { sub: String(claims.sub), email, name: typeof claims.name === 'string' ? claims.name.trim().slice(0, 120) : '' };
}

/** Finds, links or creates the RemoteWay account for a verified Google identity. */
async function resolve(g, { locale, ip } = {}) {
  let user = await knex('users').where({ google_sub: g.sub }).first();
  let created = false;
  if (!user) {
    user = await knex('users').where({ email: g.email }).first();
    if (user && user.google_sub && user.google_sub !== g.sub) throw new AppError('GOOGLE_OTHER', 'This RemoteWay account is linked to a different Google account.', 409);
  }
  if (user) {
    if (user.deleted_at || user.status !== 'active') throw new AppError('ACCOUNT_DISABLED', 'This account is disabled.', 403);
    // The platform team signs in with a password and two-step verification only.
    if (user.is_super_admin) throw new AppError('GOOGLE_NOT_ALLOWED', 'Platform team accounts cannot sign in with Google.', 403);
    await require('../sso/sso.service').assertPasswordAllowed(user); // eslint-disable-line global-require
    const values = { last_login_at: new Date() };
    if (!user.google_sub) values.google_sub = g.sub;
    await knex('users').where({ id: user.id }).update(values);
    await require('./verify.service').markVerified(user.id, 'google'); // eslint-disable-line global-require
    if (!user.google_sub) await audit.record({ userId: user.id, ip }, 'auth.google_linked', { entityType: 'user', entityId: user.id });
  } else {
    if (!(await settings()).allow_signup) throw new AppError('GOOGLE_NO_ACCOUNT', 'There is no RemoteWay account with this email. Ask your company for an invitation.', 404);
    user = await require('../talent/profile.service').signupWithGoogle({ name: g.name, email: g.email, sub: g.sub, locale }, { ip }); // eslint-disable-line global-require
    created = true;
  }
  await audit.record({ userId: user.id, ip }, 'auth.google_login', { entityType: 'user', entityId: user.id });
  return { user: await knex('users').where({ id: user.id }).first(), created };
}

async function unlink(ctx, userId) {
  await knex('users').where({ id: userId }).update({ google_sub: null });
  await audit.record(ctx, 'auth.google_unlinked', { entityType: 'user', entityId: userId });
}

module.exports = { setTestExchange, ISSUER, redirectUri, settings, enabled, save, start, verify, resolve, unlink };
