// Sign-in accounts for employees, created by a company admin without email:
// the admin sets a temporary password (or lets RemoteWay generate one) and hands it over;
// at first sign-in the employee must choose their own password.
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { z, validate, email: emailRule, password: passwordRule } = require('../../core/validate');
const { E } = require('../../core/errors');
const ent = require('../billing/entitlements.service');
const rbac = require('../rbac/rbac.service');
const authService = require('../auth/auth.service');

/** Easy to read out loud or type on a phone: no 0/O, 1/l/I. */
function generatePassword() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const pick = (set, n) => Array.from({ length: n }, () => set[crypto.randomInt(set.length)]).join('');
  return `${pick(letters, 4)}-${pick(digits, 4)}-${pick(letters, 4)}`;
}

async function employeeOf(ctx, employeeId) {
  const e = await knex('employees').where({ id: Number(employeeId), organization_id: ctx.organizationId }).first();
  if (!e) throw E.notFound('Employee');
  return e;
}

/**
 * What the admin may do for this employee's sign-in. A password can only be set for an account that
 * lives entirely inside this company (same rule as reset links): not the owner, not yourself, not an
 * account used in another company, as a company owner or as a personal career profile.
 */
async function state(ctx, employee) {
  if (!employee.user_id) return { linked: false };
  const user = await knex('users').where({ id: employee.user_id }).whereNull('deleted_at').first('id', 'email', 'last_login_at', 'must_change_password', 'is_super_admin', 'status');
  if (!user) return { linked: false };
  const member = await knex('memberships').where({ organization_id: ctx.organizationId, user_id: user.id }).first('status');
  const org = await knex('organizations').where({ id: ctx.organizationId }).first('owner_user_id');
  const [elsewhere, owns, profile] = await Promise.all([
    knex('memberships').where({ user_id: user.id }).whereNot({ organization_id: ctx.organizationId }).first('id'),
    knex('organizations').where({ owner_user_id: user.id }).first('id'),
    knex('talent_profiles').where({ user_id: user.id }).where('visibility', '!=', 'private').first('id'),
  ]);
  let blocked = null;
  if (user.id === ctx.userId) blocked = 'self';
  else if (user.is_super_admin) blocked = 'platform';
  else if (org.owner_user_id === user.id || owns) blocked = 'owner';
  else if (elsewhere || profile) blocked = 'outside';
  else if (!member) blocked = 'not_member';
  return { linked: true, user, memberStatus: member && member.status, canSetPassword: !blocked, blocked };
}

async function assignableRoles(organizationId) {
  return (await rbac.listRoles(organizationId)).filter((r) => r.key !== 'owner');
}

/** Creates the sign-in account for an employee who has none. Returns the password to hand over. */
async function createAccount(ctx, employeeId, body) {
  await ent.assertCanWrite(ctx.organizationId);
  const e = await employeeOf(ctx, employeeId);
  if (e.user_id) throw E.conflict('ACCOUNT_EXISTS', 'This employee already has a sign-in account.');
  const generate = body.generate === '1' || !body.password;
  const d = validate(z.object({ email: emailRule(), role_id: z.coerce.number().int().positive('Choose a role.') }), body);
  const plain = generate ? generatePassword() : validate(z.object({ password: passwordRule() }), body).password;
  const mustChange = body.must_change === '1';
  const roles = await assignableRoles(ctx.organizationId);
  const role = roles.find((r) => r.id === d.role_id);
  if (!role) throw E.validation({ role_id: 'Choose a role.' });
  const userId = await knex.transaction(async (trx) => {
    await ent.lockSubscription(ctx.organizationId, trx);
    // Someone who already has a RemoteWay account keeps their own password: invite them instead.
    if (await trx('users').where({ email: d.email }).first('id')) throw E.conflict('EMAIL_TAKEN', 'This email already has a RemoteWay account. Invite it from Settings → Users; the person signs in with their own password.');
    await ent.assertWithinLimit(ctx.organizationId, 'users', 1, trx);
    const org = await trx('organizations').where({ id: ctx.organizationId }).first('locale');
    const id = await authService.createUser(trx, { name: `${e.first_name} ${e.last_name}`.trim(), email: d.email, password: plain, locale: org && org.locale });
    await trx('users').where({ id }).update({ must_change_password: mustChange, last_organization_id: ctx.organizationId });
    await trx('memberships').insert({ organization_id: ctx.organizationId, user_id: id });
    await trx('user_roles').insert({ organization_id: ctx.organizationId, user_id: id, role_id: role.id });
    await trx('employees').where({ id: e.id }).update({ user_id: id, ...(e.email ? {} : { email: d.email }), updated_at: new Date() });
    await audit.record(ctx, 'employee.account_created', { entityType: 'employee', entityId: e.id, newValues: { email: d.email, role: role.name, generated: generate, must_change: mustChange } }, trx);
    return id;
  });
  rbac.invalidate(ctx.organizationId);
  return { userId, email: d.email, password: plain };
}

/** Sets a new temporary password (e.g. the employee forgot theirs). Signs the person out everywhere. */
async function setPassword(ctx, employeeId, body) {
  const e = await employeeOf(ctx, employeeId);
  const s = await state(ctx, e);
  if (!s.linked) throw E.conflict('NO_ACCOUNT', 'This employee has no sign-in account yet.');
  if (!s.canSetPassword) {
    throw E.conflict('PASSWORD_NOT_ALLOWED', s.blocked === 'self' ? 'Change your own password from Account security.'
      : 'This person uses their account outside your company, so only they can change its password (with “Forgot password”).');
  }
  const generate = body.generate === '1' || !body.password;
  const plain = generate ? generatePassword() : validate(z.object({ password: passwordRule() }), body).password;
  const mustChange = body.must_change === '1';
  await knex('users').where({ id: s.user.id }).update({ password_hash: await authService.hashPassword(plain), password_changed_at: new Date(), must_change_password: mustChange });
  await require('../auth/security.service').endSessions(s.user.id); // eslint-disable-line global-require
  await audit.record(ctx, 'employee.password_set', { entityType: 'employee', entityId: e.id, newValues: { generated: generate, must_change: mustChange } });
  return { email: s.user.email, password: plain };
}

module.exports = { generatePassword, state, assignableRoles, createAccount, setPassword };
