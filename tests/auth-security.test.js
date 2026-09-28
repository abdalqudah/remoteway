const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

describe('authentication & web security', () => {
  before(() => h.resetDatabase());
  after(() => h.knex.destroy());

  test('signup creates user, organization, owner role and trial', async () => {
    const agent = h.request.agent(h.getApp());
    const page = await agent.get('/signup');
    assert.equal(page.status, 200);
    const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    const res = await agent.post('/signup').type('form').send({
      _csrf: csrf, name: 'Aisha Test', email: 'Aisha@Example.com', password: 'Secret#1234', company_name: 'Acme KSA', country_code: 'SA', plan: 'business', terms: 'on',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/app/onboarding');
    const user = await h.knex('users').where({ email: 'aisha@example.com' }).first();
    assert.ok(user);
    assert.notEqual(user.password_hash, 'Secret#1234');
    const org = await h.knex('organizations').where({ owner_user_id: user.id }).first();
    assert.equal(org.currency, 'SAR');
    const sub = await h.knex('subscriptions').where({ organization_id: org.id }).first();
    assert.equal(sub.status, 'trial');
    const perms = await agent.get('/api/v1/organizations/current');
    assert.ok(perms.body.data.permissions.includes('billing.manage'));
  });

  test('duplicate email is rejected with a stable error code', async () => {
    await h.createCompany();
    const agent = h.request.agent(h.getApp());
    const page = await agent.get('/signup');
    const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    const existing = await h.knex('users').first();
    const res = await agent.post('/signup').type('form').send({
      _csrf: csrf, name: 'Dup', email: existing.email, password: 'Secret#1234', company_name: 'Dup Co', country_code: 'SA', plan: 'business', terms: 'on',
    });
    assert.equal(res.status, 409);
  });

  test('wrong password is refused', async () => {
    const c = await h.createCompany();
    const agent = h.request.agent(h.getApp());
    const page = await agent.get('/login');
    const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    const res = await agent.post('/login').type('form').send({ _csrf: csrf, email: c.email, password: 'nope-nope' });
    assert.equal(res.status, 401);
  });

  test('state-changing requests without a CSRF token are refused', async () => {
    const c = await h.createCompany();
    const s = await h.login(c.email, c.password);
    const res = await s.agent.post('/api/v1/employees').set('accept', 'application/json').send({ first_name: 'A', last_name: 'B' });
    assert.equal(res.status, 419);
    assert.equal(res.body.error.code, 'CSRF_TOKEN_INVALID');
  });

  test('unauthenticated access is refused', async () => {
    const app = h.getApp();
    assert.equal((await h.request(app).get('/api/v1/employees')).status, 401);
    const web = await h.request(app).get('/app/employees');
    assert.equal(web.status, 302);
    assert.equal(web.headers.location, '/login');
    assert.equal((await h.request(app).get('/api/v1/employees').set('authorization', 'Bearer rw_invalid')).status, 401);
  });

  test('revoked API tokens stop working', async () => {
    const c = await h.createCompany({ plan: 'professional' });
    const token = await h.apiToken(c.organizationId, c.userId);
    assert.equal((await h.bearer(token).call('get', '/api/v1/employees')).status, 200);
    await h.knex('api_tokens').update({ revoked_at: new Date() });
    assert.equal((await h.bearer(token).call('get', '/api/v1/employees')).status, 401);
  });

  test('invitation flow joins the workspace with the chosen role and respects user limits', async () => {
    const c = await h.createCompany({ plan: 'starter' }); // 5 users
    const s = await h.login(c.email, c.password);
    const role = await h.knex('roles').whereNull('organization_id').where({ key: 'hr_manager' }).first();
    const res = await s.form('/app/settings/users/invite', { email: 'new.hr@test.local', role_id: role.id });
    assert.equal(res.status, 302);
    const page = await s.get('/app/settings/users');
    const link = page.text.match(/\/invite\/([A-Za-z0-9_-]+)/)[1];
    const guest = h.request.agent(h.getApp());
    const inv = await guest.get(`/invite/${link}`);
    const csrf = inv.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    const accept = await guest.post(`/invite/${link}`).type('form').send({ _csrf: csrf, name: 'New HR', password: 'Secret#1234' });
    assert.equal(accept.status, 302);
    const me = await guest.get('/api/v1/organizations/current');
    assert.equal(me.body.data.id, c.organizationId);
    assert.ok(me.body.data.permissions.includes('employees.create'));
    // token cannot be reused
    assert.equal((await guest.get(`/invite/${link}`)).status, 404);
    // 1 owner + 1 HR; 3 more invites fill the 5-user limit; the next is refused
    for (let i = 0; i < 3; i += 1) assert.equal((await s.form('/app/settings/users/invite', { email: `u${i}@test.local`, role_id: role.id })).status, 302);
    const over = await s.form('/app/settings/users/invite', { email: 'over@test.local', role_id: role.id });
    assert.equal(over.status, 402);
  });

  test('security headers are set', async () => {
    const res = await h.request(h.getApp()).get('/');
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(res.headers['x-powered-by'], undefined);
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  });
});
