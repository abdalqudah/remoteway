// Removes the demo data (scripts/seed-demo.js) from a live database, from the admin panel:
// the demo companies with all their records, the demo accounts and their career profiles.
// Only accounts on the demo domains are touched; a safety backup is taken first.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const cache = require('../../core/cache');
const storage = require('../../core/storage');
const { E, AppError } = require('../../core/errors');
const backups = require('./backup.service');

const DEMO_DOMAINS = ['demo.remoteway.local', 'talent.demo.remoteway.local'];
const demoUsers = (q = knex) => q('users').where((w) => { for (const d of DEMO_DOMAINS) w.orWhere('email', 'like', `%@${d}`); }).where('is_super_admin', false);

/** What would be removed; companies that also have real (non-demo) users are left alone and listed. */
async function preview() {
  const users = await demoUsers().select('id', 'email');
  const ids = users.map((u) => u.id);
  const owned = ids.length ? await knex('organizations').whereIn('owner_user_id', ids).select('id', 'name') : [];
  const orgs = [];
  const kept = [];
  for (const o of owned) {
    const real = await knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where('m.organization_id', o.id).whereNotIn('u.id', ids).first('u.id');
    (real ? kept : orgs).push(o);
  }
  return { users: users.length, userIds: ids, orgs, kept };
}

async function remove(ctx, password) {
  const me = await knex('users').where({ id: ctx.userId }).first();
  if (!me || !(await bcrypt.compare(String(password || ''), me.password_hash))) throw E.validation({ password: 'Current password is incorrect.' });
  const p = await preview();
  if (!p.users) throw new AppError('NO_DEMO_DATA', 'There is no demo data to remove.', 409);
  if (p.kept.length) throw new AppError('DEMO_HAS_REAL_USERS', `These demo companies also have real users, so nothing was removed: ${p.kept.map((o) => o.name).join(', ')}.`, 409);
  const safety = await backups.create(ctx, { label: 'before-demo-removal' });
  const orgIds = p.orgs.map((o) => o.id);
  const cvKeys = await knex('talent_profiles').whereIn('user_id', p.userIds).whereNotNull('cv_storage_key').pluck('cv_storage_key');
  await knex.transaction(async (trx) => {
    if (orgIds.length) await trx('organizations').whereIn('id', orgIds).del(); // every company record cascades
    await trx('users').whereIn('id', p.userIds).del();
  });
  // Uploaded files of the removed companies and profiles
  for (const id of orgIds) fs.rmSync(path.join(storage.root, `org-${Number(id)}`), { recursive: true, force: true });
  for (const key of cvKeys) await storage.remove(key).catch(() => {});
  cache.clear();
  await audit.record(ctx, 'platform.demo_removed', { newValues: { companies: orgIds.length, users: p.users, safety: safety.name } });
  return { companies: orgIds.length, users: p.users, safety: safety.name };
}

module.exports = { preview, remove, DEMO_DOMAINS };
