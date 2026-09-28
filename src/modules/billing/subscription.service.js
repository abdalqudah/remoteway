// Plan changes, add-ons and invoices. There is no payment gateway yet: invoices are issued
// and a platform super admin records the payment, which activates the billing period.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const ent = require('./entitlements.service');

const addPeriod = (date, cycle) => {
  const d = new Date(date);
  if (cycle === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
};
const addDays = (date, days) => new Date(new Date(date).getTime() + days * 86_400_000);
const round2 = (n) => Math.round(n * 100) / 100;

async function listPublicPlans() {
  const plans = await knex('plans').where({ is_active: true, is_public: true }).orderBy('sort_order');
  const features = await knex('plan_features as pf').join('features as f', 'f.id', 'pf.feature_id')
    .whereIn('pf.plan_id', plans.map((p) => p.id)).select('pf.plan_id', 'f.key', 'f.name', 'f.availability', 'f.sort_order').orderBy('f.sort_order');
  const limits = await knex('plan_limits').whereIn('plan_id', plans.map((p) => p.id));
  return plans.map((p) => ({
    ...p,
    features: features.filter((f) => f.plan_id === p.id),
    limits: Object.fromEntries(limits.filter((l) => l.plan_id === p.id).map((l) => [l.limit_key, l.limit_value === null ? null : Number(l.limit_value)])),
  }));
}

async function listAddons() {
  return knex('addons as a').leftJoin('features as f', 'f.id', 'a.feature_id').where('a.is_active', true)
    .select('a.*', 'f.key as feature_key', 'f.availability as feature_availability').orderBy('a.sort_order');
}

async function startTrial(trx, organizationId, planKey) {
  const plan = await trx('plans').where({ key: planKey, is_active: true }).first();
  if (!plan) throw E.validation({ plan: 'Choose a valid plan.' });
  const now = new Date();
  const isTrial = plan.trial_days > 0;
  await trx('subscriptions').insert({
    organization_id: organizationId,
    plan_id: plan.id,
    status: isTrial ? 'trial' : 'past_due',
    billing_cycle: 'monthly',
    started_at: now,
    trial_ends_at: isTrial ? addDays(now, plan.trial_days) : null,
    // Custom (enterprise) plans without a trial get a grace window until sales activates them.
    grace_ends_at: isTrial ? null : addDays(now, 14),
  });
  return plan;
}

async function nextInvoiceNumber(trx) {
  const prefix = `RW-${new Date().toISOString().slice(0, 7).replace('-', '')}-`;
  const last = await trx('invoices').where('number', 'like', `${prefix}%`).orderBy('id', 'desc').forUpdate().first();
  const seq = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(5, '0')}`;
}

async function issueInvoice(trx, { organizationId, subscriptionId, cycle, items, periodStart }) {
  const org = await trx('organizations as o').join('country_policies as c', 'c.country_code', 'o.country_code')
    .where('o.id', organizationId).select('o.currency', 'c.vat_rate').first();
  const currency = items[0]?.currency || org.currency;
  const subtotal = round2(items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0));
  const taxRate = Number(org.vat_rate || 0);
  const tax = round2((subtotal * taxRate) / 100);
  const issueDate = new Date();
  const [invoiceId] = await trx('invoices').insert({
    organization_id: organizationId,
    subscription_id: subscriptionId,
    number: await nextInvoiceNumber(trx),
    issue_date: issueDate,
    due_date: addDays(issueDate, 7),
    period_start: periodStart,
    period_end: addPeriod(periodStart, cycle),
    currency,
    subtotal,
    tax_rate: taxRate,
    tax,
    total: round2(subtotal + tax),
    status: 'issued',
  });
  await trx('invoice_items').insert(items.map((i) => ({
    invoice_id: invoiceId, description: i.description, quantity: i.quantity, unit_price: i.unit_price, amount: round2(i.unit_price * i.quantity),
  })));
  return invoiceId;
}

async function buildLineItems(trx, subscription, plan, cycle) {
  const price = cycle === 'yearly' ? plan.price_yearly : plan.price_monthly;
  const items = [{ description: `${plan.name} plan (${cycle})`, quantity: 1, unit_price: Number(price), currency: plan.currency }];
  const addons = await trx('subscription_addons as sa').join('addons as a', 'a.id', 'sa.addon_id').where('sa.subscription_id', subscription.id)
    .select('a.name', 'a.price_monthly', 'a.currency', 'sa.quantity');
  for (const a of addons) {
    if (Number(a.price_monthly) > 0) {
      const multiplier = cycle === 'yearly' ? 12 : 1;
      items.push({ description: `${a.name} (${cycle})`, quantity: a.quantity, unit_price: Number(a.price_monthly) * multiplier, currency: a.currency });
    }
  }
  return items;
}

async function assertFitsPlan(trx, organizationId, planId) {
  const limits = Object.fromEntries((await trx('plan_limits').where({ plan_id: planId })).map((l) => [l.limit_key, l.limit_value]));
  const usage = await ent.getUsage(organizationId, trx);
  for (const key of ['employees', 'users']) {
    if (limits[key] !== null && limits[key] !== undefined && usage[key] > Number(limits[key])) {
      throw E.conflict('PLAN_LIMIT_BELOW_USAGE', `This plan allows ${limits[key]} ${key}, but you currently have ${usage[key]}.`);
    }
  }
}

/**
 * Switch plan / billing cycle. During a trial the switch is free. Otherwise an invoice
 * is issued for the new plan; the period starts once the invoice is paid.
 */
async function changePlan(ctx, { planKey, cycle }) {
  return knex.transaction(async (trx) => {
    const sub = await trx('subscriptions').where({ organization_id: ctx.organizationId }).forUpdate().first();
    const plan = await trx('plans').where({ key: planKey, is_active: true, is_public: true }).first();
    if (!plan) throw E.validation({ plan: 'Choose a valid plan.' });
    if (plan.is_custom || plan.price_monthly === null) {
      throw E.conflict('PLAN_REQUIRES_SALES', 'This plan is arranged with our sales team.');
    }
    await assertFitsPlan(trx, ctx.organizationId, plan.id);
    const oldPlan = await trx('plans').where({ id: sub.plan_id }).first();
    const effective = (await ent.getEntitlements(ctx.organizationId)).status;

    const update = { plan_id: plan.id, billing_cycle: cycle };
    let invoiceId = null;
    if (effective !== 'trial') {
      update.status = sub.status === 'active' ? 'active' : 'past_due';
      if (update.status === 'past_due') update.grace_ends_at = addDays(new Date(), 7);
      const items = await buildLineItems(trx, sub, plan, cycle);
      invoiceId = await issueInvoice(trx, { organizationId: ctx.organizationId, subscriptionId: sub.id, cycle, items, periodStart: new Date() });
    }
    await trx('subscriptions').where({ id: sub.id }).update(update);
    await audit.record(ctx, 'subscription.plan_changed', {
      entityType: 'subscription', entityId: sub.id,
      oldValues: { plan: oldPlan.key, billing_cycle: sub.billing_cycle }, newValues: { plan: plan.key, billing_cycle: cycle, invoice_id: invoiceId },
    }, trx);
    return { invoiceId };
  }).finally(() => ent.invalidate(ctx.organizationId));
}

async function setAddon(ctx, { addonKey, quantity }) {
  return knex.transaction(async (trx) => {
    const sub = await trx('subscriptions').where({ organization_id: ctx.organizationId }).forUpdate().first();
    const addon = await trx('addons').where({ key: addonKey, is_active: true }).first();
    if (!addon) throw E.notFound('Add-on');
    const qty = addon.limit_key ? quantity : Math.min(quantity, 1);
    const existing = await trx('subscription_addons').where({ subscription_id: sub.id, addon_id: addon.id }).first();
    if (qty <= 0) {
      if (existing) await trx('subscription_addons').where({ id: existing.id }).del();
    } else if (existing) {
      await trx('subscription_addons').where({ id: existing.id }).update({ quantity: qty });
    } else {
      await trx('subscription_addons').insert({ subscription_id: sub.id, addon_id: addon.id, quantity: qty });
    }
    if (qty < (existing?.quantity || 0) && addon.limit_key) {
      const e = await loadAfterChange(trx, ctx.organizationId);
      const usage = await ent.getUsage(ctx.organizationId, trx);
      if (e.limits[addon.limit_key] !== null && usage[addon.limit_key] > e.limits[addon.limit_key]) {
        throw E.conflict('PLAN_LIMIT_BELOW_USAGE', 'Removing this add-on would put you over your current usage.');
      }
    }
    await audit.record(ctx, 'subscription.addon_changed', {
      entityType: 'subscription', entityId: sub.id, oldValues: { [addon.key]: existing?.quantity || 0 }, newValues: { [addon.key]: qty },
    }, trx);
  }).finally(() => ent.invalidate(ctx.organizationId));
}

// Entitlements computed inside the running transaction (so uncommitted add-on changes count).
async function loadAfterChange(trx, organizationId) {
  const sub = await trx('subscriptions').where({ organization_id: organizationId }).first();
  const limits = Object.fromEntries((await trx('plan_limits').where({ plan_id: sub.plan_id })).map((l) => [l.limit_key, l.limit_value === null ? null : Number(l.limit_value)]));
  const addons = await trx('subscription_addons as sa').join('addons as a', 'a.id', 'sa.addon_id').where('sa.subscription_id', sub.id);
  for (const a of addons) if (a.limit_key && limits[a.limit_key] !== null) limits[a.limit_key] = (limits[a.limit_key] || 0) + Number(a.limit_increment) * a.quantity;
  return { limits };
}

/** Owner asks to activate a paid subscription after (or during) the trial: issues an invoice. */
async function requestActivation(ctx) {
  return knex.transaction(async (trx) => {
    const sub = await trx('subscriptions').where({ organization_id: ctx.organizationId }).forUpdate().first();
    const plan = await trx('plans').where({ id: sub.plan_id }).first();
    if (plan.is_custom || plan.price_monthly === null) throw E.conflict('PLAN_REQUIRES_SALES', 'This plan is arranged with our sales team.');
    const open = await trx('invoices').where({ subscription_id: sub.id, status: 'issued' }).first();
    if (open) return { invoiceId: open.id };
    const items = await buildLineItems(trx, sub, plan, sub.billing_cycle);
    const invoiceId = await issueInvoice(trx, { organizationId: ctx.organizationId, subscriptionId: sub.id, cycle: sub.billing_cycle, items, periodStart: new Date() });
    await audit.record(ctx, 'invoice.issued', { entityType: 'invoice', entityId: invoiceId }, trx);
    return { invoiceId };
  });
}

/** Super admin records an offline payment; the subscription becomes active for one billing period. */
async function markInvoicePaid(ctx, invoiceId, reference) {
  return knex.transaction((trx) => markInvoicePaidTrx(trx, ctx, invoiceId, reference));
}

/** Same, inside the caller's transaction (online payments settle the payment row and the invoice together). */
async function markInvoicePaidTrx(trx, ctx, invoiceId, reference) {
  const invoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
  if (!invoice) throw E.notFound('Invoice');
  if (invoice.status !== 'issued') throw E.conflict('INVOICE_NOT_PAYABLE', 'Only issued invoices can be marked as paid.');
  const now = new Date();
  await trx('invoices').where({ id: invoiceId }).update({ status: 'paid', paid_at: now, payment_reference: reference || null });
  if (invoice.subscription_id) {
    const sub = await trx('subscriptions').where({ id: invoice.subscription_id }).forUpdate().first();
    // A renewal paid before the period ends extends it; otherwise the new period starts today.
    const current = sub.current_period_end ? new Date(sub.current_period_end) : null;
    const start = sub.status === 'active' && current && current > now ? current : now;
    await trx('subscriptions').where({ id: sub.id }).update({
      status: 'active', current_period_start: start, current_period_end: addPeriod(start, sub.billing_cycle), grace_ends_at: null,
    });
  }
  await audit.record({ ...ctx, organizationId: invoice.organization_id }, 'invoice.paid', {
    entityType: 'invoice', entityId: invoiceId, newValues: { payment_reference: reference || null },
  }, trx);
  ent.invalidate(invoice.organization_id);
}

const RENEWAL_NOTICE_DAYS = 7;
const OVERDUE_GRACE_DAYS = 7;

/**
 * Daily billing sweep: issues the renewal invoice a week before a paid period ends, and moves a
 * subscription whose period ended with the renewal still unpaid to past due (7 days of grace).
 */
async function renewalSweep(now = new Date()) {
  const notifications = require('../notifications/notification.service'); // eslint-disable-line global-require
  let issued = 0; let overdue = 0;
  const due = await knex('subscriptions as s').join('plans as p', 'p.id', 's.plan_id')
    .where('s.status', 'active').whereNotNull('s.current_period_end').where('s.current_period_end', '<=', addDays(now, RENEWAL_NOTICE_DAYS))
    .where('p.is_custom', false).whereNotNull('p.price_monthly')
    .whereNotExists(function open() { this.select('*').from('invoices as i').whereRaw('i.subscription_id = s.id').where('i.status', 'issued'); })
    .select('s.id', 's.organization_id');
  for (const row of due) {
    const invoiceId = await knex.transaction(async (trx) => {
      const sub = await trx('subscriptions').where({ id: row.id }).forUpdate().first();
      if (sub.status !== 'active' || await trx('invoices').where({ subscription_id: sub.id, status: 'issued' }).first()) return null;
      const plan = await trx('plans').where({ id: sub.plan_id }).first();
      const items = await buildLineItems(trx, sub, plan, sub.billing_cycle);
      const id = await issueInvoice(trx, { organizationId: sub.organization_id, subscriptionId: sub.id, cycle: sub.billing_cycle, items, periodStart: new Date(sub.current_period_end) });
      // Due when the current period ends, not 7 days after issue.
      const dueDate = new Date(sub.current_period_end) > now ? new Date(sub.current_period_end) : addDays(now, 1);
      await trx('invoices').where({ id }).update({ due_date: dueDate });
      await audit.record({ organizationId: sub.organization_id, userId: null }, 'invoice.issued', { entityType: 'invoice', entityId: id, newValues: { renewal: true } }, trx);
      const inv = await trx('invoices').where({ id }).first('number', 'total', 'currency');
      const managers = await notifications.usersWithPermission(sub.organization_id, 'billing.manage', trx);
      await notifications.notify(sub.organization_id, managers, 'renewal_invoice', { number: inv.number }, `/app/billing/invoices/${id}`, trx);
      return id;
    });
    if (invoiceId) issued += 1;
  }
  const late = await knex('subscriptions as s').where('s.status', 'active').whereNotNull('s.current_period_end').where('s.current_period_end', '<', now)
    .whereExists(function open() { this.select('*').from('invoices as i').whereRaw('i.subscription_id = s.id').where('i.status', 'issued'); })
    .select('s.id', 's.organization_id', 's.current_period_end');
  for (const sub of late) {
    await knex('subscriptions').where({ id: sub.id, status: 'active' }).update({ status: 'past_due', grace_ends_at: addDays(new Date(sub.current_period_end), OVERDUE_GRACE_DAYS) });
    await audit.record({ organizationId: sub.organization_id, userId: null }, 'subscription.past_due', { entityType: 'subscription', entityId: sub.id });
    ent.invalidate(sub.organization_id);
    overdue += 1;
  }
  return { issued, overdue };
}

async function cancel(ctx) {
  await knex('subscriptions').where({ organization_id: ctx.organizationId }).update({ status: 'cancelled', cancelled_at: new Date() });
  await audit.record(ctx, 'subscription.cancelled', { entityType: 'subscription' });
  ent.invalidate(ctx.organizationId);
}

async function listInvoices(organizationId) {
  return knex('invoices').where({ organization_id: organizationId }).orderBy('id', 'desc');
}

async function getInvoice(organizationId, invoiceId) {
  const invoice = await knex('invoices').where({ organization_id: organizationId, id: invoiceId }).first();
  if (!invoice) throw E.notFound('Invoice');
  invoice.items = await knex('invoice_items').where({ invoice_id: invoice.id });
  return invoice;
}

module.exports = {
  listPublicPlans, listAddons, startTrial, changePlan, setAddon, requestActivation, markInvoicePaid, markInvoicePaidTrx, renewalSweep, cancel, issueInvoice, buildLineItems, addPeriod, listInvoices, getInvoice,
};
