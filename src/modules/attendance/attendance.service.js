const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');
const { isDateStr, todayIn, minutesNowIn, hhmmToMinutes, dayKey, addDays } = require('../../core/workdays');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');
const employees = require('../workforce/employee.service');
const leave = require('../leave/leave.service');

const LATE_GRACE_DEFAULT = 15;

/** Offset (minutes) of a timezone at a given instant. */
function tzOffsetMinutes(date, timeZone) {
  const asTz = new Date(date.toLocaleString('en-US', { timeZone }));
  const asUtc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  return (asTz - asUtc) / 60000;
}

/** 'YYYY-MM-DD' + 'HH:MM' in the organization's timezone → Date (UTC instant). */
function zonedToUtc(dateStr, hhmm, timeZone) {
  const [h, m] = hhmm.split(':').map(Number);
  const guess = new Date(Date.UTC(...dateStr.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))), h, m));
  return new Date(guess.getTime() - tzOffsetMinutes(guess, timeZone) * 60000);
}

async function context(organizationId) {
  const [org, settings] = await Promise.all([orgs.get(organizationId), orgs.getSettings(organizationId)]);
  const start = hhmmToMinutes(settings.work_start || '09:00');
  const end = hhmmToMinutes(settings.work_end || '17:00');
  return {
    tz: org.timezone, workingDays: settings.working_days || [], start, end,
    scheduled: Math.max(0, end - start), grace: Number(settings.late_grace_minutes ?? LATE_GRACE_DEFAULT),
  };
}

function computeMinutes(row, c) {
  if (!row.clock_in || !row.clock_out) return { worked_minutes: 0, overtime_minutes: 0 };
  const worked = Math.max(0, Math.round((new Date(row.clock_out) - new Date(row.clock_in)) / 60000) - Number(row.break_minutes || 0));
  return { worked_minutes: worked, overtime_minutes: c.scheduled ? Math.max(0, worked - c.scheduled) : 0 };
}

async function selfEmployee(ctx) {
  const id = await employees.linkedEmployeeId(ctx);
  if (!id) throw new AppError('EMPLOYEE_RECORD_REQUIRED', 'Your account is not linked to an employee record.', 409);
  const emp = await knex('employees').where({ id, organization_id: ctx.organizationId }).first();
  if (!emp || emp.status === 'terminated') throw new AppError('EMPLOYEE_RECORD_REQUIRED', 'Your account is not linked to an active employee record.', 409);
  return emp;
}

async function today(ctx) {
  const id = await employees.linkedEmployeeId(ctx);
  if (!id) return null;
  const c = await context(ctx.organizationId);
  const date = todayIn(c.tz);
  const row = await knex('attendance').where({ organization_id: ctx.organizationId, employee_id: id, work_date: date }).first();
  const qrRequired = Boolean((await orgs.getSettings(ctx.organizationId)).attendance_qr_required);
  return { date, row: row || null, isWorkingDay: c.workingDays.includes(dayKey(date)), workStart: c.start, workEnd: c.end, tz: c.tz, qrRequired };
}

/**
 * @param opts.method 'web' (the button) or 'qr' (scanned at a display screen)
 * When the company requires QR, clocking in and out only works by scanning; breaks stay on the button.
 */
async function clock(ctx, action, ip, { method = 'web', kioskId = null } = {}) {
  await ent.assertFeature(ctx.organizationId, 'attendance');
  await ent.assertCanWrite(ctx.organizationId);
  if (method === 'web' && ['in', 'out'].includes(action) && (await orgs.getSettings(ctx.organizationId)).attendance_qr_required) {
    throw new AppError('ATTENDANCE_QR_REQUIRED', 'Your company records attendance by scanning the QR code at the office screen.', 409);
  }
  const emp = await selfEmployee(ctx);
  const c = await context(ctx.organizationId);
  const date = todayIn(c.tz);
  const now = new Date();
  return knex.transaction(async (trx) => {
    const row = await trx('attendance').where({ organization_id: ctx.organizationId, employee_id: emp.id, work_date: date }).forUpdate().first();
    if (action === 'in') {
      if (row?.clock_in) throw new AppError('ALREADY_CLOCKED_IN', 'You have already clocked in today.', 409);
      const nowMin = minutesNowIn(c.tz);
      const late = c.workingDays.includes(dayKey(date)) ? Math.max(0, nowMin - (c.start + c.grace)) : 0;
      const how = { clock_in_method: method, ...(kioskId ? { kiosk_id: kioskId } : {}) };
      if (row) await trx('attendance').where({ id: row.id }).update({ clock_in: now, late_minutes: late, ip, source: 'web', ...how });
      else await trx('attendance').insert({ organization_id: ctx.organizationId, employee_id: emp.id, work_date: date, clock_in: now, late_minutes: late, ip, source: 'web', ...how });
      return 'in';
    }
    if (!row?.clock_in) throw new AppError('NOT_CLOCKED_IN', 'Clock in first.', 409);
    if (row.clock_out) throw new AppError('ALREADY_CLOCKED_OUT', 'You have already clocked out today.', 409);
    if (action === 'break_start') {
      if (row.break_started_at) throw new AppError('ON_BREAK', 'You are already on a break.', 409);
      await trx('attendance').where({ id: row.id }).update({ break_started_at: now });
      return 'break_start';
    }
    let breakMinutes = Number(row.break_minutes);
    if (row.break_started_at) breakMinutes += Math.round((now - new Date(row.break_started_at)) / 60000);
    if (action === 'break_end') {
      if (!row.break_started_at) throw new AppError('NOT_ON_BREAK', 'You are not on a break.', 409);
      await trx('attendance').where({ id: row.id }).update({ break_started_at: null, break_minutes: breakMinutes });
      return 'break_end';
    }
    if (action === 'out') {
      const update = { clock_out: now, break_started_at: null, break_minutes: breakMinutes, clock_out_method: method, ...(kioskId ? { kiosk_id: kioskId } : {}) };
      Object.assign(update, computeMinutes({ ...row, ...update }, c));
      await trx('attendance').where({ id: row.id }).update(update);
      return 'out';
    }
    throw E.validation({ action: 'Invalid action.' });
  });
}

/** Daily attendance sheet for every visible, current employee. */
async function daily(ctx, date) {
  const c = await context(ctx.organizationId);
  const day = isDateStr(date) ? date : todayIn(c.tz);
  const ids = await employees.visibleIds(ctx);
  const q = knex('employees as e').leftJoin('departments as d', 'd.id', 'e.department_id')
    .where('e.organization_id', ctx.organizationId).whereNot('e.status', 'terminated')
    .where((w) => w.whereNull('e.joining_date').orWhere('e.joining_date', '<=', day))
    .select('e.id', 'e.first_name', 'e.last_name', 'e.job_title', 'e.employee_number', 'd.name as department_name').orderBy('e.first_name');
  if (ids !== null) { if (!ids.length) return { date: day, rows: [], summary: {}, tz: c.tz, isWorkingDay: false }; q.whereIn('e.id', ids); }
  const people = await q;
  const records = await knex('attendance').where({ organization_id: ctx.organizationId, work_date: day }).whereIn('employee_id', people.map((p) => p.id));
  const byEmp = Object.fromEntries(records.map((r) => [r.employee_id, r]));
  const onLeave = new Set(await leave.onLeaveOn(ctx.organizationId, day));
  const isWorkingDay = c.workingDays.includes(dayKey(day));
  const todayStr = todayIn(c.tz);
  const beforeStart = day === todayStr && minutesNowIn(c.tz) < c.start + c.grace;
  const summary = { present: 0, late: 0, absent: 0, on_leave: 0, off: 0, not_yet: 0 };
  const rows = people.map((p) => {
    const r = byEmp[p.id] || null;
    let status;
    if (r?.clock_in) status = r.late_minutes > 0 ? 'late' : 'present';
    else if (onLeave.has(p.id)) status = 'on_leave';
    else if (!isWorkingDay) status = 'off';
    else if (day > todayStr || beforeStart) status = 'not_yet';
    else status = 'absent';
    summary[status] += 1;
    if (status === 'late') summary.present += 1;
    return { ...p, record: r, status };
  });
  return { date: day, rows, summary, tz: c.tz, isWorkingDay };
}

/** Monthly timesheet for one employee. month = 'YYYY-MM'. */
async function timesheet(ctx, employeeId, month) {
  await leave.assertCanSeeEmployee(ctx, employeeId);
  const c = await context(ctx.organizationId);
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : todayIn(c.tz).slice(0, 7);
  const first = `${m}-01`;
  const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10); // day 0 of next month
  const records = await knex('attendance').where({ organization_id: ctx.organizationId, employee_id: employeeId })
    .whereBetween('work_date', [first, last]).orderBy('work_date');
  const leaves = await knex('leave_requests as r').join('leave_types as t', 't.id', 'r.leave_type_id')
    .where({ 'r.organization_id': ctx.organizationId, 'r.employee_id': employeeId, 'r.status': 'approved' })
    .where('r.start_date', '<=', last).where('r.end_date', '>=', first).select('r.start_date', 'r.end_date', 't.name');
  const byDate = Object.fromEntries(records.map((r) => [new Date(r.work_date).toISOString().slice(0, 10), r]));
  const todayStr = todayIn(c.tz);
  const days = [];
  const totals = { worked: 0, overtime: 0, late: 0, present: 0, absent: 0, leave: 0 };
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const r = byDate[d] || null;
    const lv = leaves.find((l) => new Date(l.start_date).toISOString().slice(0, 10) <= d && new Date(l.end_date).toISOString().slice(0, 10) >= d);
    const working = c.workingDays.includes(dayKey(d));
    let status = 'off';
    if (r?.clock_in) status = r.late_minutes > 0 ? 'late' : 'present';
    else if (lv) status = 'on_leave';
    else if (working && d < todayStr) status = 'absent';
    else if (working) status = 'not_yet';
    if (r) { totals.worked += r.worked_minutes; totals.overtime += r.overtime_minutes; if (r.late_minutes > 0) totals.late += 1; }
    if (status === 'present' || status === 'late') totals.present += 1;
    if (status === 'absent') totals.absent += 1;
    if (status === 'on_leave') totals.leave += 1;
    days.push({ date: d, record: r, status, leave: lv ? lv.name : null, working });
  }
  return { month: m, days, totals, tz: c.tz };
}

/** HR / manager correction of a day. Times are local to the organization (HH:MM). */
async function saveManual(ctx, employeeId, input) {
  await ent.assertFeature(ctx.organizationId, 'attendance');
  await ent.assertCanWrite(ctx.organizationId);
  await leave.assertCanSeeEmployee(ctx, employeeId);
  const date = String(input.work_date || '');
  const hm = /^\d{2}:\d{2}$/;
  if (!isDateStr(date)) throw E.validation({ work_date: 'Use YYYY-MM-DD.' });
  if (!hm.test(input.clock_in || '')) throw E.validation({ clock_in: 'Use HH:MM.' });
  if (input.clock_out && !hm.test(input.clock_out)) throw E.validation({ clock_out: 'Use HH:MM.' });
  const c = await context(ctx.organizationId);
  const clockIn = zonedToUtc(date, input.clock_in, c.tz);
  const clockOut = input.clock_out ? zonedToUtc(date, input.clock_out, c.tz) : null;
  if (clockOut && clockOut <= clockIn) throw E.validation({ clock_out: 'Clock out must be after clock in.' });
  const breakMinutes = Math.max(0, Math.min(600, Number(input.break_minutes) || 0));
  const late = c.workingDays.includes(dayKey(date)) ? Math.max(0, hhmmToMinutes(input.clock_in) - (c.start + c.grace)) : 0;
  const row = { clock_in: clockIn, clock_out: clockOut, break_minutes: breakMinutes, break_started_at: null, late_minutes: late, source: 'manual', note: input.note ? String(input.note).slice(0, 500) : null, edited_by: ctx.userId };
  Object.assign(row, computeMinutes(row, c));
  const before = await knex('attendance').where({ organization_id: ctx.organizationId, employee_id: employeeId, work_date: date }).first();
  if (before) await knex('attendance').where({ id: before.id }).update(row);
  else await knex('attendance').insert({ ...row, organization_id: ctx.organizationId, employee_id: employeeId, work_date: date });
  await audit.record(ctx, 'attendance.corrected', {
    entityType: 'employee', entityId: employeeId,
    oldValues: before ? { date, clock_in: before.clock_in, clock_out: before.clock_out } : { date },
    newValues: { date, clock_in: input.clock_in, clock_out: input.clock_out || null, note: row.note },
  });
}

/** Counts for the dashboard (today, whole organization). */
async function todaySummary(organizationId) {
  const c = await context(organizationId);
  const day = todayIn(c.tz);
  const [{ present }] = await knex('attendance').where({ organization_id: organizationId, work_date: day }).whereNotNull('clock_in').count({ present: '*' });
  const [{ late }] = await knex('attendance').where({ organization_id: organizationId, work_date: day }).where('late_minutes', '>', 0).count({ late: '*' });
  return { date: day, present: Number(present), late: Number(late), isWorkingDay: c.workingDays.includes(dayKey(day)), afterStart: minutesNowIn(c.tz) >= c.start + c.grace };
}

module.exports = { today, clock, daily, timesheet, saveManual, todaySummary, zonedToUtc };
