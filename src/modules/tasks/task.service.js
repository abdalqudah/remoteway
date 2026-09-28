const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const { z, validate, optionalString, optionalId, emptyToUndefined } = require('../../core/validate');
const { isDateStr } = require('../../core/workdays');
const ent = require('../billing/entitlements.service');
const notifications = require('../notifications/notification.service');

const STATUSES = ['todo', 'in_progress', 'review', 'done'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const taskSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.').max(200),
  description: optionalString(5000),
  project_id: optionalId(),
  assignee_user_id: optionalId(),
  priority: z.enum(PRIORITIES).default('medium'),
  status: z.enum(STATUSES).default('todo'),
  due_date: z.preprocess(emptyToUndefined, z.string().refine(isDateStr, 'Use YYYY-MM-DD.').optional()),
});

const projectSchema = z.object({
  name: z.string().trim().min(2, 'Name is required.').max(150),
  description: optionalString(2000),
  status: z.enum(['active', 'on_hold', 'completed', 'archived']).default('active'),
  due_date: z.preprocess(emptyToUndefined, z.string().refine(isDateStr, 'Use YYYY-MM-DD.').optional()),
});

const canManage = (ctx) => ctx.permissions.has('tasks.manage');
const canSeeAll = (ctx) => ctx.permissions.has('tasks.view') || ctx.permissions.has('tasks.manage');

async function members(organizationId) {
  return knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.organization_id': organizationId, 'm.status': 'active' })
    .select('u.id', 'u.name').orderBy('u.name');
}

async function assertMember(organizationId, userId, field = 'assignee_user_id') {
  if (!userId) return;
  const m = await knex('memberships').where({ organization_id: organizationId, user_id: userId, status: 'active' }).first('id');
  if (!m) throw E.validation({ [field]: 'Choose a member of this workspace.' });
}

async function assertProject(organizationId, projectId) {
  if (!projectId) return;
  const p = await knex('projects').where({ id: projectId, organization_id: organizationId }).first('id');
  if (!p) throw E.validation({ project_id: 'Project not found.' });
}

function base(organizationId) {
  return knex('tasks as t').leftJoin('projects as p', 'p.id', 't.project_id').leftJoin('users as a', 'a.id', 't.assignee_user_id')
    .leftJoin('users as c', 'c.id', 't.created_by').where('t.organization_id', organizationId)
    .select('t.*', 'p.name as project_name', 'a.name as assignee_name', 'c.name as created_by_name');
}

function scope(ctx, q) {
  if (!canSeeAll(ctx)) q.where((w) => w.where('t.assignee_user_id', ctx.userId).orWhere('t.created_by', ctx.userId));
}

async function list(ctx, filters = {}) {
  const q = base(ctx.organizationId);
  scope(ctx, q);
  if (filters.mine) q.where('t.assignee_user_id', ctx.userId);
  if (filters.project_id) q.where('t.project_id', Number(filters.project_id));
  if (STATUSES.includes(filters.status)) q.where('t.status', filters.status);
  if (filters.assignee) q.where('t.assignee_user_id', Number(filters.assignee));
  if (filters.q) q.where('t.title', 'like', `%${String(filters.q).replace(/[%_]/g, '\\$&')}%`);
  if (!filters.include_done) q.where((w) => w.whereNot('t.status', 'done').orWhere('t.completed_at', '>=', new Date(Date.now() - 14 * 86_400_000)));
  return q.orderByRaw("FIELD(t.priority, 'urgent', 'high', 'medium', 'low')").orderByRaw('t.due_date IS NULL, t.due_date').limit(500);
}

async function get(ctx, id) {
  const q = base(ctx.organizationId).where('t.id', id);
  scope(ctx, q);
  const task = await q.first();
  if (!task) throw E.notFound('Task');
  task.comments = await knex('task_comments as c').leftJoin('users as u', 'u.id', 'c.user_id').where({ 'c.task_id': id, 'c.organization_id': ctx.organizationId })
    .select('c.*', 'u.name as user_name').orderBy('c.id');
  return task;
}

async function create(ctx, input) {
  await ent.assertFeature(ctx.organizationId, 'tasks');
  await ent.assertCanWrite(ctx.organizationId);
  const data = validate(taskSchema, input);
  if (data.project_id) await ent.assertFeature(ctx.organizationId, 'projects');
  // Without tasks.manage people can only create tasks for themselves.
  const assignee = canManage(ctx) ? (data.assignee_user_id ?? null) : ctx.userId;
  await assertMember(ctx.organizationId, assignee);
  await assertProject(ctx.organizationId, data.project_id);
  const [id] = await knex('tasks').insert({
    organization_id: ctx.organizationId, project_id: data.project_id ?? null, title: data.title, description: data.description ?? null,
    assignee_user_id: assignee, priority: data.priority, status: data.status, due_date: data.due_date ?? null, created_by: ctx.userId,
    completed_at: data.status === 'done' ? new Date() : null,
  });
  await audit.record(ctx, 'task.created', { entityType: 'task', entityId: id, newValues: { name: data.title } });
  if (assignee && assignee !== ctx.userId) await notifications.notify(ctx.organizationId, [assignee], 'task_assigned', { title: data.title }, `/app/tasks/${id}`);
  return id;
}

async function update(ctx, id, input) {
  await ent.assertCanWrite(ctx.organizationId);
  const task = await get(ctx, id);
  const isCreator = task.created_by === ctx.userId;
  if (!canManage(ctx) && !isCreator) throw E.forbidden('tasks.manage');
  const data = validate(taskSchema, input);
  if (data.project_id) await ent.assertFeature(ctx.organizationId, 'projects');
  const assignee = canManage(ctx) ? (data.assignee_user_id ?? null) : task.assignee_user_id;
  await assertMember(ctx.organizationId, assignee);
  await assertProject(ctx.organizationId, data.project_id);
  const patch = {
    title: data.title, description: data.description ?? null, project_id: data.project_id ?? null, assignee_user_id: assignee,
    priority: data.priority, status: data.status, due_date: data.due_date ?? null,
    completed_at: data.status === 'done' ? (task.completed_at || new Date()) : null,
  };
  const d = audit.diff(task, patch);
  await knex('tasks').where({ id, organization_id: ctx.organizationId }).update(patch);
  if (d.changed) await audit.record(ctx, 'task.updated', { entityType: 'task', entityId: id, oldValues: d.oldValues, newValues: { ...d.newValues, name: data.title } });
  if (assignee && assignee !== task.assignee_user_id && assignee !== ctx.userId) {
    await notifications.notify(ctx.organizationId, [assignee], 'task_assigned', { title: data.title }, `/app/tasks/${id}`);
  }
}

/** Status changes are allowed for the assignee too (board / quick actions). */
async function setStatus(ctx, id, status) {
  if (!STATUSES.includes(status)) throw E.validation({ status: 'Invalid status.' });
  await ent.assertCanWrite(ctx.organizationId);
  const task = await get(ctx, id);
  if (!canManage(ctx) && task.created_by !== ctx.userId && task.assignee_user_id !== ctx.userId) throw E.forbidden('tasks.manage');
  if (task.status === status) return;
  await knex('tasks').where({ id, organization_id: ctx.organizationId }).update({ status, completed_at: status === 'done' ? new Date() : null });
  await audit.record(ctx, 'task.status_changed', { entityType: 'task', entityId: id, oldValues: { status: task.status }, newValues: { status, name: task.title } });
  if (status === 'done' && task.created_by && task.created_by !== ctx.userId) {
    await notifications.notify(ctx.organizationId, [task.created_by], 'task_completed', { title: task.title }, `/app/tasks/${id}`);
  }
}

async function remove(ctx, id) {
  const task = await get(ctx, id);
  if (!canManage(ctx) && task.created_by !== ctx.userId) throw E.forbidden('tasks.manage');
  await knex('tasks').where({ id, organization_id: ctx.organizationId }).del();
  await audit.record(ctx, 'task.deleted', { entityType: 'task', entityId: id, oldValues: { name: task.title } });
}

async function comment(ctx, id, body) {
  const text = String(body || '').trim();
  if (!text) throw E.validation({ body: 'Write a comment.' });
  await ent.assertCanWrite(ctx.organizationId);
  const task = await get(ctx, id);
  await knex('task_comments').insert({ organization_id: ctx.organizationId, task_id: id, user_id: ctx.userId, body: text.slice(0, 5000) });
  const others = [task.assignee_user_id, task.created_by].filter((u) => u && u !== ctx.userId);
  await notifications.notify(ctx.organizationId, others, 'task_comment', { title: task.title }, `/app/tasks/${id}`);
}

// ---------- Projects ----------
async function listProjects(ctx) {
  const rows = await knex('projects as p').leftJoin('users as u', 'u.id', 'p.owner_user_id').where('p.organization_id', ctx.organizationId)
    .select('p.*', 'u.name as owner_name',
      knex('tasks').count('*').where('project_id', knex.ref('p.id')).as('task_count'),
      knex('tasks').count('*').where('project_id', knex.ref('p.id')).where('status', 'done').as('done_count'))
    .orderByRaw("FIELD(p.status, 'active', 'on_hold', 'completed', 'archived')").orderBy('p.name');
  return rows.map((r) => ({ ...r, task_count: Number(r.task_count), done_count: Number(r.done_count) }));
}

async function saveProject(ctx, id, input) {
  await ent.assertFeature(ctx.organizationId, 'projects');
  await ent.assertCanWrite(ctx.organizationId);
  if (!canManage(ctx)) throw E.forbidden('tasks.manage');
  const data = validate(projectSchema, input);
  const row = { name: data.name, description: data.description ?? null, status: data.status, due_date: data.due_date ?? null };
  if (id) {
    const before = await knex('projects').where({ id, organization_id: ctx.organizationId }).first();
    if (!before) throw E.notFound('Project');
    const d = audit.diff(before, row);
    await knex('projects').where({ id }).update(row);
    if (d.changed) await audit.record(ctx, 'project.updated', { entityType: 'project', entityId: id, oldValues: d.oldValues, newValues: d.newValues });
    return Number(id);
  }
  const [newId] = await knex('projects').insert({ ...row, organization_id: ctx.organizationId, owner_user_id: ctx.userId });
  await audit.record(ctx, 'project.created', { entityType: 'project', entityId: newId, newValues: { name: data.name } });
  return newId;
}

async function myOpenCount(ctx) {
  const [{ n }] = await knex('tasks').where({ organization_id: ctx.organizationId, assignee_user_id: ctx.userId }).whereNot('status', 'done').count({ n: '*' });
  return Number(n);
}

module.exports = { STATUSES, PRIORITIES, members, list, get, create, update, setStatus, remove, comment, listProjects, saveProject, myOpenCount };
