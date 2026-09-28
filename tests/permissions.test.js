const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

describe('RBAC & data scoping', () => {
  let C; let owner; let managerEmp; let reportEmp; let otherEmp;

  before(async () => {
    await h.resetDatabase();
    C = await h.createCompany({ plan: 'professional' });
    owner = await h.login(C.email, C.password);
  });
  after(() => h.knex.destroy());

  test('employee role cannot manage people or billing', async () => {
    const u = await h.addMember(C.organizationId, 'employee');
    const s = await h.login(u.email, u.password);
    assert.equal((await h.createEmployee(s)).status, 403);
    assert.equal((await s.api('get', '/api/v1/employees')).status, 403);
    assert.equal((await s.get('/app/billing')).status, 403);
    assert.equal((await s.get('/app/settings/users')).status, 403);
    const denied = await s.api('get', '/api/v1/subscription');
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  });

  test('manager sees only their reporting line', async () => {
    const m = await h.addMember(C.organizationId, 'department_manager');
    managerEmp = (await h.createEmployee(owner, { first_name: 'Mgr', email: m.email })).body.data;
    reportEmp = (await h.createEmployee(owner, { first_name: 'Direct', manager_id: managerEmp.id })).body.data;
    const indirect = (await h.createEmployee(owner, { first_name: 'Indirect', manager_id: reportEmp.id })).body.data;
    otherEmp = (await h.createEmployee(owner, { first_name: 'Outsider' })).body.data;
    const s = await h.login(m.email, m.password);
    const list = await s.api('get', '/api/v1/employees');
    assert.equal(list.status, 200);
    const ids = list.body.data.map((e) => e.id).sort();
    assert.deepEqual(ids, [managerEmp.id, reportEmp.id, indirect.id].sort());
    assert.equal((await s.api('get', `/api/v1/employees/${otherEmp.id}`)).status, 404);
    assert.equal((await s.get(`/app/employees/${otherEmp.id}`)).status, 404);
  });

  test('salary is hidden without employees.view_salary', async () => {
    await h.createEmployee(owner, { first_name: 'Paid', base_salary: 12000 });
    const r = await h.addMember(C.organizationId, 'recruiter');
    const s = await h.login(r.email, r.password);
    const list = await s.api('get', '/api/v1/employees');
    assert.equal(list.status, 200);
    assert.ok(list.body.data.length > 0);
    assert.ok(list.body.data.every((e) => !('base_salary' in e)));
    const ownerList = await owner.api('get', '/api/v1/employees?q=Paid');
    assert.equal(ownerList.body.data[0].base_salary, 12000);
  });

  test('HR manager can create but not change billing', async () => {
    const u = await h.addMember(C.organizationId, 'hr_manager');
    const s = await h.login(u.email, u.password);
    assert.equal((await h.createEmployee(s)).status, 201);
    assert.equal((await s.form('/app/billing/plan', { plan: 'starter', cycle: 'monthly' })).status, 403);
  });

  test('custom roles require the custom_roles feature (Enterprise)', async () => {
    const res = await owner.form('/app/settings/roles', { name: 'Auditor', permissions: ['audit.view'] });
    assert.equal(res.status, 402);
    const count = await h.knex('roles').where({ organization_id: C.organizationId }).count({ n: '*' });
    assert.equal(Number(count[0].n), 0);
  });

  test('owner role is protected', async () => {
    const admin = await h.addMember(C.organizationId, 'admin');
    const s = await h.login(admin.email, admin.password);
    const emp = await h.knex('roles').whereNull('organization_id').where({ key: 'employee' }).first();
    const res = await s.form(`/app/settings/users/${C.userId}/role`, { role_id: emp.id });
    assert.equal(res.status, 409);
    const disable = await s.form(`/app/settings/users/${C.userId}/status`, { status: 'disabled' });
    assert.equal(disable.status, 409);
  });

  test('disabled members lose access immediately', async () => {
    const u = await h.addMember(C.organizationId, 'hr_manager');
    const s = await h.login(u.email, u.password);
    assert.equal((await s.api('get', '/api/v1/employees')).status, 200);
    await owner.form(`/app/settings/users/${u.userId}/status`, { status: 'disabled' });
    const after = await s.api('get', '/api/v1/employees');
    assert.equal(after.status, 403);
  });

  test('sensitive changes are audit logged with old and new values', async () => {
    const e = (await h.createEmployee(owner, { first_name: 'Salary', base_salary: 7000 })).body.data;
    await owner.api('patch', `/api/v1/employees/${e.id}`, { base_salary: 8000 });
    const log = await h.knex('audit_logs').where({ organization_id: C.organizationId, action: 'employee.updated', entity_id: String(e.id) }).first();
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    assert.equal(Number(parse(log.old_values).base_salary), 7000);
    assert.equal(Number(parse(log.new_values).base_salary), 8000);
    assert.equal(log.user_id, C.userId);
  });
});
