// Departments and locations.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const { z, validate, optionalString, optionalId, emptyToUndefined } = require('../../core/validate');
const ent = require('../billing/entitlements.service');

const departmentSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120),
  code: optionalString(20),
  parent_id: optionalId(),
  head_employee_id: optionalId(),
});

const locationSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120),
  country_code: z.preprocess(emptyToUndefined, z.string().length(2).toUpperCase().optional()),
  city: optionalString(100),
  is_remote: z.preprocess((v) => v === true || v === 'on' || v === '1' || v === 'true', z.boolean()),
});

async function listDepartments(organizationId) {
  return knex('departments as d')
    .leftJoin('employees as h', 'h.id', 'd.head_employee_id')
    .leftJoin('departments as p', 'p.id', 'd.parent_id')
    .where('d.organization_id', organizationId)
    .select('d.*', 'p.name as parent_name', knex.raw("CONCAT(h.first_name, ' ', h.last_name) as head_name"),
      knex('employees').count('*').where('department_id', knex.ref('d.id')).whereNot('status', 'terminated').as('employee_count'))
    .orderBy('d.name');
}

async function listLocations(organizationId) {
  return knex('locations as l').where('l.organization_id', organizationId)
    .select('l.*', knex('employees').count('*').where('location_id', knex.ref('l.id')).whereNot('status', 'terminated').as('employee_count'))
    .orderBy('l.name');
}

async function assertOwned(trx, table, organizationId, id, field, label) {
  if (!id) return;
  if (!(await trx(table).where({ id, organization_id: organizationId }).first('id'))) throw E.validation({ [field]: `${label} not found.` });
}

async function saveDepartment(ctx, id, input) {
  const data = validate(departmentSchema, input);
  await ent.assertCanWrite(ctx.organizationId);
  return knex.transaction(async (trx) => {
    await assertOwned(trx, 'departments', ctx.organizationId, data.parent_id, 'parent_id', 'Parent department');
    await assertOwned(trx, 'employees', ctx.organizationId, data.head_employee_id, 'head_employee_id', 'Employee');
    if (id && data.parent_id === Number(id)) throw E.validation({ parent_id: 'A department cannot be its own parent.' });
    const dup = trx('departments').where({ organization_id: ctx.organizationId, name: data.name });
    if (id) dup.whereNot('id', id);
    if (await dup.first('id')) throw E.validation({ name: 'A department with this name exists.' });
    const row = { name: data.name, code: data.code ?? null, parent_id: data.parent_id ?? null, head_employee_id: data.head_employee_id ?? null };
    if (id) {
      const before = await trx('departments').where({ id, organization_id: ctx.organizationId }).first();
      if (!before) throw E.notFound('Department');
      const d = audit.diff(before, row);
      await trx('departments').where({ id, organization_id: ctx.organizationId }).update(row);
      if (d.changed) await audit.record(ctx, 'department.updated', { entityType: 'department', entityId: id, oldValues: d.oldValues, newValues: d.newValues }, trx);
      return Number(id);
    }
    const [newId] = await trx('departments').insert({ ...row, organization_id: ctx.organizationId });
    await audit.record(ctx, 'department.created', { entityType: 'department', entityId: newId, newValues: { name: data.name } }, trx);
    return newId;
  });
}

async function deleteDepartment(ctx, id) {
  const dept = await knex('departments').where({ id, organization_id: ctx.organizationId }).first();
  if (!dept) throw E.notFound('Department');
  const [{ n }] = await knex('employees').where({ organization_id: ctx.organizationId, department_id: id }).whereNot('status', 'terminated').count({ n: '*' });
  if (Number(n) > 0) throw E.conflict('DEPARTMENT_NOT_EMPTY', 'Move employees out of this department before deleting it.');
  await knex('departments').where({ id, organization_id: ctx.organizationId }).del();
  await audit.record(ctx, 'department.deleted', { entityType: 'department', entityId: id, oldValues: { name: dept.name } });
}

async function saveLocation(ctx, id, input) {
  const data = validate(locationSchema, input);
  await ent.assertCanWrite(ctx.organizationId);
  const dup = knex('locations').where({ organization_id: ctx.organizationId, name: data.name });
  if (id) dup.whereNot('id', id);
  if (await dup.first('id')) throw E.validation({ name: 'A location with this name exists.' });
  const row = { name: data.name, country_code: data.country_code ?? null, city: data.city ?? null, is_remote: data.is_remote };
  if (id) {
    const before = await knex('locations').where({ id, organization_id: ctx.organizationId }).first();
    if (!before) throw E.notFound('Location');
    const d = audit.diff(before, row);
    await knex('locations').where({ id, organization_id: ctx.organizationId }).update(row);
    if (d.changed) await audit.record(ctx, 'location.updated', { entityType: 'location', entityId: id, oldValues: d.oldValues, newValues: d.newValues });
    return Number(id);
  }
  const [newId] = await knex('locations').insert({ ...row, organization_id: ctx.organizationId });
  await audit.record(ctx, 'location.created', { entityType: 'location', entityId: newId, newValues: { name: data.name } });
  return newId;
}

async function deleteLocation(ctx, id) {
  const loc = await knex('locations').where({ id, organization_id: ctx.organizationId }).first();
  if (!loc) throw E.notFound('Location');
  const [{ n }] = await knex('employees').where({ organization_id: ctx.organizationId, location_id: id }).whereNot('status', 'terminated').count({ n: '*' });
  if (Number(n) > 0) throw E.conflict('LOCATION_NOT_EMPTY', 'Move employees out of this location before deleting it.');
  await knex('locations').where({ id, organization_id: ctx.organizationId }).del();
  await audit.record(ctx, 'location.deleted', { entityType: 'location', entityId: id, oldValues: { name: loc.name } });
}

module.exports = { listDepartments, listLocations, saveDepartment, deleteDepartment, saveLocation, deleteLocation };
