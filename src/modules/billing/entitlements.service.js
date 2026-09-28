// Subscription engine: resolves what an organization may use (features + limits) from
// plan + add-ons + custom overrides, and enforces it. Nothing is hardcoded per plan.
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const { E } = require('../../core/errors');

const WRITE_STATUSES = new Set(['trial', 'active', 'past_due']);

function currentPeriod(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

async function loadEntitlements(organizationId) {
  const sub = await knex('subscriptions').where({ organization_id: organizationId }).first();
  if (!sub) {
    return { subscription: null, plan: null, status: 'none', features: new Set(), limits: {}, addons: [], canWrite: false, trialDaysLeft: 0 };
  }
  const plan = await knex('plans').where({ id: sub.plan_id }).first();
  const planFeatures = await knex('plan_features as pf').join('features as f', 'f.id', 'pf.feature_id')
    .where('pf.plan_id', plan.id).select('f.key');
  const planLimits = await knex('plan_limits').where({ plan_id: plan.id });
  const addons = await knex('subscription_addons as sa').join('addons as a', 'a.id', 'sa.addon_id')
    .leftJoin('features as f', 'f.id', 'a.feature_id')
    .where('sa.subscription_id', sub.id)
    .select('a.id', 'a.key', 'a.name', 'a.price_monthly', 'a.currency', 'a.limit_key', 'a.limit_increment', 'sa.quantity', 'f.key as feature_key');

  const features = new Set(planFeatures.map((f) => f.key));
  const limits = {};
  for (const l of planLimits) limits[l.limit_key] = l.limit_value === null ? null : Number(l.limit_value);
  for (const a of addons) {
    if (a.feature_key) features.add(a.feature_key);
    if (a.limit_key && limits[a.limit_key] !== null) {
      limits[a.limit_key] = (limits[a.limit_key] || 0) + Number(a.limit_increment || 0) * a.quantity;
    }
  }
  const custom = typeof sub.custom_limits === 'string' ? JSON.parse(sub.custom_limits) : sub.custom_limits;
  if (custom) for (const [k, v] of Object.entries(custom)) limits[k] = v === null ? null : Number(v);

  // Effective status: an expired trial or an elapsed grace period is read-only.
  const now = Date.now();
  let status = sub.status;
  if (status === 'trial' && sub.trial_ends_at && new Date(sub.trial_ends_at).getTime() < now) status = 'trial_expired';
  if (status === 'past_due' && sub.grace_ends_at && new Date(sub.grace_ends_at).getTime() < now) status = 'suspended';
  // A platform suspension of the organization overrides the subscription.
  const org = await knex('organizations').where({ id: organizationId }).first('status');
  if (org && org.status !== 'active') status = 'suspended';
  const trialDaysLeft = sub.status === 'trial' && sub.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(sub.trial_ends_at).getTime() - now) / 86_400_000)) : 0;

  return { subscription: sub, plan, status, features, limits, addons, canWrite: WRITE_STATUSES.has(status), trialDaysLeft };
}

function getEntitlements(organizationId) {
  return cache.remember(`ent:${organizationId}`, () => loadEntitlements(organizationId));
}

function invalidate(organizationId) {
  cache.forgetPrefix(`ent:${organizationId}`);
}

async function featureAvailability() {
  return cache.remember('features:availability', async () => {
    const rows = await knex('features').select('key', 'availability');
    return Object.fromEntries(rows.map((f) => [f.key, f.availability]));
  });
}

// Counts current consumption for each limit key. Values come from live tables or usage_records.
async function getUsage(organizationId, trx = knex) {
  const [{ employees }] = await trx('employees').where({ organization_id: organizationId }).whereNot('status', 'terminated').count({ employees: '*' });
  const [{ users }] = await trx('memberships').where({ organization_id: organizationId, status: 'active' }).count({ users: '*' });
  const [{ invites }] = await trx('invitations').where({ organization_id: organizationId }).whereNull('accepted_at').whereNull('revoked_at')
    .where('expires_at', '>', new Date()).count({ invites: '*' });
  const metered = await trx('usage_records').where({ organization_id: organizationId, period: currentPeriod() });
  const m = Object.fromEntries(metered.map((r) => [r.metric, Number(r.quantity)]));
  const storage = await trx('document_versions').where({ organization_id: organizationId }).sum({ q: 'size_bytes' }).first();
  return {
    employees: Number(employees),
    users: Number(users) + Number(invites),
    storage_mb: Math.ceil(Number(storage?.q || 0) / (1024 * 1024)),
    api_calls_monthly: m.api_calls || 0,
    ai_requests_monthly: m.ai_requests || 0,
    active_jobs: 0,
  };
}

async function hasFeature(organizationId, featureKey) {
  const ent = await getEntitlements(organizationId);
  return ent.features.has(featureKey);
}

async function assertFeature(organizationId, featureKey) {
  const availability = (await featureAvailability())[featureKey];
  if (availability === 'coming_soon') throw E.featureUnavailable(featureKey);
  if (!(await hasFeature(organizationId, featureKey))) throw E.featureNotInPlan(featureKey);
}

async function assertCanWrite(organizationId) {
  const ent = await getEntitlements(organizationId);
  if (!ent.canWrite) throw E.subscriptionInactive(ent.status);
}

/**
 * Enforces a usage limit. Call inside the same transaction that creates the resource and
 * lock the subscription row first (lockSubscription) so concurrent requests can't both pass.
 */
async function assertWithinLimit(organizationId, limitKey, increment = 1, trx = knex) {
  const ent = await getEntitlements(organizationId);
  const max = ent.limits[limitKey];
  if (max === null || max === undefined) {
    if (max === undefined) throw E.limitReached(limitKey, 0, 0);
    return;
  }
  const usage = await getUsage(organizationId, trx);
  if (usage[limitKey] + increment > max) throw E.limitReached(limitKey, usage[limitKey], max);
}

async function lockSubscription(organizationId, trx) {
  await trx('subscriptions').where({ organization_id: organizationId }).forUpdate().first();
}

async function incrementUsage(organizationId, metric, quantity = 1) {
  await knex.raw(
    'INSERT INTO usage_records (organization_id, metric, period, quantity) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), updated_at = CURRENT_TIMESTAMP',
    [organizationId, metric, currentPeriod(), quantity],
  );
}

module.exports = {
  getEntitlements, invalidate, getUsage, hasFeature, assertFeature, assertCanWrite, assertWithinLimit,
  lockSubscription, incrementUsage, featureAvailability, currentPeriod,
};
