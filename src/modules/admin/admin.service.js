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
    .leftJoin('users as u', 'u.id', 'o.owner_user_id')
    .leftJoin('subscriptions as s', 's.organization_id', 'o.id')
    .leftJoin('plans as p', 'p.id', 's.plan_id')
    .select('o.id', 'o.name', 'o.slug', 'o.country_code', 'o.status', 'o.created_at', 'u.email as owner_email', 's.status as sub_status', 's.trial_ends_at', 'p.name as plan_name',
      knex('employees').count('*').where('organization_id', knex.ref('o.id')).whereNot('status', 'terminated').as('employee_count'))
    .orderBy('o.id', 'desc').limit(200);
  if (q) query.where((w) => w.where('o.name', 'like', `%${q}%`).orWhere('u.email', 'like', `%${q}%`));
  return query;
}

async function getOrganization(id) {
  const org = await knex('organizations as o').leftJoin('users as u', 'u.id', 'o.owner_user_id').where('o.id', id)
    .select('o.*', 'u.name as owner_name', 'u.email as owner_email').first();
  if (!org) throw E.notFound('Organization');
  org.entitlements = await ent.getEntitlements(id);
  org.usage = await ent.getUsage(id);
  org.invoices = await knex('invoices').where({ organization_id: id }).orderBy('id', 'desc');
  const sub = org.entitlements.subscription;
  org.planFeatures = sub ? await knex('plan_features as pf').join('features as f', 'f.id', 'pf.feature_id').where('pf.plan_id', sub.plan_id).pluck('f.key') : [];
  org.customFeatures = sub ? ((typeof sub.custom_features === 'string' ? JSON.parse(sub.custom_features) : sub.custom_features) || []) : [];
  org.addonQty = Object.fromEntries((org.entitlements.addons || []).map((a) => [a.key, a.quantity]));
  org.members = Number((await knex('memberships').where({ organization_id: id, status: 'active' }).count({ n: '*' }))[0].n);
  org.branding = await knex('organization_branding').where({ organization_id: id }).first('white_label', 'brand_name', 'custom_domain', 'logo_sha');
  return org;
}

async function setOrganizationStatus(ctx, id, status) {
  if (!['active', 'suspended'].includes(status)) throw E.validation({ status: 'Invalid status.' });
  await knex('organizations').where({ id }).update({ status });
  await audit.record({ ...ctx, organizationId: id }, `platform.organization_${status}`, { entityType: 'organization', entityId: id });
  cache.forgetPrefix(`org:${id}`);
  ent.invalidate(id);
}

async function updateSubscription(ctx, organizationId, {
  plan_id: planId, status, trial_ends_at: trialEndsAt, custom_limits: customLimits, billing_cycle: cycle, current_period_end: periodEnd,
}) {
  let sub = await knex('subscriptions').where({ organization_id: organizationId }).first();
  if (!sub) {
    // A company left without a subscription (e.g. an interrupted sign-up): the platform creates one here.
    if (!planId || !(await knex('organizations').where({ id: organizationId }).first('id'))) throw E.notFound('Subscription');
    await knex('subscriptions').insert({ organization_id: organizationId, plan_id: planId, status: status || 'active', billing_cycle: cycle || 'monthly', started_at: new Date() });
    sub = await knex('subscriptions').where({ organization_id: organizationId }).first();
  }
  const patch = {};
  if (planId) {
    if (!(await knex('plans').where({ id: planId }).first('id'))) throw E.validation({ plan_id: 'Choose a valid plan.' });
    patch.plan_id = planId;
  }
  if (status) patch.status = status;
  if (cycle) patch.billing_cycle = cycle;
  if (trialEndsAt !== undefined) patch.trial_ends_at = trialEndsAt ? new Date(`${trialEndsAt}T23:59:59Z`) : null;
  if (periodEnd !== undefined) patch.current_period_end = periodEnd ? new Date(`${periodEnd}T23:59:59Z`) : null;
  if (status === 'active' && periodEnd && !sub.current_period_start) patch.current_period_start = new Date();
  if (status && status !== 'past_due') patch.grace_ends_at = null;
  if (customLimits !== undefined) patch.custom_limits = customLimits ? JSON.stringify(customLimits) : null;
  const d = audit.diff(sub, patch);
  await knex('subscriptions').where({ id: sub.id }).update(patch);
  await audit.record({ ...ctx, organizationId }, 'platform.subscription_updated', { entityType: 'subscription', entityId: sub.id, oldValues: d.oldValues, newValues: d.newValues });
  ent.invalidate(organizationId);
}

/** Sets the company's add-ons (quantities; 0 removes). The platform may go below current usage. */
async function setAddons(ctx, organizationId, quantities) {
  await knex.transaction(async (trx) => {
    const sub = await trx('subscriptions').where({ organization_id: organizationId }).forUpdate().first();
    if (!sub) throw E.notFound('Subscription');
    const addons = await trx('addons');
    const before = {}; const after = {};
    for (const a of addons) {
      if (!(a.key in quantities)) continue; // eslint-disable-line no-continue
      const given = Array.isArray(quantities[a.key]) ? quantities[a.key][quantities[a.key].length - 1] : quantities[a.key]; // checkbox after its hidden 0
      const raw = Number(given);
      if (!Number.isInteger(raw) || raw < 0 || raw > 100) throw E.validation({ [`addons.${a.key}`]: 'Use a whole number between 0 and 100.' });
      const qty = a.limit_key ? raw : Math.min(raw, 1);
      const existing = await trx('subscription_addons').where({ subscription_id: sub.id, addon_id: a.id }).first();
      before[a.key] = existing ? existing.quantity : 0;
      after[a.key] = qty;
      if (qty === 0) { if (existing) await trx('subscription_addons').where({ id: existing.id }).del(); } else if (existing) await trx('subscription_addons').where({ id: existing.id }).update({ quantity: qty });
      else await trx('subscription_addons').insert({ subscription_id: sub.id, addon_id: a.id, quantity: qty });
    }
    const d = audit.diff(before, after);
    if (d.changed) await audit.record({ ...ctx, organizationId }, 'platform.addons_updated', { entityType: 'subscription', entityId: sub.id, oldValues: d.oldValues, newValues: d.newValues }, trx);
  });
  ent.invalidate(organizationId);
}

/** Features granted on top of the plan (e.g. White Label for one company). */
async function setCustomFeatures(ctx, organizationId, keys) {
  const sub = await knex('subscriptions').where({ organization_id: organizationId }).first();
  if (!sub) throw E.notFound('Subscription');
  const valid = new Set(await knex('features').pluck('key'));
  const planKeys = new Set(await knex('plan_features as pf').join('features as f', 'f.id', 'pf.feature_id').where('pf.plan_id', sub.plan_id).pluck('f.key'));
  const list = [...new Set((keys || []).map(String))].filter((k) => valid.has(k) && !planKeys.has(k)).sort();
  const old = (typeof sub.custom_features === 'string' ? JSON.parse(sub.custom_features) : sub.custom_features) || [];
  await knex('subscriptions').where({ id: sub.id }).update({ custom_features: list.length ? JSON.stringify(list) : null });
  await audit.record({ ...ctx, organizationId }, 'platform.features_granted', { entityType: 'subscription', entityId: sub.id, oldValues: { features: old.join(', ') }, newValues: { features: list.join(', ') } });
  ent.invalidate(organizationId);
  return list;
}

/** Issues an invoice now: the plan and add-ons at list price, or one line with an agreed amount (custom plans). */
async function issueInvoice(ctx, organizationId, { amount, description }) {
  const subscriptions = require('../billing/subscription.service'); // eslint-disable-line global-require
  return knex.transaction(async (trx) => {
    const sub = await trx('subscriptions').where({ organization_id: organizationId }).forUpdate().first();
    if (!sub) throw E.notFound('Subscription');
    if (await trx('invoices').where({ subscription_id: sub.id, status: 'issued' }).first()) throw E.conflict('OPEN_INVOICE_EXISTS', 'This company already has an open invoice. Void it first or wait for it to be paid.');
    const plan = await trx('plans').where({ id: sub.plan_id }).first();
    let items;
    if (amount !== undefined && amount !== null && amount !== '') {
      const value = Math.round(Number(amount) * 100) / 100;
      if (!(value > 0) || value > 10_000_000) throw E.validation({ amount: 'Enter an amount greater than zero.' });
      const desc = String(description || '').trim().slice(0, 200) || `${plan.name} plan (${sub.billing_cycle})`;
      items = [{ description: desc, quantity: 1, unit_price: value, currency: plan.currency }];
    } else {
      if (plan.price_monthly === null) throw E.validation({ amount: 'This plan has no list price. Enter the agreed amount.' });
      items = await subscriptions.buildLineItems(trx, sub, plan, sub.billing_cycle);
    }
    const periodStart = sub.current_period_end && new Date(sub.current_period_end) > new Date() && sub.status === 'active' ? new Date(sub.current_period_end) : new Date();
    const id = await subscriptions.issueInvoice(trx, { organizationId, subscriptionId: sub.id, cycle: sub.billing_cycle, items, periodStart });
    await audit.record({ ...ctx, organizationId }, 'invoice.issued', { entityType: 'invoice', entityId: id, newValues: { by: 'platform' } }, trx);
    const notifications = require('../notifications/notification.service'); // eslint-disable-line global-require
    const inv = await trx('invoices').where({ id }).first('number');
    await notifications.notify(organizationId, await notifications.usersWithPermission(organizationId, 'billing.manage', trx), 'invoice_issued', { number: inv.number }, `/app/billing/invoices/${id}`, trx);
    return id;
  });
}

async function voidInvoice(ctx, invoiceId) {
  const inv = await knex('invoices').where({ id: invoiceId }).first();
  if (!inv) throw E.notFound('Invoice');
  if (inv.status !== 'issued') throw E.conflict('INVOICE_NOT_PAYABLE', 'Only open invoices can be voided.');
  await knex('invoices').where({ id: invoiceId, status: 'issued' }).update({ status: 'void' });
  await knex('payments').where({ invoice_id: invoiceId, status: 'initiated' }).update({ status: 'cancelled', failure_reason: 'invoice_void' });
  await audit.record({ ...ctx, organizationId: inv.organization_id }, 'invoice.voided', { entityType: 'invoice', entityId: invoiceId });
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

module.exports = {
  setAddons, setCustomFeatures, issueInvoice, voidInvoice, overview, listOrganizations, getOrganization, setOrganizationStatus, updateSubscription, listPlans, updatePlan, listInvoices };
