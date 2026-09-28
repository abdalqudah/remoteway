// Goals & OKRs: company, department and individual goals, measurable key results, and check-ins.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const { isDateStr } = require('../../core/workdays');
const ent = require('../billing/entitlements.service');
const employees = require('../workforce/employee.service');
const notifications = require('../notifications/notification.service');
const { isAdmin, scopeIds, managedIds } = require('./access');

const HEALTH = ['on_track', 'at_risk', 'off_track'];
const parseJson = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Progress of one key result: how far current is from start towards target (works for decreasing targets too). */
function krProgress(kr) {
  const start = Number(kr.start_value); const target = Number(kr.target_value); const current = Number(kr.current_value);
  if (target === start) return current === target ? 100 : 0;
  return clamp(((current - start) / (target - start)) * 100, 0, 100);
}

/** Goal progress = average of its key results (rounded to 0.01). */
function goalProgress(krs) {
  if (!krs.length) return null;
  return Math.round((krs.reduce((s, k) => s + krProgress(k), 0) / krs.length) * 100) / 100;
}

async function linkedEmployee(ctx) {
  return employees.linkedEmployeeId(ctx);
}

/** Whether this user may create/edit/check in on a goal of the given shape. */
async function canEdit(ctx, goal) {
  if (isAdmin(ctx)) return true;
  if (goal.scope === 'company') return false;
  const self = await linkedEmployee(ctx);
  if (goal.scope === 'department') {
    // Department managers run their own department's goals.
    if (!self || !ctx.permissions.has('performance.manage') || !goal.department_id) return false;
    const me = await knex('employees').where({ id: self }).first('department_id');
    return Boolean(me && me.department_id === goal.department_id);
  }
  if (goal.employee_id && goal.employee_id === self) return true;
  return (await managedIds(ctx)).includes(goal.employee_id);
}

async function canView(ctx, goal) {
  if (goal.scope !== 'individual') return true; // company and department goals are visible to the whole company
  const ids = await scopeIds(ctx);
  return ids === null || ids.includes(goal.employee_id);
}

function base(organizationId) {
  return knex('goals as g').leftJoin('employees as e', 'e.id', 'g.employee_id').leftJoin('departments as d', 'd.id', 'g.department_id')
    .leftJoin('goals as p', 'p.id', 'g.parent_id')
    .where('g.organization_id', organizationId)
    .select('g.*', 'e.first_name', 'e.last_name', 'e.job_title', 'd.name as department_name', 'p.title as parent_title');
}

async function list(ctx, { scope, employee_id: employeeId, status = 'active', mine, q } = {}) {
  const query = base(ctx.organizationId).orderByRaw("FIELD(g.scope, 'company', 'department', 'individual')").orderBy('g.due_date').orderBy('g.id', 'desc').limit(300);
  if (['active', 'done', 'cancelled'].includes(status)) query.where('g.status', status);
  if (['company', 'department', 'individual'].includes(scope)) query.where('g.scope', scope);
  if (employeeId) query.where('g.employee_id', Number(employeeId));
  if (mine) query.where('g.employee_id', (await linkedEmployee(ctx)) || -1);
  if (q) query.where('g.title', 'like', `%${String(q).replace(/[%_]/g, '\\$&')}%`);
  const ids = await scopeIds(ctx);
  if (ids !== null) query.where((w) => w.whereNot('g.scope', 'individual').orWhereIn('g.employee_id', ids.length ? ids : [-1]));
  const rows = await query;
  const krs = rows.length ? await knex('goal_key_results').whereIn('goal_id', rows.map((r) => r.id)).orderBy(['goal_id', 'sort_order']) : [];
  return rows.map((g) => ({ ...g, progress: Number(g.progress), key_results: krs.filter((k) => k.goal_id === g.id) }));
}

async function get(ctx, id) {
  const goal = await base(ctx.organizationId).where('g.id', id).first();
  if (!goal || !(await canView(ctx, goal))) throw E.notFound('Goal');
  goal.progress = Number(goal.progress);
  const [krs, checkins, children] = await Promise.all([
    knex('goal_key_results').where({ goal_id: id }).orderBy('sort_order'),
    knex('goal_checkins as c').leftJoin('users as u', 'u.id', 'c.user_id').where('c.goal_id', id).select('c.*', 'u.name as user_name').orderBy('c.id', 'desc').limit(50),
    knex('goals').where({ organization_id: ctx.organizationId, parent_id: id }).whereNot('status', 'cancelled').select('id', 'title', 'progress', 'scope', 'health', 'employee_id'),
  ]);
  goal.key_results = krs.map((k) => ({ ...k, progress: krProgress(k) }));
  goal.checkins = checkins.map((c) => ({ ...c, values: parseJson(c.values, {}) }));
  goal.children = children;
  goal.canEdit = await canEdit(ctx, goal);
  return goal;
}

/** Parses key results from form arrays (kr_title[], kr_start[], kr_target[], kr_unit[], kr_id[]) or an API array. */
function parseKeyResults(input) {
  if (Array.isArray(input.key_results)) return input.key_results;
  const arr = (k) => [].concat(input[k] ?? []);
  return arr('kr_title').map((title, i) => ({ id: arr('kr_id')[i], title, start_value: arr('kr_start')[i], target_value: arr('kr_target')[i], unit: arr('kr_unit')[i], current_value: arr('kr_current')[i] }));
}

async function save(ctx, id, input) {
  await ent.assertFeature(ctx.organizationId, 'performance');
  await ent.assertCanWrite(ctx.organizationId);
  const errors = {};
  const title = String(input.title || '').trim();
  if (!title) errors.title = 'Title is required.';
  const existing = id ? await knex('goals').where({ id, organization_id: ctx.organizationId }).first() : null;
  if (id && !existing) throw E.notFound('Goal');
  const scope = existing ? existing.scope : (['company', 'department', 'individual'].includes(input.scope) ? input.scope : 'individual');
  let employeeId = existing ? existing.employee_id : null;
  let departmentId = input.department_id ? Number(input.department_id) : null;
  if (scope === 'individual') {
    if (!existing) employeeId = input.employee_id ? Number(input.employee_id) : await linkedEmployee(ctx);
    if (!employeeId) errors.employee_id = 'Choose an employee.';
    else {
      const e = await knex('employees').where({ id: employeeId, organization_id: ctx.organizationId }).first('id', 'department_id');
      if (!e) errors.employee_id = 'Choose an employee.';
      else departmentId = e.department_id;
    }
  } else if (scope === 'department' && !departmentId) errors.department_id = 'Choose a department.';
  if (departmentId && !(await knex('departments').where({ id: departmentId, organization_id: ctx.organizationId }).first('id'))) errors.department_id = 'Choose a department.';
  for (const f of ['start_date', 'due_date']) if (input[f] && !isDateStr(input[f])) errors[f] = 'Use YYYY-MM-DD.';
  if (input.start_date && input.due_date && input.due_date < input.start_date) errors.due_date = 'End date must be on or after the start date.';
  let parentId = input.parent_id ? Number(input.parent_id) : null;
  if (parentId) {
    const parent = await knex('goals').where({ id: parentId, organization_id: ctx.organizationId }).first('id', 'scope');
    if (!parent || parentId === Number(id) || parent.scope === 'individual') errors.parent_id = 'Choose a company or department goal.';
  }
  const krs = parseKeyResults(input).map((k, i) => ({
    id: k.id ? Number(k.id) : null, title: String(k.title || '').trim().slice(0, 200), sort_order: i,
    start_value: Number(k.start_value || 0), target_value: k.target_value === '' || k.target_value === undefined ? NaN : Number(k.target_value),
    unit: k.unit ? String(k.unit).trim().slice(0, 20) : null, current_value: k.current_value === '' || k.current_value === undefined ? null : Number(k.current_value),
  })).filter((k) => k.title);
  if (krs.some((k) => Number.isNaN(k.start_value) || Number.isNaN(k.target_value))) errors.key_results = 'Each key result needs a start and a target number.';
  if (krs.length > 10) errors.key_results = 'Up to 10 key results per goal.';
  if (Object.keys(errors).length) throw E.validation(errors);

  const shape = { scope, employee_id: employeeId, department_id: departmentId };
  // Editing needs rights over the goal as it is now and as it will be (a manager cannot pull another
  // department's goal into their own).
  if (!(await canEdit(ctx, shape)) || (existing && !(await canEdit(ctx, existing)))) throw E.forbidden('performance.manage');
  const row = {
    title: title.slice(0, 200), description: input.description ? String(input.description).slice(0, 5000) : null,
    start_date: input.start_date || null, due_date: input.due_date || null, parent_id: parentId, department_id: departmentId,
    weight: Math.max(1, Math.min(10, Number(input.weight) || 1)),
  };
  return knex.transaction(async (trx) => {
    let goalId = id ? Number(id) : null;
    if (goalId) {
      await trx('goals').where({ id: goalId }).update(row);
      const keep = krs.filter((k) => k.id).map((k) => k.id);
      await trx('goal_key_results').where({ goal_id: goalId }).modify((q) => { if (keep.length) q.whereNotIn('id', keep); }).del();
    } else {
      [goalId] = await trx('goals').insert({ ...row, organization_id: ctx.organizationId, scope, employee_id: employeeId, created_by: ctx.userId });
    }
    for (const k of krs) {
      const data = { title: k.title, start_value: k.start_value, target_value: k.target_value, unit: k.unit, sort_order: k.sort_order };
      const owned = k.id ? await trx('goal_key_results').where({ id: k.id, goal_id: goalId }).first('id') : null;
      if (owned) await trx('goal_key_results').where({ id: k.id }).update(data);
      else await trx('goal_key_results').insert({ ...data, organization_id: ctx.organizationId, goal_id: goalId, current_value: k.current_value ?? k.start_value });
    }
    const all = await trx('goal_key_results').where({ goal_id: goalId });
    const progress = goalProgress(all);
    if (progress !== null) await trx('goals').where({ id: goalId }).update({ progress });
    await audit.record(ctx, id ? 'goal.updated' : 'goal.created', { entityType: 'goal', entityId: goalId, newValues: { name: title, scope } }, trx);
    if (!id && employeeId) {
      const owner = await trx('employees').where({ id: employeeId }).first('user_id');
      if (owner?.user_id && owner.user_id !== ctx.userId) await notifications.notify(ctx.organizationId, [owner.user_id], 'goal_assigned', { title }, `/app/performance/goals/${goalId}`, trx);
    }
    return goalId;
  });
}

/** Records progress: new key-result values (or a manual % when the goal has none), health and a note. */
async function checkIn(ctx, id, input) {
  await ent.assertCanWrite(ctx.organizationId);
  const goal = await knex('goals').where({ id, organization_id: ctx.organizationId }).first();
  if (!goal || !(await canView(ctx, goal))) throw E.notFound('Goal');
  if (!(await canEdit(ctx, goal))) throw E.forbidden('performance.manage');
  if (goal.status !== 'active') throw E.conflict('GOAL_CLOSED', 'This goal is closed.');
  const health = HEALTH.includes(input.health) ? input.health : goal.health;
  const krs = await knex('goal_key_results').where({ goal_id: id });
  const values = {};
  let progress;
  await knex.transaction(async (trx) => {
    if (krs.length) {
      for (const k of krs) {
        const raw = input[`kr_${k.id}`] ?? input.values?.[k.id];
        if (raw === undefined || raw === '') { values[k.id] = Number(k.current_value); continue; }
        const v = Number(raw);
        if (Number.isNaN(v) || Math.abs(v) > 1e13) throw E.validation({ [`kr_${k.id}`]: 'Enter a valid number.' });
        values[k.id] = v;
        await trx('goal_key_results').where({ id: k.id }).update({ current_value: v });
        k.current_value = v;
      }
      progress = goalProgress(krs);
    } else {
      const p = Number(input.progress);
      if (Number.isNaN(p) || p < 0 || p > 100) throw E.validation({ progress: 'Enter a percentage between 0 and 100.' });
      progress = Math.round(p * 100) / 100;
    }
    await trx('goals').where({ id }).update({ progress, health });
    await trx('goal_checkins').insert({
      organization_id: ctx.organizationId, goal_id: id, user_id: ctx.userId, progress, health, values: JSON.stringify(values),
      note: input.note ? String(input.note).slice(0, 2000) : null,
    });
  });
  return progress;
}

async function setStatus(ctx, id, status) {
  if (!['active', 'done', 'cancelled'].includes(status)) throw E.validation({ status: 'Invalid status.' });
  const goal = await knex('goals').where({ id, organization_id: ctx.organizationId }).first();
  if (!goal || !(await canView(ctx, goal))) throw E.notFound('Goal');
  if (!(await canEdit(ctx, goal))) throw E.forbidden('performance.manage');
  await knex('goals').where({ id }).update({ status, ...(status === 'done' ? { progress: Math.max(Number(goal.progress), 0) } : {}) });
  await audit.record(ctx, `goal.${status === 'active' ? 'reopened' : status}`, { entityType: 'goal', entityId: id, newValues: { name: goal.title } });
}

async function alignOptions(organizationId) {
  return knex('goals').where({ organization_id: organizationId, status: 'active' }).whereNot('scope', 'individual').select('id', 'title', 'scope').orderBy('title');
}

async function summary(ctx) {
  const rows = await list(ctx, { status: 'active' });
  const by = (h) => rows.filter((g) => g.health === h).length;
  return { total: rows.length, on_track: by('on_track'), at_risk: by('at_risk'), off_track: by('off_track'),
    avgProgress: rows.length ? Math.round(rows.reduce((s, g) => s + g.progress, 0) / rows.length) : 0 };
}

module.exports = { HEALTH, krProgress, goalProgress, canEdit, list, get, save, checkIn, setStatus, alignOptions, summary };
