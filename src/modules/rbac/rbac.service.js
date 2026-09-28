const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const ent = require('../billing/entitlements.service');

async function loadPermissions(organizationId, userId) {
  const rows = await knex('user_roles as ur')
    .join('memberships as m', function joinMembership() {
      this.on('m.user_id', 'ur.user_id').andOn('m.organization_id', 'ur.organization_id');
    })
    .join('role_permissions as rp', 'rp.role_id', 'ur.role_id')
    .join('permissions as p', 'p.id', 'rp.permission_id')
    .where({ 'ur.organization_id': organizationId, 'ur.user_id': userId, 'm.status': 'active' })
    .distinct('p.key');
  return new Set(rows.map((r) => r.key));
}

function getUserPermissions(organizationId, userId) {
  return cache.remember(`perm:${organizationId}:${userId}`, () => loadPermissions(organizationId, userId));
}

function invalidate(organizationId) {
  cache.forgetPrefix(`perm:${organizationId}:`);
}

async function listPermissions() {
  return knex('permissions').orderBy(['module', 'key']);
}

// System role templates plus this organization's custom roles.
async function listRoles(organizationId) {
  const roles = await knex('roles')
    .where((q) => q.whereNull('organization_id').orWhere('organization_id', organizationId))
    .orderBy([{ column: 'is_system', order: 'desc' }, { column: 'id' }]);
  const counts = await knex('user_roles').where({ organization_id: organizationId }).groupBy('role_id').select('role_id').count({ n: '*' });
  const byRole = Object.fromEntries(counts.map((c) => [c.role_id, Number(c.n)]));
  const perms = await knex('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id')
    .whereIn('rp.role_id', roles.map((r) => r.id)).select('rp.role_id', 'p.key');
  return roles.map((r) => ({ ...r, members: byRole[r.id] || 0, permissions: perms.filter((p) => p.role_id === r.id).map((p) => p.key) }));
}

async function getRole(organizationId, roleId) {
  const role = await knex('roles').where({ id: roleId })
    .andWhere((q) => q.whereNull('organization_id').orWhere('organization_id', organizationId)).first();
  if (!role) throw E.notFound('Role');
  role.permissions = (await knex('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id')
    .where('rp.role_id', role.id).select('p.key')).map((p) => p.key);
  return role;
}

async function getRoleByKey(organizationId, key, trx = knex) {
  return trx('roles').where({ key })
    .andWhere((q) => q.whereNull('organization_id').orWhere('organization_id', organizationId))
    .orderByRaw('organization_id IS NULL').first();
}

async function saveCustomRole(ctx, { id, name, description, permissions }) {
  await ent.assertFeature(ctx.organizationId, 'custom_roles');
  const valid = await knex('permissions').whereIn('key', permissions);
  if (valid.length !== permissions.length) throw E.validation({ permissions: 'Unknown permission.' });
  return knex.transaction(async (trx) => {
    let roleId = id;
    if (id) {
      const role = await trx('roles').where({ id, organization_id: ctx.organizationId, is_system: false }).first();
      if (!role) throw E.notFound('Role');
      await trx('roles').where({ id }).update({ name, description: description || null });
    } else {
      const key = `custom_${Date.now().toString(36)}`;
      [roleId] = await trx('roles').insert({ organization_id: ctx.organizationId, key, name, description: description || null, is_system: false });
    }
    await trx('role_permissions').where({ role_id: roleId }).del();
    if (valid.length) await trx('role_permissions').insert(valid.map((p) => ({ role_id: roleId, permission_id: p.id })));
    await audit.record(ctx, id ? 'role.updated' : 'role.created', { entityType: 'role', entityId: roleId, newValues: { name, permissions: permissions.join(',') } }, trx);
    return roleId;
  }).finally(() => invalidate(ctx.organizationId));
}

async function deleteCustomRole(ctx, roleId) {
  const role = await knex('roles').where({ id: roleId, organization_id: ctx.organizationId, is_system: false }).first();
  if (!role) throw E.notFound('Role');
  const [{ n }] = await knex('user_roles').where({ role_id: roleId }).count({ n: '*' });
  if (Number(n) > 0) throw E.conflict('ROLE_IN_USE', 'Reassign members before deleting this role.');
  await knex('roles').where({ id: roleId }).del();
  await audit.record(ctx, 'role.deleted', { entityType: 'role', entityId: roleId, oldValues: { name: role.name } });
}

/** Replaces a member's role in the organization (one role per member). */
async function assignRole(ctx, userId, roleId, trx = knex) {
  const role = await trx('roles').where({ id: roleId })
    .andWhere((q) => q.whereNull('organization_id').orWhere('organization_id', ctx.organizationId)).first();
  if (!role) throw E.validation({ role_id: 'Choose a valid role.' });
  const membership = await trx('memberships').where({ organization_id: ctx.organizationId, user_id: userId }).first();
  if (!membership) throw E.notFound('Member');
  const org = await trx('organizations').where({ id: ctx.organizationId }).first();
  if (org.owner_user_id === userId && role.key !== 'owner') {
    throw E.conflict('OWNER_ROLE_LOCKED', 'The organization owner must keep the Owner role.');
  }
  if (role.key === 'owner' && org.owner_user_id !== userId) {
    throw E.conflict('OWNER_ROLE_LOCKED', 'Only the organization owner can hold the Owner role.');
  }
  const before = await trx('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id')
    .where({ 'ur.organization_id': ctx.organizationId, 'ur.user_id': userId }).select('r.name');
  await trx('user_roles').where({ organization_id: ctx.organizationId, user_id: userId }).del();
  await trx('user_roles').insert({ organization_id: ctx.organizationId, user_id: userId, role_id: role.id });
  await audit.record(ctx, 'member.role_changed', {
    entityType: 'user', entityId: userId, oldValues: { role: before.map((b) => b.name).join(', ') }, newValues: { role: role.name },
  }, trx);
  invalidate(ctx.organizationId);
}

module.exports = {
  getUserPermissions, invalidate, listPermissions, listRoles, getRole, getRoleByKey, saveCustomRole, deleteCustomRole, assignRole,
};
