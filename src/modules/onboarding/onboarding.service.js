// Employee onboarding: templates (checklists) → a plan per new employee → tasks for HR, the manager and the employee.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const { isDateStr, todayIn, addDays } = require('../../core/workdays');
const { ONBOARDING_DEFAULT } = require('../../db/catalog');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');
const notifications = require('../notifications/notification.service');

const CATEGORIES = ['contract', 'documents', 'bank', 'policies', 'equipment', 'accounts', 'training', 'manager', 'other'];
const ASSIGNEES = ['hr', 'manager', 'employee'];

async function ensureDefaultTemplate(organizationId) {
  const existing = await knex('onboarding_templates').where({ organization_id: organizationId }).first('id');
  if (existing) return;
  const org = await orgs.get(organizationId);
  await knex.transaction(async (trx) => {
    const [templateId] = await trx('onboarding_templates').insert({ organization_id: organizationId, name: org.locale === 'ar' ? 'التهيئة الأساسية' : 'Standard onboarding', is_default: true });
    await trx('onboarding_template_items').insert(ONBOARDING_DEFAULT.map((d, i) => ({
      organization_id: organizationId, template_id: templateId, title: org.locale === 'ar' ? d.title_ar : d.title, category: d.category,
      assignee: d.assignee, due_offset_days: d.due, sort_order: i,
    })));
  });
}

async function listTemplates(organizationId) {
  await ensureDefaultTemplate(organizationId);
  const templates = await knex('onboarding_templates').where({ organization_id: organizationId }).orderBy([{ column: 'is_default', order: 'desc' }, 'id']);
  const items = await knex('onboarding_template_items').where({ organization_id: organizationId }).orderBy(['template_id', 'sort_order', 'id']);
  return templates.map((t) => ({ ...t, items: items.filter((i) => i.template_id === t.id) }));
}

async function saveTemplate(ctx, id, { name, items }) {
  await ent.assertFeature(ctx.organizationId, 'onboarding');
  await ent.assertCanWrite(ctx.organizationId);
  const title = String(name || '').trim();
  if (!title) throw E.validation({ name: 'Name is required.' });
  const clean = (Array.isArray(items) ? items : []).map((i, idx) => ({
    title: String(i.title || '').trim().slice(0, 200), category: CATEGORIES.includes(i.category) ? i.category : 'other',
    assignee: ASSIGNEES.includes(i.assignee) ? i.assignee : 'hr', due_offset_days: Math.max(-90, Math.min(365, Number(i.due_offset_days) || 0)), sort_order: idx,
  })).filter((i) => i.title);
  if (!clean.length) throw E.validation({ items: 'Add at least one task.' });
  return knex.transaction(async (trx) => {
    let templateId = id;
    if (id) {
      const t = await trx('onboarding_templates').where({ id, organization_id: ctx.organizationId }).first();
      if (!t) throw E.notFound('Template');
      await trx('onboarding_templates').where({ id }).update({ name: title.slice(0, 120) });
      await trx('onboarding_template_items').where({ template_id: id }).del();
    } else {
      [templateId] = await trx('onboarding_templates').insert({ organization_id: ctx.organizationId, name: title.slice(0, 120), is_default: false });
    }
    await trx('onboarding_template_items').insert(clean.map((i) => ({ ...i, organization_id: ctx.organizationId, template_id: templateId })));
    await audit.record(ctx, id ? 'onboarding_template.updated' : 'onboarding_template.created', { entityType: 'onboarding_template', entityId: templateId, newValues: { name: title, tasks: clean.length } }, trx);
    return templateId;
  });
}

async function setDefaultTemplate(ctx, id) {
  const t = await knex('onboarding_templates').where({ id, organization_id: ctx.organizationId }).first();
  if (!t) throw E.notFound('Template');
  await knex('onboarding_templates').where({ organization_id: ctx.organizationId }).update({ is_default: knex.raw('id = ?', [id]) });
}

/** Resolves who does each task: HR = the plan creator, manager = the employee's manager, employee = their login. */
async function resolveAssignees(organizationId, employee, creatorUserId) {
  let managerUser = null;
  if (employee.manager_id) managerUser = (await knex('employees').where({ id: employee.manager_id, organization_id: organizationId }).first('user_id'))?.user_id || null;
  return { hr: creatorUserId || null, manager: managerUser || creatorUserId || null, employee: employee.user_id || null };
}

async function startPlan(ctx, employeeId, { template_id: templateId, start_date: startDate } = {}) {
  await ent.assertFeature(ctx.organizationId, 'onboarding');
  await ent.assertCanWrite(ctx.organizationId);
  const employee = await knex('employees').where({ id: employeeId, organization_id: ctx.organizationId }).first();
  if (!employee) throw E.notFound('Employee');
  const active = await knex('onboarding_plans').where({ organization_id: ctx.organizationId, employee_id: employeeId, status: 'active' }).first('id');
  if (active) return active.id;
  const templates = await listTemplates(ctx.organizationId);
  const template = templates.find((t) => t.id === Number(templateId)) || templates.find((t) => t.is_default) || templates[0];
  const org = await orgs.get(ctx.organizationId);
  const start = isDateStr(startDate) ? startDate : todayIn(org.timezone);
  const who = await resolveAssignees(ctx.organizationId, employee, ctx.userId);
  return knex.transaction(async (trx) => {
    const [planId] = await trx('onboarding_plans').insert({ organization_id: ctx.organizationId, employee_id: employeeId, template_id: template.id, start_date: start, created_by: ctx.userId });
    await trx('onboarding_tasks').insert(template.items.map((i) => ({
      organization_id: ctx.organizationId, plan_id: planId, title: i.title, category: i.category, assignee: i.assignee,
      assignee_user_id: who[i.assignee], due_date: addDays(start, i.due_offset_days), sort_order: i.sort_order,
    })));
    await audit.record(ctx, 'onboarding.started', { entityType: 'employee', entityId: employeeId, newValues: { name: `${employee.first_name} ${employee.last_name}`, template: template.name } }, trx);
    const recipients = [...new Set([who.manager, who.employee].filter((u) => u && u !== ctx.userId))];
    await notifications.notify(ctx.organizationId, recipients, 'onboarding_started', { name: `${employee.first_name} ${employee.last_name}` }, `/app/employee-onboarding/${planId}`, trx);
    return planId;
  });
}

function planBase(organizationId) {
  return knex('onboarding_plans as p').join('employees as e', 'e.id', 'p.employee_id').leftJoin('departments as d', 'd.id', 'e.department_id')
    .where('p.organization_id', organizationId)
    .select('p.*', 'e.first_name', 'e.last_name', 'e.job_title', 'e.user_id as employee_user_id', 'd.name as department_name',
      knex('onboarding_tasks').count('*').where('plan_id', knex.ref('p.id')).as('task_count'),
      knex('onboarding_tasks').count('*').where('plan_id', knex.ref('p.id')).whereNotNull('completed_at').as('done_count'));
}

const withProgress = (p) => ({ ...p, task_count: Number(p.task_count), done_count: Number(p.done_count), progress: Number(p.task_count) ? Math.round((Number(p.done_count) / Number(p.task_count)) * 100) : 0 });

async function canSeePlan(ctx, plan) {
  if (ctx.permissions.has('onboarding.manage')) return true;
  if (plan.employee_user_id === ctx.userId) return true;
  const mine = await knex('onboarding_tasks').where({ plan_id: plan.id, assignee_user_id: ctx.userId }).first('id');
  return Boolean(mine);
}

async function listPlans(ctx, { status = 'active' } = {}) {
  const q = planBase(ctx.organizationId).orderBy('p.start_date', 'desc');
  if (['active', 'completed', 'cancelled'].includes(status)) q.where('p.status', status);
  if (!ctx.permissions.has('onboarding.manage')) {
    q.where((w) => w.where('e.user_id', ctx.userId).orWhereExists(function sub() {
      this.select('*').from('onboarding_tasks as t').whereRaw('t.plan_id = p.id').where('t.assignee_user_id', ctx.userId);
    }));
  }
  return (await q).map(withProgress);
}

async function getPlan(ctx, id) {
  const plan = await planBase(ctx.organizationId).where('p.id', id).first();
  if (!plan || !(await canSeePlan(ctx, plan))) throw E.notFound('Onboarding plan');
  plan.tasks = await knex('onboarding_tasks as t').leftJoin('users as u', 'u.id', 't.assignee_user_id').leftJoin('users as c', 'c.id', 't.completed_by')
    .where({ 't.plan_id': id, 't.organization_id': ctx.organizationId }).select('t.*', 'u.name as assignee_name', 'c.name as completed_by_name')
    .orderBy(['t.due_date', 't.sort_order']);
  return withProgress(plan);
}

async function setTaskDone(ctx, taskId, done) {
  await ent.assertCanWrite(ctx.organizationId);
  const task = await knex('onboarding_tasks').where({ id: taskId, organization_id: ctx.organizationId }).first();
  if (!task) throw E.notFound('Task');
  if (!ctx.permissions.has('onboarding.manage') && task.assignee_user_id !== ctx.userId) throw E.forbidden('onboarding.manage');
  await knex('onboarding_tasks').where({ id: taskId }).update(done ? { completed_at: new Date(), completed_by: ctx.userId } : { completed_at: null, completed_by: null });
  // Complete (or reopen) the plan when every task is done.
  const [{ open }] = await knex('onboarding_tasks').where({ plan_id: task.plan_id }).whereNull('completed_at').count({ open: '*' });
  const plan = await knex('onboarding_plans').where({ id: task.plan_id }).first();
  if (Number(open) === 0 && plan.status === 'active') {
    await knex('onboarding_plans').where({ id: plan.id }).update({ status: 'completed', completed_at: new Date() });
    await audit.record(ctx, 'onboarding.completed', { entityType: 'employee', entityId: plan.employee_id });
  } else if (Number(open) > 0 && plan.status === 'completed') {
    await knex('onboarding_plans').where({ id: plan.id }).update({ status: 'active', completed_at: null });
  }
  return task.plan_id;
}

async function cancelPlan(ctx, id) {
  if (!ctx.permissions.has('onboarding.manage')) throw E.forbidden('onboarding.manage');
  const n = await knex('onboarding_plans').where({ id, organization_id: ctx.organizationId }).update({ status: 'cancelled' });
  if (!n) throw E.notFound('Onboarding plan');
  await audit.record(ctx, 'onboarding.cancelled', { entityType: 'onboarding_plan', entityId: id });
}

async function myOpenTasks(ctx) {
  return knex('onboarding_tasks as t').join('onboarding_plans as p', 'p.id', 't.plan_id').join('employees as e', 'e.id', 'p.employee_id')
    .where({ 't.organization_id': ctx.organizationId, 't.assignee_user_id': ctx.userId, 'p.status': 'active' }).whereNull('t.completed_at')
    .select('t.*', 'e.first_name', 'e.last_name').orderBy('t.due_date').limit(20);
}

async function employeesWithoutPlan(organizationId) {
  return knex('employees as e').where('e.organization_id', organizationId).whereNot('e.status', 'terminated')
    .whereNotExists(function sub() { this.select('*').from('onboarding_plans as p').whereRaw('p.employee_id = e.id').whereIn('p.status', ['active', 'completed']); })
    .select('e.id', 'e.first_name', 'e.last_name', 'e.job_title', 'e.joining_date').orderBy('e.joining_date', 'desc').limit(200);
}

module.exports = {
  CATEGORIES, ASSIGNEES, listTemplates, saveTemplate, setDefaultTemplate, startPlan, listPlans, getPlan, setTaskDone, cancelPlan, myOpenTasks, employeesWithoutPlan,
};
