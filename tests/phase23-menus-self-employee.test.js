// The sidebar shows what applies to the person; owners choose whether they also work as employees.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let co; let owner;
const nav = (html) => (html.match(/<nav class="nav"[\s\S]*?<\/nav>/) || [''])[0];

before(async () => {
  await h.resetDatabase();
  co = await h.createCompany({ plan: 'enterprise' });
  owner = await h.login(co.email, co.password);
});
after(async () => { await h.knex.destroy(); });

describe('Phase 23 — menus that fit the person, owner as employee or not', () => {
  test('a plain employee sees only their own things', async () => {
    const e = await h.addMember(co.organizationId, 'employee');
    await h.knex('employees').insert({ organization_id: co.organizationId, employee_number: 'E-1', first_name: 'Sami', last_name: 'K', email: e.email, user_id: e.userId, joining_date: '2026-01-01' });
    const s = await h.login(e.email, e.password);
    const menu = nav((await s.get('/app')).text);
    for (const hidden of ['/app/recruitment', '/app/talent', '/app/employee-onboarding', '/app/payroll"', '/app/modules/payway', '/app/billing']) assert.ok(!menu.includes(`href="${hidden.replace('"', '')}"`) || hidden.endsWith('"') && !menu.includes(`href="${hidden}`), hidden);
    assert.doesNotMatch(menu, /\/app\/recruitment\/interviews/, 'no interviews → no "My interviews"');
    for (const shown of ['/app/attendance', '/app/leave', '/app/performance', '/app/learning', '/app/payroll/my']) assert.match(menu, new RegExp(`href="${shown}"`), shown);
    assert.doesNotMatch(menu, /is-soon/, 'locked modules are not shown to employees');
    // Once they interview a candidate, "My interviews" appears
    const [jobId] = await h.knex('jobs').insert({ organization_id: co.organizationId, title: 'Dev', slug: 'dev', status: 'open' });
    const [candId] = await h.knex('candidates').insert({ organization_id: co.organizationId, first_name: 'C', last_name: 'D', email: 'c@d.test' });
    const [appId] = await h.knex('applications').insert({ organization_id: co.organizationId, job_id: jobId, candidate_id: candId });
    await h.knex('interviews').insert({ organization_id: co.organizationId, application_id: appId, scheduled_at: new Date(), interviewer_user_id: e.userId });
    assert.match(nav((await s.get('/app')).text), /\/app\/recruitment\/interviews/);
  });

  test('the owner chooses: not an employee → no personal items; employee → linked record', async () => {
    let page = await owner.get('/app/settings/account');
    assert.match(page.text, /id="as-employee"/);
    assert.equal(await h.knex('employees').where({ organization_id: co.organizationId, user_id: co.userId }).first(), undefined);
    let menu = nav((await owner.get('/app')).text);
    assert.doesNotMatch(menu, /\/app\/payroll\/my/, 'no payslips for a non-employee owner');
    // Leave opens on what they manage, without "my leave"
    const leave = await owner.get('/app/leave');
    assert.doesNotMatch(leave.text, /href="\?tab=mine"/);
    // Become an employee
    assert.equal((await owner.form('/app/settings/account/employee', { employee: '1' })).status, 302);
    const rec = await h.knex('employees').where({ organization_id: co.organizationId, user_id: co.userId }).first();
    assert.ok(rec);
    menu = nav((await owner.get('/app')).text);
    assert.match(menu, /\/app\/payroll\/my/);
    assert.match((await owner.get('/app/leave')).text, /href="\?tab=mine"/);
    assert.match((await owner.get('/app')).text, /name="action" value="in"|attendance\/scan/, 'clock-in on the dashboard');
    // Stop being an employee: unlinked, record kept
    assert.equal((await owner.form('/app/settings/account/employee', { employee: '0' })).status, 302);
    assert.equal((await h.knex('employees').where({ id: rec.id }).first()).user_id, null);
    assert.doesNotMatch((await owner.get('/app')).text, /name="action" value="in"/);
    // Again: the existing record with the owner's email is reused, not duplicated
    await owner.form('/app/settings/account/employee', { employee: '1' });
    assert.equal((await h.knex('employees').where({ organization_id: co.organizationId, email: co.email })).length, 1);
    // A plain employee cannot use the switch
    const e2 = await h.addMember(co.organizationId, 'employee');
    const s2 = await h.login(e2.email, e2.password);
    page = await s2.get('/app/settings/account');
    assert.doesNotMatch(page.text, /id="as-employee"/);
    await s2.form('/app/settings/account/employee', { employee: '1' });
    assert.equal(await h.knex('employees').where({ organization_id: co.organizationId, user_id: e2.userId }).first(), undefined);
  });
});
