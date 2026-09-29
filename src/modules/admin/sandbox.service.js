// Test environment: test companies inside the live platform for the team to try things safely.
// A test company gets realistic sample data and one account per role (owner, HR, finance, manager,
// employee) on its own internal domain. It never sends email, stays off the public jobs board, is left
// out of platform figures, and is deleted — with every record, file and generated account — in one step.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const cache = require('../../core/cache');
const secrets = require('../../core/secrets');
const storage = require('../../core/storage');
const { E, AppError } = require('../../core/errors');

const SANDBOX_SUFFIX = 'sandbox.remoteway.local';
const meta = (o) => { try { return JSON.parse(o.sandbox_meta || '{}'); } catch { return {}; } };

async function list() {
  const rows = await knex('organizations as o').leftJoin('subscriptions as s', 's.organization_id', 'o.id').leftJoin('plans as p', 'p.id', 's.plan_id')
    .where('o.is_sandbox', true).select('o.id', 'o.name', 'o.slug', 'o.created_at', 'o.sandbox_meta', 'p.name as plan_name').orderBy('o.id', 'desc');
  const out = [];
  for (const o of rows) {
    const m = meta(o);
    const [[{ n: people }], [{ n: members }]] = await Promise.all([
      knex('employees').where({ organization_id: o.id }).count({ n: '*' }),
      knex('memberships').where({ organization_id: o.id }).count({ n: '*' }),
    ]);
    const guests = await knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where('m.organization_id', o.id)
      .whereNot('u.email', 'like', `%@${m.domain || SANDBOX_SUFFIX}`).select('u.id', 'u.name', 'u.email');
    out.push({
      id: o.id, name: o.name, slug: o.slug, created_at: o.created_at, plan: o.plan_name, people: Number(people), members: Number(members),
      domain: m.domain, password: m.password_enc ? secrets.decrypt(m.password_enc) : null, accounts: m.accounts || [], note: m.note || '', sample: m.sample !== false, guests,
    });
  }
  return out;
}

function newPassword() {
  return `Test-${crypto.randomBytes(3).toString('hex')}-${crypto.randomInt(1000, 9999)}`;
}

/** Creates a test company. Sample data is optional; the accounts always exist. */
async function create(ctx, body) {
  const name = String(body.name || '').trim().slice(0, 120);
  if (name.length < 2) throw E.validation({ name: 'Give the test company a name.' });
  const plan = await knex('plans').where({ key: String(body.plan || 'enterprise') }).first('key');
  if (!plan) throw E.validation({ plan: 'Choose a plan.' });
  const tag = crypto.randomBytes(3).toString('hex');
  const domain = `t${tag}.${SANDBOX_SUFFIX}`;
  const password = newPassword();
  const sample = body.sample === '1';
  let organizationId; let accounts;
  const lib = require('../../db/sample-company'); // eslint-disable-line global-require
  if (sample) {
    ({ organizationId, accounts } = await lib.createSampleCompany({ name, domain, password, planKey: plan.key, talent: false }));
  } else {
    const orgs = require('../organizations/organization.service'); // eslint-disable-line global-require
    const r = await orgs.registerCompany({ account: { name: 'Test Owner', email: `owner@${domain}`, password, locale: 'ar' }, company: { name, country_code: 'SA', locale: 'ar' }, planKey: plan.key });
    organizationId = r.organizationId;
    await orgs.completeOnboarding({ organizationId });
    await knex('users').where({ id: r.userId }).update({ email_verified_at: new Date() });
    accounts = [{ role: 'owner', name: 'Test Owner', email: `owner@${domain}` }];
  }
  const m = { domain, password_enc: secrets.encrypt(password), plan: plan.key, sample, accounts, created_by: ctx.userId, note: String(body.note || '').slice(0, 300) };
  const slug = `test-${tag}`;
  const slugFree = !(await knex('organizations').where({ slug }).whereNot({ id: organizationId }).first('id'));
  await knex('organizations').where({ id: organizationId }).update({ is_sandbox: true, sandbox_meta: JSON.stringify(m), name, ...(slugFree ? { slug } : {}) });
  // Always "paid": no trial banner, no invoices.
  await knex('subscriptions').where({ organization_id: organizationId }).update({ status: 'active', trial_ends_at: null, current_period_start: new Date(), current_period_end: new Date(Date.now() + 10 * 365 * 86_400_000) });
  // Nothing from a test company reaches the public jobs board.
  await knex('jobs').where({ organization_id: organizationId }).update({ marketplace: false, marketplace_at: null });
  // Registration tells the CRM about a new company before it is marked as a test: take that back.
  await knex('crm_contacts').where('email', 'like', `%@${domain}`).del().catch(() => {});
  cache.clear();
  require('../../core/mailer').forgetOrg(organizationId); // eslint-disable-line global-require
  await audit.record(ctx, 'platform.sandbox_created', { entityType: 'organization', entityId: organizationId, newValues: { name, plan: plan.key, sample } });
  return { organizationId, domain, password, accounts };
}

async function getSandbox(id) {
  const o = await knex('organizations').where({ id: Number(id), is_sandbox: true }).first();
  if (!o) throw E.notFound('Test company');
  return o;
}

/** Gives an existing RemoteWay account (e.g. a team member) access to the test company with a role. */
async function addMember(ctx, id, { email, role }) {
  const o = await getSandbox(id);
  const user = await knex('users').where({ email: String(email || '').trim().toLowerCase() }).whereNull('deleted_at').first('id', 'email');
  if (!user) throw E.validation({ email: 'No RemoteWay account uses this email. The person signs up first (or use the ready accounts).' });
  const r = await knex('roles').whereNull('organization_id').where({ key: String(role || 'employee') }).first('id');
  if (!r || role === 'owner') throw E.validation({ role: 'Choose a role.' });
  await knex.transaction(async (trx) => {
    const mem = await trx('memberships').where({ organization_id: o.id, user_id: user.id }).first('id');
    if (!mem) await trx('memberships').insert({ organization_id: o.id, user_id: user.id });
    await trx('user_roles').where({ organization_id: o.id, user_id: user.id }).del();
    await trx('user_roles').insert({ organization_id: o.id, user_id: user.id, role_id: r.id });
  });
  require('../rbac/rbac.service').invalidate(o.id); // eslint-disable-line global-require
  await audit.record(ctx, 'platform.sandbox_member_added', { entityType: 'organization', entityId: o.id, newValues: { email: user.email, role } });
}

async function removeMember(ctx, id, userId) {
  const o = await getSandbox(id);
  await knex('user_roles').where({ organization_id: o.id, user_id: Number(userId) }).del();
  await knex('memberships').where({ organization_id: o.id, user_id: Number(userId) }).del();
  await knex('users').where({ id: Number(userId), last_organization_id: o.id }).update({ last_organization_id: null });
  require('../rbac/rbac.service').invalidate(o.id); // eslint-disable-line global-require
}

/**
 * Deletes a test company completely: every record (cascade), uploaded files, and the accounts generated
 * for it. Team members' own accounts are kept (only their access to the test company goes).
 */
async function remove(ctx, id, password) {
  const me = await knex('users').where({ id: ctx.userId }).first();
  if (!me || !(await bcrypt.compare(String(password || ''), me.password_hash))) throw E.validation({ password: 'Current password is incorrect.' });
  const o = await getSandbox(id);
  const m = meta(o);
  if (!m.domain || !m.domain.endsWith(`.${SANDBOX_SUFFIX}`)) throw new AppError('SANDBOX_BROKEN', 'This test company has no test domain, so it was not deleted automatically.', 409);
  const generated = await knex('users').where('email', 'like', `%@${m.domain}`).where('is_super_admin', false).pluck('id');
  // Generated accounts that somehow joined a real company are kept (and reported).
  const stuck = generated.length ? await knex('memberships as mm').join('organizations as oo', 'oo.id', 'mm.organization_id').whereIn('mm.user_id', generated).where('oo.is_sandbox', false).pluck('mm.user_id') : [];
  const toDelete = generated.filter((uid) => !stuck.includes(uid));
  await knex.transaction(async (trx) => {
    await trx('users').whereIn('id', await trx('memberships').where({ organization_id: o.id }).pluck('user_id')).where({ last_organization_id: o.id }).update({ last_organization_id: null });
    await trx('organizations').where({ id: o.id }).del(); // every company record cascades
    if (toDelete.length) await trx('users').whereIn('id', toDelete).del();
  });
  fs.rmSync(path.join(storage.root, `org-${Number(o.id)}`), { recursive: true, force: true });
  cache.clear();
  await audit.record(ctx, 'platform.sandbox_deleted', { entityType: 'organization', entityId: o.id, newValues: { name: o.name, accounts: toDelete.length, kept: stuck.length } });
  return { name: o.name, accounts: toDelete.length };
}

/** Deletes and recreates the test company with fresh sample data (same name, plan and team members). */
async function reset(ctx, id, password) {
  const o = await getSandbox(id);
  const m = meta(o);
  const guests = (await list()).find((x) => x.id === o.id).guests;
  const roles = {};
  for (const g of guests) {
    const r = await knex('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').where({ 'ur.organization_id': o.id, 'ur.user_id': g.id }).first('r.key');
    roles[g.email] = r ? r.key : 'employee';
  }
  await remove(ctx, id, password);
  const created = await create(ctx, { name: o.name, plan: m.plan, sample: m.sample === false ? '0' : '1', note: m.note });
  for (const [email, role] of Object.entries(roles)) await addMember(ctx, created.organizationId, { email, role }).catch(() => {});
  return created;
}

module.exports = { SANDBOX_SUFFIX, list, create, addMember, removeMember, remove, reset };
