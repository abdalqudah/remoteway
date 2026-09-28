// Company portal: every company gets its own address, remoteway.net/<link>. The page shows the
// company's name and logo and asks who is signing in (employee, manager, HR …). The choice only
// decides where the person lands after signing in — what they can open still comes from their role.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const cache = require('../../core/cache');
const ent = require('../billing/entitlements.service');
const { E } = require('../../core/errors');

// Top-level paths the platform uses (and some it may use later): a company link can never take them.
const RESERVED = new Set(`app admin me api login logout signup join jobs talent talent-media careers verify verify-email calendar
  payments webhooks demo pricing privacy terms security forgot reset invite invitations sso org-brand brand css js img fonts
  icons.svg robots.txt sitemap.xml preferences organizations healthz q kiosk help support docs blog about contact status
  www mail ftp remoteway static assets public download uploads files auth account settings dashboard home new`.split(/\s+/).filter(Boolean));
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** The places a person can choose on the company page, the page each opens and what it needs. */
const ENTRIES = [
  { key: 'employee', icon: 'user', path: '/app', permission: null },
  { key: 'manager', icon: 'users', path: '/app/leave', permission: 'leave.approve' },
  { key: 'hr', icon: 'user-cog', path: '/app/employees', permission: 'employees.view' },
  { key: 'payroll', icon: 'wallet', path: '/app/payroll', permission: 'payroll.view', feature: 'payroll' },
  { key: 'recruitment', icon: 'briefcase', path: '/app/recruitment', permission: 'recruitment.view', feature: 'recruitment' },
  { key: 'admin', icon: 'settings', path: '/app/settings/company', permission: 'organization.manage' },
];

function normalize(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function validateSlug(slug) {
  if (!SLUG_RE.test(slug)) return 'Use 3–40 English letters, numbers or dashes (for example: taawoni).';
  if (RESERVED.has(slug)) return 'This name is reserved by the platform. Choose another.';
  return null;
}

async function setSlug(ctx, raw) {
  const slug = normalize(raw);
  const error = validateSlug(slug);
  if (error) throw E.validation({ slug: error });
  const taken = await knex('organizations').where({ slug }).whereNot({ id: ctx.organizationId }).first('id');
  if (taken) throw E.validation({ slug: 'Another company already uses this link.' });
  const before = await knex('organizations').where({ id: ctx.organizationId }).first('slug');
  await knex('organizations').where({ id: ctx.organizationId }).update({ slug, updated_at: new Date() });
  cache.forgetPrefix(`org:${ctx.organizationId}`);
  cache.forgetPrefix('portal:');
  await audit.record(ctx, 'organization.link_changed', { entityType: 'organization', entityId: ctx.organizationId, oldValues: { slug: before.slug }, newValues: { slug } });
  return slug;
}

/** An active company by its link, or null. */
async function bySlug(raw) {
  const slug = normalize(raw);
  if (!SLUG_RE.test(slug) || RESERVED.has(slug)) return null;
  return cache.remember(`portal:${slug}`, async () => {
    const org = await knex('organizations').where({ slug }).whereNot('status', 'suspended').first('id', 'name', 'slug', 'status');
    return org || false;
  }, 60_000).then((o) => o || null);
}

/** Options shown on the company page: the plan decides which areas exist. */
async function entriesFor(organizationId) {
  const e = await ent.getEntitlements(organizationId);
  return ENTRIES.filter((x) => !x.feature || e.features.has(x.feature));
}

const entry = (key) => ENTRIES.find((x) => x.key === key) || ENTRIES[0];

module.exports = { RESERVED, ENTRIES, normalize, validateSlug, setSlug, bySlug, entriesFor, entry };
