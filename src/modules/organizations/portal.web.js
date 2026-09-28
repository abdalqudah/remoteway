// remoteway.net/<company link>: the company's own entry page (mounted after every other route).
const express = require('express');
const { wrap } = require('../../routes/helpers');
const portal = require('./portal.service');
const orgs = require('./organization.service');
const rbac = require('../rbac/rbac.service');
const knex = require('../../db/knex');

const router = express.Router();

async function renderPortal(req, res, org, extra = {}) {
  const entries = await portal.entriesFor(org.id);
  const as = entries.some((e) => e.key === req.query.as || e.key === req.body?.as) ? (req.query.as || req.body.as) : null;
  const sso = await knex('sso_connections').where({ organization_id: org.id, enabled: true }).first('organization_id').catch(() => null);
  const full = await orgs.get(org.id);
  const brandInfo = await require('../branding/branding.service').forOrg(org.id, full.name); // eslint-disable-line global-require
  res.page('pages/auth/portal', { layout: 'auth', title: full.name, org: full, orgLogo: brandInfo.logoUrl, entries, as, sso: Boolean(sso), ...extra });
}

router.get('/:slug', wrap(async (req, res, next) => {
  const org = await portal.bySlug(req.params.slug);
  if (!org) return next();
  // Already signed in and a member: the choice opens the area directly.
  if (req.user && req.query.as && await orgs.isMember(req.user.id, org.id)) {
    req.session.organizationId = org.id;
    const e = portal.entry(req.query.as);
    const perms = await rbac.getUserPermissions(org.id, req.user.id);
    return res.redirect(!e.permission || perms.has(e.permission) ? e.path : '/app');
  }
  return renderPortal(req, res, org);
}));

module.exports = { router, renderPortal };
