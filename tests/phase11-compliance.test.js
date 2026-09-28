// Compliance: every check against crafted data, score and history, rules, the annual-leave fix,
// policy acknowledgements (incl. new versions), permissions and plan gating.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const compliance = require('../src/modules/compliance/compliance.service');
const { todayIn, addDays } = require('../src/core/workdays');

let co; let owner; let ctx; let today; const E = {};
const byKey = (r, k) => r.checks.find((c) => c.key === k);

before(async () => {
  await h.resetDatabase();
  co = await h.createCompany({ plan: 'business' });
  owner = await h.login(co.email, co.password);
  ctx = { organizationId: co.organizationId, userId: co.userId, permissions: new Set(await h.knex('permissions').pluck('key')) };
  today = todayIn('Asia/Riyadh');
  await owner.get('/app/leave'); // default leave types
  const mk = async (key, extra) => {
    const [id] = await h.knex('employees').insert({ organization_id: co.organizationId, employee_number: key, first_name: key, last_name: 'X', status: 'active', joining_date: addDays(today, -400), nationality: 'SA', ...extra });
    E[key] = id;
  };
  await mk('saudi_ok');
  await mk('expat', { nationality: 'EG' });
  await mk('veteran', { joining_date: addDays(today, -365 * 6) });
  await mk('trainee', { status: 'probation', joining_date: addDays(today, -120) });
  await mk('unknown', { nationality: null });
  const doc = (emp, category, expires) => h.knex('documents').insert({ organization_id: co.organizationId, employee_id: E[emp], category, title: category, expires_at: expires || null });
  for (const e of Object.keys(E)) await doc(e, 'contract');
  await doc('saudi_ok', 'id', addDays(today, 400));
  await doc('veteran', 'id', addDays(today, 30)); // expiring soon
  await doc('trainee', 'id');
  await doc('expat', 'iqama', addDays(today, -5)); // expired, and no passport
  const pay = (emp, extra) => h.knex('employee_pay_profiles').insert({ organization_id: co.organizationId, employee_id: E[emp], payment_method: 'bank', iban: 'SA0380000000608010167519', gosi_registered: true, ...extra });
  await pay('saudi_ok'); await pay('veteran'); await pay('trainee');
  await pay('expat', { iban: null, gosi_registered: false });
  // unknown: no pay profile at all
  const monday = addDays(today, -14);
  for (let i = 0; i < 6; i += 1) await h.knex('attendance').insert({ organization_id: co.organizationId, employee_id: E.saudi_ok, work_date: addDays(monday, i), clock_in: new Date(), worked_minutes: 10 * 60 });
});
after(async () => { await h.knex.destroy(); });

describe('Phase 11 — compliance', () => {
  test('each check finds exactly the crafted problems', async () => {
    const r = await compliance.evaluate(ctx);
    const who = (k) => byKey(r, k).items.map((i) => Object.keys(E).find((n) => E[n] === i.employee_id)).sort();
    assert.deepEqual(who('documents_expired'), ['expat']);
    assert.deepEqual(byKey(r, 'documents_required').items.filter((i) => i.employee_id === E.expat).map((i) => i.params.category), ['passport']);
    assert.deepEqual(who('documents_required'), ['expat'], 'only the expat misses a document (unknown nationality gets the "everyone" rules only)');
    assert.deepEqual(who('documents_expiring'), ['veteran']);
    assert.deepEqual(who('probation'), ['trainee']);
    assert.deepEqual(who('annual_leave'), ['veteran']);
    assert.equal(byKey(r, 'annual_leave').items[0].params.required, 30);
    assert.deepEqual(who('wps'), ['expat', 'unknown']);
    assert.deepEqual(who('gosi'), ['expat', 'unknown']);
    assert.deepEqual(who('working_hours'), ['saudi_ok']);
    assert.deepEqual(who('nationality'), ['unknown']);
    assert.equal(byKey(r, 'policies').status, 'na');
    assert.ok(r.score > 0 && r.score < 100);
    assert.ok(await h.knex('compliance_snapshots').where({ organization_id: co.organizationId, day: today }).first());
  });

  test('the annual-leave fix raises the balance to 30 days and the check passes', async () => {
    const r = await owner.form('/app/compliance/fix/annual-leave', {});
    assert.equal(r.status, 302);
    const type = await h.knex('leave_types').where({ organization_id: co.organizationId, key: 'annual' }).first();
    const b = await h.knex('leave_balances').where({ employee_id: E.veteran, leave_type_id: type.id }).first();
    assert.equal(Number(b.entitled_days) + Number(b.adjustment_days), 30);
    assert.equal(byKey(await compliance.evaluate(ctx), 'annual_leave').status, 'pass');
    assert.ok(await h.knex('audit_logs').where({ organization_id: co.organizationId, action: 'leave_balance.adjusted' }).first());
  });

  test('rules: turning a check off, custom document rules and probation limit', async () => {
    let r = await owner.form('/app/compliance/settings', { checks: ['documents_required', 'documents_expired'], req_category: ['contract', 'passport'], req_applies: ['all', 'all'], expiry_warning_days: '30', probation_max_days: '180', weekly_hours_limit: '48' });
    assert.equal(r.status, 302);
    const res = await compliance.evaluate(ctx);
    assert.equal(byKey(res, 'wps').status, 'off');
    assert.equal(byKey(res, 'documents_required').items.length, 5, 'everyone now needs a passport');
    r = await owner.form('/app/compliance/settings', { checks: [], expiry_warning_days: '2', probation_max_days: '90', weekly_hours_limit: '48' });
    assert.equal(r.status, 422);
    await owner.form('/app/compliance/settings', { checks: Object.keys(compliance.CHECKS), req_category: ['contract'], req_applies: ['all'], expiry_warning_days: '60', probation_max_days: '90', weekly_hours_limit: '48' });
  });

  test('policy acknowledgements: require, acknowledge, and a new version asks again', async () => {
    const emp = await h.addMember(co.organizationId, 'employee');
    await h.knex('employees').where({ id: E.saudi_ok }).update({ user_id: emp.userId });
    const [policyId] = await h.knex('documents').insert({ organization_id: co.organizationId, category: 'policy', title: 'Code of conduct', visible_to_employee: true, current_version: 1 });
    let r = await owner.form(`/app/documents/${policyId}/require-ack`, { on: '1' });
    assert.equal(r.status, 302);
    assert.ok(await h.knex('notifications').where({ user_id: emp.userId, type: 'policy_ack_required' }).first());
    let res = await compliance.evaluate(ctx);
    assert.equal(byKey(res, 'policies').items.length, 1);
    const es = await h.login(emp.email, emp.password);
    assert.match((await es.get('/app')).text, /Code of conduct/);
    r = await es.form(`/app/documents/${policyId}/acknowledge`, {});
    assert.equal(r.status, 302);
    res = await compliance.evaluate(ctx);
    assert.equal(byKey(res, 'policies').status, 'pass');
    await h.knex('documents').where({ id: policyId }).update({ current_version: 2 });
    res = await compliance.evaluate(ctx);
    assert.equal(byKey(res, 'policies').items.length, 1, 'a new version needs a new acknowledgement');
    // Only company-wide policies, and only document managers
    const [personal] = await h.knex('documents').insert({ organization_id: co.organizationId, employee_id: E.expat, category: 'policy', title: 'Personal' });
    assert.equal((await owner.form(`/app/documents/${personal}/require-ack`, { on: '1' })).status, 409);
    assert.equal((await es.form(`/app/documents/${policyId}/require-ack`, { on: '0' })).status, 403);
  });

  test('permissions, plan gating, page and CSV', async () => {
    const page = await owner.get('/app/compliance');
    assert.equal(page.status, 200);
    assert.match(page.text, /Article 109/);
    const csvRes = await owner.get('/app/compliance?format=csv');
    assert.match(csvRes.headers['content-type'], /text\/csv/);
    assert.match(csvRes.text, /iqama|Iqama/);
    const hr = await h.addMember(co.organizationId, 'hr_manager');
    assert.equal((await (await h.login(hr.email, hr.password)).get('/app/compliance')).status, 200);
    const emp = await h.addMember(co.organizationId, 'employee');
    const es = await h.login(emp.email, emp.password);
    assert.equal((await es.get('/app/compliance')).status, 403);
    assert.equal((await es.form('/app/compliance/fix/annual-leave', {})).status, 403);
    const starter = await h.createCompany({ plan: 'starter' });
    const ss = await h.login(starter.email, starter.password);
    assert.equal((await ss.get('/app/compliance')).status, 402);
  });
});
