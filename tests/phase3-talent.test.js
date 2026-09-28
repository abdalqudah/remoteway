const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const csrfOf = (html) => (html.match(/name="csrf-token" content="([^"]+)"/) || [])[1];

describe('Phase 3 — recruitment, careers page, onboarding', () => {
  let C; let owner; let other; let O; let recruiterUser; let recruiter; let emp; let empUser; let mgrUser; let mgr;
  let jobId; let candidateId; let appId; let orgSlug;

  before(async () => {
    await h.resetDatabase();
    C = await h.createCompany({ plan: 'business' });
    O = await h.createCompany({ plan: 'business' });
    owner = await h.login(C.email, C.password);
    other = await h.login(O.email, O.password);
    recruiterUser = await h.addMember(C.organizationId, 'recruiter');
    recruiter = await h.login(recruiterUser.email, recruiterUser.password);
    empUser = await h.addMember(C.organizationId, 'employee');
    await h.createEmployee(owner, { first_name: 'Plain', email: empUser.email });
    emp = await h.login(empUser.email, empUser.password);
    mgrUser = await h.addMember(C.organizationId, 'department_manager');
    await h.createEmployee(owner, { first_name: 'Manny', email: mgrUser.email });
    mgr = await h.login(mgrUser.email, mgrUser.password);
    orgSlug = (await h.knex('organizations').where({ id: C.organizationId }).first('slug')).slug;
  });
  after(() => h.knex.destroy());

  const addCandidate = (s, fields, file = PDF, name = 'cv.pdf') => {
    const req = s.agent.post('/app/recruitment/candidates').field('_csrf', s.csrf);
    for (const [k, v] of Object.entries(fields)) req.field(k, String(v));
    return file ? req.attach('file', file, name) : req;
  };

  test('Starter plan has no recruitment: pages and API are locked', async () => {
    const S = await h.createCompany({ plan: 'starter' });
    const s = await h.login(S.email, S.password);
    const page = await s.get('/app/recruitment');
    assert.equal(page.status, 402);
    const api = await s.api('get', '/api/v1/recruitment/jobs');
    assert.equal(api.status, 402);
    assert.equal((await s.get('/app/employee-onboarding')).status, 402);
  });

  test('recruiter creates and publishes a job (counts against active_jobs)', async () => {
    const res = await recruiter.form('/app/recruitment/jobs', { title: 'Backend Engineer', work_mode: 'remote', employment_type: 'full_time', openings: 1, skills: 'Node.js, SQL', description: 'Build things', publish: '1' });
    assert.equal(res.status, 302, res.text.slice(0, 300));
    jobId = Number(res.headers.location.split('/').pop());
    const job = await h.knex('jobs').where({ id: jobId }).first();
    assert.equal(job.status, 'open');
    assert.equal(job.organization_id, C.organizationId);
    assert.equal(job.slug, 'backend-engineer');
    const ent = require('../src/modules/billing/entitlements.service');
    assert.equal((await ent.getUsage(C.organizationId)).active_jobs, 1);
  });

  const setLimits = async (orgId, limits) => {
    await h.knex('subscriptions').where({ organization_id: orgId }).update({ custom_limits: limits ? JSON.stringify(limits) : null });
    require('../src/modules/billing/entitlements.service').invalidate(orgId);
  };

  test('opening a job over the plan\'s active_jobs limit is refused', async () => {
    await setLimits(C.organizationId, { active_jobs: 1 });
    const res = await recruiter.form('/app/recruitment/jobs', { title: 'Second job', publish: '1' });
    assert.equal(res.status, 302); // saved as a draft …
    const id = Number(res.headers.location.split('/').pop());
    const open = await recruiter.form(`/app/recruitment/jobs/${id}/status`, { status: 'open' });
    assert.equal(open.status, 302);
    assert.equal((await h.knex('jobs').where({ id }).first()).status, 'draft'); // … but not opened
    await h.knex('jobs').where({ id }).del();
    await setLimits(C.organizationId, null);
  });

  test('recruiter adds a candidate with a CV into the job pipeline', async () => {
    const res = await addCandidate(recruiter, { first_name: 'Lina', last_name: 'Saeed', email: 'lina@example.com', source: 'referral', job_id: jobId });
    assert.equal(res.status, 302, res.text.slice(0, 400));
    const c = await h.knex('candidates').where({ organization_id: C.organizationId, email: 'lina@example.com' }).first();
    candidateId = c.id;
    assert.ok(c.cv_storage_key);
    const app = await h.knex('applications').where({ candidate_id: c.id, job_id: jobId }).first();
    appId = app.id;
    assert.equal(app.stage, 'applied');
    const cv = await recruiter.get(`/app/recruitment/candidates/${c.id}/cv`);
    assert.equal(cv.status, 200);
    assert.match(cv.headers['content-disposition'], /attachment/);
  });

  test('CVs must be PDF or Word', async () => {
    const res = await addCandidate(recruiter, { first_name: 'Bad', last_name: 'File', email: 'bad@example.com' }, Buffer.from('MZ\x90\x00binary'), 'cv.exe');
    assert.equal(res.status, 422);
    assert.equal(await h.knex('candidates').where({ email: 'bad@example.com' }).first(), undefined);
  });

  test('candidates and CVs are isolated between companies', async () => {
    assert.equal((await other.get(`/app/recruitment/candidates/${candidateId}`)).status, 404);
    assert.equal((await other.get(`/app/recruitment/candidates/${candidateId}/cv`)).status, 404);
    assert.equal((await other.get(`/app/recruitment/applications/${appId}`)).status, 404);
    assert.equal((await other.api('get', `/api/v1/recruitment/candidates/${candidateId}`)).status, 404);
    const list = await other.api('get', '/api/v1/recruitment/candidates');
    assert.equal(list.body.data.length, 0);
    const moved = await other.form(`/app/recruitment/applications/${appId}/stage`, { stage: 'screening' });
    assert.equal((await h.knex('applications').where({ id: appId }).first()).stage, 'applied');
    assert.notEqual(moved.status, 200);
  });

  test('employees cannot see recruitment data', async () => {
    assert.equal((await emp.get('/app/recruitment/candidates')).status, 403);
    assert.equal((await emp.get(`/app/recruitment/candidates/${candidateId}/cv`)).status, 403);
    assert.equal((await emp.api('get', '/api/v1/recruitment/jobs')).status, 403);
    const s = await h.request(h.getApp()).get('/api/v1/search?q=Lina');
    assert.notEqual(s.status, 200);
    const mine = await emp.api('get', '/api/v1/search?q=Lina');
    assert.deepEqual(mine.body.data.candidates, []);
  });

  test('stage moves are recorded; "hired" requires the hire action; board fetch gets JSON', async () => {
    const r = await recruiter.agent.post(`/app/recruitment/applications/${appId}/stage`).set('x-csrf-token', recruiter.csrf).set('x-requested-with', 'fetch').type('form').send({ stage: 'screening' });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    const bad = await recruiter.agent.post(`/app/recruitment/applications/${appId}/stage`).set('x-csrf-token', recruiter.csrf).set('x-requested-with', 'fetch').type('form').send({ stage: 'hired' });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error.code, 'USE_HIRE');
    const ev = await h.knex('application_events').where({ application_id: appId, type: 'stage' }).orderBy('id', 'desc').first();
    assert.match(typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data), /screening/);
  });

  let ivId;
  test('interviews: only the assigned interviewer (or recruiters) can give feedback', async () => {
    const res = await recruiter.form(`/app/recruitment/applications/${appId}/interviews`, { scheduled_at: '2030-01-15T10:00', duration_minutes: 45, mode: 'video', interviewer_user_id: mgrUser.userId });
    assert.equal(res.status, 302);
    const iv = await h.knex('interviews').where({ application_id: appId }).first();
    ivId = iv.id;
    assert.equal((await h.knex('applications').where({ id: appId }).first()).stage, 'interview');
    // Stored in UTC from the company time zone (Asia/Riyadh = UTC+3).
    assert.equal(new Date(iv.scheduled_at).toISOString(), '2030-01-15T07:00:00.000Z');
    const n = await h.knex('notifications').where({ user_id: mgrUser.userId, type: 'interview_assigned' }).first();
    assert.ok(n);

    // The manager has no recruitment access but can open and review their own interview.
    assert.equal((await mgr.get(`/app/recruitment/interviews/${ivId}`)).status, 200);
    assert.equal((await mgr.get(`/app/recruitment/applications/${appId}`)).status, 403);
    assert.equal((await emp.get(`/app/recruitment/interviews/${ivId}`)).status, 404);
    const denied = await emp.form(`/app/recruitment/interviews/${ivId}/feedback`, { recommendation: 'yes', feedback: 'x' });
    assert.equal(denied.status, 404);
    const fb = await mgr.form(`/app/recruitment/interviews/${ivId}/feedback`, { recommendation: 'strong_yes', rating: 5, feedback: 'Great fit' });
    assert.equal(fb.status, 302);
    const done = await h.knex('interviews').where({ id: ivId }).first();
    assert.equal(done.status, 'completed');
    assert.equal(done.recommendation, 'strong_yes');
  });

  test('hiring creates the employee (seat limit applies) and starts onboarding', async () => {
    const before = await h.knex('employees').where({ organization_id: C.organizationId }).count({ n: '*' });
    const res = await owner.form(`/app/recruitment/applications/${appId}/hire`, { joining_date: '2030-02-01', job_title: 'Backend Engineer', start_onboarding: 'on' });
    assert.equal(res.status, 302, res.text.slice(0, 300));
    assert.match(res.headers.location, /\/app\/employee-onboarding\/\d+/);
    const app = await h.knex('applications').where({ id: appId }).first();
    assert.equal(app.stage, 'hired');
    const e = await h.knex('employees').where({ id: app.hired_employee_id }).first();
    assert.equal(e.email, 'lina@example.com');
    assert.equal(e.status, 'probation');
    const after = await h.knex('employees').where({ organization_id: C.organizationId }).count({ n: '*' });
    assert.equal(Number(after[0].n), Number(before[0].n) + 1);
    const plan = await h.knex('onboarding_plans').where({ employee_id: e.id }).first();
    assert.equal(plan.status, 'active');
    assert.ok((await h.knex('onboarding_tasks').where({ plan_id: plan.id }).count({ n: '*' }))[0].n > 0);
    // Openings filled → the job closes automatically.
    assert.equal((await h.knex('jobs').where({ id: jobId }).first()).status, 'closed');
    // Hired candidates cannot be deleted or hired twice.
    assert.equal((await owner.form(`/app/recruitment/applications/${appId}/hire`, {})).status, 409);
    const del = await owner.form(`/app/recruitment/candidates/${candidateId}/delete`, {});
    assert.equal(del.status, 409);
  });

  test('hire refuses when the employee seat limit is reached', async () => {
    const T = await h.createCompany({ plan: 'business' });
    const t = await h.login(T.email, T.password);
    const rec = require('../src/modules/recruitment/recruitment.service');
    const ctx = { organizationId: T.organizationId, userId: T.userId, permissions: new Set(['recruitment.manage', 'employees.create']) };
    const job = await rec.saveJob(ctx, null, { title: 'Any' });
    const cand = await rec.saveCandidate(ctx, null, { first_name: 'Seat', last_name: 'Test', email: 'seat@example.com' });
    const a = await rec.addToJob(ctx, cand, job);
    await setLimits(T.organizationId, { employees: 0 });
    const res = await t.form(`/app/recruitment/applications/${a}/hire`, {});
    assert.equal(res.status, 402);
    assert.equal((await h.knex('applications').where({ id: a }).first()).stage, 'applied');
    assert.equal((await h.knex('employees').where({ organization_id: T.organizationId }).count({ n: '*' }))[0].n, 0);
  });

  describe('public careers page', () => {
    let openJob;
    before(async () => {
      const r = await recruiter.form('/app/recruitment/jobs', { title: 'Support Agent', publish: '1' });
      openJob = await h.knex('jobs').where({ id: Number(r.headers.location.split('/').pop()) }).first();
    });

    const anon = async (path) => {
      const agent = h.request.agent(h.getApp());
      const page = await agent.get(path);
      return { agent, page, csrf: csrfOf(page.text) };
    };
    const apply = (s, path, fields, file = PDF) => {
      const req = s.agent.post(path).field('_csrf', s.csrf);
      for (const [k, v] of Object.entries(fields)) req.field(k, String(v));
      return file ? req.attach('file', file, 'cv.pdf') : req;
    };

    test('is hidden until the company turns it on', async () => {
      assert.equal((await h.request(h.getApp()).get(`/careers/${orgSlug}`)).status, 404);
      const res = await owner.form('/app/recruitment/careers', { careers_enabled: 'on', careers_intro: 'Join us' });
      assert.equal(res.status, 302);
      const page = await h.request(h.getApp()).get(`/careers/${orgSlug}`);
      assert.equal(page.status, 200);
      assert.match(page.text, /Support Agent/);
      assert.doesNotMatch(page.text, /Backend Engineer/); // closed jobs are not listed
    });

    test('closed jobs, drafts and other companies\' jobs are not reachable', async () => {
      assert.equal((await h.request(h.getApp()).get(`/careers/${orgSlug}/jobs/backend-engineer`)).status, 404);
      const otherSlug = (await h.knex('organizations').where({ id: O.organizationId }).first('slug')).slug;
      assert.equal((await h.request(h.getApp()).get(`/careers/${otherSlug}/jobs/${openJob.slug}`)).status, 404);
    });

    test('a candidate applies with consent and a CV', async () => {
      const path = `/careers/${orgSlug}/jobs/${openJob.slug}`;
      const s = await anon(path);
      assert.equal(s.page.status, 200);
      const noConsent = await apply(s, `${path}/apply`, { first_name: 'Ali', last_name: 'Hasan', email: 'ali@example.com' });
      assert.equal(noConsent.status, 422);
      const noCv = await apply(s, `${path}/apply`, { first_name: 'Ali', last_name: 'Hasan', email: 'ali@example.com', consent: 'on' }, null);
      assert.equal(noCv.status, 422);
      const ok = await apply(s, `${path}/apply`, { first_name: 'Ali', last_name: 'Hasan', email: 'ali@example.com', consent: 'on', cover_note: 'Hello' });
      assert.equal(ok.status, 200, ok.text.slice(0, 300));
      const c = await h.knex('candidates').where({ organization_id: C.organizationId, email: 'ali@example.com' }).first();
      assert.equal(c.source, 'careers');
      assert.ok(c.cv_storage_key);
      const a = await h.knex('applications').where({ candidate_id: c.id, job_id: openJob.id }).first();
      assert.equal(a.cover_note, 'Hello');
      const notif = await h.knex('notifications').where({ organization_id: C.organizationId, user_id: recruiterUser.userId, type: 'candidate_applied' }).first();
      assert.ok(notif);
      // Applying again is harmless (no duplicate application).
      const again = await apply(s, `${path}/apply`, { first_name: 'Ali', last_name: 'Hasan', email: 'ali@example.com', consent: 'on' });
      assert.equal(again.status, 200);
      assert.equal((await h.knex('applications').where({ candidate_id: c.id }).count({ n: '*' }))[0].n, 1);
    });

    test('the honeypot silently drops bots and CSRF is required', async () => {
      const path = `/careers/${orgSlug}/jobs/${openJob.slug}`;
      const s = await anon(path);
      const bot = await apply(s, `${path}/apply`, { first_name: 'Bot', last_name: 'Bot', email: 'bot@example.com', consent: 'on', website: 'http://spam' });
      assert.equal(bot.status, 200);
      assert.equal(await h.knex('candidates').where({ email: 'bot@example.com' }).first(), undefined);
      const noToken = await s.agent.post(`${path}/apply`).field('first_name', 'X').attach('file', PDF, 'cv.pdf');
      assert.notEqual(noToken.status, 200);
      assert.equal(await h.knex('candidates').where({ first_name: 'X' }).first(), undefined);
    });
  });

  describe('onboarding', () => {
    let planId; let empTask; let hrTask;
    before(async () => {
      const e = await h.knex('employees').where({ organization_id: C.organizationId, email: empUser.email }).first();
      const mgrEmp = await h.knex('employees').where({ organization_id: C.organizationId, email: mgrUser.email }).first();
      await h.knex('employees').where({ id: e.id }).update({ manager_id: mgrEmp.id });
      const res = await owner.form('/app/employee-onboarding', { employee_id: e.id, start_date: '2030-03-01' });
      assert.equal(res.status, 302, res.status + res.text.slice(0, 1500));
      planId = Number(res.headers.location.split('/').pop());
      empTask = await h.knex('onboarding_tasks').where({ plan_id: planId, assignee: 'employee' }).first();
      hrTask = await h.knex('onboarding_tasks').where({ plan_id: planId, assignee: 'hr' }).first();
    });

    test('tasks are assigned to HR, the manager and the employee with dated deadlines', async () => {
      assert.equal(empTask.assignee_user_id, empUser.userId);
      assert.equal(hrTask.assignee_user_id, C.userId);
      const m = await h.knex('onboarding_tasks').where({ plan_id: planId, assignee: 'manager' }).first();
      assert.equal(m.assignee_user_id, mgrUser.userId);
      assert.ok(await h.knex('notifications').where({ user_id: empUser.userId, type: 'onboarding_started' }).first());
    });

    test('only the assignee (or HR) can complete a task', async () => {
      const denied = await emp.form(`/app/employee-onboarding/tasks/${hrTask.id}`, { done: '1' });
      assert.equal(denied.status, 403);
      assert.equal((await h.knex('onboarding_tasks').where({ id: hrTask.id }).first()).completed_at, null);
      const ok = await emp.form(`/app/employee-onboarding/tasks/${empTask.id}`, { done: '1' });
      assert.equal(ok.status, 302);
      assert.ok((await h.knex('onboarding_tasks').where({ id: empTask.id }).first()).completed_at);
      assert.equal((await emp.get(`/app/employee-onboarding/${planId}`)).status, 200);
      assert.equal((await other.get(`/app/employee-onboarding/${planId}`)).status, 404);
    });

    test('the plan completes when every task is done', async () => {
      const tasks = await h.knex('onboarding_tasks').where({ plan_id: planId }).whereNull('completed_at');
      for (const tk of tasks) await owner.form(`/app/employee-onboarding/tasks/${tk.id}`, { done: '1' });
      assert.equal((await h.knex('onboarding_plans').where({ id: planId }).first()).status, 'completed');
      await owner.form(`/app/employee-onboarding/tasks/${tasks[0].id}`, { done: '0' });
      assert.equal((await h.knex('onboarding_plans').where({ id: planId }).first()).status, 'active');
    });

    test('templates can be edited and a new default chosen', async () => {
      const res = await owner.form('/app/employee-onboarding/templates', { name: 'Remote hires', item_title: ['Ship laptop', 'Intro call'], item_category: ['equipment', 'manager'], item_assignee: ['hr', 'manager'], item_due: ['-2', '1'] });
      assert.equal(res.status, 302);
      const tpl = await h.knex('onboarding_templates').where({ organization_id: C.organizationId, name: 'Remote hires' }).first();
      assert.equal((await h.knex('onboarding_template_items').where({ template_id: tpl.id })).length, 2);
      await owner.form(`/app/employee-onboarding/templates/${tpl.id}/default`, {});
      const defaults = await h.knex('onboarding_templates').where({ organization_id: C.organizationId, is_default: true });
      assert.deepEqual(defaults.map((d) => d.id), [tpl.id]);
      const empty = await owner.form('/app/employee-onboarding/templates', { name: 'Empty', item_title: [''] });
      assert.equal(empty.status, 422);
      assert.equal((await emp.get('/app/employee-onboarding/templates')).status, 403);
    });
  });
});
