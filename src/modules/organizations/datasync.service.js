// Copy of a company's data to its own database (white-label companies).
// The company enters its MySQL/MariaDB or PostgreSQL connection; RemoteWay creates tables with a prefix
// (rw_employees, rw_attendance, …) and refreshes them on a schedule or on demand. RemoteWay stays the
// source of truth: the copy is one-way, each table is replaced inside a transaction, and nothing is read back.
const dns = require('dns').promises;
const net = require('net');
const knexFactory = require('knex');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const { isPrivateIp } = require('../../core/http');
const { E, AppError } = require('../../core/errors');
const ent = require('../billing/entitlements.service');

// Column types: i int, s string(255), t text, d date, dt datetime (UTC), n decimal(14,2), b boolean
const DATASETS = {
  employees: {
    feature: 'employees',
    tables: {
      employees: ['employees', { id: 'i', employee_number: 's', first_name: 's', last_name: 's', email: 's', phone: 's', job_title: 's', department_id: 'i', location_id: 'i', manager_id: 'i', employment_type: 's', work_mode: 's', status: 's', joining_date: 'd', termination_date: 'd', nationality: 's', created_at: 'dt', updated_at: 'dt' }],
      departments: ['departments', { id: 'i', name: 's', code: 's', parent_id: 'i', head_employee_id: 'i', created_at: 'dt', updated_at: 'dt' }],
      locations: ['locations', { id: 'i', name: 's', country_code: 's', city: 's', timezone: 's', is_remote: 'b', created_at: 'dt', updated_at: 'dt' }],
    },
  },
  salaries: { feature: 'employees', permission: 'employees.view_salary', tables: { employee_salaries: ['employees', { id: 'i', base_salary: 'n', salary_currency: 's', updated_at: 'dt' }] } },
  attendance: {
    feature: 'attendance',
    tables: { attendance: ['attendance', { id: 'i', employee_id: 'i', work_date: 'd', clock_in: 'dt', clock_out: 'dt', break_minutes: 'i', worked_minutes: 'i', late_minutes: 'i', overtime_minutes: 'i', source: 's', clock_in_method: 's', clock_out_method: 's', qr_off_network: 'b', note: 's', updated_at: 'dt' }] },
  },
  leave: {
    feature: 'leave',
    tables: {
      leave_types: ['leave_types', { id: 'i', key: 's', name: 's', name_ar: 's', days_per_year: 'n', has_balance: 'b', is_paid: 'b', is_active: 'b' }],
      leave_requests: ['leave_requests', { id: 'i', employee_id: 'i', leave_type_id: 'i', start_date: 'd', end_date: 'd', days: 'n', reason: 's', status: 's', decided_at: 'dt', decision_note: 's', created_at: 'dt', updated_at: 'dt' }],
      leave_balances: ['leave_balances', { id: 'i', employee_id: 'i', leave_type_id: 'i', year: 'i', entitled_days: 'n', adjustment_days: 'n', used_days: 'n', updated_at: 'dt' }],
    },
  },
  payroll: {
    feature: 'payroll',
    permission: 'payroll.view',
    tables: {
      payroll_runs: ['payroll_runs', { id: 'i', period: 's', period_start: 'd', period_end: 'd', status: 's', currency: 's', employee_count: 'i', total_gross: 'n', total_deductions: 'n', total_net: 'n', total_employer: 'n', payment_date: 'd', approved_at: 'dt', paid_at: 'dt', updated_at: 'dt' }],
      payslips: ['payslips', { id: 'i', run_id: 'i', employee_id: 'i', employee_number: 's', employee_name: 's', job_title: 's', department_name: 's', payment_method: 's', bank_name: 's', iban: 's', paid_days: 'n', period_days: 'n', unpaid_leave_days: 'n', basic: 'n', gross: 'n', total_deductions: 'n', net: 'n', employer_cost: 'n', gosi_base: 'n', updated_at: 'dt' }],
    },
  },
  recruitment: {
    feature: 'recruitment',
    permission: 'recruitment.view',
    tables: {
      jobs: ['jobs', { id: 'i', title: 's', department_id: 'i', location_id: 'i', work_mode: 's', employment_type: 's', salary_min: 'n', salary_max: 'n', salary_currency: 's', openings: 'i', status: 's', published_at: 'dt', closed_at: 'dt', updated_at: 'dt' }],
      candidates: ['candidates', { id: 'i', first_name: 's', last_name: 's', email: 's', phone: 's', city: 's', current_title: 's', experience_years: 'i', source: 's', created_at: 'dt', updated_at: 'dt' }],
      applications: ['applications', { id: 'i', job_id: 'i', candidate_id: 'i', stage: 's', stage_changed_at: 'dt', rejection_reason: 's', rating: 'i', hired_employee_id: 'i', created_at: 'dt', updated_at: 'dt' }],
    },
  },
  tasks: { feature: 'tasks', tables: { tasks: ['tasks', { id: 'i', project_id: 'i', title: 's', description: 't', assignee_user_id: 'i', priority: 's', status: 's', due_date: 'd', completed_at: 'dt', created_at: 'dt', updated_at: 'dt' }] } },
};
const DRIVERS = { mysql: { client: 'mysql2', port: 3306 }, postgres: { client: 'pg', port: 5432 } };
const FREQUENCIES = { manual: null, hourly: 3_600_000, daily: 86_400_000 };
const CHUNK = 500;
const allowPrivate = () => process.env.INTEGRATIONS_ALLOW_PRIVATE === 'true';

// ---------- Settings ----------
async function get(organizationId) {
  const r = await knex('organization_data_sync').where({ organization_id: organizationId }).first();
  if (!r) return null;
  const datasets = typeof r.datasets === 'string' ? JSON.parse(r.datasets) : (r.datasets || []);
  return { ...r, datasets, hasPassword: Boolean(r.password_enc) };
}

/** Datasets this person may send (plan features + their own permissions). */
async function available(ctx) {
  const e = await ent.getEntitlements(ctx.organizationId);
  return Object.keys(DATASETS).filter((k) => e.features.has(DATASETS[k].feature) && (!DATASETS[k].permission || ctx.permissions.has(DATASETS[k].permission)));
}

async function assertAllowed(organizationId) {
  await ent.assertFeature(organizationId, 'white_label');
}

function clean(body, cur) {
  const errors = {};
  const driver = DRIVERS[body.driver] ? body.driver : 'mysql';
  const host = String(body.host || '').trim().toLowerCase();
  const port = Number(body.port || DRIVERS[driver].port);
  const database = String(body.database_name || '').trim();
  const username = String(body.username || '').trim();
  const prefix = String(body.table_prefix ?? 'rw_').trim().toLowerCase();
  if (!/^(?=.{1,190}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) && !net.isIP(host)) errors.host = 'Enter the database server name or IP address.';
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'Enter a port between 1 and 65535.';
  if (!/^[A-Za-z0-9_$-]{1,64}$/.test(database)) errors.database_name = 'Enter the database name (letters, numbers, _ and -).';
  if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(username)) errors.username = 'Enter the database username.';
  if (!/^[a-z][a-z0-9_]{0,15}$/.test(prefix)) errors.table_prefix = 'Use a short prefix like rw_ (lowercase letters, numbers and _).';
  if (!body.password && !(cur && cur.password_enc)) errors.password = 'Enter the database password.';
  if (Object.keys(errors).length) throw E.validation(errors);
  return { driver, host, port, database, username, prefix };
}

async function save(ctx, body) {
  await assertAllowed(ctx.organizationId);
  const cur = await get(ctx.organizationId);
  const c = clean(body, cur);
  const allowed = await available(ctx);
  const picked = [].concat(body.datasets || []).filter((d) => allowed.includes(d));
  // Choices the editor may not see (e.g. payroll) are kept as they were.
  const kept = cur ? cur.datasets.filter((d) => DATASETS[d] && !allowed.includes(d)) : [];
  const datasets = [...new Set([...picked, ...kept])];
  if (!datasets.length) throw E.validation({ datasets: 'Choose at least one kind of data to copy.' });
  const frequency = Object.prototype.hasOwnProperty.call(FREQUENCIES, body.frequency) ? body.frequency : 'daily';
  const connChanged = !cur || ['driver', 'host', 'port', 'database_name', 'username'].some((k) => String(cur[k]) !== String({ driver: c.driver, host: c.host, port: c.port, database_name: c.database, username: c.username }[k])) || Boolean(body.password);
  const values = {
    driver: c.driver, host: c.host, port: c.port, database_name: c.database, username: c.username, ssl: body.ssl === '1', table_prefix: c.prefix,
    datasets: JSON.stringify(datasets), frequency, enabled: body.enabled === '1', updated_by: ctx.userId, updated_at: new Date(),
    next_run_at: FREQUENCIES[frequency] ? new Date(Date.now() + 60_000) : null,
    ...(body.password ? { password_enc: secrets.encrypt(String(body.password)) } : {}),
    ...(connChanged ? { verified_at: null } : {}),
  };
  await knex('organization_data_sync').insert({ organization_id: ctx.organizationId, ...values }).onConflict('organization_id').merge(values);
  await audit.record(ctx, 'datasync.updated', { entityType: 'organization', entityId: ctx.organizationId, newValues: { driver: c.driver, host: c.host, database: c.database, datasets, frequency, password: body.password ? 'changed' : 'kept' } });
}

async function remove(ctx) {
  await knex('organization_data_sync').where({ organization_id: ctx.organizationId }).del();
  await audit.record(ctx, 'datasync.removed', { entityType: 'organization', entityId: ctx.organizationId });
}

// ---------- Connection ----------
/** The server must be public (no RemoteWay internal addresses). Returns the address to connect to. */
async function resolveHost(host) {
  const list = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new AppError('DATASYNC_DNS', 'The server name could not be found.', 400); });
  if (!allowPrivate() && list.some((a) => isPrivateIp(a.address))) throw new AppError('DATASYNC_PRIVATE', 'This database address is not reachable from RemoteWay. Use a public server name or IP.', 400);
  return list[0].address;
}

async function connect(cfg) {
  const address = await resolveHost(cfg.host);
  const password = cfg.password_enc ? secrets.decrypt(cfg.password_enc) : '';
  // Without TLS the checked address is used directly; with TLS the name is needed for the certificate.
  const host = cfg.ssl ? cfg.host : address;
  const ssl = cfg.ssl ? { rejectUnauthorized: true, servername: net.isIP(cfg.host) ? undefined : cfg.host } : undefined;
  const connection = cfg.driver === 'postgres'
    ? { host, port: cfg.port, user: cfg.username, password, database: cfg.database_name, ssl, connectionTimeoutMillis: 15_000, statement_timeout: 300_000 }
    : { host, port: cfg.port, user: cfg.username, password, database: cfg.database_name, ssl, connectTimeout: 15_000, timezone: 'Z', charset: 'utf8mb4' };
  return knexFactory({ client: DRIVERS[cfg.driver].client, connection, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 20_000 });
}

/** A readable reason from a driver error (no stack, no password). */
function reason(e) {
  if (e instanceof AppError) return e.message;
  const code = e.code || '';
  if (/ECONNREFUSED/.test(code)) return 'The server refused the connection. Check the host, the port and that remote connections are allowed.';
  if (/ETIMEDOUT|ETIMEOUT|Timeout/i.test(code + e.message)) return 'The server did not answer in time. Allow RemoteWay’s server IP in the database firewall (Remote MySQL / pg_hba).';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'The server name could not be found.';
  if (code === 'ER_ACCESS_DENIED_ERROR' || code === '28P01' || code === '28000') return 'The username or password was refused.';
  if (code === 'ER_BAD_DB_ERROR' || code === '3D000') return 'This database does not exist on the server.';
  if (code === 'ER_TABLEACCESS_DENIED_ERROR' || code === '42501') return 'The user may not create or change tables in this database.';
  if (/SSL|TLS|certificate|self.signed/i.test(e.message)) return `Secure connection failed (${String(e.message).slice(0, 120)}). Turn off “Require SSL” only if the server does not support it.`;
  return String(e.message || e).replace(/password[^,;]*/gi, 'password ***').slice(0, 240);
}

/** Checks the connection and that tables can be created. */
async function test(ctx) {
  await assertAllowed(ctx.organizationId);
  const cfg = await get(ctx.organizationId);
  if (!cfg) throw E.notFound('Database connection');
  let db;
  try {
    db = await connect(cfg);
    const probe = `${cfg.table_prefix}probe`;
    await db.schema.dropTableIfExists(probe);
    await db.schema.createTable(probe, (t) => { t.integer('id'); });
    await db.schema.dropTable(probe);
    await knex('organization_data_sync').where({ organization_id: ctx.organizationId }).update({ verified_at: new Date() });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: reason(e) };
  } finally {
    if (db) await db.destroy().catch(() => {});
  }
}

// ---------- Copying ----------
const pad = (n) => String(n).padStart(2, '0');
function convert(v, type) {
  if (v === null || v === undefined) return null;
  if (type === 'd') return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  if (type === 'dt') {
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
  if (type === 'b') return Boolean(v);
  if (type === 'n') return Number(v);
  if (type === 'i') return Number.isFinite(Number(v)) ? Number(v) : null;
  if (type === 's') return String(v).slice(0, 255);
  return String(v);
}

function column(t, name, type) {
  if (name === 'id') return t.integer('id').primary();
  if (type === 'i') return t.integer(name).nullable();
  if (type === 's') return t.string(name, 255).nullable();
  if (type === 't') return t.text(name).nullable();
  if (type === 'd') return t.date(name).nullable();
  if (type === 'dt') return t.timestamp(name, { useTz: false }).nullable();
  if (type === 'n') return t.decimal(name, 14, 2).nullable();
  return t.boolean(name).nullable();
}

/** Creates the table, or adds columns a newer RemoteWay version sends. */
async function ensureTable(db, name, cols) {
  if (!(await db.schema.hasTable(name))) {
    await db.schema.createTable(name, (t) => { for (const [c, type] of Object.entries(cols)) column(t, c, type); });
    return;
  }
  const missing = [];
  for (const c of Object.keys(cols)) if (!(await db.schema.hasColumn(name, c))) missing.push(c);
  if (missing.length) await db.schema.alterTable(name, (t) => { for (const c of missing) column(t, c, cols[c]); });
}

async function copyTable(db, organizationId, target, source, cols) {
  const rows = await knex(source).where({ organization_id: organizationId }).select(Object.keys(cols)).orderBy('id');
  await ensureTable(db, target, cols);
  await db.transaction(async (trx) => {
    await trx(target).del();
    for (let i = 0; i < rows.length; i += CHUNK) {
      await trx(target).insert(rows.slice(i, i + CHUNK).map((r) => Object.fromEntries(Object.entries(cols).map(([c, type]) => [c, convert(r[c], type)]))));
    }
  });
  return rows.length;
}

/** Runs one copy now. Only one at a time per company. */
async function run(organizationId, { trigger = 'manual', userId = null } = {}) {
  const cfg = await get(organizationId);
  if (!cfg) throw E.notFound('Database connection');
  const stale = new Date(Date.now() - 30 * 60_000);
  const locked = await knex('organization_data_sync').where({ organization_id: organizationId })
    .where((q) => q.whereNull('running_since').orWhere('running_since', '<', stale)).update({ running_since: new Date() });
  if (!locked) throw new AppError('DATASYNC_BUSY', 'A copy is already running. Try again in a few minutes.', 409);
  const started = Date.now();
  const [runId] = await knex('data_sync_runs').insert({ organization_id: organizationId, trigger, status: 'running', started_by: userId, started_at: new Date() });
  const counts = {};
  let db; let error = null;
  try {
    if (!(await ent.hasFeature(organizationId, 'white_label'))) throw new AppError('DATASYNC_PLAN', 'Copying data to your own database needs the white-label feature.', 402);
    const e = await ent.getEntitlements(organizationId);
    db = await connect(cfg);
    for (const key of cfg.datasets) {
      const ds = DATASETS[key];
      if (!ds || !e.features.has(ds.feature)) continue;
      for (const [name, [source, cols]] of Object.entries(ds.tables)) counts[name] = await copyTable(db, organizationId, `${cfg.table_prefix}${name}`, source, cols);
    }
    // A small table telling people reading the copy when it was refreshed.
    const info = `${cfg.table_prefix}sync_info`;
    await ensureTable(db, info, { id: 'i', organization: 's', synced_at: 'dt', tables: 't' });
    const org = await knex('organizations').where({ id: organizationId }).first('name');
    await db(info).del();
    await db(info).insert({ id: 1, organization: org && org.name, synced_at: convert(new Date(), 'dt'), tables: JSON.stringify(counts) });
  } catch (err) {
    error = reason(err);
  } finally {
    if (db) await db.destroy().catch(() => {});
  }
  const now = new Date();
  const every = FREQUENCIES[cfg.frequency];
  await knex('data_sync_runs').where({ id: runId }).update({ status: error ? 'failed' : 'ok', counts: JSON.stringify(counts), error, duration_ms: Date.now() - started, finished_at: now });
  await knex('organization_data_sync').where({ organization_id: organizationId }).update({
    running_since: null, last_run_at: now, last_status: error ? 'failed' : 'ok', last_error: error,
    // A failing scheduled copy waits at least an hour before trying again.
    next_run_at: every ? new Date(now.getTime() + (error ? Math.max(every, 3_600_000) : every)) : null,
    ...(error ? {} : { verified_at: cfg.verified_at || now }),
  });
  // Keep the last 50 runs per company.
  const old = await knex('data_sync_runs').where({ organization_id: organizationId }).orderBy('id', 'desc').offset(50).pluck('id');
  if (old.length) await knex('data_sync_runs').whereIn('id', old).del();
  await audit.record({ organizationId, userId }, error ? 'datasync.failed' : 'datasync.completed', { entityType: 'organization', entityId: organizationId, newValues: { trigger, counts, error } });
  return { ok: !error, error, counts, runId };
}

async function runs(organizationId, limit = 10) {
  const rows = await knex('data_sync_runs').where({ organization_id: organizationId }).orderBy('id', 'desc').limit(limit);
  return rows.map((r) => ({ ...r, counts: typeof r.counts === 'string' ? JSON.parse(r.counts) : (r.counts || {}) }));
}

/** Background tick: runs the scheduled copies that are due, one after another. */
async function runDue() {
  const due = await knex('organization_data_sync').where({ enabled: true }).whereNotNull('next_run_at').where('next_run_at', '<=', new Date()).whereNull('running_since').limit(5).pluck('organization_id');
  for (const orgId of due) await run(orgId, { trigger: 'schedule' }).catch(() => {});
  return due.length;
}

module.exports = { DATASETS, DRIVERS, FREQUENCIES, get, available, save, remove, test, run, runs, runDue, convert, reason };
