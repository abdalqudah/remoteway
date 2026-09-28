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
    }
    await orgs.completeOnboarding(ctx);

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
