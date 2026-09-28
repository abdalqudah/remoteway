// Idempotent seed of platform reference data. Safe to run in production and on every deploy:
// it inserts missing rows and never overwrites prices/limits already edited by a super admin.
const bcrypt = require('bcryptjs');
const { PERMISSIONS, ROLE_TEMPLATES, FEATURES, PLANS, ADDONS, COUNTRIES } = require('./catalog');

async function seedReference(knex, { log = () => {} } = {}) {
  for (const c of COUNTRIES) {
    const exists = await knex('country_policies').where({ country_code: c.country_code }).first();
    if (!exists) await knex('country_policies').insert({ ...c, working_days: JSON.stringify(c.working_days), rules: JSON.stringify({}) });
  }

  for (const [key, module, description] of PERMISSIONS) {
    await knex('permissions').insert({ key, module, description }).onConflict('key').merge(['module', 'description']);
  }
  const permIds = Object.fromEntries((await knex('permissions').select('id', 'key')).map((p) => [p.key, p.id]));

  for (const [i, [key, name, module, availability]] of FEATURES.entries()) {
    // availability is code-driven (it reflects what is actually implemented), so it is always synced.
    await knex('features').insert({ key, name, module, availability, sort_order: i }).onConflict('key').merge(['name', 'module', 'availability', 'sort_order']);
  }
  const featureIds = Object.fromEntries((await knex('features').select('id', 'key')).map((f) => [f.key, f.id]));

  for (const tpl of ROLE_TEMPLATES) {
    let role = await knex('roles').whereNull('organization_id').where({ key: tpl.key }).first();
    if (!role) {
      const [id] = await knex('roles').insert({ organization_id: null, key: tpl.key, name: tpl.name, description: tpl.description, is_system: true });
      role = { id };
    }
    // System templates always mirror the catalog.
    await knex('role_permissions').where({ role_id: role.id }).del();
    await knex('role_permissions').insert(tpl.permissions.map((p) => ({ role_id: role.id, permission_id: permIds[p] })));
  }

  for (const plan of PLANS) {
    let row = await knex('plans').where({ key: plan.key }).first();
    if (!row) {
      const [id] = await knex('plans').insert({
        key: plan.key, name: plan.name, tagline: plan.tagline, tagline_ar: plan.tagline_ar, price_monthly: plan.price_monthly,
        price_yearly: plan.price_yearly, trial_days: plan.trial_days, is_custom: Boolean(plan.is_custom), sort_order: plan.sort_order,
      });
      await knex('plan_features').insert(plan.features.map((f) => ({ plan_id: id, feature_id: featureIds[f] })));
      await knex('plan_limits').insert(Object.entries(plan.limits).map(([limit_key, limit_value]) => ({ plan_id: id, limit_key, limit_value })));
      log(`plan created: ${plan.key}`);
    }
  }

  for (const [i, a] of ADDONS.entries()) {
    const exists = await knex('addons').where({ key: a.key }).first();
    if (!exists) {
      await knex('addons').insert({
        key: a.key, name: a.name, price_monthly: a.price_monthly, feature_id: a.feature ? featureIds[a.feature] : null,
        limit_key: a.limit_key || null, limit_increment: a.limit_increment || null, sort_order: i,
      });
    }
  }
}

async function ensureSuperAdmin(knex, { email, password, name }, rounds = 12) {
  if (!email || !password) return null;
  const existing = await knex('users').where({ email: email.toLowerCase() }).first();
  if (existing) {
    if (!existing.is_super_admin || !existing.platform_role) await knex('users').where({ id: existing.id }).update({ is_super_admin: true, platform_role: 'owner' });
    return existing.id;
  }
  const [id] = await knex('users').insert({
    name: name || 'Platform Admin', email: email.toLowerCase(), password_hash: await bcrypt.hash(password, rounds), is_super_admin: true, platform_role: 'owner', email_verified_at: new Date(),
  });
  return id;
}

module.exports = { seedReference, ensureSuperAdmin };
