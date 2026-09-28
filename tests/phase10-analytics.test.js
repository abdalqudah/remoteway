// Advanced Analytics: figures checked against hand-counted data, filters, permissions, plan gating,
// CSV export, and the SVG chart helper (escaping, integer ticks, selective labels).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const analytics = require('../src/modules/analytics/analytics.service');
const charts = require('../src/core/charts');

const ymd = (d) => d.toISOString().slice(0, 10);
const monthsAgo = (m, day = 15) => { const d = new Date(); return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - m, day))); };
const all = async () => new Set(await h.knex('permissions').pluck('key'));

let co; let owner; let ctx; let deptA; let deptB;
before(async () => {
  await h.resetDatabase();
  co = await h.createCompany({ plan: 'business' });
  owner = await h.login(co.email, co.password);
  ctx = { organizationId: co.organizationId, userId: co.userId, permissions: await all() };
  [deptA] = await h.knex('departments').insert({ organization_id: co.organizationId, name: 'Alpha' });
  [deptB] = await h.knex('departments').insert({ organization_id: co.organizationId, name: 'Beta' });
  const e = (n, extra) => ({ organization_id: co.organizationId, employee_number: `A${n}`, first_name: 'E', last_name: String(n), ...extra });
  await h.knex('employees').insert([
    e(1, { department_id: deptA, joining_date: monthsAgo(30), nationality: 'SA' }), // 2.5 years
    e(2, { department_id: deptA, joining_date: monthsAgo(14), nationality: 'EG' }), // ~1.2 years
    e(3, { department_id: deptB, joining_date: monthsAgo(2), nationality: 'SA' }), // new joiner in period
    e(4, { department_id: deptB, joining_date: monthsAgo(20), termination_date: monthsAgo(1), status: 'terminated', nationality: 'SA' }), // leaver
    e(5, { department_id: deptB, joining_date: monthsAgo(6), termination_date: monthsAgo(3), status: 'terminated' }), // early leaver
  ]);
});
after(async () => { await h.knex.destroy(); });

describe('Phase 10 — analytics', () => {
  test('the module is part of Professional; Business sees an upgrade page', async () => {
    const page = await owner.get('/app/analytics');
    assert.equal(page.status, 200);
    assert.match(page.text, /Advanced Analytics is part of/);
    await assert.rejects(analytics.section(ctx, 'workforce', {}), (e) => e.status === 402);
    const plan = await h.knex('plans').where({ key: 'professional' }).first();
    await h.knex('subscriptions').where({ organization_id: co.organizationId }).update({ plan_id: plan.id, status: 'active' });
    h.cache.clear();
  });

  test('workforce figures match the data', async () => {
    const { data } = await analytics.section(ctx, 'workforce', { months: 12 });
    assert.equal(data.kpis.headcount, 3);
    assert.equal(data.kpis.hires, 2, 'employees 3 and 5 joined in the last 12 months');
    assert.equal(data.kpis.exits, 2);
    assert.equal(data.kpis.saudization_pct, 66.7, '2 of 3 current employees');
    assert.equal(data.headcount.length, 12);
    assert.equal(data.headcount[11].value, 3);
    assert.deepEqual(data.tenure.map((b) => b.value), [1, 1, 1, 0, 0]);
    assert.deepEqual(data.departments.map((d) => [d.label, d.value]).sort(), [['Alpha', 2], ['Beta', 1]]);
    const b = await analytics.section(ctx, 'workforce', { months: 12, department_id: deptB });
    assert.equal(b.data.kpis.headcount, 1);
    assert.equal(b.data.kpis.exits, 2);
  });

  test('retention: turnover, early attrition and 12-month retention', async () => {
    const { data } = await analytics.section(ctx, 'retention', { months: 12 });
    assert.equal(data.kpis.exits, 2);
    assert.equal(data.kpis.early_attrition_pct, 50, 'one of two leavers left within a year');
    // Employed a year ago: employees 1, 2 and 4 → 4 has left
    assert.equal(data.kpis.retention_12m_pct, 66.7);
    assert.ok(data.kpis.turnover_pct > 0);
  });

  test('absence uses approved leave and the working week', async () => {
    const [typeId] = await h.knex('leave_types').insert({ organization_id: co.organizationId, key: 'sick', name: 'Sick', has_balance: false });
    const emp1 = await h.knex('employees').where({ organization_id: co.organizationId, employee_number: 'A1' }).first();
    const d = monthsAgo(1, 10);
    await h.knex('leave_requests').insert([
      { organization_id: co.organizationId, employee_id: emp1.id, leave_type_id: typeId, start_date: d, end_date: d, days: 1, status: 'approved' },
      { organization_id: co.organizationId, employee_id: emp1.id, leave_type_id: typeId, start_date: monthsAgo(1, 20), end_date: monthsAgo(1, 21), days: 2, status: 'approved' },
      { organization_id: co.organizationId, employee_id: emp1.id, leave_type_id: typeId, start_date: d, end_date: d, days: 5, status: 'rejected' },
    ]);
    const { data } = await analytics.section(ctx, 'absence', { months: 6 });
    assert.equal(data.kpis.leave_days, 3);
    assert.equal(data.bradford[0].spells, 2);
    assert.equal(data.bradford[0].score, 2 * 2 * 3);
    assert.ok(data.rate[4].value > 0);
  });

  test('hiring funnel counts the furthest stage reached (from history)', async () => {
    const [jobId] = await h.knex('jobs').insert({ organization_id: co.organizationId, title: 'Dev', slug: 'dev', status: 'open' });
    const mk = async (i, stage, events) => {
      const [cid] = await h.knex('candidates').insert({ organization_id: co.organizationId, first_name: 'C', last_name: String(i), email: `c${i}@x.test`, source: i === 1 ? 'referral' : 'careers' });
      const [aid] = await h.knex('applications').insert({ organization_id: co.organizationId, job_id: jobId, candidate_id: cid, stage, stage_changed_at: new Date() });
      for (const to of events) await h.knex('application_events').insert({ organization_id: co.organizationId, application_id: aid, type: 'stage', data: JSON.stringify({ to }) });
    };
    await mk(1, 'hired', ['applied', 'interview', 'offer', 'hired']);
    await mk(2, 'rejected', ['applied', 'shortlisted', 'rejected']); // rejected after shortlisting
    await mk(3, 'applied', ['applied']);
    const { data } = await analytics.section(ctx, 'hiring', { months: 12 });
    const f = Object.fromEntries(data.funnel.map((s) => [s.key, s.value]));
    assert.deepEqual([f.applied, f.screening, f.shortlisted, f.interview, f.offer, f.hired], [3, 2, 2, 1, 1, 1]);
    assert.equal(data.kpis.hires, 1);
    assert.deepEqual(data.sources.find((s) => s.key === 'referral'), { key: 'referral', applications: 1, hires: 1, rate: 100 });
  });

  test('payroll cost uses the full employer cost of approved runs only', async () => {
    const emp1 = await h.knex('employees').where({ organization_id: co.organizationId, employee_number: 'A1' }).first();
    const period = monthsAgo(1).slice(0, 7);
    const run = (status) => h.knex('payroll_runs').insert({ organization_id: co.organizationId, period: `${period}${status === 'draft' ? '' : ''}`, period_start: `${period}-01`, period_end: `${period}-28`, status, currency: 'SAR' });
    const [approved] = await run('approved');
    const [draft] = await run('draft');
    const slip = (runId) => ({ organization_id: co.organizationId, run_id: runId, employee_id: emp1.id, employee_name: 'E 1', department_name: 'Alpha', paid_days: 30, period_days: 30, gross: 10000, total_deductions: 975, net: 9025, employer_cost: 11175 });
    await h.knex('payslips').insert([slip(approved), slip(draft)]);
    const { data } = await analytics.section(ctx, 'cost', { months: 12 });
    assert.equal(data.kpis.total_cost, 11175);
    assert.equal(data.kpis.contributions_pct, 10.5); // 1175 of 11175
    assert.equal(data.byDepartment[0].value, 11175);
  });

  test('sections follow permissions; employees cannot open analytics', async () => {
    const fin = await h.addMember(co.organizationId, 'finance_manager');
    const perms = await require('../src/modules/rbac/rbac.service').getUserPermissions(co.organizationId, fin.userId);
    assert.deepEqual(await analytics.sectionsFor({ organizationId: co.organizationId, userId: fin.userId, permissions: perms }), ['workforce', 'retention', 'cost']);
    const fs = await h.login(fin.email, fin.password);
    assert.equal((await fs.get('/app/analytics?section=absence')).status, 200); // falls back to a permitted section
    await assert.rejects(analytics.section({ organizationId: co.organizationId, userId: fin.userId, permissions: perms }, 'absence', {}), (e) => e.status === 403);
    const mgr = await h.addMember(co.organizationId, 'department_manager');
    const ms = await h.login(mgr.email, mgr.password);
    assert.match((await ms.get('/app/analytics')).text, /cannot see company-wide data/);
    const emp = await h.addMember(co.organizationId, 'employee');
    const es = await h.login(emp.email, emp.password);
    assert.equal((await es.get('/app/analytics')).status, 403);
  });

  test('every section renders, and exports CSV', async () => {
    for (const s of Object.keys(analytics.SECTIONS)) {
      const r = await owner.get(`/app/analytics?section=${s}&months=24`);
      assert.equal(r.status, 200, s);
      assert.match(r.text, /class="chart-table"/);
    }
    const csvRes = await owner.get('/app/analytics?section=workforce&format=csv');
    assert.match(csvRes.headers['content-type'], /text\/csv/);
    assert.match(csvRes.text, /Headcount at month end/);
  });

  test('chart helper escapes labels, uses whole-number ticks for counts and labels one column', () => {
    const pts = [{ label: '<b>x</b>', value: 1 }, { label: 'b', value: 1 }, { label: 'c', value: 1 }];
    const svg = charts.columns({ points: pts, title: 't', fmt: String });
    assert.ok(!svg.includes('<b>x</b>') && svg.includes('&lt;b&gt;'));
    assert.ok(!/>0\.25</.test(svg), 'no fractional ticks for counts');
    assert.equal((svg.match(/class="ch-label"/g) || []).length, 1);
    const line = charts.line({ points: [{ label: 'a', value: 1 }, { label: 'b', value: null }, { label: 'c', value: 3 }], title: 't' });
    assert.equal((line.match(/class="ch-line"/g) || []).length, 2, 'a missing month breaks the line');
    assert.deepEqual(charts.niceScale(7, 4, true), { top: 8, step: 2 });
  });
});
