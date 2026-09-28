// Advanced Automation: "when <trigger> if <conditions> then <actions>" rules.
// Event triggers are queued inside the transaction of the action that caused them (outbox), date
// triggers by an hourly sweep. Each rule acts at most once per occurrence (automation_runs unique key),
// runs as the rule's author, and actions performed by automations never trigger other automations.
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const jobs = require('../../core/jobs');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');
const { todayIn, addDays } = require('../../core/workdays');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');
const notifications = require('../notifications/notification.service');
const { formatDate } = require('../../core/format');

const MAX_RULES = 50;
const MAX_ACTIONS = 5;
const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));

// ---------- Catalog ----------
const EVENT_TRIGGERS = {
  'employee.created': { feature: 'employees' },
  'employee.terminated': { feature: 'employees' },
  'onboarding.completed': { feature: 'onboarding' },
  'leave.requested': { feature: 'leave', leave: true },
  'leave.approved': { feature: 'leave', leave: true },
  'leave.rejected': { feature: 'leave', leave: true },
  'document.uploaded': { feature: 'documents' },
  'application.hired': { feature: 'recruitment' },
  'review.completed': { feature: 'performance' },
  'course.completed': { feature: 'learning' },
};
const SCHEDULE_TRIGGERS = {
  document_expiring: { feature: 'documents', days: 'before' },
  certificate_expiring: { feature: 'learning', days: 'before' },
  probation_ending: { feature: 'employees', days: 'before' },
  days_after_joining: { feature: 'employees', days: 'after' },
  work_anniversary: { feature: 'employees' },
};
const TRIGGERS = { ...EVENT_TRIGGERS, ...SCHEDULE_TRIGGERS };
const ACTIONS = { notify: {}, create_task: { feature: 'tasks' }, assign_course: { feature: 'learning' }, post_chat: { feature: 'integrations' } };
const RECIPIENTS = ['employee', 'manager', 'department_head'];
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern', 'freelance'];
const DOC_CATEGORIES = ['contract', 'id', 'passport', 'iqama', 'certificate', 'other'];

// ---------- Rules ----------
function present(r) {
  return { ...r, trigger_options: parse(r.trigger_options, {}), conditions: parse(r.conditions, {}), actions: parse(r.actions, []) };
}

async function list(organizationId) {
  const rows = await knex('automation_rules as r').leftJoin('users as u', 'u.id', 'r.created_by').where('r.organization_id', organizationId)
    .orderBy('r.id', 'desc').select('r.*', 'u.name as created_by_name');
  return rows.map(present);
}

async function get(ctx, id) {
  const r = await knex('automation_rules').where({ id, organization_id: ctx.organizationId }).first();
  if (!r) throw E.notFound('Automation');
  return present(r);
}

/** Validates and normalises a rule from the builder form. */
async function normalize(ctx, input) {
  const errors = {};
  const e = await ent.getEntitlements(ctx.organizationId);
  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 150) errors.name = 'Give the automation a name.';
  const trigger = String(input.trigger || '');
  if (!TRIGGERS[trigger]) errors.trigger = 'Choose when it runs.';
  else if (!e.features.has(TRIGGERS[trigger].feature)) errors.trigger = 'This trigger needs a module that is not in your plan.';
  const options = {};
  if (TRIGGERS[trigger] && SCHEDULE_TRIGGERS[trigger] && SCHEDULE_TRIGGERS[trigger].days) {
    const d = Number(input.days);
    if (!Number.isInteger(d) || d < 0 || d > 365) errors.days = 'Use 0 to 365 days.';
    options.days = d;
  }
  if (trigger === 'document_expiring' && input.category) {
    if (!DOC_CATEGORIES.includes(input.category)) errors.category = 'Choose a document type.'; else options.category = input.category;
  }
  const conditions = {};
  const depts = arr(input.department_ids).map(Number).filter((n) => n > 0);
  if (depts.length) {
    const found = await knex('departments').where({ organization_id: ctx.organizationId }).whereIn('id', depts).pluck('id');
    if (found.length !== depts.length) errors.conditions = 'Choose departments from the list.';
    conditions.department_ids = found;
  }
  const types = arr(input.employment_types).filter((t) => EMPLOYMENT_TYPES.includes(t));
  if (types.length) conditions.employment_types = types;
  if (['saudi', 'non_saudi'].includes(input.nationality)) conditions.nationality = input.nationality;
  if (TRIGGERS[trigger] && TRIGGERS[trigger].leave) {
    const lt = arr(input.leave_type_ids).map(Number).filter((n) => n > 0);
    if (lt.length) conditions.leave_type_ids = await knex('leave_types').where({ organization_id: ctx.organizationId }).whereIn('id', lt).pluck('id');
    if (input.min_days !== undefined && String(input.min_days).trim() !== '') {
      const m = Number(input.min_days);
      if (!Number.isFinite(m) || m < 0 || m > 365) errors.conditions = 'Use 0 to 365 days.'; else conditions.min_days = m;
    }
  }
  const actions = [];
  const kinds = arr(input.action_type);
  for (let i = 0; i < kinds.length; i += 1) {
    const type = kinds[i];
    if (!type) continue;
    const pick = (k) => arr(input[k])[i];
    if (!ACTIONS[type]) { errors.actions = 'Invalid action.'; break; }
    if (ACTIONS[type].feature && !e.features.has(ACTIONS[type].feature)) { errors.actions = 'This action needs a module that is not in your plan.'; break; }
    const a = { type };
    if (type === 'notify' || type === 'create_task') {
      const to = String(pick('action_to') || '');
      if (!(await validRecipient(ctx, to))) { errors.actions = 'Choose who receives each action.'; break; }
      a.to = to;
    }
    if (type === 'notify' || type === 'post_chat') {
      const msg = String(pick('action_message') || '').trim();
      if (!msg || msg.length > 500) { errors.actions = 'Write a message (up to 500 characters).'; break; }
      a.message = msg;
    }
    if (type === 'create_task') {
      const title = String(pick('action_message') || '').trim();
      if (!title || title.length > 200) { errors.actions = 'Write the task title (up to 200 characters).'; break; }
      a.title = title;
      delete a.message;
    }
    if (type === 'create_task' || type === 'assign_course') {
      const d = Number(pick('action_due_days') || 0);
      if (!Number.isInteger(d) || d < 0 || d > 365) { errors.actions = 'Use 0 to 365 days for due dates.'; break; }
      a.due_days = d;
    }
    if (type === 'assign_course') {
      const c = await knex('courses').where({ id: Number(pick('action_course_id')), organization_id: ctx.organizationId, status: 'published' }).first('id');
      if (!c) { errors.actions = 'Choose a published course.'; break; }
      a.course_id = c.id;
    }
    actions.push(a);
  }
  if (!errors.actions && !actions.length) errors.actions = 'Add at least one action.';
  if (actions.length > MAX_ACTIONS) errors.actions = `Use at most ${MAX_ACTIONS} actions.`;
  if (Object.keys(errors).length) throw E.validation(errors);
  return { name, trigger, trigger_options: options, conditions, actions, is_active: input.is_active === 'on' || input.is_active === true };
}

async function validRecipient(ctx, to) {
  if (RECIPIENTS.includes(to)) return true;
  const [kind, ref] = to.split(':');
  if (kind === 'role') return Boolean(await knex('roles').where({ key: ref }).andWhere((q) => q.whereNull('organization_id').orWhere('organization_id', ctx.organizationId)).first('id'));
  if (kind === 'user') return Boolean(await knex('memberships').where({ organization_id: ctx.organizationId, user_id: Number(ref), status: 'active' }).first('user_id'));
  return false;
}

async function save(ctx, id, input) {
  await ent.assertFeature(ctx.organizationId, 'automation');
  await ent.assertCanWrite(ctx.organizationId);
  const r = await normalize(ctx, input);
  const row = { ...r, trigger_options: JSON.stringify(r.trigger_options), conditions: JSON.stringify(r.conditions), actions: JSON.stringify(r.actions) };
  if (id) {
    const n = await knex('automation_rules').where({ id, organization_id: ctx.organizationId }).update({ ...row, updated_at: new Date() });
    if (!n) throw E.notFound('Automation');
  } else {
    const [{ n }] = await knex('automation_rules').where({ organization_id: ctx.organizationId }).count({ n: '*' });
    if (Number(n) >= MAX_RULES) throw new AppError('AUTOMATION_LIMIT', `You can have up to ${MAX_RULES} automations.`, 409);
    [id] = await knex('automation_rules').insert({ ...row, organization_id: ctx.organizationId, created_by: ctx.userId });
  }
  cache.forgetPrefix(`automation:${ctx.organizationId}`);
  await audit.record(ctx, 'automation.saved', { entityType: 'automation', entityId: id, newValues: { name: r.name, trigger: r.trigger } });
  return id;
}

async function setActive(ctx, id, on) {
  const n = await knex('automation_rules').where({ id, organization_id: ctx.organizationId }).update({ is_active: Boolean(on), updated_at: new Date() });
  if (!n) throw E.notFound('Automation');
  cache.forgetPrefix(`automation:${ctx.organizationId}`);
}

async function remove(ctx, id) {
  const r = await get(ctx, id);
  await knex('automation_rules').where({ id: r.id }).del();
  cache.forgetPrefix(`automation:${ctx.organizationId}`);
  await audit.record(ctx, 'automation.deleted', { entityType: 'automation', entityId: r.id, newValues: { name: r.name } });
}

async function runs(organizationId, { ruleId, limit = 50 } = {}) {
  const q = knex('automation_runs as x').join('automation_rules as r', 'r.id', 'x.rule_id').leftJoin('employees as e', 'e.id', 'x.employee_id')
    .where('x.organization_id', organizationId).orderBy('x.id', 'desc').limit(limit)
    .select('x.*', 'r.name as rule_name', 'e.first_name', 'e.last_name');
  if (ruleId) q.where('x.rule_id', ruleId);
  return (await q).map((x) => ({ ...x, detail: parse(x.detail, []) }));
}

// ---------- Subject & context ----------
async function employeeContext(organizationId, employeeId) {
  const e = await knex('employees as e').leftJoin('departments as d', 'd.id', 'e.department_id')
    .where({ 'e.id': employeeId, 'e.organization_id': organizationId }).first('e.*', 'd.name as department_name', 'd.head_employee_id');
  return e || null;
}

/** Finds the employee an event is about, plus template values. */
async function resolveEvent(organizationId, { event, entityId, actorUserId }) {
  const id = Number(entityId);
  if (event.startsWith('leave.')) {
    const r = await knex('leave_requests as r').join('leave_types as t', 't.id', 'r.leave_type_id').where({ 'r.id': id, 'r.organization_id': organizationId })
      .first('r.employee_id', 'r.days', 'r.start_date', 'r.leave_type_id', 't.name as type_name');
    return r ? { employeeId: r.employee_id, vars: { leave_type: r.type_name, days: Number(r.days), date: ymd(r.start_date) }, leave: { type_id: r.leave_type_id, days: Number(r.days) } } : null;
  }
  if (event === 'document.uploaded') {
    const d = await knex('documents').where({ id, organization_id: organizationId }).first('employee_id', 'title', 'expires_at');
    return d && d.employee_id ? { employeeId: d.employee_id, vars: { document: d.title, date: d.expires_at ? ymd(d.expires_at) : '' } } : null;
  }
  if (event === 'application.hired') {
    const a = await knex('applications').where({ id, organization_id: organizationId }).first('hired_employee_id');
    return a && a.hired_employee_id ? { employeeId: a.hired_employee_id, vars: {} } : null;
  }
  if (event === 'review.completed') {
    const r = await knex('reviews').where({ id, organization_id: organizationId }).first('employee_id');
    return r ? { employeeId: r.employee_id, vars: {} } : null;
  }
  if (event === 'course.completed') {
    const e = actorUserId ? await knex('employees').where({ organization_id: organizationId, user_id: actorUserId }).first('id') : null;
    const c = await knex('courses').where({ id, organization_id: organizationId }).first('title');
    return e ? { employeeId: e.id, vars: { course: c ? c.title : '' } } : null;
  }
  return { employeeId: id, vars: {} }; // employee.* and onboarding.completed carry the employee id
}

function conditionsMet(conditions, emp, extra = {}) {
  const c = conditions || {};
  if (c.department_ids && c.department_ids.length && !c.department_ids.includes(emp.department_id)) return 'department';
  if (c.employment_types && c.employment_types.length && !c.employment_types.includes(emp.employment_type)) return 'employment_type';
  if (c.nationality === 'saudi' && emp.nationality !== 'SA') return 'nationality';
  if (c.nationality === 'non_saudi' && (!emp.nationality || emp.nationality === 'SA')) return 'nationality';
  if (c.leave_type_ids && c.leave_type_ids.length && extra.leave && !c.leave_type_ids.includes(extra.leave.type_id)) return 'leave_type';
  if (c.min_days != null && extra.leave && extra.leave.days < c.min_days) return 'min_days';
  return null;
}

async function recipients(organizationId, to, emp) {
  let ids = [];
  if (to === 'employee') ids = emp.user_id ? [emp.user_id] : [];
  else if (to === 'manager' && emp.manager_id) ids = await knex('employees').where({ id: emp.manager_id, organization_id: organizationId }).whereNotNull('user_id').pluck('user_id');
  else if (to === 'department_head' && emp.head_employee_id) ids = await knex('employees').where({ id: emp.head_employee_id, organization_id: organizationId }).whereNotNull('user_id').pluck('user_id');
  else if (to.startsWith('role:')) {
    ids = await knex('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').where({ 'ur.organization_id': organizationId, 'r.key': to.slice(5) }).pluck('ur.user_id');
  } else if (to.startsWith('user:')) ids = [Number(to.slice(5))];
  if (!ids.length) return [];
  return knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.organization_id': organizationId, 'm.status': 'active', 'u.status': 'active' })
    .whereIn('m.user_id', ids).select('u.id', 'u.name');
}

function render(template, vars) {
  return String(template || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k]))).slice(0, 500);
}

/** Template values; dates are written out in the company's language (e.g. 27 Nov 2026). */
function varsFor(emp, extra, today, locale = 'en') {
  const v = {
    name: `${emp.first_name} ${emp.last_name}`, first_name: emp.first_name, job_title: emp.job_title || '', department: emp.department_name || '',
    employee_number: emp.employee_number || '', joining_date: emp.joining_date ? ymd(emp.joining_date) : '', today, ...extra,
  };
  for (const k of ['date', 'joining_date', 'today']) if (/^\d{4}-\d{2}-\d{2}$/.test(String(v[k] || ''))) v[k] = formatDate(v[k], locale);
  return v;
}

// ---------- Actions ----------
async function perform(rule, emp, vars, today, { dryRun = false } = {}) {
  const out = [];
  for (const a of rule.actions) {
    try {
      if (a.type === 'notify') {
        const to = await recipients(rule.organization_id, a.to, emp);
        const text = render(a.message, vars);
        if (!dryRun && to.length) await notifications.notify(rule.organization_id, to.map((u) => u.id), 'automation', { message: text, rule: rule.name }, `/app/employees/${emp.id}`);
        out.push({ type: a.type, ok: to.length > 0, to: to.map((u) => u.name), text, note: to.length ? null : 'no_recipient' });
      } else if (a.type === 'create_task') {
        const to = await recipients(rule.organization_id, a.to, emp);
        const title = render(a.title, vars).slice(0, 200);
        const due = addDays(today, a.due_days || 0);
        if (!dryRun && to.length) {
          for (const u of to.slice(0, 20)) {
            const [taskId] = await knex('tasks').insert({ organization_id: rule.organization_id, title, description: `${rule.name} · ${vars.name}`, assignee_user_id: u.id, priority: 'medium', status: 'todo', due_date: due, created_by: rule.created_by });
            await audit.record({ organizationId: rule.organization_id, userId: rule.created_by, automation: true }, 'task.created', { entityType: 'task', entityId: taskId, newValues: { name: title, automation: rule.name } });
            await notifications.notify(rule.organization_id, [u.id], 'task_assigned', { title }, `/app/tasks/${taskId}`);
          }
        }
        out.push({ type: a.type, ok: to.length > 0, to: to.map((u) => u.name), text: title, due, note: to.length ? null : 'no_recipient' });
      } else if (a.type === 'assign_course') {
        const course = await knex('courses').where({ id: a.course_id, organization_id: rule.organization_id, status: 'published' }).first('id', 'title');
        if (!course) { out.push({ type: a.type, ok: false, note: 'course_unavailable' }); continue; }
        const due = a.due_days ? addDays(today, a.due_days) : null;
        if (!dryRun) {
          // eslint-disable-next-line global-require
          await require('../learning/enrollments.service').assignCourse({ organizationId: rule.organization_id, userId: rule.created_by, permissions: new Set(['learning.manage']), automation: true },
            course.id, { due_date: due }, { people: [{ id: emp.id, user_id: emp.user_id }] });
        }
        out.push({ type: a.type, ok: true, text: course.title, due });
      } else if (a.type === 'post_chat') {
        const text = render(a.message, vars);
        const chat = await knex('integration_settings').where({ organization_id: rule.organization_id, kind: 'chat', is_active: true }).first('id');
        if (!dryRun && chat) await jobs.enqueue(null, { organizationId: rule.organization_id, type: 'chat.post', payload: { organizationId: rule.organization_id, action: 'automation', text }, maxAttempts: 4 });
        out.push({ type: a.type, ok: Boolean(chat), text, note: chat ? null : 'chat_not_connected' });
      }
    } catch (err) {
      out.push({ type: a.type, ok: false, note: 'error', error: String(err.message).slice(0, 200) });
    }
  }
  return out;
}

/** Job handler for one rule and one occurrence. Never retried after it starts acting. */
async function execute(payload) {
  const rule = await knex('automation_rules').where({ id: payload.ruleId, is_active: true }).first();
  if (!rule) return;
  const r = present(rule);
  if (!(await ent.hasFeature(r.organization_id, 'automation'))) return;
  const org = await orgs.get(r.organization_id);
  if (!org || org.status !== 'active') return;
  const today = todayIn(org.timezone || 'UTC');
  let subject = payload.employeeId ? { employeeId: payload.employeeId, vars: payload.vars || {} } : await resolveEvent(r.organization_id, payload);
  const [runId] = await knex('automation_runs').insert({ organization_id: r.organization_id, rule_id: r.id, employee_id: subject ? subject.employeeId : null, dedupe_key: payload.dedupeKey, status: 'running' })
    .onConflict(['rule_id', 'dedupe_key']).ignore();
  if (!runId) return; // already handled
  const finish = async (status, detail, error) => {
    await knex('automation_runs').where({ id: runId }).update({ status, detail: JSON.stringify(detail || []), error: error ? String(error).slice(0, 500) : null });
    if (status === 'done') await knex('automation_rules').where({ id: r.id }).update({ last_run_at: new Date(), run_count: knex.raw('run_count + 1') });
  };
  const emp = subject && subject.employeeId ? await employeeContext(r.organization_id, subject.employeeId) : null;
  if (!emp) return finish('skipped', [{ note: 'no_employee' }]);
  const failed = conditionsMet(r.conditions, emp, subject);
  if (failed) return finish('skipped', [{ note: `condition_${failed}` }]);
  subject = subject || { vars: {} };
  const detail = await perform(r, emp, varsFor(emp, subject.vars, today, org.locale), today);
  const errors = detail.filter((d) => d.note === 'error');
  return finish(errors.length ? 'failed' : 'done', detail, errors.length ? errors[0].error : null);
}
jobs.register('automation.run', execute);

// ---------- Event hook (called from integrations/events.dispatch inside the action's transaction) ----------
function eventRules(organizationId) {
  return cache.remember(`automation:${organizationId}`, async () => knex('automation_rules').where({ organization_id: organizationId, is_active: true })
    .whereIn('trigger', Object.keys(EVENT_TRIGGERS)).select('id', 'trigger'), 30_000);
}

async function onEvent(ctx, action, details, trx) {
  if (ctx.automation || !EVENT_TRIGGERS[action] || details.entityId == null) return;
  const rules = (await eventRules(ctx.organizationId)).filter((r) => r.trigger === action);
  for (const r of rules) {
    await jobs.enqueue(trx, {
      organizationId: ctx.organizationId, type: 'automation.run', maxAttempts: 3,
      payload: { ruleId: r.id, dedupeKey: action === 'course.completed' ? `${action}:${details.entityId}:${ctx.userId}` : `${action}:${details.entityId}`, event: action, entityType: details.entityType, entityId: details.entityId, actorUserId: ctx.userId || null },
    });
  }
}

// ---------- Date triggers ----------
async function scheduledMatches(rule, today) {
  const org = rule.organization_id;
  const days = Number(rule.trigger_options.days || 0);
  const active = () => knex('employees as e').where('e.organization_id', org).whereNot('e.status', 'terminated');
  if (rule.trigger === 'document_expiring') {
    const q = knex('documents as d').join('employees as e', 'e.id', 'd.employee_id').where('d.organization_id', org).whereNot('e.status', 'terminated')
      .whereBetween('d.expires_at', [today, addDays(today, days)]).select('d.id', 'd.employee_id', 'd.title', 'd.expires_at');
    if (rule.trigger_options.category) q.where('d.category', rule.trigger_options.category);
    return (await q).map((d) => ({ employeeId: d.employee_id, key: `doc:${d.id}:${ymd(d.expires_at)}`, vars: { document: d.title, date: ymd(d.expires_at), days: dayDiff(today, d.expires_at) } }));
  }
  if (rule.trigger === 'certificate_expiring') {
    const rows = await knex('certificates as c').join('employees as e', 'e.id', 'c.employee_id').where('c.organization_id', org).whereNot('e.status', 'terminated')
      .whereBetween('c.expires_on', [today, addDays(today, days)]).select('c.id', 'c.employee_id', 'c.course_title', 'c.expires_on');
    return rows.map((c) => ({ employeeId: c.employee_id, key: `cert:${c.id}:${ymd(c.expires_on)}`, vars: { course: c.course_title, date: ymd(c.expires_on), days: dayDiff(today, c.expires_on) } }));
  }
  if (rule.trigger === 'probation_ending') {
    const s = (await orgs.getSettings(org)).compliance || {};
    const length = Number(s.probation_max_days) || 90;
    const rows = await active().where('e.status', 'probation').whereNotNull('e.joining_date').select('e.id', 'e.joining_date');
    return rows.map((e) => ({ e, end: addDays(ymd(e.joining_date), length) })).filter((x) => x.end >= today && x.end <= addDays(today, days))
      .map((x) => ({ employeeId: x.e.id, key: `probation:${x.end}`, vars: { date: x.end, days: dayDiff(today, x.end) } }));
  }
  if (rule.trigger === 'days_after_joining') {
    const rows = await active().whereNotNull('e.joining_date').whereBetween('e.joining_date', [addDays(today, -days - 3), addDays(today, -days)]).select('e.id', 'e.joining_date');
    return rows.map((e) => ({ employeeId: e.id, key: `joined:${ymd(e.joining_date)}:${days}`, vars: { date: ymd(e.joining_date), days } }));
  }
  if (rule.trigger === 'work_anniversary') {
    const rows = await active().whereNotNull('e.joining_date').where('e.joining_date', '<=', addDays(today, -360)).select('e.id', 'e.joining_date');
    const out = [];
    for (const e of rows) {
      const j = ymd(e.joining_date);
      const years = Number(today.slice(0, 4)) - Number(j.slice(0, 4));
      const anniversary = `${today.slice(0, 4)}${j.slice(4)}`;
      // Fires on the day, or up to 3 days late if the server was asleep.
      if (years >= 1 && anniversary <= today && anniversary >= addDays(today, -3)) out.push({ employeeId: e.id, key: `anniversary:${anniversary}`, vars: { years, date: anniversary } });
    }
    return out;
  }
  return [];
}
const dayIn = (tz, date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const dayDiff = (a, b) => Math.round((new Date(`${ymd(b)}T00:00:00Z`) - new Date(`${ymd(a)}T00:00:00Z`)) / 86_400_000);

/** Queues date-triggered runs that are due. Safe to call often and from several processes. */
async function runScheduled(now = new Date()) {
  const rules = (await knex('automation_rules as r').join('organizations as o', 'o.id', 'r.organization_id')
    .where({ 'r.is_active': true, 'o.status': 'active' }).whereIn('r.trigger', Object.keys(SCHEDULE_TRIGGERS)).select('r.*', 'o.timezone')).map(present);
  let queued = 0;
  for (const r of rules) {
    if (!(await ent.hasFeature(r.organization_id, 'automation'))) continue;
    const today = dayIn(r.timezone || 'UTC', now);
    for (const m of await scheduledMatches(r, today)) {
      const key = `${r.trigger}:${m.employeeId}:${m.key}`.slice(0, 120);
      if (await knex('automation_runs').where({ rule_id: r.id, dedupe_key: key }).first('id')) continue;
      const pending = await knex('background_jobs').where({ type: 'automation.run', status: 'pending' }).whereRaw("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.dedupeKey')) = ?", [key])
        .whereRaw("JSON_EXTRACT(payload, '$.ruleId') = ?", [r.id]).first('id');
      if (pending) continue;
      await jobs.enqueue(null, { organizationId: r.organization_id, type: 'automation.run', maxAttempts: 3, payload: { ruleId: r.id, dedupeKey: key, employeeId: m.employeeId, vars: m.vars } });
      queued += 1;
    }
  }
  return queued;
}

// ---------- Preview (dry run) ----------
async function preview(ctx, input, employeeId) {
  const rule = { ...(await normalize(ctx, { ...input, is_active: 'on' })), organization_id: ctx.organizationId, created_by: ctx.userId };
  const emp = await employeeContext(ctx.organizationId, Number(employeeId));
  if (!emp) throw E.validation({ employee_id: 'Choose an employee.' });
  const org = await orgs.get(ctx.organizationId);
  const today = todayIn(org.timezone || 'UTC');
  const sample = { date: addDays(today, rule.trigger_options.days || 0), days: rule.trigger_options.days || 0, years: 1, document: 'Iqama', leave_type: 'Annual leave', course: 'Course' };
  const failed = conditionsMet(rule.conditions, emp, {});
  return { rule, employee: emp, failed, actions: await perform(rule, emp, varsFor(emp, sample, today, org.locale), today, { dryRun: true }) };
}

module.exports = {
  EVENT_TRIGGERS, SCHEDULE_TRIGGERS, TRIGGERS, ACTIONS, RECIPIENTS, EMPLOYMENT_TYPES, DOC_CATEGORIES, MAX_RULES,
  list, get, save, setActive, remove, runs, onEvent, execute, runScheduled, preview, render, conditionsMet,
};
