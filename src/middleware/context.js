// Request context: user (session or API token), tenant, permissions and entitlements.
// Tenant isolation is enforced here: the organization comes from a verified membership,
// never from request input, and every service call receives req.ctx.organizationId.
const knex = require('../db/knex');
const cache = require('../core/cache');
const { E } = require('../core/errors');
const authService = require('../modules/auth/auth.service');
const orgs = require('../modules/organizations/organization.service');
const rbac = require('../modules/rbac/rbac.service');
const ent = require('../modules/billing/entitlements.service');

const isApi = (req) => req.originalUrl.startsWith('/api/');

async function loadUser(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    if (isApi(req) && header.startsWith('Bearer ')) {
      const resolved = await authService.resolveApiToken(header.slice(7).trim());
      if (!resolved) throw E.unauthenticated();
      req.user = resolved.user;
      req.apiToken = { id: resolved.tokenId, organizationId: resolved.organizationId };
    } else if (req.session?.userId) {
      const user = await authService.findUser(req.session.userId);
      if (user && user.status === 'active') req.user = user;
      else delete req.session.userId;
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (isApi(req)) return next(E.unauthenticated());
  req.session.returnTo = req.originalUrl;
  return res.redirect('/login');
}

function requireSuperAdmin(req, res, next) {
  if (req.user?.is_super_admin) return next();
  return next(E.forbidden('platform.admin'));
}

async function resolveTenant(req, res, next) {
  try {
    let organizationId = req.apiToken ? req.apiToken.organizationId : req.session.organizationId;
    if (!organizationId || !(await orgs.isMember(req.user.id, organizationId))) {
      organizationId = null;
      if (!req.apiToken) {
        const list = await orgs.listForUser(req.user.id);
        const preferred = list.find((o) => o.id === req.user.last_organization_id) || list[0];
        if (preferred) {
          organizationId = preferred.id;
          req.session.organizationId = organizationId;
        }
      }
    }
    if (!organizationId) {
      if (isApi(req)) throw E.noOrganization();
      return res.redirect(req.user.is_super_admin ? '/admin' : '/organizations/new');
    }
    const [organization, permissions, entitlements] = await Promise.all([
      orgs.get(organizationId),
      rbac.getUserPermissions(organizationId, req.user.id),
      ent.getEntitlements(organizationId),
    ]);
    if (organization.status === 'suspended' && !isApi(req) && !req.path.startsWith('/billing')) {
      entitlements.canWrite = false;
    }
    req.ctx = {
      organizationId,
      userId: req.user.id,
      permissions,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
    req.organization = organization;
    req.entitlements = entitlements;
    res.locals.organization = organization;
    res.locals.entitlements = entitlements;
    res.locals.can = (p) => permissions.has(p);
    res.locals.hasFeature = (f) => entitlements.features.has(f);
    if (!isApi(req)) {
      res.locals.organizations = await orgs.listForUser(req.user.id);
      const [{ n }] = await knex('employees').where({ organization_id: organizationId }).whereNot('status', 'terminated').count({ n: '*' });
      res.locals.seatUsage = Number(n);
    }

    // Any successful mutation refreshes the tenant's cached dashboard metrics.
    if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) cache.forgetPrefix(`dash:${organizationId}`); });
    next();
  } catch (err) {
    next(err);
  }
}

const can = (permission) => (req, res, next) => (req.ctx?.permissions.has(permission) ? next() : next(E.forbidden(permission)));
const canAny = (...perms) => (req, res, next) => (perms.some((p) => req.ctx?.permissions.has(p)) ? next() : next(E.forbidden(perms.join('|'))));

const feature = (key) => async (req, res, next) => {
  try {
    await ent.assertFeature(req.ctx.organizationId, key);
    next();
  } catch (err) {
    next(err);
  }
};

// Meter API calls against the plan's monthly allowance.
async function meterApi(req, res, next) {
  try {
    if (!req.apiToken) return next();
    await ent.assertFeature(req.ctx.organizationId, 'api');
    await ent.assertWithinLimit(req.ctx.organizationId, 'api_calls_monthly', 1);
    await ent.incrementUsage(req.ctx.organizationId, 'api_calls', 1);
    return next();
  } catch (err) {
    return next(err);
  }
}

async function touchLastOrganization(userId, organizationId) {
  await knex('users').where({ id: userId }).update({ last_organization_id: organizationId });
}

module.exports = { loadUser, requireAuth, requireSuperAdmin, resolveTenant, can, canAny, feature, meterApi, touchLastOrganization, isApi };
