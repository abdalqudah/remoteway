const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const subscriptions = require('../billing/subscription.service');
const rbac = require('../rbac/rbac.service');
const authService = require('../auth/auth.service');

const DEFAULT_SETTINGS = (country) => ({
  working_days: country.working_days,
  work_start: '09:00',
  work_end: '17:00',
  week_starts_on: country.working_days[0],
  employee_number_prefix: 'EMP-',
  date_format: country.date_format,
});

// Settings are stored as {"v": value}. MySQL 8 returns JSON columns parsed while MariaDB returns
// text, so wrapping in an object makes both drivers' results unambiguous.
const wrap = (value) => JSON.stringify({ v: value });
const unwrap = (raw) => (typeof raw === 'string' ? JSON.parse(raw) : raw)?.v;

function slugify(name) {
  const base = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return base || 'org';
}

async function uniqueSlug(trx, name) {
  const base = slugify(name);
  for (let i = 0; i < 50; i += 1) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await trx('organizations').where({ slug }).first())) return slug;
  }
  return `${base}-${Date.now().toString(36)}`;
}

async function getCountry(trx, code) {
  const country = await trx('country_policies').where({ country_code: code, is_active: true }).first();
  if (!country) throw E.validation({ country_code: 'Choose a supported country.' });
  country.working_days = typeof country.working_days === 'string' ? JSON.parse(country.working_days) : country.working_days;
  return country;
}

/** Creates a tenant: organization + owner membership + trial subscription + default settings. */
async function createOrganization(trx, { ownerUserId, company, planKey }, ctx = {}) {
  const country = await getCountry(trx, company.country_code);
  const [organizationId] = await trx('organizations').insert({
    name: company.name,
    slug: await uniqueSlug(trx, company.name),
    country_code: country.country_code,
    industry: company.industry || null,
    company_size: company.company_size || null,
    website: company.website || null,
    phone: company.phone || null,
    address: company.address || null,
    currency: country.currency,
    timezone: country.timezone,
    locale: company.locale || country.default_locale,
    owner_user_id: ownerUserId,
  });
  await trx('memberships').insert({ organization_id: organizationId, user_id: ownerUserId });
  const ownerRole = await rbac.getRoleByKey(organizationId, 'owner', trx);
  await trx('user_roles').insert({ organization_id: organizationId, user_id: ownerUserId, role_id: ownerRole.id });
  const settings = DEFAULT_SETTINGS(country);
  await trx('organization_settings').insert(Object.entries(settings).map(([key, value]) => ({ organization_id: organizationId, key, value: wrap(value) })));
  await subscriptions.startTrial(trx, organizationId, planKey);
  await trx('users').where({ id: ownerUserId }).update({ last_organization_id: organizationId });
  await audit.record({ ...ctx, organizationId, userId: ownerUserId }, 'organization.created', {
    entityType: 'organization', entityId: organizationId, newValues: { name: company.name, plan: planKey },
  }, trx);
  return organizationId;
}

/** Public sign-up: new user + new organization, atomically. */
async function registerCompany({ account, company, planKey }, ctx = {}) {
  const out = await knex.transaction(async (trx) => {
    const userId = await authService.createUser(trx, account);
    const organizationId = await createOrganization(trx, { ownerUserId: userId, company, planKey }, ctx);
    return { userId, organizationId };
  });
  await require('../crm/crm.service').track('company_signup', { organizationId: out.organizationId, plan: planKey }); // eslint-disable-line global-require
  return out;
}

/** An existing user creates an additional organization. */
async function createAdditionalOrganization(userId, { company, planKey }, ctx = {}) {
  const organizationId = await knex.transaction((trx) => createOrganization(trx, { ownerUserId: userId, company, planKey }, ctx));
  await require('../crm/crm.service').track('company_signup', { organizationId, plan: planKey }); // eslint-disable-line global-require
  return organizationId;
}

async function listForUser(userId) {
  return knex('memberships as m').join('organizations as o', 'o.id', 'm.organization_id')
    .where({ 'm.user_id': userId, 'm.status': 'active' }).whereNot('o.status', 'closed')
    .select('o.id', 'o.name', 'o.slug', 'o.logo_url', 'o.status').orderBy('o.name');
}

async function isMember(userId, organizationId) {
  const row = await knex('memberships as m').join('organizations as o', 'o.id', 'm.organization_id')
    .where({ 'm.user_id': userId, 'm.organization_id': organizationId, 'm.status': 'active' }).whereNot('o.status', 'closed').first('m.id');
  return Boolean(row);
}

async function get(organizationId) {
  return cache.remember(`org:${organizationId}`, async () => {
    const org = await knex('organizations as o').join('country_policies as c', 'c.country_code', 'o.country_code')
      .where('o.id', organizationId).select('o.*', 'c.name as country_name', 'c.name_ar as country_name_ar', 'c.vat_rate').first();
    if (!org) throw E.notFound('Organization');
    return org;
  });
}

async function getSettings(organizationId) {
  return cache.remember(`org:${organizationId}:settings`, async () => {
    const rows = await knex('organization_settings').where({ organization_id: organizationId });
    return Object.fromEntries(rows.map((r) => [r.key, unwrap(r.value)]));
  });
}

async function updateSettings(ctx, values) {
  const before = await getSettings(ctx.organizationId);
  await knex.transaction(async (trx) => {
    for (const [key, value] of Object.entries(values)) {
      await trx('organization_settings').insert({ organization_id: ctx.organizationId, key, value: wrap(value) })
        .onConflict(['organization_id', 'key']).merge({ value: wrap(value), updated_at: new Date() });
    }
    const d = audit.diff(Object.fromEntries(Object.keys(values).map((k) => [k, JSON.stringify(before[k] ?? null)])),
      Object.fromEntries(Object.entries(values).map(([k, v]) => [k, JSON.stringify(v)])));
    if (d.changed) await audit.record(ctx, 'organization.settings_updated', { entityType: 'organization', entityId: ctx.organizationId, oldValues: d.oldValues, newValues: d.newValues }, trx);
  });
  cache.forgetPrefix(`org:${ctx.organizationId}`);
}

async function updateProfile(ctx, values) {
  const before = await knex('organizations').where({ id: ctx.organizationId }).first();
  const patch = { ...values };
  if (values.country_code && values.country_code !== before.country_code) {
    const country = await getCountry(knex, values.country_code);
    patch.currency = country.currency;
    patch.timezone = country.timezone;
  }
  const d = audit.diff(before, patch);
  if (!d.changed) return;
  await knex('organizations').where({ id: ctx.organizationId }).update(patch);
  await audit.record(ctx, 'organization.updated', { entityType: 'organization', entityId: ctx.organizationId, oldValues: d.oldValues, newValues: d.newValues });
  cache.forgetPrefix(`org:${ctx.organizationId}`);
}

async function completeOnboarding(ctx) {
  await knex('organizations').where({ id: ctx.organizationId }).whereNull('onboarding_completed_at').update({ onboarding_completed_at: new Date() });
  cache.forgetPrefix(`org:${ctx.organizationId}`);
}

async function listCountries() {
  return cache.remember('countries', () => knex('country_policies').where({ is_active: true }).orderBy('name'));
}

module.exports = {
  registerCompany, createAdditionalOrganization, listForUser, isMember, get, getSettings, updateSettings, updateProfile, completeOnboarding, listCountries,
};
