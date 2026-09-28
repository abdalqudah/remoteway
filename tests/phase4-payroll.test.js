const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { todayIn } = require('../src/core/workdays');
const engine = require('../src/modules/payroll/engine');

const VALID_IBAN = 'SA0380000000608010167519';

describe('Phase 4 — payroll', () => {
  let C; let O; let owner; let other; let prep; let prepUser; let fin; let finUser; let hr; let emp; let empUser;
  let period; let bounds; let sara; let omar; let joiner; let runId;

  before(async () => {
    await h.resetDatabase();
    C = await h.createCompany({ plan: 'business' });
    O = await h.createCompany({ plan: 'business' });
    owner = await h.login(C.email, C.password);
    other = await h.login(O.email, O.password);
    prepUser = await h.addMember(C.organizationId, 'payroll_manager');
    prep = await h.login(prepUser.email, prepUser.password);
    finUser = await h.addMember(C.organizationId, 'finance_manager');
    fin = await h.login(finUser.email, finUser.password);
    const hrUser = await h.addMember(C.organizationId, 'hr_manager');
    hr = await h.login(hrUser.email, hrUser.password);
    empUser = await h.addMember(C.organizationId, 'employee');
    emp = await h.login(empUser.email, empUser.password);

    const [y, m] = todayIn('Asia/Riyadh').slice(0, 7).split('-').map(Number);
    period = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); // last month
    bounds = engine.periodBounds(period);
    sara = (await h.createEmployee(owner, { first_name: 'Sara', email: empUser.email, base_salary: 10000, nationality: 'SA', joining_date: '2024-01-01' })).body.data;
    omar = (await h.createEmployee(owner, { first_name: 'Omar', base_salary: 8000, nationality: 'EG', joining_date: '2024-01-01' })).body.data;
    joiner = (await h.createEmployee(owner, { first_name: 'Nora', base_salary: 9000, nationality: 'EG', joining_date: `${period}-21` })).body.data;
    await h.createEmployee(owner, { first_name: 'Future', base_salary: 9000, joining_date: '2099-01-01' });
  });
  after(() => h.knex.destroy());

  test('payroll is not part of the Starter plan', async () => {
    const S = await h.createCompany({ plan: 'starter' });
    const s = await h.login(S.email, S.password);
    assert.equal((await s.get('/app/payroll')).status, 402);
    assert.equal((await s.api('get', '/api/v1/payroll/runs')).status, 402);
  });

  test('compensation: IBANs are validated; allowances are saved; only payroll staff can edit', async () => {
    const comps = await h.knex('pay_components').where({ organization_id: C.organizationId });
    assert.ok(comps.length === 0 || comps.length === 4);
    await owner.get('/app/payroll/settings'); // creates the default components
    const all = await h.knex('pay_components').where({ organization_id: C.organizationId });
    const housing = all.find((c) => c.code === 'HOUSING');
    const bad = await prep.form(`/app/payroll/compensation/${sara.id}`, { base_salary: 10000, iban: 'SA0380000000608010167518', payment_method: 'bank' });
    assert.equal(bad.status, 302);
    assert.equal(await h.knex('employee_pay_profiles').where({ employee_id: sara.id }).first(), undefined);
    const ok = await prep.form(`/app/payroll/compensation/${sara.id}`, { base_salary: 10000, iban: 'sa03 8000 0000 6080 1016 7519', payment_method: 'bank', gosi_registered: 'on', [`component_${housing.id}`]: 25 });
    assert.equal(ok.status, 302);
    const p = await h.knex('employee_pay_profiles').where({ employee_id: sara.id }).first();
    assert.equal(p.iban, VALID_IBAN);
    assert.equal((await h.knex('employee_pay_components').where({ employee_id: sara.id })).length, 1);
    // HR can see salaries but cannot change payroll data; employees cannot do either.
    assert.equal((await hr.get(`/app/employees/${sara.id}?tab=payroll`)).status, 200);
    assert.equal((await hr.form(`/app/payroll/compensation/${sara.id}`, { base_salary: 1 })).status, 403);
    assert.equal((await other.form(`/app/payroll/compensation/${sara.id}`, { base_salary: 1 })).status, 302); // refused with an error message
    assert.equal(Number((await h.knex('employees').where({ id: sara.id }).first()).base_salary), 10000);
    // Omar and Nora are paid by bank without IBAN on purpose (warnings).
  });

  test('a run pays everyone employed in the month, with GOSI, proration and unpaid leave', async () => {
    const unpaid = await (async () => { await owner.get('/app/leave'); return h.knex('leave_types').where({ organization_id: C.organizationId, key: 'unpaid' }).first(); })();
    await h.knex('leave_requests').insert({ organization_id: C.organizationId, employee_id: omar.id, leave_type_id: unpaid.id, start_date: `${period}-01`, end_date: `${period}-28`, days: 20, status: 'approved' });
    const res = await prep.form('/app/payroll/runs', { period });
    assert.equal(res.status, 302, res.text.slice(0, 300));
    runId = Number(res.headers.location.split('/').pop());
    const slips = await h.knex('payslips').where({ run_id: runId });
    assert.deepEqual(slips.map((s) => s.employee_id).sort(), [sara.id, omar.id, joiner.id].sort()); // not the future joiner
    const s = slips.find((x) => x.employee_id === sara.id);
    assert.equal(Number(s.gross), 12500);
    assert.equal(Number(s.gosi_base), 12500);
    assert.equal(Number(s.total_deductions), 1218.75);
    assert.equal(Number(s.net), 11281.25);
    assert.equal(s.iban, VALID_IBAN);
    const n = slips.find((x) => x.employee_id === joiner.id);
    const expectDays = Math.min(30, Number(bounds.end.slice(8)) - 20);
    assert.equal(Number(n.paid_days), expectDays);
    assert.equal(Number(n.basic), Math.round(9000 * expectDays / 30 * 100) / 100);
    const o = slips.find((x) => x.employee_id === omar.id);
    assert.ok(Number(o.unpaid_leave_days) > 0 && Number(o.unpaid_leave_days) <= 20);
    const leaveLine = await h.knex('payslip_lines').where({ payslip_id: o.id, code: 'UNPAID_LEAVE' }).first();
    assert.equal(Number(leaveLine.amount), Math.round(8000 / 30 * Number(o.unpaid_leave_days) * 100) / 100);
    const run = await h.knex('payroll_runs').where({ id: runId }).first();
    assert.equal(Number(run.total_net), Math.round(slips.reduce((a, x) => a + Number(x.net), 0) * 1000) / 1000);
    const warnings = typeof run.warnings === 'string' ? JSON.parse(run.warnings) : run.warnings;
    assert.equal(warnings.no_iban, 2);
  });

  test('one payroll per month', async () => {
    const again = await prep.form('/app/payroll/runs', { period });
    assert.equal(again.status, 302);
    assert.equal(again.headers.location, `/app/payroll/runs/${runId}`);
    const api = await prep.api('post', '/api/v1/payroll/runs', { period });
    assert.equal(api.status, 409);
    assert.equal(api.body.error.code, 'PAYROLL_EXISTS');
    assert.equal((await prep.form('/app/payroll/runs', { period: '2099-01' })).status, 422);
  });

  test('adjustments recalculate the payslip', async () => {
    const r = await prep.form(`/app/payroll/runs/${runId}/adjustments`, { employee_id: sara.id, kind: 'earning', name: 'Bonus', amount: 1000 });
    assert.equal(r.status, 302);
    const s = await h.knex('payslips').where({ run_id: runId, employee_id: sara.id }).first();
    assert.equal(Number(s.gross), 13500);
    assert.equal(Number(s.net), 12281.25);
    const bad = await prep.form(`/app/payroll/runs/${runId}/adjustments`, { employee_id: sara.id, kind: 'earning', name: 'X', amount: -5 });
    assert.equal(bad.status, 422);
  });

  test('employees and other companies cannot see payroll', async () => {
    assert.equal((await emp.get('/app/payroll')).status, 403);
    assert.equal((await emp.get(`/app/payroll/runs/${runId}`)).status, 403);
    assert.equal((await emp.get(`/app/payroll/runs/${runId}/export/bank.csv`)).status, 403);
    assert.equal((await other.get(`/app/payroll/runs/${runId}`)).status, 404);
    assert.equal((await other.get(`/app/payroll/runs/${runId}/export/register.csv`)).status, 404);
    const slip = await h.knex('payslips').where({ run_id: runId, employee_id: sara.id }).first();
    assert.equal((await other.get(`/app/payroll/payslips/${slip.id}`)).status, 404);
    // Before payment, even the employee cannot open their own payslip.
    assert.equal((await emp.get(`/app/payroll/payslips/${slip.id}`)).status, 404);
    assert.equal((await other.form(`/app/payroll/runs/${runId}/submit`, {})).status, 302);
    assert.equal((await h.knex('payroll_runs').where({ id: runId }).first()).status, 'draft');
  });

  test('workflow: submit → four-eyes approval → locked → paid', async () => {
    await owner.form('/app/payroll/settings', { proration: 'thirty', four_eyes: 'on', gosi_enabled: 'on' });
    assert.equal((await prep.form(`/app/payroll/runs/${runId}/submit`, {})).status, 302);
    assert.equal((await h.knex('payroll_runs').where({ id: runId }).first()).status, 'review');
    assert.ok(await h.knex('notifications').where({ user_id: finUser.userId, type: 'payroll_submitted' }).first());
    // The payroll manager may not approve (no permission); the owner submitted nothing, so four-eyes lets them — but we use finance.
    assert.equal((await prep.form(`/app/payroll/runs/${runId}/approve`, {})).status, 403);
    // Edits are refused while in review.
    await prep.form(`/app/payroll/runs/${runId}/recalculate`, {});
    await prep.form(`/app/payroll/runs/${runId}/adjustments`, { employee_id: sara.id, kind: 'earning', name: 'Late', amount: 5 });
    assert.equal((await h.knex('payroll_adjustments').where({ run_id: runId })).length, 1);
    // Four eyes: the submitter cannot approve even with the permission.
    const payroll = require('../src/modules/payroll/payroll.service');
    await assert.rejects(() => payroll.transition({ organizationId: C.organizationId, userId: prepUser.userId, permissions: new Set(['payroll.approve', 'payroll.process']) }, runId, 'approve'),
      (e) => e.code === 'PAYROLL_FOUR_EYES');
    assert.equal((await fin.form(`/app/payroll/runs/${runId}/approve`, {})).status, 302);
    const approved = await h.knex('payroll_runs').where({ id: runId }).first();
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approved_by, finUser.userId);
    // Approved payrolls are locked.
    const net = (await h.knex('payslips').where({ run_id: runId, employee_id: sara.id }).first()).net;
    await h.knex('employees').where({ id: sara.id }).update({ base_salary: 99999 });
    await prep.form(`/app/payroll/runs/${runId}/recalculate`, {});
    assert.equal((await h.knex('payslips').where({ run_id: runId, employee_id: sara.id }).first()).net, net);
    assert.equal((await prep.form(`/app/payroll/runs/${runId}/cancel`, {})).status, 302);
    assert.equal((await h.knex('payroll_runs').where({ id: runId }).first()).status, 'approved');
    // Pay.
    assert.equal((await prep.form(`/app/payroll/runs/${runId}/pay`, { payment_date: `${period}-27` })).status, 302);
    const paid = await h.knex('payroll_runs').where({ id: runId }).first();
    assert.equal(paid.status, 'paid');
    assert.ok(await h.knex('notifications').where({ user_id: empUser.userId, type: 'payslip_available' }).first());
  });

  test('after payment employees see only their own payslips', async () => {
    const mine = await h.knex('payslips').where({ run_id: runId, employee_id: sara.id }).first();
    const theirs = await h.knex('payslips').where({ run_id: runId, employee_id: omar.id }).first();
    const page = await emp.get(`/app/payroll/payslips/${mine.id}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /12,281\.25/);
    assert.equal((await emp.get(`/app/payroll/payslips/${theirs.id}`)).status, 404);
    const list = await emp.api('get', '/api/v1/payroll/payslips/mine');
    assert.deepEqual(list.body.data.map((x) => x.id), [mine.id]);
    assert.equal((await emp.get(`/app/payroll/payslips/${mine.id}?print=1`)).status, 200);
  });

  test('exports: register, bank transfer (IBAN) and GOSI files', async () => {
    const bank = await fin.get(`/app/payroll/runs/${runId}/export/bank.csv`);
    assert.equal(bank.status, 200);
    assert.match(bank.headers['content-type'], /text\/csv/);
    assert.match(bank.text, new RegExp(VALID_IBAN));
    assert.match(bank.text, /12281\.25/);
    const gosi = await fin.get(`/app/payroll/runs/${runId}/export/gosi.csv`);
    assert.match(gosi.text, /1218\.75/);
    const reg = await fin.get(`/app/payroll/runs/${runId}/export/register.csv`);
    assert.equal(reg.text.split('\r\n').length, 4);
    const csv = require('../src/core/csv');
    assert.equal(csv.cell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.equal(csv.cell(-5), '-5');
  });

  test('a cancelled month can be run again; the audit log records every step', async () => {
    const res = await prep.form('/app/payroll/runs', { period: todayIn('Asia/Riyadh').slice(0, 7) });
    const id = Number(res.headers.location.split('/').pop());
    await prep.form(`/app/payroll/runs/${id}/cancel`, {});
    assert.equal((await h.knex('payroll_runs').where({ id }).first()).status, 'cancelled');
    const again = await prep.form('/app/payroll/runs', { period: todayIn('Asia/Riyadh').slice(0, 7) });
    assert.notEqual(Number(again.headers.location.split('/').pop()), id);
    const actions = (await h.knex('audit_logs').where({ organization_id: C.organizationId }).where('action', 'like', 'payroll.%')).map((a) => a.action);
    for (const a of ['payroll.created', 'payroll.adjusted', 'payroll.submitted', 'payroll.approved', 'payroll.paid', 'payroll.cancelled']) assert.ok(actions.includes(a), a);
    const comp = await h.knex('audit_logs').where({ organization_id: C.organizationId, action: 'compensation.updated' }).first();
    assert.doesNotMatch(JSON.stringify(comp.new_values), /6080101675/); // IBAN is masked in the audit log
  });
});
