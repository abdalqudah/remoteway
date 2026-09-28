// Company metrics for the analytics assistant. Every number is computed here with SQL; the model only
// explains them. Each area is included only when the user may see it company-wide, and the plan has it.
const knex = require('../../db/knex');
const orgs = require('../organizations/organization.service');
const ent = require('../billing/entitlements.service');
const dashboard = require('../dashboard/dashboard.service');

const n = (v) => Number(v || 0);
const round = (v, d = 1) => Math.round(Number(v || 0) * 10 ** d) / 10 ** d;

function ymd(date) { return date.toISOString().slice(0, 10); }
function daysAgo(days) { const d = new Date(); d.setUTCDate(d.getUTCDate() - days); return d; }

async function workforce(orgId) {
  const d = await dashboard.companyDashboard(orgId);
  const yearAgo = ymd(daysAgo(365));
  const [row] = await knex('employees').where({ organization_id: orgId }).select(
    knex.raw('SUM(status = ? AND termination_date >= ?) as left_12m', ['terminated', yearAgo]),
    knex.raw('SUM(joining_date >= ?) as joined_12m', [yearAgo]),
  );
  const avgHeadcount = d.trend.length ? d.trend.reduce((s, m) => s + m.count, 0) / d.trend.length : d.overview.total;
  return {
    headcount: d.overview.total, active: d.overview.active, probation: d.overview.probation, on_leave_status: d.overview.on_leave,
    joined_this_month: d.overview.new_this_month, left_this_month: d.overview.left_this_month,
    joined_last_12_months: n(row.joined_12m), left_last_12_months: n(row.left_12m),
    turnover_rate_12m_percent: avgHeadcount ? round((n(row.left_12m) / avgHeadcount) * 100) : null,
    without_department: d.overview.without_department, without_manager: d.overview.without_manager,
    by_department: d.departments.map((x) => ({ department: x.name || 'No department', employees: x.count })),
    by_employment_type: d.types.map((x) => ({ type: x.key, employees: x.count })),
    by_work_mode: d.workModes.map((x) => ({ mode: x.key, employees: x.count })),
    headcount_last_6_months: d.trend.map((x) => ({ month: x.month, headcount: x.count })),
  };
}

async function leave(orgId, today) {
  const year = today.slice(0, 4);
  const [pending, onLeaveToday, byType] = await Promise.all([
    knex('leave_requests').where({ organization_id: orgId, status: 'pending' }).count({ c: '*' }).first(),
    knex('leave_requests').where({ organization_id: orgId, status: 'approved' }).where('start_date', '<=', today).where('end_date', '>=', today).countDistinct({ c: 'employee_id' }).first(),
    knex('leave_requests as r').join('leave_types as t', 't.id', 'r.leave_type_id').where({ 'r.organization_id': orgId, 'r.status': 'approved' })
      .where('r.start_date', '>=', `${year}-01-01`).groupBy('t.id', 't.name').select('t.name').sum({ days: 'r.days' }).count({ requests: '*' }),
  ]);
  return {
    pending_requests: n(pending.c), employees_on_leave_today: n(onLeaveToday.c),
    approved_this_year_by_type: byType.map((x) => ({ type: x.name, days: round(x.days), requests: n(x.requests) })),
  };
}

async function attendance(orgId) {
  const from = ymd(daysAgo(30));
  const [r] = await knex('attendance').where({ organization_id: orgId }).where('work_date', '>=', from).select(
    knex.raw('COUNT(*) as records'), knex.raw('COUNT(DISTINCT employee_id) as employees'), knex.raw('AVG(worked_minutes) as avg_worked'),
    knex.raw('SUM(late_minutes > 0) as late_days'), knex.raw('SUM(overtime_minutes) as overtime'),
  );
  return {
    period: 'last 30 days', attendance_records: n(r.records), employees_with_records: n(r.employees),
    average_worked_hours_per_day: round(n(r.avg_worked) / 60), late_arrivals: n(r.late_days), overtime_hours: round(n(r.overtime) / 60),
  };
}

async function recruitment(orgId) {
  const since = daysAgo(90);
  const [open, stages, hires] = await Promise.all([
    knex('jobs').where({ organization_id: orgId, status: 'open' }).count({ c: '*' }).first(),
    knex('applications as a').join('jobs as j', 'j.id', 'a.job_id').where({ 'a.organization_id': orgId, 'j.status': 'open' })
      .groupBy('a.stage').select('a.stage').count({ c: '*' }),
    knex('applications').where({ organization_id: orgId, stage: 'hired' }).where('stage_changed_at', '>=', since)
      .select(knex.raw('COUNT(*) as hires'), knex.raw('AVG(DATEDIFF(stage_changed_at, created_at)) as days')).first(),
  ]);
  return {
    open_jobs: n(open.c), applications_on_open_jobs_by_stage: stages.map((s) => ({ stage: s.stage, applications: n(s.c) })),
    hires_last_90_days: n(hires.hires), average_days_to_hire_last_90_days: hires.hires ? round(hires.days) : null,
  };
}

async function payroll(orgId) {
  const runs = await knex('payroll_runs').where({ organization_id: orgId }).whereIn('status', ['approved', 'paid'])
    .orderBy('period', 'desc').limit(3).select('period', 'status', 'currency', 'employee_count', 'total_gross', 'total_deductions', 'total_net', 'total_employer');
  return {
    last_approved_runs: runs.map((r) => ({
      period: r.period, status: r.status, currency: r.currency, employees: r.employee_count,
      gross: Number(r.total_gross), deductions: Number(r.total_deductions), net: Number(r.total_net), employer_contributions: Number(r.total_employer),
    })),
  };
}

async function performance(orgId) {
  const [health, cycles] = await Promise.all([
    knex('goals').where({ organization_id: orgId, status: 'active' }).groupBy('health').select('health').count({ c: '*' }).avg({ p: 'progress' }),
    knex('reviews as r').join('review_cycles as c', 'c.id', 'r.cycle_id').where({ 'r.organization_id': orgId, 'c.status': 'active' })
      .groupBy('c.id', 'c.name', 'r.status').select('c.name', 'r.status').count({ c: '*' }),
  ]);
  const active = {};
  for (const r of cycles) (active[r.name] = active[r.name] || {})[r.status] = n(r.c);
  return {
    active_goals_by_health: health.map((h) => ({ health: h.health, goals: n(h.c), average_progress_percent: round(h.p) })),
    active_review_cycles: Object.entries(active).map(([name, byStatus]) => ({ cycle: name, reviews_by_status: byStatus })),
  };
}

async function learning(orgId, today) {
  const [byStatus, overdue, expiring] = await Promise.all([
    knex('enrollments').where({ organization_id: orgId }).groupBy('status').select('status').count({ c: '*' }),
    knex('enrollments').where({ organization_id: orgId }).whereNot('status', 'completed').whereNotNull('due_date').where('due_date', '<', today).count({ c: '*' }).first(),
    knex('certificates').where({ organization_id: orgId }).whereNotNull('expires_on').whereBetween('expires_on', [today, ymd(new Date(Date.now() + 60 * 86_400_000))]).count({ c: '*' }).first(),
  ]);
  const total = byStatus.reduce((s, r) => s + n(r.c), 0);
  const done = n((byStatus.find((r) => r.status === 'completed') || {}).c);
  return {
    enrollments_by_status: byStatus.map((r) => ({ status: r.status, enrollments: n(r.c) })),
    completion_rate_percent: total ? round((done / total) * 100) : null,
    overdue_assignments: n(overdue.c), certificates_expiring_next_60_days: n(expiring.c),
  };
}

async function documents(orgId, today) {
  const soon = ymd(new Date(Date.now() + 30 * 86_400_000));
  const [row] = await knex('documents').where({ organization_id: orgId }).select(
    knex.raw('SUM(expires_at < ?) as expired', [today]), knex.raw('SUM(expires_at >= ? AND expires_at <= ?) as expiring', [today, soon]),
  );
  return { expired_documents: n(row.expired), documents_expiring_next_30_days: n(row.expiring) };
}

async function tasks(orgId, today) {
  const [byStatus, overdue] = await Promise.all([
    knex('tasks').where({ organization_id: orgId }).groupBy('status').select('status').count({ c: '*' }),
    knex('tasks').where({ organization_id: orgId }).whereNot('status', 'done').whereNotNull('due_date').where('due_date', '<', today).count({ c: '*' }).first(),
  ]);
  return { tasks_by_status: byStatus.map((r) => ({ status: r.status, tasks: n(r.c) })), overdue_tasks: n(overdue.c) };
}

// area → [needed permissions (all), plan feature or null, loader]
const AREAS = [
  ['workforce', ['employees.view'], 'employees', workforce],
  ['leave', ['employees.view', 'leave.view'], 'leave', leave],
  ['attendance', ['employees.view', 'attendance.view'], 'attendance', attendance],
  ['recruitment', ['recruitment.view'], 'recruitment', recruitment],
  ['payroll', ['payroll.view'], 'payroll', payroll],
  ['performance', ['employees.view', 'performance.view'], 'performance', performance],
  ['learning', ['learning.manage'], 'learning', learning],
  ['documents', ['employees.view', 'documents.view'], 'documents', documents],
  ['tasks', ['tasks.view'], 'tasks', tasks],
];

/** @returns {Promise<{asOf:string, currency:string, areas:object}>} metrics the user may see */
async function collect(ctx) {
  const org = await orgs.get(ctx.organizationId);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone || 'UTC' }).format(new Date());
  const entitlements = await ent.getEntitlements(ctx.organizationId);
  const areas = {};
  for (const [key, perms, feature, load] of AREAS) {
    if (!perms.every((p) => ctx.permissions.has(p))) continue;
    if (feature && !entitlements.features.has(feature)) continue;
    areas[key] = await load(ctx.organizationId, today);
  }
  return { asOf: today, currency: org.currency, areas };
}

module.exports = { collect, AREA_KEYS: AREAS.map((a) => a[0]) };
