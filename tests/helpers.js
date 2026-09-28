// Test harness: a real MySQL/MariaDB test database (DB_NAME_TEST), rebuilt once per test file.
process.env.NODE_ENV = 'test';
process.env.STORAGE_PATH = require('path').join(require('os').tmpdir(), `remoteway-test-storage-${process.pid}`);
const request = require('supertest');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const { createApp } = require('../src/app');
const { seedReference } = require('../src/db/seed-reference');
const orgs = require('../src/modules/organizations/organization.service');

let app;

async function resetDatabase() {
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  const [tables] = await knex.raw('SHOW TABLES');
  for (const row of tables) await knex.schema.dropTableIfExists(Object.values(row)[0]);
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
  await knex.migrate.latest();
  await seedReference(knex);
  cache.clear();
  app = createApp();
  return app;
}

let seq = 0;
async function createCompany({ plan = 'business', name } = {}) {
  seq += 1;
  const email = `owner${seq}-${Date.now()}@test.local`;
  const password = 'Password#123';
  const { userId, organizationId } = await orgs.registerCompany({
    account: { name: `Owner ${seq}`, email, password },
    company: { name: name || `Company ${seq}`, country_code: 'SA' },
    planKey: plan,
  });
  await orgs.completeOnboarding({ organizationId });
  return { userId, organizationId, email, password };
}

async function addMember(organizationId, roleKey, { email } = {}) {
  seq += 1;
  const bcrypt = require('bcryptjs');
  const mail = email || `${roleKey}${seq}-${Date.now()}@test.local`;
  const [userId] = await knex('users').insert({ name: `${roleKey} ${seq}`, email: mail, password_hash: await bcrypt.hash('Password#123', 4) });
  await knex('memberships').insert({ organization_id: organizationId, user_id: userId });
  const role = await knex('roles').whereNull('organization_id').where({ key: roleKey }).first();
  await knex('user_roles').insert({ organization_id: organizationId, user_id: userId, role_id: role.id });
  cache.clear();
  return { userId, email: mail, password: 'Password#123' };
}

/** Browser-like agent: keeps cookies and knows the CSRF token. */
async function login(email, password) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)[1];
  const res = await agent.post('/login').type('form').send({ _csrf: csrf, email, password });
  if (res.status !== 302) throw new Error(`login failed: ${res.status}`);
  const home = await agent.get('/app').redirects(3);
  const token = (home.text.match(/name="csrf-token" content="([^"]+)"/) || [])[1] || csrf;
  return {
    agent,
    csrf: token,
    get: (url) => agent.get(url),
    api: (method, url, body) => agent[method](url).set('x-csrf-token', token).set('accept', 'application/json').send(body),
    form: (url, body) => agent.post(url).type('form').send({ _csrf: token, ...body }),
  };
}

async function apiToken(organizationId, userId) {
  const auth = require('../src/modules/auth/auth.service');
  const { token } = await auth.createApiToken({ organizationId, userId }, 'test');
  return token;
}

function bearer(token) {
  return {
    call: (method, url, body) => request(app)[method](url).set('authorization', `Bearer ${token}`).send(body),
  };
}

async function createEmployee(session, data = {}) {
  seq += 1;
  return session.api('post', '/api/v1/employees', { first_name: 'Emp', last_name: `N${seq}`, ...data });
}

module.exports = { knex, cache, resetDatabase, createCompany, addMember, login, apiToken, bearer, createEmployee, getApp: () => app, request };
