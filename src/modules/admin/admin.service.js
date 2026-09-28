// Platform (super admin) operations. These deliberately work across tenants.
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const { LIMIT_KEYS } = require('../../db/catalog');
const ent = require('../billing/entitlements.service');

async function overview() {
  const [[{ orgs }], [{ users }], [{ employees }], byStatus, [{ open }], [{ revenue }]] = await Promise.all([
    knex('organizations').count({ orgs: '*' }),
    knex('users').count({ users: '*' }),
    knex('employees').whereNot('status', 'terminated').count({ employees: '*' }),
    knex('subscriptions').groupBy('status').select('status').count({ n: '*' }),
    knex('invoices').where({ status: 'issued' }).count({ open: '*' }),
    knex('invoices').where({ status: 'paid' }).where('paid_at', '>=', new Date(Date.now() - 30 * 86_400_000)).sum({ revenue: 'total' }),
  ]);
  return {
    orgs: Number(orgs), users: Number(users), employees: Number(employees), openInvoices: Number(open), revenue30d: Number(revenue || 0),
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
  };
}

async function listOrganizations({ q } = {}) {
  const query = knex('organizations as o')
    .join('users as u', 'u.id', 'o.owner_user_id')
    .leftJoin('subscriptions as s', 's.organization_id', 'o.id')
    .leftJoin('plans as p', 'p.id', 's.plan_id')
    .select('o.id', 'o.name', 'o.slug', 'o.country_code', 'o.status', 'o.created_at', 'u.email as owner_email', 's.status as sub_status', 's.trial_ends_at', 'p.name as plan_name',
      knex('employees').count('*').where('organization_id', knex.ref('o.id')).whereNot('status', 'terminated').as('employee_count'))
    .orderBy('o.id', 'desc').limit(200);
  if (q) query.where((w) => w.where('o.name', 'like', `%${q}%`).orWhere('u.email', 'like', `%${q}%`));
  return query;
}

async function getOrganization(id) {
  const org = await knex('organizations as o').join('users as u', 'u.id', 'o.owner_user_id').where('o.id', id)
    .select('o.*', 'u.name as owner_name', 'u.email as owner_email').first();
  if (!org) throw E.notFound('Organization');
  org.entitlements = await ent.getEntitlements(id);
  org.usage = await ent.getUsage(id);
  org.invoices = await knex('invoices').where({ organization_id: id }).orderBy('id', 'desc');
  return org;
}

async function setOrganizationStatus(ctx, id, status) {
  if (!['active', 'suspended'].includes(status)) throw E.validation({ status: 'Invalid status.' });
  await knex('organizations').where({ id }).update({ status });
  await audit.record({ ...ctx, organizationId: id }, `platform.organization_${status}`, { entityType: 'organization', entityId: id });
  cache.forgetPrefix(`org:${id}`);
}

async function updateSubscription(ctx, organizationId, { plan_id: planId, status, trial_ends_at: trialEndsAt, custom_limits: customLimits }) {
  const sub = await knex('subscriptions').where({ organization_id: organizationId }).first();
  if (!sub) throw E.notFound('Subscription');
  const patch = {};
  if (planId) patch.plan_id = planId;
  if (status) patch.status = status;
  if (trialEndsAt !== undefined) patch.trial_ends_at = trialEndsAt ? new Date(`${trialEndsAt}T23:59:59Z`) : null;
  if (customLimits !== undefined) patch.custom_limits = customLimits ? JSON.stringify(customLimits) : null;
  const d = audit.diff(sub, patch);
  await knex('subscriptions').where({ id: sub.id }).update(patch);
  await audit.record({ ...ctx, organizationId }, 'platform.subscription_updated', { entityType: 'subscription', entityId: sub.id, oldValues: d.oldValues, newValues: d.newValues });
  ent.invalidate(organizationId);
}

async function listPlans() {
  const plans = await knex('plans').orderBy('sort_order');
  const limits = await knex('plan_limits');
  const pf = await knex('plan_features');
  return plans.map((p) => ({
    ...p,
    limits: Object.fromEntries(limits.filter((l) => l.plan_id === p.id).map((l) => [l.limit_key, l.limit_value === null ? null : Number(l.limit_value)])),
    featureIds: pf.filter((f) => f.plan_id === p.id).map((f) => f.feature_id),
  }));
}

async function updatePlan(ctx, planId, data) {
  const before = await knex('plans').where({ id: planId }).first();
  if (!before) throw E.notFound('Plan');
  await knex.transaction(async (trx) => {
    const patch = {
      name: data.name, tagline: data.tagline ?? null, tagline_ar: data.tagline_ar ?? null, price_monthly: data.price_monthly ?? null, price_yearly: data.price_yearly ?? null,
      trial_days: data.trial_days, is_public: data.is_public, is_active: data.is_active, is_custom: data.price_monthly === undefined || data.price_monthly === null,
    };
    await trx('plans').where({ id: planId }).update(patch);
    for (const key of LIMIT_KEYS) {
      await trx('plan_limits').insert({ plan_id: planId, limit_key: key, limit_value: data.limits[key] ?? null })
        .onConflict(['plan_id', 'limit_key']).merge(['limit_value']);
    }
    await trx('plan_features').where({ plan_id: planId }).del();
    if (data.feature_ids.length) await trx('plan_features').insert(data.feature_ids.map((id) => ({ plan_id: planId, feature_id: id })));
    const d = audit.diff(before, patch);
    await audit.record(ctx, 'platform.plan_updated', {
      entityType: 'plan', entityId: planId, oldValues: d.oldValues, newValues: { ...d.newValues, limits: JSON.stringify(data.limits), features: data.feature_ids.length },
    }, trx);
  });
  cache.forgetPrefix('ent:');
}

async function listInvoices(status) {
  const q = knex('invoices as i').join('organizations as o', 'o.id', 'i.organization_id').select('i.*', 'o.name as organization_name').orderBy('i.id', 'desc').limit(200);
  if (status) q.where('i.status', status);
  return q;
}

module.exports = { overview, listOrganizations, getOrganization, setOrganizationStatus, updateSubscription, listPlans, updatePlan, listInvoices };
