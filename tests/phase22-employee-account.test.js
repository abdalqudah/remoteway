// Sign-in accounts for employees with a temporary password set by a company admin, and the forced
// password change at first sign-in.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let co; let owner; let empId;
const pub = () => h.request.agent(h.getApp());
const csrfOf = (text) => text.match(/name="csrf-token" content="([^"]+)"/)[1];

before(async () => {
  await h.resetDatabase();
  co = await h.createCompany({ plan: 'business' });
  owner = await h.login(co.email, co.password);
  const [id] = await h.knex('employees').insert({ organization_id: co.organizationId, employee_number: 'E-100', first_name: 'Huda', last_name: 'Saleh', email: 'huda@co.test', joining_date: '2026-02-01' });
  empId = id;
});
after(async () => { await h.knex.destroy(); });

describe('Phase 22 — employee sign-in accounts with a temporary password', () => {
  test('admin creates the account; the password is shown once', async () => {
    const page = await owner.get(`/app/employees/${empId}`);
    assert.match(page.text, /id="account"/);
    assert.match(page.text, /value="huda@co.test"/);
    assert.equal((await owner.form(`/app/employees/${empId}/account`, { email: 'huda@co.test', role_id: '999999', password: 'Temp#1234', must_change: '1' })).status, 302);
    assert.equal((await h.knex('employees').where({ id: empId }).first()).user_id, null, 'bad role refused');
    assert.equal((await owner.form(`/app/employees/${empId}/account`, { email: 'huda@co.test', role_id: String((await h.knex('roles').whereNull('organization_id').where({ key: 'employee' }).first()).id), password: 'short', must_change: '1' })).status, 302);
    assert.equal((await h.knex('employees').where({ id: empId }).first()).user_id, null, 'short password refused');

    const roleId = (await h.knex('roles').whereNull('organization_id').where({ key: 'employee' }).first()).id;
    const r = await owner.form(`/app/employees/${empId}/account`, { email: 'huda@co.test', role_id: String(roleId), password: '', must_change: '1' });
    assert.equal(r.status, 302);
    const emp = await h.knex('employees').where({ id: empId }).first();
    assert.ok(emp.user_id);
    const u = await h.knex('users').where({ id: emp.user_id }).first();
    assert.equal(Boolean(u.must_change_password), true);
    assert.ok(await h.knex('memberships').where({ organization_id: co.organizationId, user_id: u.id }).first());
    const shown = await owner.get(`/app/employees/${empId}`);
    const pw = shown.text.match(/class="mono temp-password" dir="ltr">([^<]+)</)[1];
    assert.match(pw, /^[A-Za-z]{4}-\d{4}-[A-Za-z]{4}$/, 'generated, easy to read');
    assert.doesNotMatch((await owner.get(`/app/employees/${empId}`)).text, new RegExp(pw), 'shown only once');
    // A second account for the same employee is refused
    await owner.form(`/app/employees/${empId}/account`, { email: 'other@co.test', role_id: String(roleId) });
    assert.equal(await h.knex('users').where({ email: 'other@co.test' }).first(), undefined);
    return pw;
  });

  test('first sign-in: must choose a new password before anything else', async () => {
    const u = await h.knex('users').where({ email: 'huda@co.test' }).first();
    // Set a known temporary password through the admin
    await owner.form(`/app/employees/${empId}/password`, { password: 'Temp#2026x', must_change: '1' });
    const a = pub();
    let page = await a.get('/login');
    let r = await a.post('/login').type('form').send({ _csrf: csrfOf(page.text), email: 'huda@co.test', password: 'Temp#2026x' });
    assert.equal(r.status, 302);
    r = await a.get('/app');
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/security/new-password');
    assert.equal((await a.get('/app/leave')).headers.location, '/security/new-password');
    page = await a.get('/security/new-password');
    assert.equal(page.status, 200);
    const csrf = csrfOf(page.text);
    // Same as the temporary one, mismatch, too short → refused
    assert.equal((await a.post('/security/new-password').type('form').send({ _csrf: csrf, new_password: 'Temp#2026x', new_password_confirm: 'Temp#2026x' })).status, 422);
    assert.equal((await a.post('/security/new-password').type('form').send({ _csrf: csrf, new_password: 'MyOwn#Pass1', new_password_confirm: 'Different1' })).status, 422);
    r = await a.post('/security/new-password').type('form').send({ _csrf: csrf, new_password: 'MyOwn#Pass1', new_password_confirm: 'MyOwn#Pass1' });
    assert.equal(r.status, 302);
    assert.equal((await h.knex('users').where({ id: u.id }).first()).must_change_password, 0);
    assert.equal((await a.get('/app')).status, 200);
    // The new password works; the temporary one does not
    const b = pub();
    page = await b.get('/login');
    assert.equal((await b.post('/login').type('form').send({ _csrf: csrfOf(page.text), email: 'huda@co.test', password: 'Temp#2026x' })).status, 401);
    page = await b.get('/login');
    assert.equal((await b.post('/login').type('form').send({ _csrf: csrfOf(page.text), email: 'huda@co.test', password: 'MyOwn#Pass1' })).status, 302);
    // Without "must change", the admin's password is kept
    await owner.form(`/app/employees/${empId}/password`, { password: 'Kept#Pass22' });
    assert.equal((await h.knex('users').where({ id: u.id }).first()).must_change_password, 0);
  });

  test('limits: existing accounts, accounts used elsewhere, permissions', async () => {
    const roleId = String((await h.knex('roles').whereNull('organization_id').where({ key: 'employee' }).first()).id);
    // An email that already has a RemoteWay account → invite instead
    const [e2] = await h.knex('employees').insert({ organization_id: co.organizationId, employee_number: 'E-101', first_name: 'Owner', last_name: 'Copy', email: co.email, joining_date: '2026-02-01' });
    const r = await owner.form(`/app/employees/${e2}/account`, { email: co.email, role_id: roleId, password: 'Some#Pass1' });
    assert.equal(r.status, 302);
    assert.equal((await h.knex('employees').where({ id: e2 }).first()).user_id, null);
    // Someone who also works for another company: only they change their password
    const other = await h.createCompany({ plan: 'business' });
    const outsider = await h.addMember(other.organizationId, 'employee');
    await h.knex('memberships').insert({ organization_id: co.organizationId, user_id: outsider.userId });
    const [e3] = await h.knex('employees').insert({ organization_id: co.organizationId, employee_number: 'E-102', first_name: 'Out', last_name: 'Sider', email: outsider.email, user_id: outsider.userId, joining_date: '2026-02-01' });
    assert.match((await owner.get(`/app/employees/${e3}`)).text, /outside your company|خارج منشأتك/);
    const before = (await h.knex('users').where({ id: outsider.userId }).first()).password_hash;
    await owner.form(`/app/employees/${e3}/password`, { password: 'Hijack#123' });
    assert.equal((await h.knex('users').where({ id: outsider.userId }).first()).password_hash, before);
    // Without users.manage: no panel, no access
    const mgr = await h.addMember(co.organizationId, 'employee');
    const m = await h.login(mgr.email, mgr.password);
    assert.equal((await m.form(`/app/employees/${empId}/password`, { password: 'Hijack#123' })).status, 403);
  });
});
