// Every number here is computed from the database. Modules that are not built yet
// are reported as unavailable instead of showing placeholder figures.
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const ent = require('../billing/entitlements.service');

async function workforceOverview(organizationId) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  const monthStr = monthStart.toISOString().slice(0, 10);
  const rows = await knex('employees').where({ organization_id: organizationId }).select(
    knex.raw("SUM(status <> 'terminated') as total"),
    knex.raw("SUM(status = 'active') as active"),
    knex.raw("SUM(status = 'probation') as probation"),
    knex.raw("SUM(status = 'on_leave') as on_leave"),
    knex.raw("SUM(status <> 'terminated' AND joining_date >= ?) as new_this_month", [monthStr]),
    knex.raw("SUM(status = 'terminated' AND termination_date >= ?) as left_this_month", [monthStr]),
    knex.raw("SUM(status <> 'terminated' AND department_id IS NULL) as without_department"),
    knex.raw("SUM(status <> 'terminated' AND manager_id IS NULL) as without_manager"),
  );
  const r = rows[0];
  const n = (v) => Number(v || 0);
  return {
    total: n(r.total), active: n(r.active), probation: n(r.probation), on_leave: n(r.on_leave),
    new_this_month: n(r.new_this_month), left_this_month: n(r.left_this_month),
    without_department: n(r.without_department), without_manager: n(r.without_manager),
  };
}

async function byDepartment(organizationId) {
  const rows = await knex('employees as e').leftJoin('departments as d', 'd.id', 'e.department_id')
    .where('e.organization_id', organizationId).whereNot('e.status', 'terminated')
    .groupBy('d.id', 'd.name').select('d.id', 'd.name').count({ n: '*' }).orderBy('n', 'desc');
  return rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.n) }));
}

async function byType(organizationId) {
  const rows = await knex('employees').where({ organization_id: organizationId }).whereNot('status', 'terminated')
    .groupBy('employment_type').select('employment_type').count({ n: '*' });
  return rows.map((r) => ({ key: r.employment_type, count: Number(r.n) }));
}

async function byWorkMode(organizationId) {
  const rows = await knex('employees').where({ organization_id: organizationId }).whereNot('status', 'terminated')
    .groupBy('work_mode').select('work_mode').count({ n: '*' });
  return rows.map((r) => ({ key: r.work_mode, count: Number(r.n) }));
}

// Net headcount at the end of each of the last 6 months.
async function headcountTrend(organizationId) {
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i -= 1) {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 0));
    months.push(end.toISOString().slice(0, 10));
  }
  const selects = months.map((m, i) => knex.raw(
    `SUM(COALESCE(joining_date, DATE(created_at)) <= ? AND (termination_date IS NULL OR termination_date > ?)) as m${i}`, [m, m],
  ));
  const [row] = await knex('employees').where({ organization_id: organizationId }).select(selects);
  return months.map((m, i) => ({ month: m.slice(0, 7), count: Number(row[`m${i}`] || 0) }));
}

async function recentActivity(organizationId, limit = 8) {
  return knex('audit_logs as a').leftJoin('users as u', 'u.id', 'a.user_id').where('a.organization_id', organizationId)
    .whereNot('a.action', 'like', 'auth.%').select('a.*', 'u.name as user_name').orderBy('a.id', 'desc').limit(limit);
}

async function actionCenter(organizationId, overview, entitlements, usage) {
  const items = [];
  const [{ n: pendingInvites }] = await knex('invitations').where({ organization_id: organizationId }).whereNull('accepted_at').whereNull('revoked_at')
    .where('expires_at', '>', new Date()).count({ n: '*' });
  if (Number(pendingInvites)) items.push({ key: 'pending_invitations', count: Number(pendingInvites), href: '/app/settings/users', tone: 'info' });
  const [{ n: openInvoices }] = await knex('invoices').where({ organization_id: organizationId, status: 'issued' }).count({ n: '*' });
  if (Number(openInvoices)) items.push({ key: 'open_invoices', count: Number(openInvoices), href: '/app/billing', tone: 'warning' });
  if (overview.without_department) items.push({ key: 'without_department', count: overview.without_department, href: '/app/employees?status=current', tone: 'neutral' });
  if (overview.without_manager > 1) items.push({ key: 'without_manager', count: overview.without_manager, href: '/app/employees?status=current', tone: 'neutral' });
  const maxEmp = entitlements.limits.employees;
  if (maxEmp !== null && maxEmp !== undefined && usage.employees >= maxEmp * 0.9) {
    items.push({ key: usage.employees >= maxEmp ? 'employee_limit_reached' : 'employee_limit_near', count: usage.employees, max: maxEmp, href: '/app/billing', tone: 'warning' });
  }
  if (entitlements.status === 'trial' && entitlements.trialDaysLeft <= 7) items.push({ key: 'trial_ending', count: entitlements.trialDaysLeft, href: '/app/billing', tone: 'warning' });
  if (!entitlements.canWrite) items.push({ key: 'subscription_inactive', href: '/app/billing', tone: 'danger' });
  return items;
}

async function companyDashboard(organizationId) {
  return cache.remember(`dash:${organizationId}`, async () => {
    const entitlements = await ent.getEntitlements(organizationId);
    const usage = await ent.getUsage(organizationId);
    const overview = await workforceOverview(organizationId);
    return {
      overview,
      usage,
      limits: entitlements.limits,
      departments: await byDepartment(organizationId),
      types: await byType(organizationId),
      workModes: await byWorkMode(organizationId),
      trend: await headcountTrend(organizationId),
      actions: await actionCenter(organizationId, overview, entitlements, usage),
    };
  }, 15_000);
}

function invalidate(organizationId) {
  cache.forgetPrefix(`dash:${organizationId}`);
}

module.exports = { companyDashboard, recentActivity, invalidate };
