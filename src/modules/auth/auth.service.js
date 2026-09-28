const bcrypt = require('bcryptjs');
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { randomToken, sha256 } = require('../../core/tokens');

// Constant-time-ish rejection when the email is unknown.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 4);

const hashPassword = (plain) => bcrypt.hash(plain, config.bcryptRounds);

async function createUser(trx, { name, email, password, locale }) {
  const existing = await trx('users').where({ email }).first();
  if (existing) throw E.conflict('EMAIL_TAKEN', 'An account with this email already exists.');
  const [id] = await trx('users').insert({ name, email, password_hash: await hashPassword(password), locale: locale || 'en' });
  return id;
}

async function authenticate({ email, password }, ctx = {}) {
  const user = await knex('users').where({ email: String(email).toLowerCase().trim() }).first();
  const ok = await bcrypt.compare(String(password), user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    await audit.record({ ...ctx, userId: user?.id }, 'auth.login_failed', { entityType: 'user', entityId: user?.id, newValues: { email } });
    throw E.invalidCredentials();
  }
  if (user.status !== 'active') throw new AppError('ACCOUNT_DISABLED', 'This account is disabled.', 403);
  await require('../sso/sso.service').assertPasswordAllowed(user); // eslint-disable-line global-require
  await knex('users').where({ id: user.id }).update({ last_login_at: new Date() });
  await audit.record({ ...ctx, userId: user.id }, 'auth.login', { entityType: 'user', entityId: user.id });
  return user;
}

async function changePassword(ctx, { currentPassword, newPassword }) {
  const user = await knex('users').where({ id: ctx.userId }).first();
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) throw E.validation({ current_password: 'Current password is incorrect.' });
  await knex('users').where({ id: user.id }).update({ password_hash: await hashPassword(newPassword), password_changed_at: new Date() });
  // Sign out every other device that used the old password.
  await require('./security.service').endSessions(user.id, ctx.sessionId); // eslint-disable-line global-require
  await audit.record(ctx, 'auth.password_changed', { entityType: 'user', entityId: user.id });
}

async function findUser(id) {
  return knex('users').where({ id }).first();
}

// ---- API tokens (Bearer). Only the SHA-256 hash is stored. ----
async function createApiToken(ctx, name) {
  const plain = `rw_${randomToken(30)}`;
  const [id] = await knex('api_tokens').insert({
    organization_id: ctx.organizationId, user_id: ctx.userId, name, token_hash: sha256(plain), token_prefix: plain.slice(0, 10),
  });
  await audit.record(ctx, 'api_token.created', { entityType: 'api_token', entityId: id, newValues: { name } });
  return { id, token: plain };
}

async function listApiTokens(organizationId) {
  return knex('api_tokens as t').join('users as u', 'u.id', 't.user_id').where('t.organization_id', organizationId).whereNull('t.revoked_at')
    .select('t.id', 't.name', 't.token_prefix', 't.last_used_at', 't.created_at', 'u.name as user_name').orderBy('t.id', 'desc');
}

async function revokeApiToken(ctx, id) {
  const n = await knex('api_tokens').where({ id, organization_id: ctx.organizationId }).whereNull('revoked_at').update({ revoked_at: new Date() });
  if (!n) throw E.notFound('API token');
  await audit.record(ctx, 'api_token.revoked', { entityType: 'api_token', entityId: id });
}

async function resolveApiToken(plain) {
  if (!plain || !plain.startsWith('rw_')) return null;
  const token = await knex('api_tokens').where({ token_hash: sha256(plain) }).whereNull('revoked_at').first();
  if (!token || (token.expires_at && new Date(token.expires_at) < new Date())) return null;
  const user = await knex('users').where({ id: token.user_id, status: 'active' }).first();
  if (!user) return null;
  // Throttle last_used_at writes to once a minute.
  if (!token.last_used_at || Date.now() - new Date(token.last_used_at).getTime() > 60_000) {
    await knex('api_tokens').where({ id: token.id }).update({ last_used_at: new Date() });
  }
  return { user, organizationId: token.organization_id, tokenId: token.id };
}

module.exports = { hashPassword, createUser, authenticate, changePassword, findUser, createApiToken, listApiTokens, revokeApiToken, resolveApiToken };
