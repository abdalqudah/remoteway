// Custom domains for white-label companies (e.g. hr.company.com instead of remoteway.net).
// A domain goes live only after it is proven:
//   1. ownership — a TXT record  _remoteway.<domain>  =  remoteway-verify=<token>
//   2. pointing  — a CNAME to the platform host, or an A record to the same server address.
// The server must also answer for that name: on cPanel (Orange Host) the domain is added to the hosting
// account as an alias ("parked") domain and AutoSSL issues its certificate. The platform team can do this
// by hand, or save a cPanel API token here and let RemoteWay do it.
const crypto = require('crypto');
const dns = require('dns').promises;
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const cache = require('../../core/cache');
const secrets = require('../../core/secrets');
const { request } = require('../../core/http');
const { E, AppError } = require('../../core/errors');
const { PLATFORM_HOST, invalidate } = require('./branding.service');

const TXT_PREFIX = '_remoteway';
const txtValue = (token) => `remoteway-verify=${token}`;
const newToken = () => crypto.randomBytes(12).toString('hex');

/** The DNS records a company must add, for the settings page and the admin panel. */
function records(b) {
  if (!b || !b.custom_domain) return null;
  return {
    domain: b.custom_domain,
    txt: { name: `${TXT_PREFIX}.${b.custom_domain}`, value: txtValue(b.domain_token || '') },
    cname: { name: b.custom_domain, value: PLATFORM_HOST },
    serverIp: process.env.SERVER_IP || null, // for apex domains, which cannot use CNAME
  };
}

/** Called when a company saves a new domain: it waits for DNS again with a fresh token. */
async function onDomainChanged(organizationId, domain, trx = knex) {
  await trx('organization_branding').where({ organization_id: organizationId }).update(domain
    ? { domain_status: 'pending', domain_token: newToken(), domain_checked_at: null, domain_verified_at: null, domain_check: null, domain_hosting: null, domain_hosting_note: null }
    : { domain_status: 'none', domain_token: null, domain_checked_at: null, domain_verified_at: null, domain_check: null, domain_hosting: null, domain_hosting_note: null });
}

const safe = (p) => p.then((v) => v, (e) => ({ error: e.code || e.message }));

/** Looks the domain up in public DNS; returns what was found (never throws on DNS errors). */
async function inspect(b, resolver = dns) {
  const domain = b.custom_domain;
  const [txt, cname, a, platformA] = await Promise.all([
    safe(resolver.resolveTxt(`${TXT_PREFIX}.${domain}`)), safe(resolver.resolveCname(domain)), safe(resolver.resolve4(domain)),
    process.env.SERVER_IP ? Promise.resolve([process.env.SERVER_IP]) : safe(resolver.resolve4(PLATFORM_HOST)),
  ]);
  const txtList = Array.isArray(txt) ? txt.map((parts) => parts.join('')) : [];
  const cnames = Array.isArray(cname) ? cname.map((c) => c.toLowerCase().replace(/\.$/, '')) : [];
  const addrs = Array.isArray(a) ? a : [];
  const ours = Array.isArray(platformA) ? platformA : [];
  const owned = Boolean(b.domain_token) && txtList.includes(txtValue(b.domain_token));
  const pointed = cnames.includes(PLATFORM_HOST) || (addrs.length > 0 && addrs.every((ip) => ours.includes(ip)));
  return { owned, pointed, txt: txtList.slice(0, 5), cname: cnames.slice(0, 3), a: addrs.slice(0, 4), platform: ours.slice(0, 4), at: new Date().toISOString() };
}

/** Checks DNS and turns the domain on when both records are right. */
async function check(ctx, organizationId, { resolver } = {}) {
  const b = await knex('organization_branding').where({ organization_id: organizationId }).first();
  if (!b || !b.custom_domain) throw E.notFound('Domain');
  if (b.domain_status === 'suspended') throw new AppError('DOMAIN_SUSPENDED', 'The platform team stopped this domain. Contact support.', 409);
  const result = await inspect(b, resolver);
  const live = result.owned && result.pointed;
  const values = { domain_check: JSON.stringify(result), domain_checked_at: new Date() };
  if (live && b.domain_status !== 'verified') Object.assign(values, { domain_status: 'verified', domain_verified_at: new Date() });
  await knex('organization_branding').where({ organization_id: organizationId }).update(values);
  invalidate(organizationId);
  cache.forgetPrefix('brand-host:');
  if (live && b.domain_status !== 'verified') {
    await audit.record({ ...ctx, organizationId }, 'branding.domain_verified', { entityType: 'organization', entityId: organizationId, newValues: { domain: b.custom_domain } });
    if (await hosting.enabled()) await addToHosting(ctx, organizationId).catch(() => {}); // result is stored on the row
  }
  return { ...result, live };
}

// ---------- Platform team ----------
async function list() {
  const rows = await knex('organization_branding as b').join('organizations as o', 'o.id', 'b.organization_id').whereNotNull('b.custom_domain')
    .select('b.organization_id', 'o.name as org_name', 'o.status as org_status', 'b.white_label', 'b.custom_domain', 'b.domain_status', 'b.domain_token', 'b.domain_checked_at',
      'b.domain_verified_at', 'b.domain_check', 'b.domain_hosting', 'b.domain_hosting_note')
    .orderBy('b.domain_status').orderBy('o.name');
  return rows.map((r) => ({ ...r, check: r.domain_check ? (typeof r.domain_check === 'string' ? JSON.parse(r.domain_check) : r.domain_check) : null, records: records(r) }));
}

/** The platform team turns a domain on without the DNS check (e.g. behind a proxy that hides the CNAME). */
async function approve(ctx, organizationId) {
  const b = await knex('organization_branding').where({ organization_id: organizationId }).first();
  if (!b || !b.custom_domain) throw E.notFound('Domain');
  await knex('organization_branding').where({ organization_id: organizationId }).update({ domain_status: 'verified', domain_verified_at: new Date() });
  invalidate(organizationId); cache.forgetPrefix('brand-host:');
  await audit.record(ctx, 'platform.domain_approved', { entityType: 'organization', entityId: organizationId, newValues: { domain: b.custom_domain } });
}

async function suspend(ctx, organizationId) {
  const b = await knex('organization_branding').where({ organization_id: organizationId }).first();
  if (!b || !b.custom_domain) throw E.notFound('Domain');
  await knex('organization_branding').where({ organization_id: organizationId }).update({ domain_status: 'suspended' });
  invalidate(organizationId); cache.forgetPrefix('brand-host:');
  await audit.record(ctx, 'platform.domain_suspended', { entityType: 'organization', entityId: organizationId, newValues: { domain: b.custom_domain } });
}

async function resume(ctx, organizationId) {
  await knex('organization_branding').where({ organization_id: organizationId }).update({ domain_status: 'pending' });
  invalidate(organizationId); cache.forgetPrefix('brand-host:');
  await audit.record(ctx, 'platform.domain_resumed', { entityType: 'organization', entityId: organizationId });
  return check(ctx, organizationId);
}

// ---------- cPanel (optional automation) ----------
const hosting = {
  async get() {
    const row = await knex('platform_settings').where({ key: 'cpanel' }).first();
    const v = row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : {};
    return { host: v.host || '', user: v.user || '', hasToken: Boolean(v.token_enc), token_enc: v.token_enc || null, auto: v.auto !== false };
  },
  async enabled() {
    const c = await hosting.get();
    return Boolean(c.host && c.user && c.token_enc && c.auto);
  },
  async save(ctx, body) {
    const cur = await hosting.get();
    const host = String(body.cp_host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
    const user = String(body.cp_user || '').trim();
    const errors = {};
    if (host && !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) errors.cp_host = 'Enter the cPanel server name, e.g. server1.orangehost.com.';
    if (user && !/^[a-z0-9_]{1,32}$/i.test(user)) errors.cp_user = 'Enter the cPanel username.';
    if (Object.keys(errors).length) throw E.validation(errors);
    const token = String(body.cp_token || '').trim();
    const value = JSON.stringify({ host, user, token_enc: token ? secrets.encrypt(token) : (host && user ? cur.token_enc : null), auto: body.cp_auto === '1' });
    await knex('platform_settings').insert({ key: 'cpanel', value }).onConflict('key').merge({ value, updated_at: new Date() });
    await audit.record(ctx, 'platform.cpanel_updated', { newValues: { host, user, token: token ? 'changed' : 'kept' } });
  },
  /** Calls cPanel with the saved API token. */
  async call(path) {
    const c = await hosting.get();
    if (!c.host || !c.user || !c.token_enc) throw new AppError('CPANEL_NOT_SET', 'Save the cPanel server, username and API token first.', 409);
    const res = await request(`https://${c.host}:2083${path}`, { method: 'GET', headers: { authorization: `cpanel ${c.user}:${secrets.decrypt(c.token_enc)}`, accept: 'application/json' }, timeoutMs: 30_000, maxBytes: 256 * 1024 });
    let j = null;
    try { j = JSON.parse(res.body); } catch { /* not JSON */ }
    if (res.status === 401 || res.status === 403) throw new AppError('CPANEL_AUTH', 'cPanel refused the API token. Create a new token in cPanel → Security → Manage API Tokens.', 400);
    if (res.status !== 200 || !j) throw new AppError('CPANEL_HTTP', `cPanel answered HTTP ${res.status}.`, 502);
    return j;
  },
};

/** Adds the domain to the hosting account as an alias of the app's domain, then asks AutoSSL for a certificate. */
async function addToHosting(ctx, organizationId) {
  const b = await knex('organization_branding').where({ organization_id: organizationId }).first();
  if (!b || !b.custom_domain) throw E.notFound('Domain');
  const note = [];
  let status = 'added';
  try {
    const q = new URLSearchParams({ cpanel_jsonapi_user: (await hosting.get()).user, cpanel_jsonapi_apiversion: '2', cpanel_jsonapi_module: 'Park', cpanel_jsonapi_func: 'park', domain: b.custom_domain });
    const r = await hosting.call(`/json-api/cpanel?${q}`);
    const d = r.cpanelresult || {};
    const ok = d.data && d.data[0] && Number(d.data[0].result) === 1;
    const reason = (d.data && d.data[0] && d.data[0].reason) || d.error || '';
    if (ok) note.push('Alias domain added.');
    else if (/already/i.test(reason)) note.push('The domain was already on the hosting account.');
    else { status = 'failed'; note.push(`cPanel could not add the domain: ${String(reason).slice(0, 200)}`); }
    if (status === 'added') {
      const s = await hosting.call('/execute/SSL/start_autossl_check').catch((e) => ({ status: 0, errors: [e.message] }));
      note.push(Number(s.status) === 1 ? 'AutoSSL check started; the certificate usually arrives within minutes to a few hours.' : `AutoSSL could not start: ${String((s.errors || []).join(' ')).slice(0, 200)}`);
    }
  } catch (e) {
    if (!(e instanceof AppError) && !e.message) throw e;
    status = 'failed';
    note.push(e.message);
  }
  await knex('organization_branding').where({ organization_id: organizationId }).update({ domain_hosting: status, domain_hosting_note: note.join(' ') });
  await audit.record(ctx, 'platform.domain_hosting', { entityType: 'organization', entityId: organizationId, newValues: { domain: b.custom_domain, status } });
  return { status, note: note.join(' ') };
}

async function markManual(ctx, organizationId) {
  await knex('organization_branding').where({ organization_id: organizationId }).update({ domain_hosting: 'manual', domain_hosting_note: null });
  await audit.record(ctx, 'platform.domain_hosting', { entityType: 'organization', entityId: organizationId, newValues: { status: 'manual' } });
}

module.exports = { records, onDomainChanged, inspect, check, list, approve, suspend, resume, hosting, addToHosting, markManual, txtValue, TXT_PREFIX, appUrl: () => config.appUrl };
