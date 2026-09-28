const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

describe('subscription engine & employee limits', () => {
  before(() => h.resetDatabase());
  after(() => h.knex.destroy());

  test('backend blocks the employee over the plan limit (Starter = 10)', async () => {
    const c = await h.createCompany({ plan: 'starter' });
    const s = await h.login(c.email, c.password);
    const ids = [];
    for (let i = 0; i < 10; i += 1) {
      const r = await h.createEmployee(s);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      ids.push(r.body.data.id);
    }
    const over = await h.createEmployee(s);
    assert.equal(over.status, 402);
    assert.equal(over.body.success, false);
    assert.equal(over.body.error.code, 'EMPLOYEE_LIMIT_REACHED');
    assert.deepEqual(over.body.error.details, { limit: 'employees', current: 10, max: 10 });

    // The web form shows the limit message and upgrade path instead of creating the record.
    const web = await s.form('/app/employees', { first_name: 'Web', last_name: 'Over' });
    assert.equal(web.status, 402);
    assert.match(web.text, /employee limit/i);
    const [{ n }] = await h.knex('employees').where({ organization_id: c.organizationId }).count({ n: '*' });
    assert.equal(Number(n), 10);

    // Terminating frees a seat.
    await s.api('post', `/api/v1/employees/${ids[0]}/terminate`, {});
    assert.equal((await h.createEmployee(s)).status, 201);
    // ...and reactivating when full is blocked.
    const re = await s.form(`/app/employees/${ids[0]}/reactivate`, {});
    assert.equal(re.status, 302);
    assert.equal((await h.knex('employees').where({ id: ids[0] }).first()).status, 'terminated');
  });

  test('concurrent creates cannot exceed the limit', async () => {
    const c = await h.createCompany({ plan: 'starter' });
    const s = await h.login(c.email, c.password);
    for (let i = 0; i < 8; i += 1) await h.createEmployee(s);
    const results = await Promise.all(Array.from({ length: 6 }, () => h.createEmployee(s)));
    assert.equal(results.filter((r) => r.status === 201).length, 2);
    const [{ n }] = await h.knex('employees').where({ organization_id: c.organizationId }).count({ n: '*' });
    assert.equal(Number(n), 10);
  });

  test('extra-employees add-on raises the limit', async () => {
    const c = await h.createCompany({ plan: 'starter' });
    const s = await h.login(c.email, c.password);
    for (let i = 0; i < 10; i += 1) await h.createEmployee(s);
    assert.equal((await h.createEmployee(s)).status, 402);
    const add = await s.form('/app/billing/addons', { addon: 'extra_employees', quantity: 1 });
    assert.equal(add.status, 302);
    assert.equal((await h.createEmployee(s)).status, 201);
    const sub = await s.api('get', '/api/v1/subscription');
    assert.equal(sub.body.data.limits.employees, 20);
    assert.equal(sub.body.data.usage.employees, 11);
    // Removing the add-on below current usage is refused.
    const remove = await s.form('/app/billing/addons', { addon: 'extra_employees', quantity: 0 });
    assert.equal(remove.status, 409);
  });

  test('downgrade is refused when usage exceeds the target plan', async () => {
    const c = await h.createCompany({ plan: 'business' });
    const s = await h.login(c.email, c.password);
    for (let i = 0; i < 11; i += 1) await h.createEmployee(s);
    const res = await s.form('/app/billing/plan', { plan: 'starter', cycle: 'monthly' });
    assert.equal(res.status, 409);
    assert.match(res.text, /exceeds the limits|PLAN_LIMIT_BELOW_USAGE|current usage/i);
    const ok = await s.form('/app/billing/plan', { plan: 'professional', cycle: 'yearly' });
    assert.equal(ok.status, 302);
    const sub = await h.knex('subscriptions').where({ organization_id: c.organizationId }).first();
    assert.equal(sub.billing_cycle, 'yearly');
    assert.equal(sub.status, 'trial');
  });

  test('expired trial makes the workspace read-only', async () => {
    const c = await h.createCompany({ plan: 'business' });
    const s = await h.login(c.email, c.password);
    await h.knex('subscriptions').where({ organization_id: c.organizationId }).update({ trial_ends_at: new Date(Date.now() - 1000) });
    h.cache.clear();
    const res = await h.createEmployee(s);
    assert.equal(res.status, 402);
    assert.equal(res.body.error.code, 'SUBSCRIPTION_INACTIVE');
    assert.equal((await s.get('/app')).status, 200);
  });

  test('activation invoice + super admin payment activates the subscription with VAT', async () => {
    const c = await h.createCompany({ plan: 'business' });
    const s = await h.login(c.email, c.password);
    const act = await s.form('/app/billing/activate', {});
    assert.equal(act.status, 302);
    const invoice = await h.knex('invoices').where({ organization_id: c.organizationId }).first();
    assert.equal(Number(invoice.subtotal), 699);
    assert.equal(Number(invoice.tax_rate), 15);
    assert.equal(Number(invoice.total), 803.85);

    await h.knex('users').insert({ name: 'Root', email: 'root@test.local', password_hash: require('bcryptjs').hashSync('Password#123', 4), is_super_admin: true });
    const admin = h.request.agent(h.getApp());
    const lp = await admin.get('/login');
    const csrf = lp.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    await admin.post('/login').type('form').send({ _csrf: csrf, email: 'root@test.local', password: 'Password#123' });
    const page = await admin.get('/admin/invoices');
    const token = page.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    const paid = await admin.post(`/admin/invoices/${invoice.id}/paid`).type('form').send({ _csrf: token, reference: 'TRX-1' });
    assert.equal(paid.status, 302);
    const sub = await h.knex('subscriptions').where({ organization_id: c.organizationId }).first();
    assert.equal(sub.status, 'active');
    assert.ok(sub.current_period_end > new Date());
  });

  test('pricing is dynamic from the database', async () => {
    await h.knex('plans').where({ key: 'starter' }).update({ price_monthly: 123 });
    const res = await h.request(h.getApp()).get('/api/v1/plans');
    assert.equal(res.body.data.find((p) => p.key === 'starter').price_monthly, 123);
    const page = await h.request(h.getApp()).get('/pricing');
    assert.match(page.text, /123/);
  });

  test('features outside the plan are refused (API on Starter)', async () => {
    const c = await h.createCompany({ plan: 'starter' });
    const token = await h.apiToken(c.organizationId, c.userId);
    const res = await h.bearer(token).call('get', '/api/v1/employees');
    assert.equal(res.status, 402);
    assert.equal(res.body.error.code, 'FEATURE_NOT_IN_PLAN');
  });

  test('API calls are metered on plans with API access', async () => {
    const c = await h.createCompany({ plan: 'professional' });
    const token = await h.apiToken(c.organizationId, c.userId);
    for (let i = 0; i < 3; i += 1) assert.equal((await h.bearer(token).call('get', '/api/v1/employees')).status, 200);
    const row = await h.knex('usage_records').where({ organization_id: c.organizationId, metric: 'api_calls' }).first();
    assert.equal(Number(row.quantity), 3);
  });
});
