const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { addDays, todayIn } = require('../src/core/workdays');

// Next date (from today + offset) that is a Sunday–Thursday working day, so tests never land on a weekend.
// All leave dates in this file fall in one calendar year (BASE_YEAR), whatever day the tests run.
const today = todayIn('Asia/Riyadh');
const BASE = today.slice(5) > '10-15' ? `${Number(today.slice(0, 4)) + 1}-01-04` : today;
const BASE_YEAR = BASE.slice(0, 4);
function workday(offset) {
  let d = addDays(offset < 0 ? today : BASE, offset);
  while ([5, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1);
  return d;
}

describe('Phase 2 — leave & attendance', () => {
  let C; let owner; let mgr; let mgrEmp; let emp; let empEmp; let outsider; let outsiderEmp; let annual;

  before(async () => {
    await h.resetDatabase();
    C = await h.createCompany({ plan: 'business' });
    owner = await h.login(C.email, C.password);
    const m = await h.addMember(C.organizationId, 'department_manager');
    const e = await h.addMember(C.organizationId, 'employee');
    const o = await h.addMember(C.organizationId, 'employee');
    mgrEmp = (await h.createEmployee(owner, { first_name: 'Mgr', email: m.email })).body.data;
    empEmp = (await h.createEmployee(owner, { first_name: 'Worker', email: e.email, manager_id: mgrEmp.id })).body.data;
    outsiderEmp = (await h.createEmployee(owner, { first_name: 'Out', email: o.email })).body.data;
    // Link the logins to the employee records (normally done by invitation acceptance).
    await h.knex('employees').where({ id: mgrEmp.id }).update({ user_id: m.userId });
    await h.knex('employees').where({ id: empEmp.id }).update({ user_id: e.userId });
    await h.knex('employees').where({ id: outsiderEmp.id }).update({ user_id: o.userId });
    mgr = await h.login(m.email, m.password);
    emp = await h.login(e.email, e.password);
    outsider = await h.login(o.email, o.password);
    const types = await emp.api('get', '/api/v1/leave/types');
    annual = types.body.data.find((t) => t.key === 'annual');
  });
  after(() => h.knex.destroy());

  test('default leave types are created with balances', async () => {
    assert.ok(annual);
    assert.equal(Number(annual.days_per_year), 21);
    const b = await emp.api('get', `/api/v1/leave/balances?year=${BASE_YEAR}`);
    assert.equal(b.body.data.find((x) => x.type.key === 'annual').available, 21);
  });

  let requestId;
  test('employee requests leave; working days are counted; manager is notified', async () => {
    const start = workday(10);
    const res = await emp.api('post', '/api/v1/leave/requests', { leave_type_id: annual.id, start_date: start, end_date: addDays(start, 6) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    requestId = res.body.data.id;
    const row = await h.knex('leave_requests').where({ id: requestId }).first();
    assert.equal(Number(row.days), 5); // 7 calendar days = 5 working days (Sun–Thu week)
    const n = await mgr.api('get', '/api/v1/notifications');
    assert.ok(n.body.data.some((x) => x.type === 'leave_requested'));
  });

  test('overlapping and over-balance requests are refused', async () => {
    const start = workday(10);
    const overlap = await emp.api('post', '/api/v1/leave/requests', { leave_type_id: annual.id, start_date: start, end_date: start });
    assert.equal(overlap.body.error.code, 'LEAVE_OVERLAP');
    const s2 = workday(25); // after the first request, inside this calendar year
    const tooMuch = await emp.api('post', '/api/v1/leave/requests', { leave_type_id: annual.id, start_date: s2, end_date: addDays(s2, 35) });
    assert.equal(tooMuch.body.error.code, 'INSUFFICIENT_LEAVE_BALANCE');
  });

  test('employees cannot approve; an unrelated person cannot approve', async () => {
    assert.equal((await emp.api('post', `/api/v1/leave/requests/${requestId}/decide`, { decision: 'approved' })).status, 403);
    assert.equal((await outsider.api('post', `/api/v1/leave/requests/${requestId}/decide`, { decision: 'approved' })).status, 403);
  });

  test('manager approves a direct report; balance is deducted; cancel restores it', async () => {
    const approvals = await mgr.api('get', '/api/v1/leave/requests?scope=approvals');
    assert.deepEqual(approvals.body.data.map((r) => r.id), [requestId]);
    const res = await mgr.api('post', `/api/v1/leave/requests/${requestId}/decide`, { decision: 'approved' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let b = await emp.api('get', `/api/v1/leave/balances?year=${BASE_YEAR}`);
    assert.equal(b.body.data.find((x) => x.type.key === 'annual').available, 16);
    const again = await mgr.api('post', `/api/v1/leave/requests/${requestId}/decide`, { decision: 'rejected' });
    assert.equal(again.body.error.code, 'LEAVE_NOT_PENDING');
    assert.ok((await emp.api('get', '/api/v1/notifications')).body.data.some((x) => x.type === 'leave_approved'));
    await emp.api('post', `/api/v1/leave/requests/${requestId}/cancel`, {});
    b = await emp.api('get', `/api/v1/leave/balances?year=${BASE_YEAR}`);
    assert.equal(b.body.data.find((x) => x.type.key === 'annual').available, 21);
  });

  test('people cannot see or cancel other people\'s leave', async () => {
    const start = workday(20);
    const r = await outsider.api('post', '/api/v1/leave/requests', { leave_type_id: annual.id, start_date: start, end_date: start });
    const res = await emp.api('post', `/api/v1/leave/requests/${r.body.data.id}/cancel`, {});
    assert.equal(res.status, 403);
    assert.equal((await emp.api('get', `/api/v1/leave/balances?employee_id=${outsiderEmp.id}`)).status, 404);
  });

  test('clock in / break / out computes worked minutes', async () => {
    assert.equal((await emp.api('post', '/api/v1/attendance/clock', { action: 'out' })).body.error.code, 'NOT_CLOCKED_IN');
    assert.equal((await emp.api('post', '/api/v1/attendance/clock', { action: 'in' })).status, 200);
    assert.equal((await emp.api('post', '/api/v1/attendance/clock', { action: 'in' })).body.error.code, 'ALREADY_CLOCKED_IN');
    assert.equal((await emp.api('post', '/api/v1/attendance/clock', { action: 'break_start' })).status, 200);
    assert.equal((await emp.api('post', '/api/v1/attendance/clock', { action: 'break_end' })).status, 200);
    // Pretend the employee arrived 2 hours ago.
    await h.knex('attendance').where({ employee_id: empEmp.id }).update({ clock_in: new Date(Date.now() - 2 * 3600_000) });
    assert.equal((await emp.api('post', '/api/v1/attendance/clock', { action: 'out' })).status, 200);
    const row = await h.knex('attendance').where({ employee_id: empEmp.id }).first();
    assert.ok(row.worked_minutes >= 119 && row.worked_minutes <= 121, String(row.worked_minutes));
    const today = await emp.api('get', '/api/v1/attendance/today');
    assert.ok(today.body.data.row.clock_out);
  });

  test('daily sheet is for HR/managers; managers only see their team', async () => {
    assert.equal((await emp.api('get', '/api/v1/attendance/daily')).status, 403);
    const hr = await owner.api('get', '/api/v1/attendance/daily');
    assert.equal(hr.body.data.rows.length, 3);
    const team = await mgr.api('get', '/api/v1/attendance/daily');
    assert.deepEqual(team.body.data.rows.map((r) => r.id).sort(), [mgrEmp.id, empEmp.id].sort());
    assert.equal((await mgr.api('get', `/api/v1/attendance/employees/${outsiderEmp.id}`)).status, 404);
  });

  test('HR corrections are validated and audited', async () => {
    const bad = await owner.form('/app/attendance/manual', { employee_id: outsiderEmp.id, work_date: workday(-7), clock_in: '10:00', clock_out: '09:00' });
    assert.equal(bad.status, 302);
    const ok = await owner.form('/app/attendance/manual', { employee_id: outsiderEmp.id, work_date: workday(-7), clock_in: '09:00', clock_out: '17:30', break_minutes: 30 });
    assert.equal(ok.status, 302);
    const row = await h.knex('attendance').where({ employee_id: outsiderEmp.id }).first();
    assert.equal(row.worked_minutes, 480);
    assert.equal(row.source, 'manual');
    assert.ok(await h.knex('audit_logs').where({ action: 'attendance.corrected' }).first());
    const denied = await emp.form('/app/attendance/manual', { employee_id: empEmp.id, work_date: workday(-7), clock_in: '09:00' });
    assert.equal(denied.status, 403);
  });

  test('leave is tenant isolated', async () => {
    const other = await h.createCompany({ plan: 'business' });
    const o = await h.login(other.email, other.password);
    assert.equal((await o.api('post', `/api/v1/leave/requests/${requestId}/cancel`, {})).status, 404);
    const types = await o.api('get', '/api/v1/leave/types');
    assert.ok(types.body.data.every((t) => t.organization_id === other.organizationId));
  });
});
