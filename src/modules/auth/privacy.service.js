// Personal data rights (PDPL): a person can download a copy of their data and delete their account.
// Deleting anonymises the account instead of removing the row, so company records that legally belong
// to an employer (attendance, payroll, recruitment history) stay consistent without naming the person.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const storage = require('../../core/storage');
const { AppError, E } = require('../../core/errors');
const { endSessions } = require('./security.service');

const parse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const pick = (row, drop) => Object.fromEntries(Object.entries(row).filter(([k]) => !drop.includes(k)).map(([k, v]) => [k, parse(v)]));

/** Everything RemoteWay holds about the person as the controller, as one JSON document. */
async function exportData(userId) {
  const user = await knex('users').where({ id: userId }).first();
  if (!user) throw E.notFound('User');
  const memberships = (await knex('memberships as m').join('organizations as o', 'o.id', 'm.organization_id').where('m.user_id', userId)
    .select('o.name as organization', 'o.owner_user_id', 'm.status', 'm.created_at as joined_at'))
    .map(({ owner_user_id: ownerId, ...m }) => ({ ...m, is_owner: ownerId === userId }));
  const profile = await knex('talent_profiles').where({ user_id: userId }).first();
  const applications = await knex('applications as a').join('candidates as c', 'c.id', 'a.candidate_id').leftJoin('jobs as j', 'j.id', 'a.job_id')
    .leftJoin('organizations as o', 'o.id', 'a.organization_id').where('c.user_id', userId)
    .select('o.name as company', 'j.title as job', 'a.stage', 'a.cover_note', 'a.created_at as applied_at');
  const invitations = profile ? await knex('talent_invitations as i').leftJoin('organizations as o', 'o.id', 'i.organization_id').where('i.profile_id', profile.id)
    .select('o.name as company', 'i.message', 'i.status', 'i.created_at') : [];
  const activity = await knex('audit_logs').where({ user_id: userId }).orderBy('id', 'desc').limit(500).select('action', 'ip', 'user_agent', 'created_at');
  return {
    generated_at: new Date().toISOString(),
    note: 'Personal data held by RemoteWay about this account. Records kept by an employer (attendance, leave, payroll) are controlled by that company — ask them for a copy.',
    account: pick(user, ['password_hash', 'two_factor_secret_enc', 'two_factor_recovery', 'two_factor_last_step']),
    two_factor_enabled: Boolean(user.two_factor_enabled_at),
    memberships,
    career_profile: profile ? pick(profile, ['photo', 'ai_analysis', 'cv_storage_key']) : null,
    applications,
    invitations,
    security_activity: activity,
  };
}

/** Companies this person owns: they must hand them over or close them first. */
async function ownedCompanies(userId) {
  return knex('organizations').where({ owner_user_id: userId }).select('id', 'name');
}

async function deleteAccount(userId, { password, confirm, ip } = {}) {
  const user = await knex('users').where({ id: userId }).first();
  if (!user || user.deleted_at) throw E.notFound('User');
  if (user.is_super_admin) throw E.conflict('ACCOUNT_PLATFORM_TEAM', 'Platform team accounts are removed by the platform owner from the team page.');
  if (!(await bcrypt.compare(String(password || ''), user.password_hash))) throw E.validation({ password: 'Current password is incorrect.' });
  if (String(confirm || '').trim().toLowerCase() !== user.email.toLowerCase()) throw E.validation({ confirm: 'Type your email address exactly to confirm.' });
  const owned = await ownedCompanies(userId);
  if (owned.length) throw new AppError('ACCOUNT_OWNS_COMPANY', `You own ${owned.map((o) => o.name).join(', ')}. Transfer ownership or close the company before deleting your account.`, 409);

  const profile = await knex('talent_profiles').where({ user_id: userId }).first('id', 'cv_storage_key');
  await knex.transaction(async (trx) => {
    await trx('users').where({ id: userId }).update({
      name: 'Deleted user', email: `deleted-${userId}-${crypto.randomBytes(4).toString('hex')}@deleted.invalid`,
      password_hash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 4), status: 'disabled', deleted_at: new Date(),
      two_factor_secret_enc: null, two_factor_enabled_at: null, two_factor_recovery: null, two_factor_last_step: null, last_organization_id: null,
    });
    await trx('memberships').where({ user_id: userId }).del();
    await trx('user_roles').where({ user_id: userId }).del();
    await trx('api_tokens').where({ user_id: userId }).update({ revoked_at: new Date() });
    await trx('password_resets').where({ user_id: userId }).del();
    await trx('notifications').where({ user_id: userId }).del();
    if (await trx.schema.hasTable('user_identities')) await trx('user_identities').where({ user_id: userId }).del();
    if (await trx.schema.hasTable('calendar_tokens')) await trx('calendar_tokens').where({ user_id: userId }).del();
    // Career profile: removed completely (companies' shortlists and invitations go with it).
    if (profile) await trx('talent_profiles').where({ id: profile.id }).del();
    // Applications stay in the company's recruitment records but are no longer tied to the account.
    await trx('candidates').where({ user_id: userId }).update({ user_id: null });
    await trx('employees').where({ user_id: userId }).update({ user_id: null });
    // Platform CRM: the contact stays (so it is not re-created) without personal details, and is never contacted again.
    await trx('crm_contacts').where({ user_id: userId }).update({ name: 'Deleted user', email: null, phone: null, notes: null, job_title: null, city: null, opt_out_email: true, opt_out_sms: true, opt_out_whatsapp: true });
  });
  if (profile?.cv_storage_key) await storage.remove(profile.cv_storage_key).catch(() => {});
  await endSessions(userId);
  await audit.record({ userId, ip }, 'account.deleted', { entityType: 'user', entityId: userId });
}

module.exports = { exportData, deleteAccount, ownedCompanies };
