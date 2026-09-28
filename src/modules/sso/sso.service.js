// Single sign-on per organization (OpenID Connect). Company admins configure their identity provider;
// members then sign in with their work account. Optional: create accounts on first sign-in (JIT) and
// require SSO for members (owners keep their password as a break-glass login).
const crypto = require('crypto');
const knex = require('../../db/knex');
const config = require('../../config');
const secrets = require('../../core/secrets');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { validateUrl } = require('../../core/http');
const { E, AppError } = require('../../core/errors');
const ent = require('../billing/entitlements.service');
const rbac = require('../rbac/rbac.service');
const oidc = require('./oidc');

const DOMAIN_RE = /^(?=.{3,190}$)([a-z0-9-]+\.)+[a-z]{2,}$/;
const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const redirectUri = () => `${config.appUrl.replace(/\/+$/, '')}/sso/callback`;

async function get(organizationId) {
  const row = await knex('sso_connections').where({ organization_id: organizationId }).first();
  if (!row) return null;
  return { ...row, domains: parse(row.domains, []), hasSecret: Boolean(row.client_secret_enc) };
}

function parseDomains(raw) {
  return [...new Set(String(raw || '').toLowerCase().split(/[\s,;]+/).map((d) => d.replace(/^@/, '').trim()).filter(Boolean))];
}

async function save(ctx, input) {
  await ent.assertFeature(ctx.organizationId, 'sso');
  const before = await get(ctx.organizationId);
  const errors = {};
  const issuer = String(input.issuer || '').trim().replace(/\/+$/, '');
  const check = validateUrl(issuer);
  if (!issuer || check.error) errors.issuer = check.error || 'Enter the issuer URL from your identity provider.';
  const clientId = String(input.client_id || '').trim();
  if (!clientId || clientId.length > 255) errors.client_id = 'Enter the client (application) ID.';
  const secret = String(input.client_secret || '').trim();
  if (!secret && !(before && before.hasSecret)) errors.client_secret = 'Enter the client secret.';
  const domains = parseDomains(input.domains);
  if (!domains.length) errors.domains = 'Add at least one email domain, e.g. company.com.';
  else if (domains.some((d) => !DOMAIN_RE.test(d))) errors.domains = 'Use domains like company.com, separated by commas.';
  const roleKey = String(input.default_role || 'employee');
  const role = await rbac.getRoleByKey(ctx.organizationId, roleKey);
  if (!role || roleKey === 'owner') errors.default_role = 'Choose a role.';
  if (Object.keys(errors).length) throw E.validation(errors);
  // Another company may not claim the same domain.
  const taken = await knex('sso_connections').whereNot('organization_id', ctx.organizationId)
    .where((q) => { for (const d of domains) q.orWhereRaw('JSON_CONTAINS(domains, JSON_QUOTE(?))', [d]); }).first('organization_id');
  if (taken) throw E.validation({ domains: 'One of these domains is already used by another company.' });
  try {
    await oidc.discover(issuer);
  } catch (e) {
    throw E.validation({ issuer: `Could not read the provider settings from this issuer (${String(e.message).slice(0, 150)}).` });
  }
  const changed = !before || before.issuer !== issuer || before.client_id !== clientId || Boolean(secret);
  const enabled = input.enabled === 'on' || input.enabled === true;
  // Turning SSO on is for paying customers only (not trials or unpaid sign-ups): a company's identity
  // provider decides who can sign in, so the company must be a known, billed customer.
  if (enabled) {
    const sub = await knex('subscriptions').where({ organization_id: ctx.organizationId }).first('status');
    if (!sub || sub.status !== 'active') throw E.conflict('SSO_NEEDS_ACTIVE', 'Single sign-on can be turned on once the subscription is active (paid). Contact us if you need it during a trial.');
  }
  const verifiedAt = changed ? null : before.verified_at;
  let enforce = input.enforce === 'on' || input.enforce === true;
  if (enforce && (!verifiedAt || !enabled)) throw E.validation({ enforce: 'Run a successful test sign-in before requiring SSO.' });
  if (!enabled) enforce = false;
  const row = {
    protocol: 'oidc', issuer, client_id: clientId, domains: JSON.stringify(domains), enabled, enforce,
    jit: input.jit === 'on' || input.jit === true, default_role: roleKey, verified_at: verifiedAt, updated_by: ctx.userId, updated_at: new Date(),
    ...(secret ? { client_secret_enc: secrets.encrypt(secret) } : {}),
  };
  await knex('sso_connections').insert({ organization_id: ctx.organizationId, ...row }).onConflict('organization_id').merge(row);
  await audit.record(ctx, 'sso.updated', { entityType: 'organization', entityId: ctx.organizationId, newValues: { issuer, domains, enabled, enforce, jit: row.jit } });
}

async function remove(ctx) {
  await knex('sso_connections').where({ organization_id: ctx.organizationId }).del();
  await audit.record(ctx, 'sso.removed', { entityType: 'organization', entityId: ctx.organizationId });
}

/** The enabled connection that owns an email's domain, if any. */
async function forEmail(email) {
  const domain = String(email || '').toLowerCase().split('@')[1];
  if (!domain) return null;
  const row = await knex('sso_connections as s').join('organizations as o', 'o.id', 's.organization_id')
    .where({ 's.enabled': true, 'o.status': 'active' }).whereRaw('JSON_CONTAINS(s.domains, JSON_QUOTE(?))', [domain]).first('s.organization_id');
  return row ? row.organization_id : null;
}

/**
 * Starts a sign-in. Returns the provider URL and the state to keep in the session.
 * @param {object} opts {test: userId of the admin running a test, loginHint}
 */
async function start(organizationId, { test = null, loginHint = null } = {}) {
  const conn = await get(organizationId);
  if (!conn || (!conn.enabled && !test)) throw new AppError('SSO_NOT_ENABLED', 'Single sign-on is not enabled for this company.', 404);
  if (!(await ent.hasFeature(organizationId, 'sso'))) throw E.featureNotInPlan('sso');
  const meta = await oidc.discover(conn.issuer);
  const state = oidc.b64url(crypto.randomBytes(24));
  const nonce = oidc.b64url(crypto.randomBytes(24));
  const { verifier, challenge } = oidc.pkce();
  const url = oidc.authorizationUrl(meta, { clientId: conn.client_id, redirectUri: redirectUri(), state, nonce, challenge, loginHint });
  return { url, pending: { state, nonce, verifier, organizationId, test, createdAt: Date.now() } };
}

async function isOwner(organizationId, userId, trx = knex) {
  const r = await trx('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id')
    .where({ 'ur.organization_id': organizationId, 'ur.user_id': userId, 'r.key': 'owner' }).first('ur.user_id');
  return Boolean(r);
}

async function resolveUser(conn, claims, email) {
  return knex.transaction(async (trx) => {
    const orgId = conn.organization_id;
    const identity = await trx('user_identities').where({ issuer: claims.iss, subject: String(claims.sub) }).first();
    let user = identity ? await trx('users').where({ id: identity.user_id }).first() : await trx('users').where({ email }).first();
    if (user && user.status !== 'active') throw new AppError('ACCOUNT_DISABLED', 'This account is disabled.', 403);
    // A company's identity provider must never be able to sign in as the platform team.
    if (user && user.is_super_admin) throw new AppError('SSO_NOT_ALLOWED', 'Platform team accounts cannot use company single sign-on.', 403);
    let membership = user ? await trx('memberships').where({ organization_id: orgId, user_id: user.id }).first() : null;
    // An existing RemoteWay account is only linked when it already belongs to this company (it accepted an
    // invitation). Otherwise any company could claim a domain and take over other people's accounts.
    if (user && !identity && !membership) throw new AppError('SSO_ACCOUNT_EXISTS', 'An account with this email already exists. Ask your administrator for an invitation, accept it, then sign in with single sign-on.', 403);
    if (membership && membership.status !== 'active') throw new AppError('SSO_NOT_MEMBER', 'Your access to this company is disabled. Ask your administrator.', 403);
    if (!membership) {
      if (!conn.jit) throw new AppError('SSO_NOT_MEMBER', 'You do not have an account in this company yet. Ask your administrator for an invitation.', 403);
      await ent.lockSubscription(orgId, trx);
      await ent.assertWithinLimit(orgId, 'users', 1, trx);
      if (!user) {
        const name = String(claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || email.split('@')[0]).slice(0, 120);
        const [id] = await trx('users').insert({ name, email, password_hash: `!sso:${crypto.randomBytes(16).toString('hex')}`, locale: 'en', last_organization_id: orgId });
        user = await trx('users').where({ id }).first();
      }
      await trx('memberships').insert({ organization_id: orgId, user_id: user.id });
      const role = await rbac.getRoleByKey(orgId, conn.default_role, trx);
      await trx('user_roles').insert({ organization_id: orgId, user_id: user.id, role_id: role.id });
      membership = { status: 'active' };
      await audit.record({ organizationId: orgId, userId: user.id }, 'sso.user_provisioned', { entityType: 'user', entityId: user.id, newValues: { email, role: conn.default_role } }, trx);
    }
    if (identity) {
      await trx('user_identities').where({ id: identity.id }).update({ email, last_login_at: new Date() });
    } else {
      await trx('user_identities').insert({ user_id: user.id, organization_id: orgId, issuer: claims.iss, subject: String(claims.sub), email, last_login_at: new Date() });
    }
    return user;
  });
}

/** Finishes a sign-in from the provider's redirect. Returns {user, organizationId, test}. */
async function complete(pending, query) {
  if (!pending || !query.state || query.state !== pending.state || Date.now() - pending.createdAt > 15 * 60_000) {
    throw new AppError('SSO_STATE_MISMATCH', 'This sign-in link has expired. Please start again.', 400);
  }
  if (query.error) throw new AppError('SSO_PROVIDER_ERROR', `Your identity provider cancelled the sign-in (${String(query.error).slice(0, 60)}).`, 400);
  const conn = await get(pending.organizationId);
  if (!conn) throw new AppError('SSO_NOT_ENABLED', 'Single sign-on is not enabled for this company.', 404);
  let claims;
  try {
    const meta = await oidc.discover(conn.issuer);
    const tokens = await oidc.exchangeCode(meta, {
      clientId: conn.client_id, clientSecret: secrets.decrypt(conn.client_secret_enc) || '', code: String(query.code || ''), redirectUri: redirectUri(), verifier: pending.verifier,
    });
    claims = await oidc.verifyIdToken(meta, tokens.id_token, { clientId: conn.client_id, nonce: pending.nonce });
  } catch (e) {
    if (e instanceof oidc.OidcError) throw new AppError('SSO_FAILED', `Single sign-on failed: ${e.message}`, 400);
    throw new AppError('SSO_FAILED', `Single sign-on failed: could not reach the identity provider (${String(e.message).slice(0, 120)}).`, 400);
  }
  const email = oidc.emailFrom(claims);
  if (!email || claims.email_verified === false || claims.email_verified === 'false') throw new AppError('SSO_NO_EMAIL', 'Your identity provider did not share a verified email address.', 400);
  if (!conn.domains.includes(email.split('@')[1])) throw new AppError('SSO_DOMAIN', 'Your email domain is not allowed for this company.', 403);
  const user = await resolveUser(conn, claims, email);
  if (pending.test) {
    if (user.id !== pending.test) throw new AppError('SSO_TEST_USER', `The test signed in as ${email}, which is not your account. Sign in to the provider with your own account.`, 400);
    await knex('sso_connections').where({ organization_id: conn.organization_id }).update({ verified_at: new Date() });
  }
  await knex('users').where({ id: user.id }).update({ last_login_at: new Date(), last_organization_id: conn.organization_id });
  await knex('sso_connections').where({ organization_id: conn.organization_id }).update({ last_login_at: new Date() });
  await audit.record({ organizationId: conn.organization_id, userId: user.id }, pending.test ? 'sso.tested' : 'auth.sso_login', { entityType: 'user', entityId: user.id, newValues: { email } });
  cache.clear();
  return { user, organizationId: conn.organization_id, test: Boolean(pending.test) };
}

/** Password sign-in is refused for members of companies that require SSO (owners and super admins excepted). */
async function assertPasswordAllowed(user) {
  if (user.is_super_admin) return;
  const rows = await knex('sso_connections as s').join('memberships as m', 'm.organization_id', 's.organization_id')
    .where({ 's.enabled': true, 's.enforce': true, 'm.user_id': user.id, 'm.status': 'active' }).select('s.organization_id');
  for (const r of rows) {
    if (!(await isOwner(r.organization_id, user.id))) throw new AppError('SSO_REQUIRED', 'Your company requires single sign-on. Use "Sign in with SSO".', 409);
  }
}

async function stats(organizationId) {
  const [row] = await knex('user_identities').where({ organization_id: organizationId }).count({ n: '*' });
  return { linked: Number(row.n) };
}

module.exports = { get, save, remove, forEmail, start, complete, assertPasswordAllowed, stats, redirectUri, parseDomains };
