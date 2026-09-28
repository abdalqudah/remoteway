const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');
const { z, validate, optionalString, emptyToUndefined } = require('../../core/validate');
const { countWorkingDays, isDateStr, todayIn } = require('../../core/workdays');
const { LEAVE_TYPE_DEFAULTS } = require('../../db/catalog');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');
const employees = require('../workforce/employee.service');
const notifications = require('../notifications/notification.service');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// ---------- Leave types ----------
async function ensureDefaultTypes(organizationId) {
  const existing = await knex('leave_types').where({ organization_id: organizationId }).first('id');
  if (existing) return;
  await knex('leave_types').insert(LEAVE_TYPE_DEFAULTS.map((d, i) => ({
    organization_id: organizationId, key: d.key, name: d.name, name_ar: d.name_ar, days_per_year: d.days_per_year,
    has_balance: d.has_balance, is_paid: d.is_paid, requires_document: Boolean(d.requires_document), color: d.color, sort_order: i,
  }))).onConflict(['organization_id', 'key']).ignore();
}

async function listTypes(organizationId, { activeOnly = false } = {}) {
  await ensureDefaultTypes(organizationId);
  const q = knex('leave_types').where({ organization_id: organizationId }).orderBy('sort_order').orderBy('id');
  if (activeOnly) q.where({ is_active: true });
  return q;
}

const typeSchema = z.object({
  name: z.string().trim().min(2).max(100),
  name_ar: optionalString(100),
  days_per_year: z.coerce.number().min(0).max(365),
  has_balance: z.preprocess((v) => v === true || v === 'on' || v === 'true', z.boolean()),
  is_paid: z.preprocess((v) => v === true || v === 'on' || v === 'true', z.boolean()),
  requires_document: z.preprocess((v) => v === true || v === 'on' || v === 'true', z.boolean()),
  is_active: z.preprocess((v) => v === true || v === 'on' || v === 'true', z.boolean()),
});

async function saveType(ctx, id, input) {
  const data = validate(typeSchema, input);
  await ent.assertCanWrite(ctx.organizationId);
  const row = { ...data, name_ar: data.name_ar ?? null };
  if (id) {
    const before = await knex('leave_types').where({ id, organization_id: ctx.organizationId }).first();
    if (!before) throw E.notFound('Leave type');
    const d = audit.diff(before, row);
    await knex('leave_types').where({ id, organization_id: ctx.organizationId }).update(row);
    // Keep this year's untouched entitlements in line with the new policy.
    if (before.days_per_year !== data.days_per_year) {
      await knex('leave_balances').where({ organization_id: ctx.organizationId, leave_type_id: id, year: new Date().getUTCFullYear() })
        .update({ entitled_days: data.days_per_year });
    }
    if (d.changed) await audit.record(ctx, 'leave_type.updated', { entityType: 'leave_type', entityId: id, oldValues: d.oldValues, newValues: d.newValues });
    return Number(id);
  }
  const key = `custom_${Date.now().toString(36)}`;
  const [newId] = await knex('leave_types').insert({ ...row, key, organization_id: ctx.organizationId, sort_order: 100 });
  await audit.record(ctx, 'leave_type.created', { entityType: 'leave_type', entityId: newId, newValues: { name: data.name } });
  return newId;
}

// ---------- Balances ----------
async function balanceRow(trx, organizationId, employeeId, type, year) {
  let row = await trx('leave_balances').where({ organization_id: organizationId, employee_id: employeeId, leave_type_id: type.id, year }).first();
  if (!row) {
    await trx('leave_balances').insert({ organization_id: organizationId, employee_id: employeeId, leave_type_id: type.id, year, entitled_days: type.days_per_year })
      .onConflict(['organization_id', 'employee_id', 'leave_type_id', 'year']).ignore();
    row = await trx('leave_balances').where({ organization_id: organizationId, employee_id: employeeId, leave_type_id: type.id, year }).first();
  }
  return row;
}

const available = (b) => round2(Number(b.entitled_days) + Number(b.adjustment_days) - Number(b.used_days));

/** Balances for one employee (caller must already have checked visibility). */
async function balancesFor(organizationId, employeeId, year = new Date().getUTCFullYear()) {
  const types = await listTypes(organizationId, { activeOnly: true });
  const pending = await knex('leave_requests').where({ organization_id: organizationId, employee_id: employeeId, status: 'pending' })
    .whereRaw('YEAR(start_date) = ?', [year]).groupBy('leave_type_id').select('leave_type_id').sum({ days: 'days' });
  const pendingBy = Object.fromEntries(pending.map((p) => [p.leave_type_id, Number(p.days)]));
  const out = [];
  for (const type of types) {
    const b = await balanceRow(knex, organizationId, employeeId, type, year);
    out.push({
      type, entitled: Number(b.entitled_days) + Number(b.adjustment_days), used: Number(b.used_days), pending: pendingBy[type.id] || 0,
      available: type.has_balance ? available(b) : null,
    });
  }
  return out;
}

async function adjustBalance(ctx, employeeId, leaveTypeId, adjustment, note) {
  await ent.assertCanWrite(ctx.organizationId);
  const type = await knex('leave_types').where({ id: leaveTypeId, organization_id: ctx.organizationId }).first();
  const emp = await knex('employees').where({ id: employeeId, organization_id: ctx.organizationId }).first('id');
  if (!type || !emp) throw E.notFound('Leave balance');
  const value = Number(adjustment);
  if (!Number.isFinite(value) || Math.abs(value) > 365) throw E.validation({ adjustment: 'Enter a number of days.' });
  const year = new Date().getUTCFullYear();
  const b = await balanceRow(knex, ctx.organizationId, employeeId, type, year);
  await knex('leave_balances').where({ id: b.id }).update({ adjustment_days: round2(Number(b.adjustment_days) + value) });
  await audit.record(ctx, 'leave_balance.adjusted', {
    entityType: 'employee', entityId: employeeId, oldValues: { adjustment_days: Number(b.adjustment_days) },
    newValues: { adjustment_days: round2(Number(b.adjustment_days) + value), type: type.name, note: note || null },
  });
}

// ---------- Requests ----------
const requestSchema = z.object({
  employee_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  leave_type_id: z.coerce.number().int().positive(),
  start_date: z.string().refine(isDateStr, 'Use YYYY-MM-DD.'),
  end_date: z.string().refine(isDateStr, 'Use YYYY-MM-DD.'),
  reason: optionalString(1000),
});

async function assertCanSeeEmployee(ctx, employeeId) {
  const ids = await employees.visibleIds(ctx);
  if (ids !== null && !ids.includes(Number(employeeId))) throw E.notFound('Employee');
}

async function createRequest(ctx, input) {
  const data = validate(requestSchema, input);
  await ent.assertFeature(ctx.organizationId, 'leave');
  await ent.assertCanWrite(ctx.organizationId);
  const self = await employees.linkedEmployeeId(ctx);
  const employeeId = data.employee_id || self;
  if (!employeeId) throw new AppError('EMPLOYEE_RECORD_REQUIRED', 'Your account is not linked to an employee record.', 409);
  // Requesting on behalf of someone else is an HR action.
  if (employeeId !== self && !ctx.permissions.has('leave.approve')) throw E.forbidden('leave.approve');
  if (employeeId !== self) await assertCanSeeEmployee(ctx, employeeId);
  if (data.end_date < data.start_date) throw E.validation({ end_date: 'End date must be on or after the start date.' });
  if (data.start_date.slice(0, 4) !== data.end_date.slice(0, 4)) throw E.validation({ end_date: 'Split requests that cross into a new year.' });

  const [settings, employee] = await Promise.all([
    orgs.getSettings(ctx.organizationId),
    knex('employees').where({ id: employeeId, organization_id: ctx.organizationId }).first(),
  ]);
  if (!employee || employee.status === 'terminated') throw E.notFound('Employee');
  const type = await knex('leave_types').where({ id: data.leave_type_id, organization_id: ctx.organizationId, is_active: true }).first();
  if (!type) throw E.validation({ leave_type_id: 'Choose a leave type.' });
  const days = countWorkingDays(data.start_date, data.end_date, settings.working_days);
  if (days <= 0) throw E.validation({ end_date: 'The selected dates contain no working days.' });

  return knex.transaction(async (trx) => {
    const overlap = await trx('leave_requests').where({ organization_id: ctx.organizationId, employee_id: employeeId })
      .whereIn('status', ['pending', 'approved']).where('start_date', '<=', data.end_date).where('end_date', '>=', data.start_date).first('id');
    if (overlap) throw new AppError('LEAVE_OVERLAP', 'This request overlaps another pending or approved leave.', 409);
    if (type.has_balance) {
      const b = await balanceRow(trx, ctx.organizationId, employeeId, type, Number(data.start_date.slice(0, 4)));
      const [{ p }] = await trx('leave_requests').where({ organization_id: ctx.organizationId, employee_id: employeeId, leave_type_id: type.id, status: 'pending' })
        .whereRaw('YEAR(start_date) = ?', [Number(data.start_date.slice(0, 4))]).sum({ p: 'days' });
      if (days > available(b) - Number(p || 0)) {
        throw new AppError('INSUFFICIENT_LEAVE_BALANCE', 'Not enough leave balance for this request.', 409, { available: available(b) - Number(p || 0), requested: days });
      }
    }
    const [id] = await trx('leave_requests').insert({
      organization_id: ctx.organizationId, employee_id: employeeId, leave_type_id: type.id, start_date: data.start_date, end_date: data.end_date,
      days, reason: data.reason ?? null, requested_by: ctx.userId,
    });
    await audit.record(ctx, 'leave.requested', {
      entityType: 'leave_request', entityId: id, newValues: { name: `${employee.first_name} ${employee.last_name}`, type: type.name, days, start_date: data.start_date },
    }, trx);
    const approvers = await approversFor(trx, ctx.organizationId, employee);
    await notifications.notify(ctx.organizationId, approvers.filter((u) => u !== ctx.userId), 'leave_requested',
      { name: `${employee.first_name} ${employee.last_name}`, days, type: type.name }, '/app/leave?tab=approvals', trx);
    return id;
  });
}

/** Direct manager (if they can approve) plus everyone with leave.approve + employees.view (HR). */
async function approversFor(trx, organizationId, employee) {
  const users = new Set();
  const hr = await trx('user_roles as ur').join('role_permissions as rp', 'rp.role_id', 'ur.role_id').join('permissions as p', 'p.id', 'rp.permission_id')
    .join('memberships as m', function j() { this.on('m.user_id', 'ur.user_id').andOn('m.organization_id', 'ur.organization_id'); })
    .where({ 'ur.organization_id': organizationId, 'm.status': 'active' }).whereIn('p.key', ['leave.approve', 'employees.view'])
    .groupBy('ur.user_id').havingRaw('COUNT(DISTINCT p.key) = 2').select('ur.user_id');
  hr.forEach((r) => users.add(r.user_id));
  if (employee.manager_id) {
    const mgr = await trx('employees').where({ id: employee.manager_id, organization_id: organizationId }).first('user_id');
    if (mgr?.user_id) users.add(mgr.user_id);
  }
  if (employee.user_id) users.delete(employee.user_id);
  return [...users];
}

async function assertCanDecide(ctx, request) {
  const scope = await employees.approvableIds(ctx);
  const ok = scope.all ? request.employee_id !== scope.exclude : scope.ids.includes(request.employee_id);
  if (!ok) throw E.forbidden('leave.approve');
}

async function decide(ctx, id, { decision, note }) {
  if (!['approved', 'rejected'].includes(decision)) throw E.validation({ decision: 'Invalid decision.' });
  await ent.assertCanWrite(ctx.organizationId);
  return knex.transaction(async (trx) => {
    const req = await trx('leave_requests').where({ id, organization_id: ctx.organizationId }).forUpdate().first();
    if (!req) throw E.notFound('Leave request');
    await assertCanDecide(ctx, req);
    if (req.status !== 'pending') throw new AppError('LEAVE_NOT_PENDING', 'This request has already been decided.', 409);
    const type = await trx('leave_types').where({ id: req.leave_type_id }).first();
    if (decision === 'approved' && type.has_balance) {
      const year = new Date(req.start_date).getUTCFullYear();
      const b = await balanceRow(trx, ctx.organizationId, req.employee_id, type, year);
      if (Number(req.days) > available(b)) throw new AppError('INSUFFICIENT_LEAVE_BALANCE', 'Not enough leave balance for this request.', 409);
      await trx('leave_balances').where({ id: b.id }).update({ used_days: round2(Number(b.used_days) + Number(req.days)) });
    }
    await trx('leave_requests').where({ id }).update({ status: decision, decided_by: ctx.userId, decided_at: new Date(), decision_note: note ? String(note).slice(0, 500) : null });
    const emp = await trx('employees').where({ id: req.employee_id }).first();
    await audit.record(ctx, `leave.${decision}`, {
      entityType: 'leave_request', entityId: id, oldValues: { status: 'pending' }, newValues: { status: decision, name: `${emp.first_name} ${emp.last_name}` },
    }, trx);
    const notifyUser = emp.user_id || req.requested_by;
    await notifications.notify(ctx.organizationId, [notifyUser].filter((u) => u && u !== ctx.userId), `leave_${decision}`,
      { type: type.name, days: Number(req.days), start: String(req.start_date instanceof Date ? req.start_date.toISOString().slice(0, 10) : req.start_date) }, '/app/leave', trx);
  });
}

async function cancel(ctx, id) {
  return knex.transaction(async (trx) => {
    const req = await trx('leave_requests').where({ id, organization_id: ctx.organizationId }).forUpdate().first();
    if (!req) throw E.notFound('Leave request');
    const self = await employees.linkedEmployeeId(ctx);
    const own = req.employee_id === self || req.requested_by === ctx.userId;
    if (!own) await assertCanDecide(ctx, req);
    if (!['pending', 'approved'].includes(req.status)) throw new AppError('LEAVE_NOT_PENDING', 'This request cannot be cancelled.', 409);
    const today = todayIn((await orgs.get(ctx.organizationId)).timezone);
    const start = req.start_date instanceof Date ? req.start_date.toISOString().slice(0, 10) : String(req.start_date);
    if (req.status === 'approved' && start <= today && own && !ctx.permissions.has('leave.approve')) {
      throw new AppError('LEAVE_ALREADY_STARTED', 'Leave that has started can only be cancelled by an approver.', 409);
    }
    if (req.status === 'approved') {
      const type = await trx('leave_types').where({ id: req.leave_type_id }).first();
      if (type.has_balance) {
        const b = await balanceRow(trx, ctx.organizationId, req.employee_id, type, new Date(req.start_date).getUTCFullYear());
        await trx('leave_balances').where({ id: b.id }).update({ used_days: round2(Math.max(0, Number(b.used_days) - Number(req.days))) });
      }
    }
    await trx('leave_requests').where({ id }).update({ status: 'cancelled', decided_by: ctx.userId, decided_at: new Date() });
    await audit.record(ctx, 'leave.cancelled', { entityType: 'leave_request', entityId: id, oldValues: { status: req.status }, newValues: { status: 'cancelled' } }, trx);
  });
}

function baseRequests(organizationId) {
  return knex('leave_requests as r').join('employees as e', 'e.id', 'r.employee_id').join('leave_types as t', 't.id', 'r.leave_type_id')
    .leftJoin('users as d', 'd.id', 'r.decided_by')
    .where('r.organization_id', organizationId)
    .select('r.*', 'e.first_name', 'e.last_name', 'e.job_title', 't.name as type_name', 't.name_ar as type_name_ar', 't.color as type_color', 'd.name as decided_by_name');
}

async function myRequests(ctx) {
  const self = await employees.linkedEmployeeId(ctx);
  if (!self) return [];
  return baseRequests(ctx.organizationId).where('r.employee_id', self).orderBy('r.start_date', 'desc').limit(50);
}

async function pendingApprovals(ctx) {
  if (!ctx.permissions.has('leave.approve')) return [];
  const scope = await employees.approvableIds(ctx);
  const q = baseRequests(ctx.organizationId).where('r.status', 'pending').orderBy('r.start_date');
  if (scope.all) { if (scope.exclude) q.whereNot('r.employee_id', scope.exclude); } else if (scope.ids.length) q.whereIn('r.employee_id', scope.ids); else return [];
  return q;
}

/** Leave across the visible workforce (calendar / list), filtered by month or status. */
async function teamRequests(ctx, { from, to, status } = {}) {
  const ids = await employees.visibleIds(ctx);
  const q = baseRequests(ctx.organizationId).orderBy('r.start_date');
  if (ids !== null) { if (!ids.length) return []; q.whereIn('r.employee_id', ids); }
  if (from) q.where('r.end_date', '>=', from);
  if (to) q.where('r.start_date', '<=', to);
  if (status) q.where('r.status', status); else q.whereIn('r.status', ['pending', 'approved']);
  return q.limit(500);
}

/** Employees on approved leave on a given date (used by dashboard and attendance). */
async function onLeaveOn(organizationId, date) {
  return knex('leave_requests').where({ organization_id: organizationId, status: 'approved' })
    .where('start_date', '<=', date).where('end_date', '>=', date).distinct('employee_id').pluck('employee_id');
}

module.exports = {
  ensureDefaultTypes, listTypes, saveType, balancesFor, adjustBalance, createRequest, decide, cancel, myRequests, pendingApprovals, teamRequests,
  onLeaveOn, assertCanSeeEmployee,
};
