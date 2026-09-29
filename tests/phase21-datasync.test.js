// Copy of a company's data to its own database (white label). Uses a second local MariaDB database and
// user (rw_client_sync / rw_client) standing in for the company's server; skipped when it does not exist.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const knexFactory = require('knex');
const h = require('./helpers');
const sync = require('../src/modules/organizations/datasync.service');

const TARGET = { host: process.env.DB_HOST || '127.0.0.1', port: 3306, database_name: 'rw_client_sync', username: 'rw_client', password: 'clientpass' };
let target; let reachable = false;
let co; let cs; let other;

before(async () => {
  await h.resetDatabase();
  target = knexFactory({ client: 'mysql2', connection: { host: TARGET.host, port: TARGET.port, user: TARGET.username, password: TARGET.password, database: TARGET.database_name }, pool: { min: 0, max: 1 } });
  try {
    await target.raw('select 1');
    reachable = true;
    for (const t of await target.raw("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'rw_client_sync'").then((r) => r[0])) await target.schema.dropTableIfExists(t.n || t.TABLE_NAME);
  } catch { reachable = false; }
  co = await h.createCompany({ plan: 'enterprise' });
  cs = await h.login(co.email, co.password);
  other = await h.createCompany({ plan: 'enterprise' });
  const add = (orgId, first, extra = {}) => h.knex('employees').insert({ organization_id: orgId, employee_number: `E-${first}`, first_name: first, last_name: 'Test', email: `${first.toLowerCase()}${Date.now()}@co.test`, joining_date: '2026-01-15', base_salary: 9000, ...extra });
  await add(co.organizationId, 'Sara');
  await add(co.organizationId, 'Omar');
  await add(co.organizationId, 'Lina');
  await add(other.organizationId, 'Stranger');
});
after(async () => { delete process.env.INTEGRATIONS_ALLOW_PRIVATE; if (target) await target.destroy(); await h.knex.destroy(); });

const body = (extra = {}) => ({ driver: 'mysql', host: TARGET.host, port: String(TARGET.port), database_name: TARGET.database_name, username: TARGET.username, password: TARGET.password, table_prefix: 'rw_', frequency: 'hourly', enabled: '1', datasets: ['employees', 'salaries', 'attendance', 'leave'], ...extra });

describe('Phase 21 — copy of company data to its own database', () => {
  test('white label only; validation; internal addresses refused', async () => {
    const basic = await h.createCompany({ plan: 'business' });
    const bs = await h.login(basic.email, basic.password);
    assert.match((await bs.get('/app/settings/database')).text, /datasync|white label|الوايت ليبل/i);
    assert.equal((await bs.form('/app/settings/database', body())).status, 402);

    assert.equal((await cs.form('/app/settings/database', body({ host: 'bad host!', table_prefix: 'Bad-', datasets: [] }))).status, 422);
    delete process.env.INTEGRATIONS_ALLOW_PRIVATE;
    const r = await cs.form('/app/settings/database', body());
    assert.equal(r.status, 302, 'saved');
    const t = await sync.test({ organizationId: co.organizationId });
    assert.equal(t.ok, false);
    assert.match(t.error, /not reachable from RemoteWay/);
    const row = await h.knex('organization_data_sync').where({ organization_id: co.organizationId }).first();
    assert.ok(row.password_enc && !row.password_enc.includes('clientpass'), 'password stored encrypted');
    assert.equal(row.verified_at, null);
  });

  test('connects, creates prefixed tables, copies only this company, keeps up with changes', async (t) => {
    if (!reachable) return t.skip();
    process.env.INTEGRATIONS_ALLOW_PRIVATE = 'true';
    // Wrong password: saved, but the page says the connection failed
    await cs.form('/app/settings/database', body({ password: 'wrong' }));
    let page = await cs.get('/app/settings/database');
    assert.match(page.text, /username or password was refused|اسم المستخدم أو كلمة المرور/);
    await cs.form('/app/settings/database', body());
    assert.ok((await h.knex('organization_data_sync').where({ organization_id: co.organizationId }).first()).verified_at);

    assert.equal((await cs.form('/app/settings/database/run', {})).status, 302);
    const emps = await target('rw_employees').select('*').orderBy('id');
    assert.deepEqual(emps.map((e) => e.first_name), ['Sara', 'Omar', 'Lina'], 'only this company');
    assert.equal(emps[0].joining_date instanceof Date ? emps[0].joining_date.toISOString().slice(0, 10) : String(emps[0].joining_date).slice(0, 10), '2026-01-15');
    assert.equal(emps[0].base_salary, undefined, 'salaries are a separate choice');
    assert.equal(Number((await target('rw_employee_salaries').first()).base_salary), 9000);
    for (const tb of ['rw_departments', 'rw_locations', 'rw_attendance', 'rw_leave_types', 'rw_leave_requests', 'rw_leave_balances', 'rw_sync_info']) assert.ok(await target.schema.hasTable(tb), tb);
    assert.equal(await target.schema.hasTable('rw_payslips'), false, 'payroll was not chosen');
    const info = await target('rw_sync_info').first();
    assert.equal(JSON.parse(info.tables).employees, 3);

    // Changes and deletions follow; a column a newer version adds is created
    await h.knex('employees').where({ organization_id: co.organizationId, first_name: 'Omar' }).del();
    await h.knex('employees').where({ organization_id: co.organizationId, first_name: 'Sara' }).update({ job_title: 'HR Lead' });
    await target.schema.alterTable('rw_employees', (tb) => tb.dropColumn('nationality'));
    const r = await sync.run(co.organizationId, { trigger: 'manual' });
    assert.equal(r.ok, true, r.error);
    const after2 = await target('rw_employees').orderBy('id');
    assert.deepEqual(after2.map((e) => e.first_name), ['Sara', 'Lina']);
    assert.equal(after2[0].job_title, 'HR Lead');
    assert.ok(await target.schema.hasColumn('rw_employees', 'nationality'));
    // Tables with other names in the company's database are never touched
    await target.schema.createTable('their_own_table', (tb) => { tb.integer('id'); });
    await sync.run(co.organizationId);
    assert.ok(await target.schema.hasTable('their_own_table'));
    await target.schema.dropTable('their_own_table');

    // Log and status on the page
    page = await cs.get('/app/settings/database');
    assert.match(page.text, /rw_employees: 2/);
    assert.ok((await h.knex('data_sync_runs').where({ organization_id: co.organizationId, status: 'ok' })).length >= 3);

    // Scheduled copies: due ones run, then wait an hour
    await h.knex('organization_data_sync').where({ organization_id: co.organizationId }).update({ next_run_at: new Date(Date.now() - 1000) });
    assert.equal(await sync.runDue(), 1);
    const cfg = await h.knex('organization_data_sync').where({ organization_id: co.organizationId }).first();
    assert.ok(new Date(cfg.next_run_at).getTime() > Date.now() + 50 * 60_000);
    assert.equal(await sync.runDue(), 0);
    const last = await h.knex('data_sync_runs').where({ organization_id: co.organizationId }).orderBy('id', 'desc').first();
    assert.equal(last.trigger, 'schedule');

    // One copy at a time
    await h.knex('organization_data_sync').where({ organization_id: co.organizationId }).update({ running_since: new Date() });
    await assert.rejects(sync.run(co.organizationId), /already running/);
    await h.knex('organization_data_sync').where({ organization_id: co.organizationId }).update({ running_since: null });
  });

  test('payroll and salaries need the permission; members without settings access are refused', async () => {
    const hr = await h.addMember(co.organizationId, 'employee');
    const s = await h.login(hr.email, hr.password);
    assert.equal((await s.get('/app/settings/database')).status, 403);
    const perms = new Set(['organization.manage']);
    const list = await sync.available({ organizationId: co.organizationId, permissions: perms });
    assert.ok(list.includes('employees'));
    assert.ok(!list.includes('payroll') && !list.includes('salaries'));
    // Saving without payroll permission keeps the owner's payroll choice
    await h.knex('organization_data_sync').where({ organization_id: co.organizationId }).update({ datasets: JSON.stringify(['employees', 'payroll']) });
    await sync.save({ organizationId: co.organizationId, userId: co.userId, permissions: perms }, body({ password: '', datasets: ['employees', 'tasks'] }));
    const ds = (await sync.get(co.organizationId)).datasets;
    assert.ok(ds.includes('payroll') && ds.includes('tasks'));
    // Disconnect keeps the company's tables
    assert.equal((await cs.form('/app/settings/database/remove', {})).status, 302);
    assert.equal(await sync.get(co.organizationId), null);
    if (reachable) assert.ok(await target.schema.hasTable('rw_employees'));
  });
});
