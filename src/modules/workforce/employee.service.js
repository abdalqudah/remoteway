const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const { z, validate, optionalString, optionalId, emptyToUndefined } = require('../../core/validate');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');

const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern', 'freelance'];
const WORK_MODES = ['remote', 'hybrid', 'onsite'];
const STATUSES = ['active', 'probation', 'on_leave', 'terminated'];
const SORTABLE = { name: 'e.first_name', number: 'e.employee_number', department: 'd.name', joining_date: 'e.joining_date', status: 'e.status', created: 'e.id' };

const optionalDate = () => z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').optional());

const employeeSchema = z.object({
  first_name: z.string().trim().min(1, 'First name is required.').max(80),
  last_name: z.string().trim().min(1, 'Last name is required.').max(80),
  email: z.preprocess(emptyToUndefined, z.string().trim().toLowerCase().email('Enter a valid email address.').max(190).optional()),
  phone: optionalString(40),
  employee_number: optionalString(30),
  job_title: optionalString(120),
  department_id: optionalId(),
  location_id: optionalId(),
  manager_id: optionalId(),
  employment_type: z.enum(EMPLOYMENT_TYPES).default('full_time'),
  work_mode: z.enum(WORK_MODES).default('onsite'),
  status: z.enum(['active', 'probation', 'on_leave']).default('active'),
  joining_date: optionalDate(),
  nationality: z.preprocess(emptyToUndefined, z.string().length(2).toUpperCase().optional()),
  base_salary: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(99_999_999).optional()),
});

const filterSchema = z.object({
  q: optionalString(100),
  department_id: optionalId(),
  location_id: optionalId(),
  manager_id: optionalId(),
  status: z.preprocess(emptyToUndefined, z.enum([...STATUSES, 'current']).optional()),
  employment_type: z.preprocess(emptyToUndefined, z.enum(EMPLOYMENT_TYPES).optional()),
  joined_from: optionalDate(),
  joined_to: optionalDate(),
  sort: z.preprocess(emptyToUndefined, z.enum(Object.keys(SORTABLE)).default('name')),
  dir: z.preprocess(emptyToUndefined, z.enum(['asc', 'desc']).default('asc')),
  page: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).default(1)),
  per_page: z.preprocess(emptyToUndefined, z.coerce.number().int().min(5).max(100).default(20)),
});

async function linkedEmployeeId(ctx) {
  if (ctx.employeeId !== undefined) return ctx.employeeId;
  const row = await knex('employees').where({ organization_id: ctx.organizationId, user_id: ctx.userId }).first('id');
  return row ? row.id : null;
}

/**
 * Row-level scope: all (employees.view), my reporting line (team.view) or only myself.
 * Mutates the builder and returns nothing (returning a knex builder from an async function would execute it).
 */
async function applyScope(ctx, query) {
  if (ctx.permissions.has('employees.view')) return;
  const self = await linkedEmployeeId(ctx);
  if (!self) {
    query.whereRaw('1 = 0');
    return;
  }
  if (ctx.permissions.has('team.view')) {
    query.whereIn('e.id', [self, ...(await reportIds(ctx.organizationId, self))]);
    return;
  }
  query.where('e.id', self);
}

/**
 * Ids of the manager's whole reporting line (direct + indirect), excluding the manager.
 * Walked in Node from one query (no WITH RECURSIVE: MySQL 5.7 and MariaDB < 10.2 do not support it).
 */
async function reportIds(organizationId, managerEmployeeId) {
  const rows = await knex('employees').where({ organization_id: organizationId }).whereNotNull('manager_id').select('id', 'manager_id');
  const children = new Map();
  for (const r of rows) {
    if (!children.has(r.manager_id)) children.set(r.manager_id, []);
    children.get(r.manager_id).push(r.id);
  }
  const root = Number(managerEmployeeId);
  const seen = new Set([root]); // also stops a loop in bad data (A manages B manages A)
  const out = [];
  const queue = [root];
  while (queue.length) {
    for (const id of children.get(queue.shift()) || []) {
      if (seen.has(id)) continue;
      seen.add(id); out.push(id); queue.push(id);
    }
  }
  return out;
}

/**
 * Employee ids another module may show to this user:
 * null = all (employees.view), otherwise self + reporting line (team.view) or just self.
 */
async function visibleIds(ctx) {
  if (ctx.permissions.has('employees.view')) return null;
  const self = await linkedEmployeeId(ctx);
  if (!self) return [];
  if (ctx.permissions.has('team.view')) return [self, ...(await reportIds(ctx.organizationId, self))];
  return [self];
}

/** Employee ids whose requests this user may approve: everyone but themselves (HR) or their reporting line (managers). */
async function approvableIds(ctx) {
  const self = await linkedEmployeeId(ctx);
  if (ctx.permissions.has('employees.view')) return { all: true, exclude: self };
  if (ctx.permissions.has('team.view') && self) return { all: false, ids: await reportIds(ctx.organizationId, self) };
  return { all: false, ids: [] };
}

function present(ctx, row) {
  if (!row) return row;
  const out = { ...row, full_name: `${row.first_name} ${row.last_name}` };
  if (!ctx.permissions.has('employees.view_salary')) {
    delete out.base_salary;
    delete out.salary_currency;
  }
  return out;
}

function baseQuery(organizationId) {
  return knex('employees as e')
    .leftJoin('departments as d', 'd.id', 'e.department_id')
    .leftJoin('locations as l', 'l.id', 'e.location_id')
    .leftJoin('employees as m', 'm.id', 'e.manager_id')
    .where('e.organization_id', organizationId);
}

async function list(ctx, rawFilters = {}) {
  const f = validate(filterSchema, rawFilters);
  const q = baseQuery(ctx.organizationId);
  await applyScope(ctx, q);
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, '\\$&')}%`;
    q.andWhere((w) => w.whereRaw("CONCAT(e.first_name, ' ', e.last_name) LIKE ?", [like]).orWhere('e.email', 'like', like)
      .orWhere('e.employee_number', 'like', like).orWhere('e.job_title', 'like', like));
  }
  if (f.department_id) q.where('e.department_id', f.department_id);
  if (f.location_id) q.where('e.location_id', f.location_id);
  if (f.manager_id) q.where('e.manager_id', f.manager_id);
  if (f.status === 'current') q.whereNot('e.status', 'terminated');
  else if (f.status) q.where('e.status', f.status);
  if (f.employment_type) q.where('e.employment_type', f.employment_type);
  if (f.joined_from) q.where('e.joining_date', '>=', f.joined_from);
  if (f.joined_to) q.where('e.joining_date', '<=', f.joined_to);

  const [{ total }] = await q.clone().clearSelect().count({ total: 'e.id' });
  const rows = await q.select(
    'e.*', 'd.name as department_name', 'l.name as location_name',
    knex.raw("CONCAT(m.first_name, ' ', m.last_name) as manager_name"),
  ).orderBy(SORTABLE[f.sort], f.dir).orderBy('e.id', 'asc').limit(f.per_page).offset((f.page - 1) * f.per_page);

  return {
    data: rows.map((r) => present(ctx, r)),
    meta: { total: Number(total), page: f.page, per_page: f.per_page, pages: Math.max(1, Math.ceil(Number(total) / f.per_page)) },
    filters: f,
  };
}

async function get(ctx, id) {
  const q = baseQuery(ctx.organizationId).where('e.id', id);
  await applyScope(ctx, q);
  const row = await q.first('e.*', 'd.name as department_name', 'l.name as location_name', knex.raw("CONCAT(m.first_name, ' ', m.last_name) as manager_name"));
  if (!row) throw E.notFound('Employee');
  return present(ctx, row);
}

// Every foreign key must belong to the same tenant.
async function assertRefs(trx, organizationId, data, selfId) {
  const checks = [['department_id', 'departments', 'Department'], ['location_id', 'locations', 'Location'], ['manager_id', 'employees', 'Manager']];
  for (const [field, table, label] of checks) {
    if (data[field]) {
      const row = await trx(table).where({ id: data[field], organization_id: organizationId }).first('id');
      if (!row) throw E.validation({ [field]: `${label} not found.` });
    }
  }
  if (selfId && data.manager_id === Number(selfId)) throw E.validation({ manager_id: 'An employee cannot manage themselves.' });
}

async function nextEmployeeNumber(trx, organizationId) {
  const settings = await orgs.getSettings(organizationId);
  const prefix = settings.employee_number_prefix || 'EMP-';
  const rows = await trx('employees').where({ organization_id: organizationId }).where('employee_number', 'like', `${prefix}%`).select('employee_number');
  const max = rows.reduce((m, r) => Math.max(m, Number(r.employee_number.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

async function create(ctx, input) {
  const data = validate(employeeSchema, input);
  await ent.assertCanWrite(ctx.organizationId);
  const org = await orgs.get(ctx.organizationId);
  const id = await knex.transaction(async (trx) => {
    // Serialize seat checks per tenant so two concurrent requests cannot exceed the limit.
    await ent.lockSubscription(ctx.organizationId, trx);
    await ent.assertWithinLimit(ctx.organizationId, 'employees', 1, trx);
    await assertRefs(trx, ctx.organizationId, data);
    if (data.email && await trx('employees').where({ organization_id: ctx.organizationId, email: data.email }).first('id')) {
      throw E.validation({ email: 'Another employee already uses this email.' });
    }
    const employeeNumber = data.employee_number || await nextEmployeeNumber(trx, ctx.organizationId);
    if (await trx('employees').where({ organization_id: ctx.organizationId, employee_number: employeeNumber }).first('id')) {
      throw E.validation({ employee_number: 'This employee ID is already used.' });
    }
    const salaryAllowed = ctx.permissions.has('employees.view_salary');
    const [newId] = await trx('employees').insert({
      ...data,
      base_salary: salaryAllowed ? data.base_salary ?? null : null,
      salary_currency: salaryAllowed && data.base_salary !== undefined ? org.currency : null,
      employee_number: employeeNumber,
      organization_id: ctx.organizationId,
    });
    const linkedUser = data.email ? await trx('memberships as m').join('users as u', 'u.id', 'm.user_id')
      .where({ 'm.organization_id': ctx.organizationId, 'u.email': data.email }).first('u.id') : null;
    if (linkedUser) await trx('employees').where({ id: newId }).update({ user_id: linkedUser.id });
    await audit.record(ctx, 'employee.created', {
      entityType: 'employee', entityId: newId,
      newValues: { name: `${data.first_name} ${data.last_name}`, employee_number: employeeNumber, job_title: data.job_title },
    }, trx);
    return newId;
  });
  return get(ctx, id);
}

async function update(ctx, id, input) {
  const data = validate(employeeSchema, input);
  await ent.assertCanWrite(ctx.organizationId);
  const before = await knex('employees').where({ id, organization_id: ctx.organizationId }).first();
  if (!before) throw E.notFound('Employee');
  await knex.transaction(async (trx) => {
    await assertRefs(trx, ctx.organizationId, data, id);
    if (data.email && await trx('employees').where({ organization_id: ctx.organizationId, email: data.email }).whereNot('id', id).first('id')) {
      throw E.validation({ email: 'Another employee already uses this email.' });
    }
    const patch = {
      ...data,
      employee_number: data.employee_number || before.employee_number,
      email: data.email ?? null, phone: data.phone ?? null, job_title: data.job_title ?? null, department_id: data.department_id ?? null,
      location_id: data.location_id ?? null, manager_id: data.manager_id ?? null, joining_date: data.joining_date ?? null, nationality: data.nationality ?? null,
    };
    // Reactivating a terminated employee is not done through edit.
    if (before.status === 'terminated') patch.status = 'terminated';
    if (ctx.permissions.has('employees.view_salary')) {
      patch.base_salary = data.base_salary ?? null;
      patch.salary_currency = data.base_salary !== undefined ? (before.salary_currency || (await orgs.get(ctx.organizationId)).currency) : null;
    } else {
      delete patch.base_salary;
    }
    if (patch.employee_number !== before.employee_number
      && await trx('employees').where({ organization_id: ctx.organizationId, employee_number: patch.employee_number }).whereNot('id', id).first('id')) {
      throw E.validation({ employee_number: 'This employee ID is already used.' });
    }
    const d = audit.diff(before, patch);
    if (!d.changed) return;
    await trx('employees').where({ id, organization_id: ctx.organizationId }).update(patch);
    await audit.record(ctx, 'employee.updated', { entityType: 'employee', entityId: id, oldValues: d.oldValues, newValues: d.newValues }, trx);
  });
  return get(ctx, id);
}

async function terminate(ctx, id, { termination_date: date } = {}) {
  await ent.assertCanWrite(ctx.organizationId);
  const before = await knex('employees').where({ id, organization_id: ctx.organizationId }).first();
  if (!before) throw E.notFound('Employee');
  if (before.status === 'terminated') return get(ctx, id);
  const terminationDate = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : new Date().toISOString().slice(0, 10);
  await knex.transaction(async (trx) => {
    await trx('employees').where({ id, organization_id: ctx.organizationId }).update({ status: 'terminated', termination_date: terminationDate });
    await trx('employees').where({ organization_id: ctx.organizationId, manager_id: id }).update({ manager_id: before.manager_id });
    await audit.record(ctx, 'employee.terminated', { entityType: 'employee', entityId: id, oldValues: { status: before.status }, newValues: { status: 'terminated', termination_date: terminationDate } }, trx);
  });
  return get(ctx, id);
}

async function reactivate(ctx, id) {
  await ent.assertCanWrite(ctx.organizationId);
  await knex.transaction(async (trx) => {
    await ent.lockSubscription(ctx.organizationId, trx);
    const before = await trx('employees').where({ id, organization_id: ctx.organizationId }).first();
    if (!before) throw E.notFound('Employee');
    if (before.status !== 'terminated') return;
    await ent.assertWithinLimit(ctx.organizationId, 'employees', 1, trx);
    await trx('employees').where({ id }).update({ status: 'active', termination_date: null });
    await audit.record(ctx, 'employee.reactivated', { entityType: 'employee', entityId: id }, trx);
  });
  return get(ctx, id);
}

async function remove(ctx, id) {
  const before = await knex('employees').where({ id, organization_id: ctx.organizationId }).first();
  if (!before) throw E.notFound('Employee');
  await knex.transaction(async (trx) => {
    await trx('employees').where({ organization_id: ctx.organizationId, manager_id: id }).update({ manager_id: before.manager_id });
    await trx('departments').where({ organization_id: ctx.organizationId, head_employee_id: id }).update({ head_employee_id: null });
    await trx('employees').where({ id, organization_id: ctx.organizationId }).del();
    await audit.record(ctx, 'employee.deleted', {
      entityType: 'employee', entityId: id, oldValues: { name: `${before.first_name} ${before.last_name}`, employee_number: before.employee_number },
    }, trx);
  });
}

/** Lightweight option list for manager pickers (current employees only). */
async function options(organizationId) {
  return knex('employees').where({ organization_id: organizationId }).whereNot('status', 'terminated')
    .select('id', 'first_name', 'last_name', 'employee_number', 'job_title').orderBy('first_name');
}

async function forUser(organizationId, userId) {
  return baseQuery(organizationId).where('e.user_id', userId)
    .first('e.*', 'd.name as department_name', 'l.name as location_name', knex.raw("CONCAT(m.first_name, ' ', m.last_name) as manager_name"));
}

module.exports = {
  EMPLOYMENT_TYPES, WORK_MODES, STATUSES, list, get, create, update, terminate, reactivate, remove, options, forUser, linkedEmployeeId,
  visibleIds, approvableIds, reportIds,
};
