const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

describe('tenant isolation', () => {
  let A; let B; let a; let b; let bEmployeeId; let bDepartmentId;

  before(async () => {
    await h.resetDatabase();
    A = await h.createCompany({ plan: 'professional', name: 'Company A' });
    B = await h.createCompany({ plan: 'professional', name: 'Company B' });
    a = await h.login(A.email, A.password);
    b = await h.login(B.email, B.password);
    const dep = await b.api('post', '/api/v1/departments', { name: 'B Secret Dept' });
    bDepartmentId = dep.body.data.id;
    const emp = await h.createEmployee(b, { first_name: 'Bob', last_name: 'FromB', department_id: bDepartmentId, base_salary: 9999 });
    assert.equal(emp.status, 201);
    bEmployeeId = emp.body.data.id;
  });
  after(() => h.knex.destroy());

  test('Company A cannot read a Company B employee (API)', async () => {
    const res = await a.api('get', `/api/v1/employees/${bEmployeeId}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  test('Company A cannot see Company B employees in lists or search', async () => {
    const list = await a.api('get', '/api/v1/employees?status=');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.some((e) => e.id === bEmployeeId), false);
    const search = await a.api('get', '/api/v1/search?q=FromB');
    assert.deepEqual(search.body.data.employees, []);
    const depts = await a.api('get', '/api/v1/departments');
    assert.equal(depts.body.data.some((d) => d.id === bDepartmentId), false);
  });

  test('Company A cannot open, edit, terminate or delete a Company B employee (web)', async () => {
    assert.equal((await a.get(`/app/employees/${bEmployeeId}`)).status, 404);
    assert.equal((await a.get(`/app/employees/${bEmployeeId}/edit`)).status, 404);
    await a.form(`/app/employees/${bEmployeeId}`, { first_name: 'Hacked', last_name: 'X' });
    await a.form(`/app/employees/${bEmployeeId}/terminate`, {});
    await a.form(`/app/employees/${bEmployeeId}/delete`, {});
    const row = await h.knex('employees').where({ id: bEmployeeId }).first();
    assert.equal(row.first_name, 'Bob');
    assert.equal(row.status, 'active');
  });

  test('Company A cannot modify or delete Company B via API', async () => {
    assert.equal((await a.api('patch', `/api/v1/employees/${bEmployeeId}`, { first_name: 'X' })).status, 404);
    assert.equal((await a.api('delete', `/api/v1/employees/${bEmployeeId}`)).status, 404);
    assert.equal((await a.api('delete', `/api/v1/departments/${bDepartmentId}`)).status, 404);
  });

  test('Company A cannot reference Company B records as foreign keys', async () => {
    const res = await h.createEmployee(a, { department_id: bDepartmentId, manager_id: bEmployeeId });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.department_id);
  });

  test('Company A cannot switch into Company B', async () => {
    await a.form('/organizations/switch', { organization_id: B.organizationId });
    const me = await a.api('get', '/api/v1/organizations/current');
    assert.equal(me.body.data.id, A.organizationId);
  });

  test('API tokens are bound to their own organization', async () => {
    const token = await h.apiToken(A.organizationId, A.userId);
    const api = h.bearer(token);
    assert.equal((await api.call('get', `/api/v1/employees/${bEmployeeId}`)).status, 404);
    const cur = await api.call('get', '/api/v1/organizations/current');
    assert.equal(cur.body.data.id, A.organizationId);
  });

  test('audit logs and invoices are tenant-scoped', async () => {
    const page = await a.get('/app/settings/audit');
    assert.equal(page.status, 200);
    assert.equal(page.text.includes('Bob'), false);
    const inv = await h.knex('invoices').insert({
      organization_id: B.organizationId, number: 'RW-TEST-1', issue_date: new Date(), due_date: new Date(), currency: 'SAR', subtotal: 1, total: 1,
    });
    assert.equal((await a.get(`/app/billing/invoices/${inv[0]}`)).status, 404);
  });
});
