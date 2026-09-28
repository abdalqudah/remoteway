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

/** Salaries, allowances, bank details and two payrolls (last month paid, this month in draft). */
async function seedPhase4(ctx, empIds) {
  const payroll = require('../src/modules/payroll/payroll.service');
  const { todayIn } = require('../src/core/workdays');
  // Valid Saudi IBANs (ISO 13616 check digits) for demo accounts.
  const iban = (n) => {
    const bban = `80${String(1000000000000000 + n * 7919).padStart(18, '0')}`;
    const digits = `${bban}SA00`.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
    let rem = 0;
    for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
    return `SA${String(98 - rem).padStart(2, '0')}${bban}`;
  };
  const comps = await payroll.listComponents(ctx.organizationId);
  const byCode = Object.fromEntries(comps.map((c) => [c.code, c.id]));
  const expats = new Set([8, 11]); // two non-Saudi employees, for GOSI differences
  for (const [i, id] of empIds.entries()) {
    if (expats.has(i)) await knex('employees').where({ id }).update({ nationality: 'EG' });
    const e = await knex('employees').where({ id }).first('base_salary');
    const input = {
      base_salary: Number(e.base_salary), payment_method: 'bank', bank_name: i % 2 ? 'Al Rajhi Bank' : 'Saudi National Bank',
      iban: i === 17 ? '' : iban(i + 1), gosi_registered: 'on',
      [`component_${byCode.HOUSING}`]: 25, [`component_${byCode.TRANSPORT}`]: 10,
    };
    if (i === 6) input[`component_${byCode.LOAN}`] = 1500;
    await payroll.saveCompensation(ctx, id, input);
  }
  const current = todayIn('Asia/Riyadh').slice(0, 7);
  const [y, m] = current.split('-').map(Number);
  const previous = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const last = await payroll.createRun(ctx, previous);
  await payroll.addAdjustment(ctx, last, { employee_id: empIds[5], kind: 'earning', name: 'Performance bonus', amount: 2000 });
  await payroll.transition(ctx, last, 'submit');
  await payroll.transition(ctx, last, 'approve');
  await payroll.transition(ctx, last, 'pay', { payment_date: `${previous}-27` });
  await payroll.createRun(ctx, current);
}

/** Goals with key results and check-ins, a launched review cycle with reviews at every stage, and feedback. */
async function seedPhase5(ctx, empIds, userIds) {
  const goals = require('../src/modules/performance/goals.service');
  const reviews = require('../src/modules/performance/reviews.service');
  const { todayIn, addDays } = require('../src/core/workdays');
  const rbacCtx = async (uid) => ({ organizationId: ctx.organizationId, userId: uid, permissions: await rbac.getUserPermissions(ctx.organizationId, uid) });
  const today = todayIn('Asia/Riyadh');
  const year = today.slice(0, 4);
  const dept = async (name) => (await knex('departments').where({ organization_id: ctx.organizationId, name }).first('id')).id;
  const company = await goals.save(ctx, null, { scope: 'company', title: 'Grow recurring revenue to SAR 12M', description: 'Our north star for the year.', start_date: `${year}-01-01`, due_date: `${year}-12-31`,
    kr_title: ['Annual recurring revenue (SAR M)', 'Net revenue retention (%)'], kr_start: [7, 96], kr_target: [12, 110], kr_unit: ['M', '%'] });
  const support = await goals.save(ctx, null, { scope: 'department', department_id: await dept('Customer Support'), parent_id: company, title: 'World-class customer support', due_date: `${year}-12-31`,
    kr_title: ['First response time (hours)', 'CSAT (%)'], kr_start: [10, 82], kr_target: [2, 95], kr_unit: ['h', '%'] });
  const eng = await goals.save(ctx, null, { scope: 'department', department_id: await dept('Engineering'), parent_id: company, title: 'Ship the self-service portal', due_date: addDays(today, 60),
    kr_title: ['Portal features shipped', 'Uptime (%)'], kr_start: [0, 99], kr_target: [12, 99.9], kr_unit: ['', '%'] });
  const mgr = await rbacCtx(userIds.manager);
  const sara = await rbacCtx(userIds.employee);
  const saraGoal = await goals.save(sara, null, { title: 'Deliver the billing module of the portal', parent_id: eng, start_date: `${year}-07-01`, due_date: addDays(today, 45),
    kr_title: ['Billing screens released', 'Automated test coverage (%)'], kr_start: [0, 40], kr_target: [6, 80], kr_unit: ['', '%'] });
  const g2 = await goals.save(mgr, null, { employee_id: empIds[6], title: 'Improve API performance', parent_id: eng, due_date: addDays(today, 30), kr_title: ['p95 latency (ms)'], kr_start: [800], kr_target: [300], kr_unit: ['ms'] });
  await goals.save(ctx, null, { employee_id: empIds[4], title: 'Build the support knowledge base', parent_id: support, due_date: addDays(today, 50), kr_title: ['Articles published'], kr_start: [0], kr_target: [40] });
  const kr = async (goalId) => knex('goal_key_results').where({ goal_id: goalId }).orderBy('sort_order');
  const [arr, nrr] = await kr(company);
  await goals.checkIn(ctx, company, { [`kr_${arr.id}`]: 9.4, [`kr_${nrr.id}`]: 104, health: 'on_track', note: 'Strong Q3 renewals.' });
  const [frt, csat] = await kr(support);
  await goals.checkIn(ctx, support, { [`kr_${frt.id}`]: 5, [`kr_${csat.id}`]: 88, health: 'at_risk', note: 'Response time improving, CSAT behind plan.' });
  const [feat, up] = await kr(eng);
  await goals.checkIn(mgr, eng, { [`kr_${feat.id}`]: 7, [`kr_${up.id}`]: 99.95, health: 'on_track' });
  const [screens, cov] = await kr(saraGoal);
  await goals.checkIn(sara, saraGoal, { [`kr_${screens.id}`]: 4, [`kr_${cov.id}`]: 65, health: 'on_track', note: 'Invoices and payments screens are live.' });
  const [lat] = await kr(g2);
  await goals.checkIn(mgr, g2, { [`kr_${lat.id}`]: 650, health: 'off_track', note: 'Blocked on the database upgrade.' });

  // Mid-year review for Engineering, launched; Sara has done her self review; one review completed.
  const comps = await reviews.listCompetencies(ctx.organizationId);
  const cycleId = await reviews.saveCycle(ctx, null, { name: `H2 ${year} review`, kind: 'semi_annual', period_start: `${year}-07-01`, period_end: `${year}-12-31`,
    self_due: addDays(today, 7), manager_due: addDays(today, 21), include_self: 'on', goals_weight: 60, competency_ids: comps.slice(0, 5).map((c) => c.id), department_ids: [await dept('Engineering')] });
  await reviews.launchCycle(ctx, cycleId);
  const saraReview = await knex('reviews').where({ cycle_id: cycleId, employee_id: empIds[5] }).first();
  const items = await knex('review_items').where({ review_id: saraReview.id });
  const selfInput = { self_summary: 'Shipped most of the billing module and improved our test coverage.' };
  for (const it of items) { selfInput[`self_rating_${it.id}`] = it.item_type === 'goal' ? 4 : 4; selfInput[`self_comment_${it.id}`] = ''; }
  await reviews.saveSelf(sara, saraReview.id, selfInput, true);
  const lamaReview = await knex('reviews').where({ cycle_id: cycleId, employee_id: empIds[7] }).first();
  const lamaItems = await knex('review_items').where({ review_id: lamaReview.id });
  const mgrInput = { manager_summary: 'Lama raised the quality bar of our product design.', strengths: 'Craft, user research', improvements: 'Share work earlier with engineering' };
  for (const [i, it] of lamaItems.entries()) mgrInput[`manager_rating_${it.id}`] = [5, 4, 4, 5, 4][i % 5];
  await knex('reviews').where({ id: lamaReview.id }).update({ status: 'manager_review', self_submitted_at: new Date() });
  await reviews.saveManager(mgr, lamaReview.id, mgrInput, true);

  // Feedback.
  await reviews.giveFeedback(ctx, { employee_id: empIds[4], kind: 'praise', public: 'on', body: 'Thank you Reem for turning around the enterprise escalation this week — the customer renewed.' });
  await reviews.giveFeedback(mgr, { employee_id: empIds[5], kind: 'praise', public: 'on', body: 'Great demo of the billing screens to the leadership team!' });
  await reviews.giveFeedback(mgr, { employee_id: empIds[6], kind: 'suggestion', body: 'Please share a short weekly update on the latency work so we can unblock you earlier.' });
}

/** Courses with lessons and quizzes, a learning path, assignments and a certificate. */
async function seedPhase6(ctx, empIds, userIds) {
  const courses = require('../src/modules/learning/courses.service');
  const enroll = require('../src/modules/learning/enrollments.service');
  const { todayIn, addDays } = require('../src/core/workdays');
  const today = todayIn('Asia/Riyadh');
  const asUser = async (uid) => ({ organizationId: ctx.organizationId, userId: uid, permissions: await rbac.getUserPermissions(ctx.organizationId, uid) });
  const quiz = (items) => ({ q_text: items.map((i) => i[0]), q_opt0: items.map((i) => i[1][0]), q_opt1: items.map((i) => i[1][1]), q_opt2: items.map((i) => i[1][2] || ''), q_opt3: items.map((i) => i[1][3] || ''), q_correct: items.map((i) => i[2]) });

  const sec = await courses.saveCourse(ctx, null, { title: 'Information security basics', category: 'Compliance', level: 'beginner', is_mandatory: 'on', self_enroll: 'on', certificate_enabled: 'on', validity_months: 12, passing_score: 70,
    description: 'Every employee completes this course once a year.\n\n- Recognise phishing\n- Protect passwords and devices\n- Report incidents quickly' });
  await courses.saveLesson(ctx, sec, null, { kind: 'text', title: 'Why security matters', duration_minutes: 5, body: '# Our shared responsibility\nMost incidents start with a single click. **You** are the first line of defence.\n\n- Lock your screen when you step away\n- Never share one-time codes\n- Report anything suspicious to IT' });
  await courses.saveLesson(ctx, sec, null, { kind: 'video', title: 'Spotting phishing emails', duration_minutes: 8, url: 'https://www.youtube.com/watch?v=aO858HyFbKI', body: 'Watch the video, then continue.' });
  await courses.saveLesson(ctx, sec, null, { kind: 'text', title: 'Passwords and multi-factor authentication', duration_minutes: 6, body: '## Strong passwords\nUse a password manager and a unique password for every account.\n\n## Multi-factor authentication\nTurn it on for email, HR and banking apps.' });
  await courses.saveLesson(ctx, sec, null, { kind: 'quiz', title: 'Check your knowledge', duration_minutes: 5, ...quiz([
    ['An email asks you to confirm your password urgently. What do you do?', ['Reply with the password', 'Click the link to check', 'Report it to IT without clicking'], 2],
    ['What is the safest way to manage many passwords?', ['Reuse one strong password', 'Use a password manager', 'Write them on a sticky note'], 1],
    ['Someone calls asking for your one-time code. You…', ['Share it if they sound official', 'Never share it'], 1],
  ]) });
  await courses.setCourseStatus(ctx, sec, 'published');

  const cs = await courses.saveCourse(ctx, null, { title: 'Customer service excellence', category: 'Customer experience', level: 'intermediate', self_enroll: 'on', certificate_enabled: 'on', passing_score: 60,
    description: 'Practical habits that turn support tickets into loyal customers.' });
  await courses.saveLesson(ctx, cs, null, { kind: 'text', title: 'The first response', duration_minutes: 7, body: 'Answer quickly, use the customer\'s name and confirm what you understood.\n\n1. Acknowledge\n2. Clarify\n3. Commit to a next step' });
  await courses.saveLesson(ctx, cs, null, { kind: 'link', title: 'Our service standards (intranet)', duration_minutes: 10, url: 'https://remoteway.com/standards' });
  await courses.saveLesson(ctx, cs, null, { kind: 'quiz', title: 'Quick check', duration_minutes: 3, ...quiz([
    ['What comes first in a good response?', ['Acknowledge the customer', 'Explain our policy'], 0],
    ['A customer is angry. You…', ['Argue the facts', 'Listen and summarise their concern'], 1],
  ]) });
  await courses.setCourseStatus(ctx, cs, 'published');

  const lead = await courses.saveCourse(ctx, null, { title: 'Leading your first team', category: 'Leadership', level: 'intermediate', self_enroll: 'on', certificate_enabled: 'on',
    description: 'One-to-ones, feedback and delegation for new managers.' });
  await courses.saveLesson(ctx, lead, null, { kind: 'text', title: 'Running great one-to-ones', duration_minutes: 10, body: 'Keep a shared agenda, let your report speak first, and end with clear actions.' });
  await courses.saveLesson(ctx, lead, null, { kind: 'text', title: 'Giving feedback that lands', duration_minutes: 8, body: 'Be specific: describe the situation, the behaviour and the impact.' });
  await courses.setCourseStatus(ctx, lead, 'published');
  const draft = await courses.saveCourse(ctx, null, { title: 'Saudi Labor Law essentials', category: 'Compliance', level: 'beginner' });
  await courses.saveLesson(ctx, draft, null, { kind: 'text', title: 'Working hours and overtime', duration_minutes: 10, body: 'Draft content.' });

  const path = await courses.savePath(ctx, null, { title: 'New manager essentials', description: 'Everything a first-time manager needs in the first 90 days.', status: 'published', course_ids: [lead, cs] });

  // Everyone must complete security training within three weeks.
  await enroll.assignCourse(ctx, sec, { everyone: 'on', due_date: addDays(today, 21) });
  await knex('enrollments').where({ course_id: sec, employee_id: empIds[10] }).update({ due_date: addDays(today, -3) }); // one overdue
  await enroll.assignPath(ctx, path, { employee_ids: [empIds[3]], due_date: addDays(today, 60) });

  // Sara completes security training and gets a certificate; Omar is half-way through his path.
  const sara = await asUser(userIds.employee);
  const lessons = await knex('course_lessons').where({ course_id: sec }).orderBy('sort_order');
  for (const l of lessons.filter((x) => x.kind !== 'quiz')) await enroll.completeLesson(sara, sec, l.id);
  const qz = lessons.find((x) => x.kind === 'quiz');
  const qs = await knex('lesson_questions').where({ lesson_id: qz.id });
  await enroll.submitQuiz(sara, sec, qz.id, Object.fromEntries(qs.map((q) => [`q_${q.id}`, q.correct_index])));
  await enroll.enrollSelf(sara, cs);
  const csLessons = await knex('course_lessons').where({ course_id: cs }).orderBy('sort_order');
  await enroll.completeLesson(sara, cs, csLessons[0].id);
  const omar = await asUser(userIds.manager);
  const leadLessons = await knex('course_lessons').where({ course_id: lead }).orderBy('sort_order');
  await enroll.completeLesson(omar, lead, leadLessons[0].id);
  await enroll.completeLesson(omar, sec, lessons[0].id);
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
    await seedPhase4(ctx, empIds);
    await seedPhase5(ctx, empIds, userIds);
    await seedPhase6(ctx, empIds, userIds);

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
