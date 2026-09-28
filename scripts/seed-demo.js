// Creates "RemoteWay Demo Company" with demo users for each role.
// For demos and local development only — refuses to run when NODE_ENV=production unless --force.
//   npm run seed:demo            (password: DEMO_PASSWORD or Demo@12345)
const knex = require('../src/db/knex');
const config = require('../src/config');
const { seedReference } = require('../src/db/seed-reference');
const orgs = require('../src/modules/organizations/organization.service');
const structure = require('../src/modules/workforce/structure.service');
const employees = require('../src/modules/workforce/employee.service');
const rbac = require('../src/modules/rbac/rbac.service');
const authService = require('../src/modules/auth/auth.service');

const PASSWORD = process.env.DEMO_PASSWORD || 'Demo@12345';
const DOMAIN = 'demo.remoteway.local';

const DEPARTMENTS = [['Executive', 'EXE'], ['Human Resources', 'HR'], ['Finance', 'FIN'], ['Engineering', 'ENG'], ['Customer Support', 'CS'], ['Sales', 'SAL'], ['Operations', 'OPS']];
// [first, last, title, dept, location, type, mode, monthsAgo, managerIndex, salary]
const PEOPLE = [
  ['Faisal', 'Al-Harbi', 'Chief Executive Officer', 'Executive', 'Riyadh HQ', 'full_time', 'onsite', 30, null, 45000],
  ['Noura', 'Al-Qahtani', 'HR Manager', 'Human Resources', 'Riyadh HQ', 'full_time', 'hybrid', 24, 0, 22000],
  ['Khalid', 'Al-Otaibi', 'Finance Manager', 'Finance', 'Riyadh HQ', 'full_time', 'onsite', 22, 0, 24000],
  ['Omar', 'Al-Shehri', 'Engineering Manager', 'Engineering', 'Riyadh HQ', 'full_time', 'hybrid', 20, 0, 30000],
  ['Reem', 'Al-Dosari', 'Support Team Lead', 'Customer Support', 'Jeddah Office', 'full_time', 'onsite', 18, 0, 14000],
  ['Sara', 'Al-Ghamdi', 'Software Engineer', 'Engineering', 'Remote — KSA', 'full_time', 'remote', 14, 3, 18000],
  ['Abdullah', 'Al-Mutairi', 'Senior Software Engineer', 'Engineering', 'Riyadh HQ', 'full_time', 'hybrid', 16, 3, 23000],
  ['Lama', 'Al-Zahrani', 'Product Designer', 'Engineering', 'Remote — KSA', 'contract', 'remote', 9, 3, 16000],
  ['Mohammed', 'Khaled', 'Customer Support Specialist', 'Customer Support', 'Jeddah Office', 'full_time', 'onsite', 7, 4, 8500],
  ['Hessa', 'Al-Anazi', 'Customer Support Specialist', 'Customer Support', 'Remote — KSA', 'part_time', 'remote', 5, 4, 5000],
  ['Yousef', 'Al-Shammari', 'Customer Support Specialist', 'Customer Support', 'Jeddah Office', 'full_time', 'onsite', 3, 4, 8500],
  ['Maha', 'Al-Subaie', 'Accountant', 'Finance', 'Riyadh HQ', 'full_time', 'onsite', 11, 2, 12000],
  ['Turki', 'Al-Rashid', 'Payroll Specialist', 'Finance', 'Riyadh HQ', 'full_time', 'onsite', 6, 2, 11000],
  ['Aljawhara', 'Al-Saud', 'Talent Acquisition Specialist', 'Human Resources', 'Riyadh HQ', 'full_time', 'hybrid', 4, 1, 12500],
  ['Nasser', 'Al-Juhani', 'Sales Manager', 'Sales', 'Riyadh HQ', 'full_time', 'onsite', 12, 0, 20000],
  ['Rana', 'Al-Harthi', 'Account Executive', 'Sales', 'Jeddah Office', 'full_time', 'onsite', 2, 14, 11000],
  ['Fahad', 'Al-Qurashi', 'Operations Coordinator', 'Operations', 'Riyadh HQ', 'full_time', 'onsite', 8, 0, 10000],
  ['Dana', 'Al-Amri', 'QA Engineer', 'Engineering', 'Remote — KSA', 'intern', 'remote', 1, 3, 4000],
  ['Saad', 'Al-Balawi', 'DevOps Engineer', 'Engineering', 'Riyadh HQ', 'full_time', 'hybrid', 0, 3, 21000],
];

const DEMO_USERS = [
  ['owner', 'Faisal Al-Harbi', 'owner', 0],
  ['hr', 'Noura Al-Qahtani', 'hr_manager', 1],
  ['finance', 'Khalid Al-Otaibi', 'finance_manager', 2],
  ['manager', 'Omar Al-Shehri', 'department_manager', 3],
  ['employee', 'Sara Al-Ghamdi', 'employee', 5],
];

/** Leave, attendance, tasks and documents so every Phase 2 screen has realistic content. */
async function seedPhase2(ctx, empIds) {
  const leave = require('../src/modules/leave/leave.service');
  const attendance = require('../src/modules/attendance/attendance.service');
  const tasks = require('../src/modules/tasks/task.service');
  const documents = require('../src/modules/documents/document.service');
  const { todayIn, addDays, dayKey, countWorkingDays } = require('../src/core/workdays');
  const org = await orgs.get(ctx.organizationId);
  const settings = await orgs.getSettings(ctx.organizationId);
  const today = todayIn(org.timezone);
  const types = Object.fromEntries((await leave.listTypes(ctx.organizationId)).map((t) => [t.key, t]));
  const userOf = async (i) => (await knex('employees').where({ id: empIds[i] }).first('user_id')).user_id;

  // Attendance: last 10 working days for every current employee (deterministic pseudo-random times).
  let seed = 7;
  const rnd = (n) => { seed = (seed * 9301 + 49297) % 233280; return Math.floor((seed / 233280) * n); };
  const workingDays = [];
  for (let d = addDays(today, -1); workingDays.length < 10; d = addDays(d, -1)) if (settings.working_days.includes(dayKey(d))) workingDays.push(d);
  const rows = [];
  for (const d of workingDays) {
    for (const [i, id] of empIds.entries()) {
      if (rnd(20) === 0) continue; // occasional absence
      const inMin = 8 * 60 + 40 + rnd(45) + (i % 7 === 0 ? 25 : 0);
      const outMin = 17 * 60 + rnd(70);
      const hh = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const clockIn = attendance.zonedToUtc(d, hh(inMin), org.timezone);
      const clockOut = attendance.zonedToUtc(d, hh(outMin), org.timezone);
      const breakMinutes = 30 + rnd(30);
      const worked = Math.round((clockOut - clockIn) / 60000) - breakMinutes;
      rows.push({
        organization_id: ctx.organizationId, employee_id: id, work_date: d, clock_in: clockIn, clock_out: clockOut, break_minutes: breakMinutes,
        worked_minutes: worked, late_minutes: Math.max(0, inMin - (9 * 60 + 15)), overtime_minutes: Math.max(0, worked - 480), source: 'web',
      });
    }
  }
  // Today: most people have clocked in (still working).
  if (settings.working_days.includes(dayKey(today))) {
    for (const [i, id] of empIds.entries()) {
      if (i % 6 === 5) continue;
      const inMin = 8 * 60 + 45 + rnd(40);
      const clockIn = attendance.zonedToUtc(today, `${String(Math.floor(inMin / 60)).padStart(2, '0')}:${String(inMin % 60).padStart(2, '0')}`, org.timezone);
      if (clockIn > new Date()) continue;
      rows.push({ organization_id: ctx.organizationId, employee_id: id, work_date: today, clock_in: clockIn, late_minutes: Math.max(0, inMin - (9 * 60 + 15)), source: 'web' });
    }
  }
  await knex.batchInsert('attendance', rows, 200);

  // Leave: approved history, one person on leave today, and pending requests for the approvers.
  const hrUser = await userOf(1);
  const hrCtx = { organizationId: ctx.organizationId, userId: hrUser, permissions: await rbac.getUserPermissions(ctx.organizationId, hrUser) };
  const request = async (i, type, start, days, reason) => {
    let end = start;
    while (countWorkingDays(start, end, settings.working_days) < days) end = addDays(end, 1);
    const uid = await userOf(i);
    const c = uid ? { organizationId: ctx.organizationId, userId: uid, permissions: await rbac.getUserPermissions(ctx.organizationId, uid) } : hrCtx;
    return leave.createRequest(c, { employee_id: uid ? undefined : empIds[i], leave_type_id: types[type].id, start_date: start, end_date: end, reason });
  };
  const approve = (id) => leave.decide(hrCtx, id, { decision: 'approved' });
  await approve(await request(6, 'annual', addDays(today, -40), 5, 'Family trip'));
  await approve(await request(9, 'sick', addDays(today, -12), 2, 'Flu'));
  await approve(await request(12, 'annual', addDays(today, -1), 4, 'Umrah'));
  await approve(await request(15, 'annual', addDays(today, 9), 3, 'Personal'));
  await request(5, 'annual', addDays(today, 14), 5, 'Summer holiday');       // Sara → pending for Omar (manager) and HR
  await request(10, 'emergency', addDays(today, 3), 1, 'Family matter');     // pending for HR

  // Tasks & projects.
  const pm = await tasks.saveProject(ctx, null, { name: 'Customer Portal Launch', description: 'Ship the self-service portal for enterprise clients.', status: 'active', due_date: addDays(today, 45) });
  await tasks.saveProject(ctx, null, { name: 'Q4 Hiring Plan', description: 'Plan headcount for the next quarter.', status: 'on_hold' });
  const omar = await userOf(3);
  const sara = await userOf(5);
  const noura = await userOf(1);
  const items = [
    ['Finalize portal wireframes', sara, 'high', 'in_progress', 3],
    ['Security review of login flow', omar, 'urgent', 'review', 1],
    ['Write API documentation', sara, 'medium', 'todo', 10],
    ['Prepare onboarding checklist for new hires', noura, 'medium', 'todo', 7],
    ['Migrate support macros', omar, 'low', 'done', -2],
  ];
  for (const [title, assignee, priority, status, dueIn] of items) {
    await tasks.create(ctx, { title, assignee_user_id: assignee, priority, status, due_date: addDays(today, dueIn), project_id: pm });
  }

  // Documents: a company policy and a contract that expires soon (tiny generated PDFs).
  const pdf = (text) => Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length ${text.length + 30}>>stream\nBT /F1 18 Tf 60 780 Td (${text}) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
  const file = (name, text) => { const buffer = pdf(text); return { buffer, size: buffer.length, originalname: name }; };
  await documents.upload(ctx, { title: 'Employee Handbook 2026', category: 'policy', visible_to_employee: 'on' }, file('employee-handbook.pdf', 'RemoteWay Demo Company - Employee Handbook'));
  await documents.upload(ctx, { title: 'Employment contract', category: 'contract', employee_id: empIds[5], issue_date: monthsAgo(14), expires_at: addDays(today, 20), visible_to_employee: 'on' }, file('contract-sara.pdf', 'Employment contract - Sara Al-Ghamdi'));
  await documents.upload(ctx, { title: 'Iqama', category: 'iqama', employee_id: empIds[8], expires_at: addDays(today, -5), visible_to_employee: 'on' }, file('iqama.pdf', 'Iqama copy'));
}

/** Jobs, candidates across the pipeline, interviews and an onboarding plan so every Phase 3 screen has content. */
async function seedPhase3(ctx, empIds, userIds) {
  const rec = require('../src/modules/recruitment/recruitment.service');
  const onboarding = require('../src/modules/onboarding/onboarding.service');
  const { todayIn, addDays } = require('../src/core/workdays');
  const today = todayIn('Asia/Riyadh');
  const [eng, cs] = await Promise.all(['Engineering', 'Customer Support'].map((n) => knex('departments').where({ organization_id: ctx.organizationId, name: n }).first('id')));
  const [riyadh, remote] = await Promise.all(['Riyadh HQ', 'Remote — KSA'].map((n) => knex('locations').where({ organization_id: ctx.organizationId, name: n }).first('id')));

  const jobs = [
    { title: 'Senior Backend Engineer', department_id: eng.id, location_id: riyadh.id, work_mode: 'hybrid', employment_type: 'full_time', salary_min: 22000, salary_max: 30000, show_salary: 'on', experience_years: 5, openings: 2,
      skills: 'Node.js, MySQL, REST APIs, Docker', description: 'Design and build the services behind our HR platform. You will own features end to end, from database design to production monitoring.',
      requirements: '5+ years building backend services\nStrong SQL and data modelling\nExperience with cloud deployments', hiring_manager_user_id: userIds.manager },
    { title: 'Customer Success Specialist', department_id: cs.id, location_id: remote.id, work_mode: 'remote', employment_type: 'full_time', salary_min: 8000, salary_max: 11000, experience_years: 2, openings: 1,
      skills: 'Arabic, English, CRM, Communication', description: 'Help our customers get the most out of RemoteWay through onboarding sessions and fast, friendly support.', requirements: 'Fluent Arabic and English\n2+ years in a customer-facing role' },
    { title: 'Product Designer (Contract)', department_id: eng.id, work_mode: 'remote', employment_type: 'contract', skills: 'Figma, UX research', description: 'A six-month contract to redesign our mobile experience.', openings: 1 },
  ];
  const jobIds = [];
  for (const j of jobs) jobIds.push(await rec.saveJob(ctx, null, j));
  await rec.setJobStatus(ctx, jobIds[0], 'open');
  await rec.setJobStatus(ctx, jobIds[1], 'open');

  const pdf = (text) => Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length ${text.length + 30}>>stream\nBT /F1 18 Tf 60 780 Td (${text}) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
  // [first, last, title, years, source, job index, stage, rating]
  const people = [
    ['Hamad', 'Al-Fahad', 'Backend Developer', 6, 'linkedin', 0, 'interview', 4],
    ['Lulwa', 'Al-Nasser', 'Software Engineer', 5, 'careers', 0, 'shortlisted', 4],
    ['Ibrahim', 'Saleh', 'Full-stack Developer', 4, 'referral', 0, 'screening', 3],
    ['Ghada', 'Al-Marri', 'Senior Engineer', 8, 'careers', 0, 'offer', 5],
    ['Waleed', 'Hassan', 'Junior Developer', 1, 'careers', 0, 'rejected', 2],
    ['Asma', 'Al-Tamimi', 'Backend Engineer', 5, 'agency', 0, 'applied', null],
    ['Bader', 'Al-Enezi', 'Support Agent', 3, 'careers', 1, 'applied', null],
    ['Shahad', 'Al-Hajri', 'Customer Care Lead', 4, 'linkedin', 1, 'assessment', 4],
    ['Ziyad', 'Al-Khaldi', 'Account Coordinator', 2, 'careers', 1, 'screening', 3],
  ];
  const appIds = [];
  for (const [first, last, title, years, source, jobIndex, stage, rating] of people) {
    const buffer = pdf(`${first} ${last} - CV`);
    const id = await rec.saveCandidate(ctx, null, {
      first_name: first, last_name: last, email: `${first}.${last}@example.com`.toLowerCase().replace(/[^a-z.@]/g, ''), phone: '+966 5' + String(10000000 + appIds.length * 7919).slice(0, 8),
      city: jobIndex === 1 ? 'Jeddah' : 'Riyadh', current_title: title, experience_years: years, source, skills: jobs[jobIndex].skills,
    }, { buffer, size: buffer.length, originalname: `${first}-${last}-cv.pdf`.toLowerCase() });
    const appId = await rec.addToJob(ctx, id, jobIds[jobIndex], { source });
    if (stage !== 'applied') await rec.moveStage(ctx, appId, stage, { reason: stage === 'rejected' ? 'Not enough backend experience' : undefined });
    if (rating) await rec.rate(ctx, appId, rating);
    appIds.push(appId);
  }
  await rec.addNote(ctx, appIds[0], 'Strong system design answers in the screening call. Move to technical interview.');
  const at = (days, hm) => `${addDays(today, days)}T${hm}`;
  await rec.scheduleInterview(ctx, appIds[0], { scheduled_at: at(1, '11:00'), duration_minutes: 60, mode: 'video', location: 'https://meet.example.com/rw-backend', interviewer_user_id: userIds.manager });
  const ivDone = await rec.scheduleInterview(ctx, appIds[3], { scheduled_at: at(-3, '14:00'), duration_minutes: 45, mode: 'onsite', location: 'Riyadh HQ — Room 2', interviewer_user_id: userIds.owner });
  await rec.submitFeedback(ctx, ivDone, { recommendation: 'strong_yes', rating: 5, feedback: 'Excellent architecture knowledge and clear communication. Recommend making an offer.' });
  await rec.scheduleInterview(ctx, appIds[7], { scheduled_at: at(2, '10:30'), duration_minutes: 30, mode: 'phone', interviewer_user_id: userIds.hr });
  await rec.addAssessment(ctx, appIds[7], { title: 'Customer scenario role-play', score: 17, max_score: 20, notes: 'Calm and empathetic.' });

  await orgs.updateSettings(ctx, { careers_enabled: true, careers_intro: 'RemoteWay Demo Company builds HR software for growing teams across the Gulf. We value ownership, clarity and kindness.' });

  // Onboarding for the newest employee (joined this month).
  await onboarding.startPlan(ctx, empIds[18], { start_date: addDays(today, -3) });
  const plan = await knex('onboarding_plans').where({ organization_id: ctx.organizationId, employee_id: empIds[18] }).first('id');
  const firstTasks = await knex('onboarding_tasks').where({ plan_id: plan.id }).orderBy('due_date').limit(3);
  for (const tk of firstTasks) await onboarding.setTaskDone(ctx, tk.id, true);
}

function monthsAgo(n) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  d.setUTCDate(Math.min(d.getUTCDate(), 25));
  return d.toISOString().slice(0, 10);
}

(async () => {
  try {
    if (config.isProd && !process.argv.includes('--force')) throw new Error('Refusing to seed demo data in production (use --force to override).');
    await knex.migrate.latest();
    await seedReference(knex);

    const ownerEmail = `owner@${DOMAIN}`;
    const existing = await knex('users').where({ email: ownerEmail }).first();
    if (existing) {
      console.log('Demo company already exists. Run `npm run migrate:fresh` first to rebuild it.');
      return;
    }

    const { userId: ownerId, organizationId } = await orgs.registerCompany({
      account: { name: DEMO_USERS[0][1], email: ownerEmail, password: PASSWORD, locale: 'en' },
      company: { name: 'RemoteWay Demo Company', country_code: 'SA', industry: 'technology', company_size: '11-50', website: 'https://remoteway.com', phone: '+966 11 000 0000', locale: 'ar' },
      planKey: 'business',
    });
    const ctx = { organizationId, userId: ownerId, permissions: await rbac.getUserPermissions(organizationId, ownerId) };

    const deptIds = {};
    for (const [name, code] of DEPARTMENTS) deptIds[name] = await structure.saveDepartment(ctx, null, { name, code });
    const locIds = {
      'Riyadh HQ': await structure.saveLocation(ctx, null, { name: 'Riyadh HQ', city: 'Riyadh', country_code: 'SA' }),
      'Jeddah Office': await structure.saveLocation(ctx, null, { name: 'Jeddah Office', city: 'Jeddah', country_code: 'SA' }),
      'Remote — KSA': await structure.saveLocation(ctx, null, { name: 'Remote — KSA', country_code: 'SA', is_remote: 'on' }),
    };

    const empIds = [];
    for (const [first, last, title, dept, loc, type, mode, ago, mgr, salary] of PEOPLE) {
      const e = await employees.create(ctx, {
        first_name: first, last_name: last, job_title: title, email: `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + `@${DOMAIN}`,
        department_id: deptIds[dept], location_id: locIds[loc], employment_type: type, work_mode: mode, joining_date: monthsAgo(ago),
        manager_id: mgr === null ? undefined : empIds[mgr], base_salary: salary, nationality: 'SA', status: ago < 3 ? 'probation' : 'active',
      });
      empIds.push(e.id);
    }
    // One former employee, for turnover figures.
    const former = await employees.create(ctx, {
      first_name: 'Majed', last_name: 'Al-Ahmadi', job_title: 'Sales Representative', department_id: deptIds.Sales, location_id: locIds['Riyadh HQ'],
      joining_date: monthsAgo(10), manager_id: empIds[14], base_salary: 9000,
    });
    await employees.terminate(ctx, former.id, { termination_date: monthsAgo(1) });

    for (const [name, key] of [['Executive', 0], ['Human Resources', 1], ['Finance', 2], ['Engineering', 3], ['Customer Support', 4], ['Sales', 14], ['Operations', 16]]) {
      await structure.saveDepartment(ctx, deptIds[name], { name, code: DEPARTMENTS.find((d) => d[0] === name)[1], head_employee_id: empIds[key] });
    }

    // Demo users (besides the owner) join through the same membership + role tables as invited users.
    const userIds = {};
    for (const [slug, name, roleKey, empIndex] of DEMO_USERS) {
      let uid = ownerId;
      if (slug !== 'owner') {
        uid = await knex.transaction((trx) => authService.createUser(trx, { name, email: `${slug}@${DOMAIN}`, password: PASSWORD }));
        await knex('memberships').insert({ organization_id: organizationId, user_id: uid });
        const role = await rbac.getRoleByKey(organizationId, roleKey);
        await knex('user_roles').insert({ organization_id: organizationId, user_id: uid, role_id: role.id });
        await knex('users').where({ id: uid }).update({ last_organization_id: organizationId });
      }
      await knex('employees').where({ id: empIds[empIndex] }).update({ user_id: uid });
      userIds[slug] = uid;
    }
    await orgs.completeOnboarding(ctx);
    await seedPhase2(ctx, empIds);
    await seedPhase3(ctx, empIds, userIds);

    console.log('\nRemoteWay Demo Company is ready.');
    console.log(`Password for all demo users: ${PASSWORD}\n`);
    for (const [slug, , roleKey] of DEMO_USERS) console.log(`  ${roleKey.padEnd(20)} ${slug}@${DOMAIN}`);
    if (process.env.SUPER_ADMIN_EMAIL) console.log(`  ${'super admin'.padEnd(20)} ${process.env.SUPER_ADMIN_EMAIL} (from .env)`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
