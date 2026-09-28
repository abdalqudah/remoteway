// REST API v1. Auth: `Authorization: Bearer rw_...` (Settings → API) or the browser session.
// Responses: { success: true, data, meta? } | { success: false, error: { code, message, details? } }
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { E } = require('../core/errors');
const { requireAuth, resolveTenant, can, canAny, meterApi } = require('../middleware/context');
const { wrap } = require('./helpers');
const employees = require('../modules/workforce/employee.service');
const structure = require('../modules/workforce/structure.service');
const members = require('../modules/organizations/members.service');
const orgs = require('../modules/organizations/organization.service');
const rbac = require('../modules/rbac/rbac.service');
const subscriptions = require('../modules/billing/subscription.service');
const ent = require('../modules/billing/entitlements.service');
const dashboard = require('../modules/dashboard/dashboard.service');
const searchService = require('../modules/search/search.service');

const router = express.Router();
const ok = (res, data, meta, status = 200) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

router.use(rateLimit({
  windowMs: 60_000, limit: config.isTest ? 10_000 : 300, standardHeaders: true, legacyHeaders: false,
  handler: (req, res, next) => next(E.rateLimited()),
}));

// ---------- Public ----------
router.get('/plans', wrap(async (req, res) => {
  const plans = await subscriptions.listPublicPlans();
  ok(res, plans.map((p) => ({
    key: p.key, name: p.name, tagline: p.tagline, currency: p.currency, price_monthly: p.price_monthly, price_yearly: p.price_yearly,
    trial_days: p.trial_days, is_custom: Boolean(p.is_custom), limits: p.limits, features: p.features.map((f) => ({ key: f.key, availability: f.availability })),
  })));
}));

// ---------- Authenticated ----------
router.use(requireAuth);

router.get('/auth/me', wrap(async (req, res) => {
  ok(res, { id: req.user.id, name: req.user.name, email: req.user.email, locale: req.user.locale, organizations: await orgs.listForUser(req.user.id) });
}));

router.use(resolveTenant, meterApi);

router.get('/organizations/current', (req, res) => {
  const o = req.organization;
  ok(res, {
    id: o.id, name: o.name, slug: o.slug, country_code: o.country_code, currency: o.currency, timezone: o.timezone, locale: o.locale,
    permissions: [...req.ctx.permissions].sort(),
  });
});

router.get('/subscription', can('billing.view'), wrap(async (req, res) => {
  const e = await ent.getEntitlements(req.ctx.organizationId);
  ok(res, {
    plan: e.plan && { key: e.plan.key, name: e.plan.name }, status: e.status, billing_cycle: e.subscription?.billing_cycle,
    trial_ends_at: e.subscription?.trial_ends_at, features: [...e.features].sort(), limits: e.limits, usage: await ent.getUsage(req.ctx.organizationId),
    addons: e.addons.map((a) => ({ key: a.key, quantity: a.quantity })),
  });
}));

router.get('/dashboard', can('employees.view'), wrap(async (req, res) => ok(res, await dashboard.companyDashboard(req.ctx.organizationId))));

router.get('/search', wrap(async (req, res) => ok(res, await searchService.search(req.ctx, req.query.q))));

// Employees
router.get('/employees', canAny('employees.view', 'team.view'), wrap(async (req, res) => {
  const { data, meta } = await employees.list(req.ctx, req.query);
  ok(res, data, meta);
}));
router.post('/employees', can('employees.create'), wrap(async (req, res) => ok(res, await employees.create(req.ctx, req.body), undefined, 201)));
router.get('/employees/:id', canAny('employees.view', 'team.view'), wrap(async (req, res) => ok(res, await employees.get(req.ctx, Number(req.params.id)))));
router.patch('/employees/:id', can('employees.edit'), wrap(async (req, res) => {
  const current = await employees.get(req.ctx, Number(req.params.id));
  const merged = { ...current, ...req.body };
  for (const k of ['joining_date']) if (merged[k] instanceof Date) merged[k] = merged[k].toISOString().slice(0, 10);
  if (!req.ctx.permissions.has('employees.view_salary')) delete merged.base_salary;
  ok(res, await employees.update(req.ctx, Number(req.params.id), merged));
}));
router.post('/employees/:id/terminate', can('employees.delete'), wrap(async (req, res) => ok(res, await employees.terminate(req.ctx, Number(req.params.id), req.body))));
router.delete('/employees/:id', can('employees.delete'), wrap(async (req, res) => {
  await employees.remove(req.ctx, Number(req.params.id));
  ok(res, { deleted: true });
}));

// Departments & locations
router.get('/departments', canAny('employees.view', 'team.view'), wrap(async (req, res) => ok(res, await structure.listDepartments(req.ctx.organizationId))));
router.post('/departments', can('departments.manage'), wrap(async (req, res) => {
  const id = await structure.saveDepartment(req.ctx, null, req.body);
  ok(res, { id }, undefined, 201);
}));
router.patch('/departments/:id', can('departments.manage'), wrap(async (req, res) => ok(res, { id: await structure.saveDepartment(req.ctx, Number(req.params.id), req.body) })));
router.delete('/departments/:id', can('departments.manage'), wrap(async (req, res) => {
  await structure.deleteDepartment(req.ctx, Number(req.params.id));
  ok(res, { deleted: true });
}));
router.get('/locations', canAny('employees.view', 'team.view'), wrap(async (req, res) => ok(res, await structure.listLocations(req.ctx.organizationId))));
router.post('/locations', can('locations.manage'), wrap(async (req, res) => {
  const id = await structure.saveLocation(req.ctx, null, req.body);
  ok(res, { id }, undefined, 201);
}));
router.delete('/locations/:id', can('locations.manage'), wrap(async (req, res) => {
  await structure.deleteLocation(req.ctx, Number(req.params.id));
  ok(res, { deleted: true });
}));

// Users & roles
router.get('/users', can('users.view'), wrap(async (req, res) => ok(res, await members.listMembers(req.ctx.organizationId))));
router.get('/roles', can('users.view'), wrap(async (req, res) => ok(res, await rbac.listRoles(req.ctx.organizationId))));

router.use((req, res, next) => next(E.notFound('Endpoint')));

module.exports = router;
