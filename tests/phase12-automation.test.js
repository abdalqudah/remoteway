// Advanced Automation: event and date triggers, conditions, every action type, once-only runs,
// no automation loops, dry-run preview, validation, permissions and plan gating.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const jobs = require('../src/modules/integrations/handlers');
const automation = require('../src/modules/automation/automation.service');
const { todayIn, addDays } = require('../src/core/workdays');

let co; let owner; let mgr; let mgrEmpId; let today;
const j = (v) => (typeof v === 'string' ? JSON.parse(v) : v); // JSON columns may arrive parsed
const drain = async () => {
  for (let i = 0; i < 4; i += 1) {
    await h.knex('background_jobs').where('status', 'pending').update({ run_at: new Date(Date.now() - 1000) });
    await jobs.runDue({ limit: 50 });
  }
};
const saveRule = (body) => owner.form('/app/automation', { is_active: 'on', ...body });

before(async () => {
  await h.resetDatabase();
  co = await h.createCompany({ plan: 'business' });
  owner = await h.login(co.email, co.password);
  today = todayIn('Asia/Riyadh');
  mgr = await h.addMember(co.organizationId, 'team_manager');
  const m = await h.createEmployee(owner, { first_name: 'Maha', last_name: 'Manager' });
  mgrEmpId = m.body.data.id;
  await h.knex('employees').where({ id: mgrEmpId }).update({ user_id: mgr.userId });
});
after(async () => { await h.knex.destroy(); });

describe('Phase 12 — automation', () => {
  test('Professional feature; Business gets 402', async () => {
    assert.equal((await owner.get('/app/automation')).status, 402);
    const plan = await h.knex('plans').where({ key: 'professional' }).first();
    await h.knex('subscriptions').where({ organization_id: co.organizationId }).update({ plan_id: plan.id, status: 'active' });
    h.cache.clear();
    assert.equal((await owner.get('/app/automation')).status, 200);
    assert.equal((await owner.get('/app/automation/new?template=iqama_expiring')).status, 200);
  });

  test('event rule: new employee → notification to the manager and a task, exactly once', async () => {
    const r = await saveRule({ name: 'Welcome', trigger: 'employee.created', action_type: ['notify', 'create_task'], action_to: ['manager', 'manager'],
      action_message: ['{{name}} joins as {{job_title}}', 'Set up laptop for {{first_name}}'], action_due_days: ['0', '5'], action_course_id: ['', ''] });
    assert.equal(r.status, 302, r.text.slice(0, 300));
    const e = await h.createEmployee(owner, { first_name: 'Nora', last_name: 'New', job_title: 'Analyst', manager_id: mgrEmpId });
    await drain();
    const n = await h.knex('notifications').where({ user_id: mgr.userId, type: 'automation' }).first();
    assert.equal(j(n.data).message, 'Nora New joins as Analyst');
    const task = await h.knex('tasks').where({ organization_id: co.organizationId, assignee_user_id: mgr.userId }).first();
    assert.equal(task.title, 'Set up laptop for Nora');
    assert.equal(String(task.due_date instanceof Date ? task.due_date.toISOString() : task.due_date).slice(0, 10), addDays(today, 5));
    const run = await h.knex('automation_runs').where({ employee_id: e.body.data.id }).first();
    assert.equal(run.status, 'done');
    // Running the same occurrence again does nothing
    const rule = await h.knex('automation_rules').where({ name: 'Welcome' }).first();
    await automation.execute({ ruleId: rule.id, dedupeKey: `employee.created:${e.body.data.id}`, event: 'employee.created', entityId: e.body.data.id });
    assert.equal(Number((await h.knex('notifications').where({ user_id: mgr.userId, type: 'automation' }).count({ c: '*' }))[0].c), 1);
    // The task created by the automation did not start anything else
    assert.equal(Number((await h.knex('automation_runs').count({ c: '*' }))[0].c), 1, 'only Nora (the manager existed before the rule); the task it created started nothing');
    await h.knex('automation_rules').where({ id: rule.id }).update({ is_active: false });
    h.cache.clear();
  });

  test('conditions skip people who do not match, and the skip is logged', async () => {
    await saveRule({ name: 'Long leave', trigger: 'leave.approved', min_days: '5', action_type: ['notify'], action_to: ['manager'], action_message: ['{{name}} off for {{days}} days'], action_due_days: ['0'], action_course_id: [''] });
    const rule = await h.knex('automation_rules').where({ name: 'Long leave' }).first();
    const emp = await h.knex('employees').where({ organization_id: co.organizationId, first_name: 'Nora' }).first();
    await owner.get('/app/leave'); // creates the default leave types
    const type = await h.knex('leave_types').where({ organization_id: co.organizationId, key: 'annual' }).first();
    const [lr] = await h.knex('leave_requests').insert({ organization_id: co.organizationId, employee_id: emp.id, leave_type_id: type.id, start_date: addDays(today, 10), end_date: addDays(today, 11), days: 2, status: 'approved' });
    await automation.execute({ ruleId: rule.id, dedupeKey: `leave.approved:${lr}`, event: 'leave.approved', entityId: lr });
    const run = await h.knex('automation_runs').where({ rule_id: rule.id }).first();
    assert.equal(run.status, 'skipped');
    assert.match(JSON.stringify(j(run.detail)), /condition_min_days/);
  });

  test('date rules act once per person and date (document expiry, anniversary, course, chat)', async () => {
    const [courseId] = await h.knex('courses').insert({ organization_id: co.organizationId, title: 'Iqama process', status: 'published' });
    await saveRule({ name: 'Iqama', trigger: 'document_expiring', days: '30', category: 'iqama',
      action_type: ['notify', 'assign_course', 'post_chat'], action_to: ['manager', 'employee', 'employee'],
      action_message: ['{{document}} of {{name}} expires {{date}} ({{days}} days)', '', 'Iqama reminder for {{name}}'], action_due_days: ['0', '7', '0'], action_course_id: ['', String(courseId), ''] });
    const emp = await h.knex('employees').where({ organization_id: co.organizationId, first_name: 'Nora' }).first();
    await h.knex('documents').insert({ organization_id: co.organizationId, employee_id: emp.id, category: 'iqama', title: 'Iqama', expires_at: addDays(today, 20) });
    await h.knex('documents').insert({ organization_id: co.organizationId, employee_id: emp.id, category: 'passport', title: 'Passport', expires_at: addDays(today, 20) });
    assert.equal(await automation.runScheduled(), 1, 'only the Iqama matches');
    await drain();
    assert.equal(await automation.runScheduled(), 0, 'already handled');
    const rule = await h.knex('automation_rules').where({ name: 'Iqama' }).first();
    const run = await h.knex('automation_runs').where({ rule_id: rule.id }).first();
    const detail = j(run.detail);
    assert.match(detail[0].text, /^Iqama of Nora New expires \d{1,2} \S+ \d{4} \(20 days\)$/, 'dates are written out');
    assert.ok(await h.knex('enrollments').where({ employee_id: emp.id, course_id: courseId }).first(), 'course assigned');
    assert.equal(detail[2].note, 'chat_not_connected');

    await saveRule({ name: 'Anniversary', trigger: 'work_anniversary', action_type: ['notify'], action_to: ['manager'], action_message: ['{{name}}: {{years}} years'], action_due_days: ['0'], action_course_id: [''] });
    const [vet] = await h.knex('employees').insert({ organization_id: co.organizationId, employee_number: 'V1', first_name: 'Vet', last_name: 'Eran', joining_date: `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`, manager_id: mgrEmpId });
    await automation.runScheduled();
    await drain();
    const msg = await h.knex('notifications').where({ user_id: mgr.userId, type: 'automation' }).orderBy('id', 'desc').first();
    assert.equal(j(msg.data).message, 'Vet Eran: 2 years');
    assert.ok(vet);
  });

  test('automations never trigger from actions done by automations', async () => {
    const before = Number((await h.knex('background_jobs').where({ type: 'automation.run' }).count({ c: '*' }))[0].c);
    await automation.onEvent({ organizationId: co.organizationId, userId: co.userId, automation: true }, 'employee.created', { entityId: 1 }, h.knex);
    const afterCount = Number((await h.knex('background_jobs').where({ type: 'automation.run' }).count({ c: '*' }))[0].c);
    assert.equal(afterCount, before);
  });

  test('preview shows recipients and texts without sending anything', async () => {
    const emp = await h.knex('employees').where({ organization_id: co.organizationId, first_name: 'Nora' }).first();
    const count = async () => Number((await h.knex('notifications').count({ c: '*' }))[0].c);
    const n0 = await count();
    const r = await owner.form('/app/automation', { action: 'preview', preview_employee_id: String(emp.id), name: 'Try', trigger: 'employee.created',
      action_type: ['notify'], action_to: ['manager'], action_message: ['Hello {{first_name}} from {{department}}'], action_due_days: ['0'], action_course_id: [''] });
    assert.equal(r.status, 200);
    assert.match(r.text, /Hello Nora from/);
    const mgrName = (await h.knex('users').where({ id: mgr.userId }).first('name')).name;
    assert.ok(r.text.includes(mgrName), 'the manager is named');
    assert.equal(await count(), n0);
  });

  test('validation, placeholders and permissions', async () => {
    let r = await saveRule({ name: 'Bad', trigger: 'employee.created', action_type: ['notify'], action_to: ['role:nope'], action_message: ['x'], action_due_days: ['0'], action_course_id: [''] });
    assert.equal(r.status, 422);
    r = await saveRule({ name: 'Bad', trigger: 'not_a_trigger', action_type: ['notify'], action_to: ['manager'], action_message: ['x'], action_due_days: ['0'], action_course_id: [''] });
    assert.equal(r.status, 422);
    assert.equal(automation.render('Hi {{name}} {{missing}}!', { name: 'A' }), 'Hi A !');
    const hr = await h.addMember(co.organizationId, 'hr_manager');
    assert.equal((await (await h.login(hr.email, hr.password)).get('/app/automation')).status, 200);
    const emp = await h.addMember(co.organizationId, 'employee');
    assert.equal((await (await h.login(emp.email, emp.password)).get('/app/automation')).status, 403);
    const other = await h.createCompany({ plan: 'business' });
    const plan = await h.knex('plans').where({ key: 'professional' }).first();
    await h.knex('subscriptions').where({ organization_id: other.organizationId }).update({ plan_id: plan.id });
    h.cache.clear();
    const os = await h.login(other.email, other.password);
    const rule = await h.knex('automation_rules').where({ organization_id: co.organizationId }).first();
    assert.equal((await os.get(`/app/automation/${rule.id}`)).status, 404);
  });
});
