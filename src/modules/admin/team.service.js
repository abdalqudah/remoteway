// The platform team: people who can open Super Admin, each with a platform role (see access.js).
const bcrypt = require('bcryptjs');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const config = require('../../config');
const mailer = require('../../core/mailer');
const { E } = require('../../core/errors');
const { ROLES } = require('./access');

async function list() {
  return knex('users').where({ is_super_admin: true }).orderBy('name')
    .select('id', 'name', 'email', 'platform_role', 'status', 'last_login_at', 'created_at', 'two_factor_enabled_at');
}

async function ownersLeft(trx, exceptId) {
  const [{ n }] = await trx('users').where({ is_super_admin: true, platform_role: 'owner', status: 'active' }).whereNot('id', exceptId).count({ n: '*' });
  return Number(n);
}

/** Adds someone to the team. An existing account keeps its password; a new one gets the password given. */
async function add(ctx, { name, email, role, password }) {
  if (!ROLES.includes(role)) throw E.validation({ role: 'Choose a role.' });
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw E.validation({ email: 'Enter a valid email address.' });
  const existing = await knex('users').where({ email: mail }).first();
  let userId;
  if (existing) {
    if (existing.is_super_admin) throw E.conflict('ALREADY_ON_TEAM', 'This person is already on the platform team.');
    await knex('users').where({ id: existing.id }).update({ is_super_admin: true, platform_role: role, email_verified_at: new Date() });
    userId = existing.id;
  } else {
    const cleanName = String(name || '').trim().slice(0, 120);
    if (cleanName.length < 2) throw E.validation({ name: 'Enter the name.' });
    const pw = String(password || '');
    if (pw.length < 10 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw E.validation({ password: 'Use at least 10 characters with letters and numbers.' });
    [userId] = await knex('users').insert({ name: cleanName, email: mail, password_hash: await bcrypt.hash(pw, config.bcryptRounds), is_super_admin: true, platform_role: role });
  }
  await audit.record(ctx, 'platform.team_added', { entityType: 'user', entityId: userId, newValues: { email: mail, role } });
  if (mailer.enabled()) {
    await mailer.send({ kind: 'team_access',
      to: mail, subject: 'RemoteWay — platform administration access',
      html: mailer.layout({ locale: 'en', title: 'You now have access to RemoteWay administration', body: `Role: ${role}. Sign in with ${existing ? 'your existing password' : 'the password shared with you, then change it from your profile'}.`, cta: 'Sign in', href: `${config.appUrl}/login` }),
    }).catch(() => {});
  }
  return userId;
}

async function setRole(ctx, userId, role) {
  if (!ROLES.includes(role)) throw E.validation({ role: 'Choose a role.' });
  if (Number(userId) === Number(ctx.userId)) throw E.conflict('TEAM_SELF', 'You cannot change your own role.');
  await knex.transaction(async (trx) => {
    const u = await trx('users').where({ id: userId, is_super_admin: true }).forUpdate().first();
    if (!u) throw E.notFound('Team member');
    if (u.platform_role === 'owner' && role !== 'owner' && (await ownersLeft(trx, u.id)) === 0) throw E.conflict('LAST_OWNER', 'The platform needs at least one owner.');
    await trx('users').where({ id: u.id }).update({ platform_role: role });
    await audit.record(ctx, 'platform.team_role_changed', { entityType: 'user', entityId: u.id, oldValues: { role: u.platform_role }, newValues: { role } }, trx);
  });
}

async function remove(ctx, userId) {
  if (Number(userId) === Number(ctx.userId)) throw E.conflict('TEAM_SELF', 'You cannot remove yourself.');
  await knex.transaction(async (trx) => {
    const u = await trx('users').where({ id: userId, is_super_admin: true }).forUpdate().first();
    if (!u) throw E.notFound('Team member');
    if (u.platform_role === 'owner' && (await ownersLeft(trx, u.id)) === 0) throw E.conflict('LAST_OWNER', 'The platform needs at least one owner.');
    await trx('users').where({ id: u.id }).update({ is_super_admin: false, platform_role: null });
    await audit.record(ctx, 'platform.team_removed', { entityType: 'user', entityId: u.id, oldValues: { email: u.email, role: u.platform_role } }, trx);
  });
}

module.exports = { list, add, setRole, remove };
