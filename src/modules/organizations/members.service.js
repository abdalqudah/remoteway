// Workspace users: memberships, roles and invitations.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const { randomToken, sha256 } = require('../../core/tokens');
const ent = require('../billing/entitlements.service');
const rbac = require('../rbac/rbac.service');
const authService = require('../auth/auth.service');

const INVITE_TTL_DAYS = 7;

async function listMembers(organizationId) {
  const org = await knex('organizations').where({ id: organizationId }).first('owner_user_id');
  const rows = await knex('memberships as m').join('users as u', 'u.id', 'm.user_id')
    .leftJoin('user_roles as ur', function joinRoles() { this.on('ur.user_id', 'm.user_id').andOn('ur.organization_id', 'm.organization_id'); })
    .leftJoin('roles as r', 'r.id', 'ur.role_id')
    .where('m.organization_id', organizationId)
    .select('u.id', 'u.name', 'u.email', 'u.last_login_at', 'm.status', 'm.created_at', 'r.id as role_id', 'r.name as role_name', 'r.key as role_key')
    .orderBy('u.name');
  return rows.map((r) => ({ ...r, is_owner: r.id === org.owner_user_id }));
}

async function listInvitations(organizationId) {
  return knex('invitations as i').join('roles as r', 'r.id', 'i.role_id').leftJoin('users as u', 'u.id', 'i.invited_by')
    .where('i.organization_id', organizationId).whereNull('i.accepted_at').whereNull('i.revoked_at')
    .select('i.id', 'i.email', 'i.expires_at', 'i.created_at', 'r.name as role_name', 'u.name as invited_by_name').orderBy('i.id', 'desc');
}

/** Returns the plain invite token once so the admin can share the link (email delivery is Phase 7). */
async function invite(ctx, { email, roleId }) {
  await ent.assertCanWrite(ctx.organizationId);
  // Invitations send email in the company's name: the inviter must have confirmed their own address.
  if (ctx.userId) require('../auth/verify.service').assertVerified(await knex('users').where({ id: ctx.userId }).first()); // eslint-disable-line global-require
  return knex.transaction(async (trx) => {
    await ent.lockSubscription(ctx.organizationId, trx);
    const already = await trx('memberships as m').join('users as u', 'u.id', 'm.user_id')
      .where({ 'm.organization_id': ctx.organizationId, 'u.email': email }).first('m.id');
    if (already) throw E.conflict('ALREADY_MEMBER', 'This person is already a member of the workspace.');
    const role = await trx('roles').where({ id: roleId }).andWhere((q) => q.whereNull('organization_id').orWhere('organization_id', ctx.organizationId)).first();
    if (!role || role.key === 'owner') throw E.validation({ role_id: 'Choose a valid role.' });
    await trx('invitations').where({ organization_id: ctx.organizationId, email }).whereNull('accepted_at').whereNull('revoked_at').update({ revoked_at: new Date() });
    await ent.assertWithinLimit(ctx.organizationId, 'users', 1, trx);
    const token = randomToken(32);
    const [id] = await trx('invitations').insert({
      organization_id: ctx.organizationId, email, role_id: role.id, token_hash: sha256(token), invited_by: ctx.userId,
      expires_at: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
    });
    await audit.record(ctx, 'invitation.created', { entityType: 'invitation', entityId: id, newValues: { email, role: role.name } }, trx);
    return { id, token };
  });
}

async function revokeInvitation(ctx, id) {
  const n = await knex('invitations').where({ id, organization_id: ctx.organizationId }).whereNull('accepted_at').whereNull('revoked_at').update({ revoked_at: new Date() });
  if (!n) throw E.notFound('Invitation');
  await audit.record(ctx, 'invitation.revoked', { entityType: 'invitation', entityId: id });
}

async function findInvitation(token) {
  if (!token) return null;
  const inv = await knex('invitations as i').join('organizations as o', 'o.id', 'i.organization_id').join('roles as r', 'r.id', 'i.role_id')
    .where('i.token_hash', sha256(token)).whereNull('i.accepted_at').whereNull('i.revoked_at').where('i.expires_at', '>', new Date())
    .select('i.*', 'o.name as organization_name', 'r.name as role_name').first();
  return inv || null;
}

/**
 * Accepts an invitation. If `userId` is given the signed-in user joins (email must match);
 * otherwise a new account is created from `account`.
 */
async function acceptInvitation(token, { userId, account }, ctx = {}) {
  return knex.transaction(async (trx) => {
    const inv = await trx('invitations').where({ token_hash: sha256(token) }).whereNull('accepted_at').whereNull('revoked_at')
      .where('expires_at', '>', new Date()).forUpdate().first();
    if (!inv) throw E.conflict('INVITATION_INVALID', 'This invitation is invalid or has expired.');
    let uid = userId;
    if (uid) {
      const user = await trx('users').where({ id: uid }).first();
      if (user.email !== inv.email) throw E.conflict('INVITATION_EMAIL_MISMATCH', `This invitation was sent to ${inv.email}.`);
    } else {
      const existing = await trx('users').where({ email: inv.email }).first();
      if (existing) throw E.conflict('EMAIL_TAKEN', 'An account with this email exists. Sign in to accept the invitation.');
      uid = await authService.createUser(trx, { ...account, email: inv.email });
    }
    const membership = await trx('memberships').where({ organization_id: inv.organization_id, user_id: uid }).first();
    if (membership) await trx('memberships').where({ id: membership.id }).update({ status: 'active' });
    else await trx('memberships').insert({ organization_id: inv.organization_id, user_id: uid });
    await trx('user_roles').where({ organization_id: inv.organization_id, user_id: uid }).del();
    await trx('user_roles').insert({ organization_id: inv.organization_id, user_id: uid, role_id: inv.role_id });
    await trx('invitations').where({ id: inv.id }).update({ accepted_at: new Date() });
    // Link to an existing employee record with the same email, if any.
    await trx('employees').where({ organization_id: inv.organization_id, email: inv.email }).whereNull('user_id').update({ user_id: uid });
    await trx('users').where({ id: uid }).update({ last_organization_id: inv.organization_id });
    // The invitation was sent to this address: following it confirms the email.
    await require('../auth/verify.service').markVerified(uid, 'invitation', trx); // eslint-disable-line global-require
    await audit.record({ ...ctx, organizationId: inv.organization_id, userId: uid }, 'invitation.accepted', { entityType: 'invitation', entityId: inv.id }, trx);
    rbac.invalidate(inv.organization_id);
    return { userId: uid, organizationId: inv.organization_id };
  });
}

async function setMemberStatus(ctx, userId, status) {
  const org = await knex('organizations').where({ id: ctx.organizationId }).first();
  if (org.owner_user_id === Number(userId)) throw E.conflict('OWNER_ROLE_LOCKED', 'The organization owner cannot be disabled.');
  if (Number(userId) === ctx.userId) throw E.conflict('CANNOT_DISABLE_SELF', 'You cannot disable your own access.');
  if (status === 'active') {
    await knex.transaction(async (trx) => {
      await ent.lockSubscription(ctx.organizationId, trx);
      await ent.assertWithinLimit(ctx.organizationId, 'users', 1, trx);
      const n = await trx('memberships').where({ organization_id: ctx.organizationId, user_id: userId }).update({ status });
      if (!n) throw E.notFound('Member');
    });
  } else {
    const n = await knex('memberships').where({ organization_id: ctx.organizationId, user_id: userId }).update({ status });
    if (!n) throw E.notFound('Member');
  }
  await audit.record(ctx, status === 'active' ? 'member.enabled' : 'member.disabled', { entityType: 'user', entityId: userId });
  rbac.invalidate(ctx.organizationId);
}

module.exports = { listMembers, listInvitations, invite, revokeInvitation, findInvitation, acceptInvitation, setMemberStatus };
