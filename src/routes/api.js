// REST API v1. Auth: `Authorization: Bearer rw_...` (Settings → API) or the browser session.
// Responses: { success: true, data, meta? } | { success: false, error: { code, message, details? } }
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { E } = require('../core/errors');
const { requireAuth, resolveTenant, can, canAny, feature, meterApi } = require('../middleware/context');
const { singleFile } = require('../middleware/upload');
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
const leave = require('../modules/leave/leave.service');
const attendance = require('../modules/attendance/attendance.service');
const documents = require('../modules/documents/document.service');
const tasks = require('../modules/tasks/task.service');
const notifications = require('../modules/notifications/notification.service');

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

// Leave
router.get('/leave/types', feature('leave'), wrap(async (req, res) => ok(res, await leave.listTypes(req.ctx.organizationId, { activeOnly: true }))));
router.get('/leave/balances', feature('leave'), wrap(async (req, res) => {
  const employeeId = req.query.employee_id ? Number(req.query.employee_id) : await employees.linkedEmployeeId(req.ctx);
  if (!employeeId) return ok(res, []);
  await leave.assertCanSeeEmployee(req.ctx, employeeId);
  const year = /^\d{4}$/.test(req.query.year || '') ? Number(req.query.year) : undefined;
  const rows = await leave.balancesFor(req.ctx.organizationId, employeeId, year);
  return ok(res, rows.map((b) => ({ type: { id: b.type.id, key: b.type.key, name: b.type.name }, entitled: b.entitled, used: b.used, pending: b.pending, available: b.available })));
}));
router.get('/leave/requests', feature('leave'), wrap(async (req, res) => {
  if (req.query.scope === 'approvals') return ok(res, await leave.pendingApprovals(req.ctx));
  if (req.query.scope === 'team') return ok(res, await leave.teamRequests(req.ctx, { from: req.query.from, to: req.query.to, status: req.query.status }));
  return ok(res, await leave.myRequests(req.ctx));
}));
router.post('/leave/requests', feature('leave'), can('leave.request'), wrap(async (req, res) => ok(res, { id: await leave.createRequest(req.ctx, req.body) }, undefined, 201)));
router.post('/leave/requests/:id/decide', feature('leave'), can('leave.approve'), wrap(async (req, res) => {
  await leave.decide(req.ctx, Number(req.params.id), { decision: req.body.decision, note: req.body.note });
  ok(res, { id: Number(req.params.id), status: req.body.decision });
}));
router.post('/leave/requests/:id/cancel', feature('leave'), wrap(async (req, res) => {
  await leave.cancel(req.ctx, Number(req.params.id));
  ok(res, { id: Number(req.params.id), status: 'cancelled' });
}));

// Attendance
router.get('/attendance/today', feature('attendance'), wrap(async (req, res) => ok(res, await attendance.today(req.ctx))));
router.post('/attendance/clock', feature('attendance'), wrap(async (req, res) => ok(res, { action: await attendance.clock(req.ctx, String(req.body.action || ''), req.ip) })));
router.get('/attendance/daily', feature('attendance'), can('attendance.view'), wrap(async (req, res) => ok(res, await attendance.daily(req.ctx, req.query.date))));
router.get('/attendance/employees/:id', feature('attendance'), wrap(async (req, res) => ok(res, await attendance.timesheet(req.ctx, Number(req.params.id), req.query.month))));

// Documents (metadata; files are downloaded through the permission-checked stream)
router.get('/documents', feature('documents'), wrap(async (req, res) => {
  const rows = await documents.list(req.ctx, req.query);
  ok(res, rows.map((d) => ({
    id: d.id, title: d.title, category: d.category, employee_id: d.employee_id, issue_date: d.issue_date, expires_at: d.expires_at, expiry: d.expiry,
    version: d.current_version, file_name: d.original_name, mime_type: d.mime_type, size_bytes: d.size_bytes, download_url: `/api/v1/documents/${d.id}/download`,
  })));
}));
router.post('/documents', feature('documents'), ...singleFile('file'), wrap(async (req, res) => ok(res, { id: await documents.upload(req.ctx, req.body, req.file) }, undefined, 201)));
router.get('/documents/:id/download', feature('documents'), wrap(async (req, res) => {
  const f = await documents.openFile(req.ctx, Number(req.params.id), req.query.v);
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  f.stream.on('error', () => res.destroy());
  f.stream.pipe(res);
}));

// Tasks
router.get('/tasks', feature('tasks'), wrap(async (req, res) => ok(res, await tasks.list(req.ctx, { ...req.query, mine: req.query.mine === '1', include_done: req.query.include_done === '1' }))));
router.post('/tasks', feature('tasks'), wrap(async (req, res) => ok(res, await tasks.get(req.ctx, await tasks.create(req.ctx, req.body)), undefined, 201)));
router.get('/tasks/:id', feature('tasks'), wrap(async (req, res) => ok(res, await tasks.get(req.ctx, Number(req.params.id)))));
router.patch('/tasks/:id', feature('tasks'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (Object.keys(req.body).length === 1 && req.body.status) await tasks.setStatus(req.ctx, id, req.body.status);
  else {
    const current = await tasks.get(req.ctx, id);
    const dateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
    await tasks.update(req.ctx, id, { ...current, due_date: dateStr(current.due_date), ...req.body });
  }
  ok(res, await tasks.get(req.ctx, id));
}));
router.delete('/tasks/:id', feature('tasks'), wrap(async (req, res) => {
  await tasks.remove(req.ctx, Number(req.params.id));
  ok(res, { deleted: true });
}));

// Notifications
router.get('/notifications', wrap(async (req, res) => ok(res, await notifications.list(req.ctx, { unreadOnly: req.query.unread === '1' }), { unread: await notifications.unreadCount(req.ctx) })));
router.post('/notifications/read', wrap(async (req, res) => {
  await notifications.markRead(req.ctx, req.body.id ? Number(req.body.id) : null);
  ok(res, { read: true });
}));

router.use((req, res, next) => next(E.notFound('Endpoint')));

module.exports = router;
