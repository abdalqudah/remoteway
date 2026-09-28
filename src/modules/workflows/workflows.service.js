// Custom approval workflows (Enterprise). A workflow is an ordered list of approval steps that applies
// to leave requests matching its conditions (leave types, minimum days). Each step names who approves:
// the employee's manager, the department head, anyone holding a role, or a specific person.
// Steps whose approver cannot be resolved (e.g. no manager) are skipped and recorded as skipped.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const ent = require('../billing/entitlements.service');

const STEP_TYPES = ['manager', 'department_head', 'role', 'user'];
const MAX_STEPS = 5;
const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);

function present(row) {
  return { ...row, leave_type_ids: parse(row.leave_type_ids, []).map(Number), steps: parse(row.steps, []), min_days: row.min_days != null ? Number(row.min_days) : null };
}

async function list(organizationId) {
  return (await knex('approval_workflows').where({ organization_id: organizationId, entity: 'leave' }).orderBy([{ column: 'priority', order: 'desc' }, 'id'])).map(present);
}

async function get(ctx, id) {
  const row = await knex('approval_workflows').where({ id, organization_id: ctx.organizationId }).first();
  if (!row) throw E.notFound('Workflow');
  return present(row);
}

async function save(ctx, id, input) {
  await ent.assertFeature(ctx.organizationId, 'custom_workflows');
  await ent.assertCanWrite(ctx.organizationId);
  const errors = {};
  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 150) errors.name = 'Enter a name.';
  const typeIds = arr(input.leave_type_ids).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (typeIds.length) {
    const found = await knex('leave_types').where({ organization_id: ctx.organizationId }).whereIn('id', typeIds).count({ n: '*' }).first();
    if (Number(found.n) !== typeIds.length) errors.leave_type_ids = 'Choose leave types from the list.';
  }
  let minDays = null;
  if (input.min_days !== undefined && String(input.min_days).trim() !== '') {
    minDays = Number(input.min_days);
    if (!Number.isFinite(minDays) || minDays < 0 || minDays > 365) errors.min_days = 'Use a number between 0 and 365.';
  }
  const priority = Number(input.priority || 0);
  const types = arr(input.step_type);
  const refs = arr(input.step_ref);
  const steps = [];
  for (let i = 0; i < types.length; i += 1) {
    const type = String(types[i] || '');
    if (!type) continue;
    if (!STEP_TYPES.includes(type)) { errors.steps = 'Invalid approver.'; break; }
    let ref = type === 'role' || type === 'user' ? String(refs[i] || '').trim() : null;
    if (type === 'role') {
      const role = await knex('roles').where({ key: ref }).andWhere((q) => q.whereNull('organization_id').orWhere('organization_id', ctx.organizationId)).first('id');
      if (!role) { errors.steps = 'Choose a role for each "role" step.'; break; }
    }
    if (type === 'user') {
      const m = await knex('memberships').where({ organization_id: ctx.organizationId, user_id: Number(ref), status: 'active' }).first('user_id');
      if (!m) { errors.steps = 'Choose a person for each "specific person" step.'; break; }
      ref = String(Number(ref));
    }
    steps.push({ type, ref });
  }
  if (!errors.steps && !steps.length) errors.steps = 'Add at least one approval step.';
  if (steps.length > MAX_STEPS) errors.steps = `Use at most ${MAX_STEPS} steps.`;
  if (Object.keys(errors).length) throw E.validation(errors);
  const row = {
    name, leave_type_ids: JSON.stringify(typeIds), min_days: minDays, steps: JSON.stringify(steps),
    priority: Number.isInteger(priority) ? Math.max(-100, Math.min(100, priority)) : 0,
    is_active: input.is_active === 'on' || input.is_active === true || input.is_active === 'true',
  };
  if (id) {
    const n = await knex('approval_workflows').where({ id, organization_id: ctx.organizationId }).update({ ...row, updated_at: new Date() });
    if (!n) throw E.notFound('Workflow');
  } else {
    [id] = await knex('approval_workflows').insert({ ...row, organization_id: ctx.organizationId, entity: 'leave', created_by: ctx.userId });
  }
  await audit.record(ctx, 'workflow.saved', { entityType: 'workflow', entityId: id, newValues: { name, steps: steps.length } });
  return id;
}

async function remove(ctx, id) {
  const n = await knex('approval_workflows').where({ id, organization_id: ctx.organizationId }).del();
  if (!n) throw E.notFound('Workflow');
  await audit.record(ctx, 'workflow.deleted', { entityType: 'workflow', entityId: id });
}

/** The workflow that applies to a new leave request, or null (standard single approval). */
async function match(trx, organizationId, { leaveTypeId, days }) {
  if (!(await ent.hasFeature(organizationId, 'custom_workflows'))) return null;
  const rows = (await trx('approval_workflows').where({ organization_id: organizationId, entity: 'leave', is_active: true })
    .orderBy([{ column: 'priority', order: 'desc' }, 'id'])).map(present);
  return rows.find((w) => (!w.leave_type_ids.length || w.leave_type_ids.includes(Number(leaveTypeId)))
    && (w.min_days == null || Number(days) >= w.min_days) && w.steps.length) || null;
}

/** User ids who may decide one step for this employee (never the employee themselves). */
async function approversFor(trx, organizationId, employee, step) {
  let ids = [];
  if (step.approver_type === 'manager' && employee.manager_id) {
    const m = await trx('employees').where({ id: employee.manager_id, organization_id: organizationId }).first('user_id');
    if (m && m.user_id) ids = [m.user_id];
  } else if (step.approver_type === 'department_head' && employee.department_id) {
    const d = await trx('departments as d').join('employees as h', 'h.id', 'd.head_employee_id')
      .where({ 'd.id': employee.department_id, 'd.organization_id': organizationId }).first('h.user_id');
    if (d && d.user_id) ids = [d.user_id];
  } else if (step.approver_type === 'role') {
    ids = await trx('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id')
      .where({ 'ur.organization_id': organizationId, 'r.key': step.approver_ref }).pluck('ur.user_id');
  } else if (step.approver_type === 'user') {
    ids = [Number(step.approver_ref)];
  }
  if (!ids.length) return [];
  const active = await trx('memberships').where({ organization_id: organizationId, status: 'active' }).whereIn('user_id', ids).pluck('user_id');
  return active.filter((u) => u !== employee.user_id);
}

async function labelFor(trx, organizationId, s) {
  if (s.type === 'role') {
    const r = await trx('roles').where({ key: s.ref }).andWhere((q) => q.whereNull('organization_id').orWhere('organization_id', organizationId)).first('name');
    return r ? r.name : s.ref;
  }
  if (s.type === 'user') {
    const u = await trx('users').where({ id: Number(s.ref) }).first('name');
    return u ? u.name : '';
  }
  return null;
}

/**
 * Creates the steps of a new request and activates the first step that has approvers.
 * @returns {Promise<number[]|null>} approvers of the active step, or null when no step could be resolved
 */
async function start(trx, organizationId, requestId, employee, workflow) {
  let first = null;
  for (let i = 0; i < workflow.steps.length; i += 1) {
    const s = workflow.steps[i];
    await trx('leave_request_steps').insert({
      organization_id: organizationId, leave_request_id: requestId, step_no: i + 1, approver_type: s.type, approver_ref: s.ref,
      approver_label: await labelFor(trx, organizationId, s), status: 'waiting',
    });
  }
  first = await activateNext(trx, organizationId, requestId, employee);
  if (!first) {
    // Nobody could approve any step: fall back to the standard approval so the request is never stuck.
    await trx('leave_request_steps').where({ leave_request_id: requestId }).del();
    return null;
  }
  await trx('leave_requests').where({ id: requestId }).update({ workflow_id: workflow.id });
  return first;
}

/** Moves to the next waiting step with approvers (skipping empty ones). Returns its approvers or null when done. */
async function activateNext(trx, organizationId, requestId, employee) {
  const waiting = await trx('leave_request_steps').where({ leave_request_id: requestId, status: 'waiting' }).orderBy('step_no');
  for (const step of waiting) {
    const approvers = await approversFor(trx, organizationId, employee, step);
    if (approvers.length) {
      await trx('leave_request_steps').where({ id: step.id }).update({ status: 'pending' });
      await trx('leave_requests').where({ id: requestId }).update({ current_step: step.step_no });
      return approvers;
    }
    await trx('leave_request_steps').where({ id: step.id }).update({ status: 'skipped', decided_at: new Date() });
  }
  await trx('leave_requests').where({ id: requestId }).update({ current_step: null });
  return null;
}

async function currentStep(trx, requestId) {
  return trx('leave_request_steps').where({ leave_request_id: requestId, status: 'pending' }).orderBy('step_no').first();
}

/** Whether this user decides the active step of a workflow request. */
async function canDecide(trx, ctx, request, employee) {
  const step = await currentStep(trx, request.id);
  if (!step) return false;
  return (await approversFor(trx, ctx.organizationId, employee, step)).includes(ctx.userId);
}

/**
 * Records a decision on the active step.
 * @returns {Promise<{final:boolean, next:number[]|null, step:object}>}
 */
async function decideStep(trx, ctx, request, employee, decision, note) {
  const step = await currentStep(trx, request.id);
  if (!step || !(await approversFor(trx, ctx.organizationId, employee, step)).includes(ctx.userId)) throw E.forbidden('leave.approve');
  await trx('leave_request_steps').where({ id: step.id }).update({ status: decision, decided_by: ctx.userId, decided_at: new Date(), note: note ? String(note).slice(0, 500) : null });
  if (decision === 'rejected') {
    await trx('leave_request_steps').where({ leave_request_id: request.id, status: 'waiting' }).update({ status: 'cancelled' });
    return { final: true, next: null, step };
  }
  const next = await activateNext(trx, ctx.organizationId, request.id, employee);
  return { final: !next, next, step };
}

async function cancelSteps(trx, requestId) {
  await trx('leave_request_steps').where({ leave_request_id: requestId }).whereIn('status', ['waiting', 'pending']).update({ status: 'cancelled' });
}

/** Pending workflow requests whose active step this user decides. */
async function pendingFor(ctx) {
  const rows = await knex('leave_request_steps as s').join('leave_requests as r', 'r.id', 's.leave_request_id').join('employees as e', 'e.id', 'r.employee_id')
    .where({ 's.organization_id': ctx.organizationId, 's.status': 'pending', 'r.status': 'pending' })
    .select('r.id', 's.approver_type', 's.approver_ref', 'e.id as employee_id', 'e.user_id', 'e.manager_id', 'e.department_id');
  const ids = [];
  for (const r of rows) {
    const approvers = await approversFor(knex, ctx.organizationId, { id: r.employee_id, user_id: r.user_id, manager_id: r.manager_id, department_id: r.department_id }, r);
    if (approvers.includes(ctx.userId)) ids.push(r.id);
  }
  return ids;
}

/** Adds `steps` to leave request rows that follow a workflow. */
async function attachSteps(rows) {
  const ids = rows.filter((r) => r.workflow_id).map((r) => r.id);
  if (!ids.length) return rows;
  const steps = await knex('leave_request_steps as s').leftJoin('users as u', 'u.id', 's.decided_by').whereIn('s.leave_request_id', ids)
    .orderBy('s.step_no').select('s.*', 'u.name as decided_by_name');
  for (const r of rows) r.steps = steps.filter((s) => s.leave_request_id === r.id);
  return rows;
}

module.exports = {
  STEP_TYPES, MAX_STEPS, list, get, save, remove, match, start, canDecide, decideStep, cancelSteps, pendingFor, attachSteps, approversFor,
};
