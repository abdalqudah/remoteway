// Advanced Analytics: workforce, retention, absence, attendance, hiring and payroll-cost metrics.
// Every figure is computed here from the database for the selected months and department.
// Department filters use each employee's current department (department history is not tracked).
const knex = require('../../db/knex');
const { E } = require('../../core/errors');
const { countWorkingDays } = require('../../core/workdays');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');

const n = (v) => Number(v || 0);
const r1 = (v) => Math.round(Number(v || 0) * 10) / 10;
const pct = (a, b) => (b ? r1((a / b) * 100) : null);
const ymd = (d) => d.toISOString().slice(0, 10);
const PERIODS = [6, 12, 24];
const STAGES = ['applied', 'screening', 'shortlisted', 'interview', 'assessment', 'offer', 'hired'];
const TENURE_BANDS = [[0, 1, 'lt1'], [1, 2, '1_2'], [2, 5, '2_5'], [5, 10, '5_10'], [10, 999, '10p']];

// Section → permissions (all needed) and plan module.
const SECTIONS = {
  workforce: { perms: ['employees.view'], feature: 'employees' },
  retention: { perms: ['employees.view'], feature: 'employees' },
  absence: { perms: ['employees.view', 'leave.view'], feature: 'leave' },
  attendance: { perms: ['employees.view', 'attendance.view'], feature: 'attendance' },
  hiring: { perms: ['recruitment.view'], feature: 'recruitment' },
  cost: { perms: ['payroll.view'], feature: 'payroll' },
};

async function sectionsFor(ctx) {
  const e = await ent.getEntitlements(ctx.organizationId);
  return Object.keys(SECTIONS).filter((k) => e.features.has(SECTIONS[k].feature) && SECTIONS[k].perms.every((p) => ctx.permissions.has(p)));
}

async function assertAccess(ctx, section) {
  if (!ctx.permissions.has('reports.view')) throw E.forbidden('reports.view');
  await ent.assertFeature(ctx.organizationId, 'analytics');
  if (!SECTIONS[section]) throw E.notFound('Section');
  if (!(await sectionsFor(ctx)).includes(section)) throw E.forbidden(SECTIONS[section].perms.join('+'));
}

/** Month buckets (oldest first) ending with the current month, in the organization's time zone. */
async function frame(ctx, { months, department_id: dept } = {}) {
  const org = await orgs.get(ctx.organizationId);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone || 'UTC' }).format(new Date());
  const count = PERIODS.includes(Number(months)) ? Number(months) : 12;
  const [y, m] = today.split('-').map(Number);
  const buckets = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const start = new Date(Date.UTC(y, m - 1 - i, 1));
    const end = new Date(Date.UTC(y, m - i, 0));
    buckets.push({ key: ymd(start).slice(0, 7), start: ymd(start), end: i === 0 ? today : ymd(end) });
  }
  let departmentId = Number(dept) > 0 ? Number(dept) : null;
  if (departmentId && !(await knex('departments').where({ id: departmentId, organization_id: ctx.organizationId }).first('id'))) departmentId = null;
  return { org, today, months: count, buckets, from: buckets[0].start, to: today, departmentId };
}

const emp = (f, alias = 'e') => {
  const q = knex(`employees as ${alias}`).where(`${alias}.organization_id`, f.orgId);
  if (f.departmentId) q.where(`${alias}.department_id`, f.departmentId);
  return q;
};
const started = (alias = 'e') => `COALESCE(${alias}.joining_date, DATE(${alias}.created_at))`;
const bucketBy = (rows, f, key = 'k', val = 'v') => f.buckets.map((b) => n((rows.find((r) => r[key] === b.key) || {})[val]));

async function headcountAt(f, dates) {
  if (!dates.length) return [];
  const selects = dates.map((d, i) => knex.raw(`SUM(${started()} <= ? AND (e.termination_date IS NULL OR e.termination_date > ?)) as h${i}`, [d, d]));
  const [row] = await emp(f).select(selects);
  return dates.map((d, i) => n(row[`h${i}`]));
}

// ---------- Workforce ----------
async function workforce(f) {
  const ends = f.buckets.map((b) => b.end);
  const [headcount, joins, exits, depts, active] = await Promise.all([
    headcountAt(f, ends),
    emp(f).whereRaw(`${started()} BETWEEN ? AND ?`, [f.from, f.to]).select(knex.raw(`DATE_FORMAT(${started()}, '%Y-%m') as k`)).count({ v: '*' }).groupBy('k'),
    emp(f).where('e.status', 'terminated').whereBetween('e.termination_date', [f.from, f.to]).select(knex.raw("DATE_FORMAT(e.termination_date, '%Y-%m') as k")).count({ v: '*' }).groupBy('k'),
    emp(f).leftJoin('departments as d', 'd.id', 'e.department_id').whereNot('e.status', 'terminated')
      .groupBy('d.id', 'd.name').select('d.name').count({ total: '*' }).select(knex.raw("SUM(e.nationality = 'SA') as saudi")).orderBy('total', 'desc'),
    emp(f).whereNot('e.status', 'terminated').select(knex.raw(`${started()} as since`), 'e.nationality'),
  ]);
  const now = new Date(`${f.today}T00:00:00Z`).getTime();
  const years = active.map((a) => Math.max(0, (now - new Date(a.since).getTime()) / (365.25 * 86_400_000)));
  const tenure = TENURE_BANDS.map(([lo, hi, key]) => ({ key, value: years.filter((y) => y >= lo && y < hi).length }));
  const start = (await headcountAt(f, [ymd(new Date(new Date(`${f.from}T00:00:00Z`).getTime() - 86_400_000))]))[0];
  const saudi = active.filter((a) => a.nationality === 'SA').length;
  const nationalityKnown = active.filter((a) => a.nationality).length;
  return {
    kpis: {
      headcount: headcount[headcount.length - 1], net_change: headcount[headcount.length - 1] - start,
      hires: joins.reduce((s, r) => s + n(r.v), 0), exits: exits.reduce((s, r) => s + n(r.v), 0),
      avg_tenure_years: years.length ? r1(years.reduce((s, y) => s + y, 0) / years.length) : null,
      saudization_pct: nationalityKnown ? pct(saudi, active.length) : null,
    },
    headcount: f.buckets.map((b, i) => ({ label: b.key, value: headcount[i] })),
    joins: f.buckets.map((b, i) => ({ label: b.key, value: bucketBy(joins, f)[i] })),
    exits: f.buckets.map((b, i) => ({ label: b.key, value: bucketBy(exits, f)[i] })),
    departments: depts.map((d) => ({ label: d.name || null, value: n(d.total) })),
    saudization: depts.map((d) => ({ label: d.name || null, value: pct(n(d.saudi), n(d.total)), count: n(d.total) })),
    tenure,
  };
}

// ---------- Retention ----------
async function retention(f) {
  const startsOfMonth = f.buckets.map((b) => ymd(new Date(new Date(`${b.start}T00:00:00Z`).getTime() - 86_400_000)));
  const [openHc, exitsRows, leavers, byDept, yearAgoIds] = await Promise.all([
    headcountAt(f, startsOfMonth),
    emp(f).where('e.status', 'terminated').whereBetween('e.termination_date', [f.from, f.to]).select(knex.raw("DATE_FORMAT(e.termination_date, '%Y-%m') as k")).count({ v: '*' }).groupBy('k'),
    emp(f).where('e.status', 'terminated').whereBetween('e.termination_date', [f.from, f.to]).select(knex.raw(`DATEDIFF(e.termination_date, ${started()}) as days`)),
    emp(f).leftJoin('departments as d', 'd.id', 'e.department_id').groupBy('d.id', 'd.name').select('d.name')
      .select(knex.raw('SUM(e.status = ? AND e.termination_date BETWEEN ? AND ?) as exits', ['terminated', f.from, f.to]))
      .select(knex.raw(`SUM(${started()} <= ? AND (e.termination_date IS NULL OR e.termination_date >= ?)) as exposed`, [f.to, f.from])),
    emp(f).whereRaw(`${started()} <= ?`, [ymd(new Date(new Date(`${f.today}T00:00:00Z`).getTime() - 365 * 86_400_000))])
      .where((w) => w.whereNull('e.termination_date').orWhere('e.termination_date', '>', ymd(new Date(new Date(`${f.today}T00:00:00Z`).getTime() - 365 * 86_400_000))))
      .select('e.id', 'e.status'),
  ]);
  const exits = bucketBy(exitsRows, f);
  const totalExits = exits.reduce((s, v) => s + v, 0);
  const avgHc = openHc.length ? openHc.reduce((s, v) => s + v, 0) / openHc.length : 0;
  const years = leavers.map((l) => n(l.days) / 365.25);
  return {
    kpis: {
      turnover_pct: pct(totalExits, avgHc), exits: totalExits,
      early_attrition_pct: leavers.length ? pct(years.filter((y) => y < 1).length, leavers.length) : null,
      retention_12m_pct: yearAgoIds.length ? pct(yearAgoIds.filter((e) => e.status !== 'terminated').length, yearAgoIds.length) : null,
    },
    monthly: f.buckets.map((b, i) => ({ label: b.key, value: openHc[i] ? pct(exits[i], openHc[i]) : 0 })),
    tenureAtExit: TENURE_BANDS.map(([lo, hi, key]) => ({ key, value: years.filter((y) => y >= lo && y < hi).length })),
    byDepartment: byDept.filter((d) => n(d.exposed)).map((d) => ({ label: d.name || null, value: pct(n(d.exits), n(d.exposed)), exits: n(d.exits) }))
      .sort((a, b) => b.value - a.value),
  };
}

// ---------- Absence ----------
async function absence(f) {
  const settings = await orgs.getSettings(f.orgId);
  const workDays = settings.working_days || ['sun', 'mon', 'tue', 'wed', 'thu'];
  const base = () => {
    const q = knex('leave_requests as r').join('employees as e', 'e.id', 'r.employee_id').join('leave_types as t', 't.id', 'r.leave_type_id')
      .where({ 'r.organization_id': f.orgId, 'r.status': 'approved' });
    if (f.departmentId) q.where('e.department_id', f.departmentId);
    return q;
  };
  const [monthly, byType, headcount, sick] = await Promise.all([
    base().whereBetween('r.start_date', [f.from, f.to]).select(knex.raw("DATE_FORMAT(r.start_date, '%Y-%m') as k")).sum({ v: 'r.days' }).groupBy('k'),
    base().whereBetween('r.start_date', [f.from, f.to]).groupBy('t.id', 't.name', 't.name_ar').select('t.name', 't.name_ar').sum({ v: 'r.days' }).count({ c: '*' }).orderBy('v', 'desc'),
    headcountAt(f, f.buckets.map((b) => b.end)),
    base().where('t.key', 'sick').where('r.start_date', '>=', ymd(new Date(new Date(`${f.today}T00:00:00Z`).getTime() - 364 * 86_400_000)))
      .groupBy('e.id', 'e.first_name', 'e.last_name').select('e.id', 'e.first_name', 'e.last_name').count({ spells: '*' }).sum({ days: 'r.days' }),
  ]);
  const days = bucketBy(monthly, f);
  const rate = f.buckets.map((b, i) => {
    const wd = countWorkingDays(b.start, b.end, workDays);
    return headcount[i] && wd ? r1((days[i] / (headcount[i] * wd)) * 100) : 0;
  });
  const bradford = sick.map((s) => ({ id: s.id, name: `${s.first_name} ${s.last_name}`, spells: n(s.spells), days: n(s.days), score: n(s.spells) ** 2 * n(s.days) }))
    .sort((a, b) => b.score - a.score).slice(0, 10);
  const totalDays = days.reduce((s, v) => s + v, 0);
  const avgHc = headcount.reduce((s, v) => s + v, 0) / (headcount.length || 1);
  return {
    kpis: { leave_days: r1(totalDays), days_per_employee: avgHc ? r1(totalDays / avgHc) : null, absence_rate_pct: r1(rate.reduce((s, v) => s + v, 0) / (rate.length || 1)) },
    days: f.buckets.map((b, i) => ({ label: b.key, value: r1(days[i]) })),
    rate: f.buckets.map((b, i) => ({ label: b.key, value: rate[i] })),
    byType: byType.map((t) => ({ label: t.name, label_ar: t.name_ar, value: r1(t.v), count: n(t.c) })),
    bradford,
  };
}

// ---------- Attendance ----------
async function attendance(f) {
  const base = () => {
    const q = knex('attendance as a').join('employees as e', 'e.id', 'a.employee_id').where('a.organization_id', f.orgId).whereBetween('a.work_date', [f.from, f.to]);
    if (f.departmentId) q.where('e.department_id', f.departmentId);
    return q;
  };
  const [monthly, byDept] = await Promise.all([
    base().whereNotNull('a.clock_in').select(knex.raw("DATE_FORMAT(a.work_date, '%Y-%m') as k"))
      .select(knex.raw('COUNT(*) as records'), knex.raw('AVG(a.worked_minutes) as worked'), knex.raw('SUM(a.late_minutes = 0) as ontime'), knex.raw('SUM(a.overtime_minutes) as ot')).groupBy('k'),
    base().leftJoin('departments as d', 'd.id', 'e.department_id').groupBy('d.id', 'd.name').select('d.name')
      .select(knex.raw('SUM(a.overtime_minutes) as ot'), knex.raw('COUNT(*) as records')).orderBy('ot', 'desc'),
  ]);
  const get = (k) => monthly.find((r) => r.k === k) || {};
  const records = monthly.reduce((s, r) => s + n(r.records), 0);
  return {
    kpis: {
      records,
      punctuality_pct: records ? pct(monthly.reduce((s, r) => s + n(r.ontime), 0), records) : null,
      avg_hours: records ? r1(monthly.reduce((s, r) => s + n(r.worked) * n(r.records), 0) / records / 60) : null,
      overtime_hours: r1(monthly.reduce((s, r) => s + n(r.ot), 0) / 60),
    },
    punctuality: f.buckets.map((b) => ({ label: b.key, value: n(get(b.key).records) ? pct(n(get(b.key).ontime), n(get(b.key).records)) : null })),
    hours: f.buckets.map((b) => ({ label: b.key, value: n(get(b.key).records) ? r1(n(get(b.key).worked) / 60) : null })),
    overtime: byDept.map((d) => ({ label: d.name || null, value: r1(n(d.ot) / 60) })).filter((d) => d.value > 0),
  };
}

// ---------- Hiring ----------
async function hiring(f) {
  const base = () => {
    const q = knex('applications as a').join('jobs as j', 'j.id', 'a.job_id').join('candidates as c', 'c.id', 'a.candidate_id')
      .where('a.organization_id', f.orgId).whereRaw('DATE(a.created_at) BETWEEN ? AND ?', [f.from, f.to]);
    if (f.departmentId) q.where('j.department_id', f.departmentId);
    return q;
  };
  const [apps, hires, events, bySource] = await Promise.all([
    base().select(knex.raw("DATE_FORMAT(a.created_at, '%Y-%m') as k")).count({ v: '*' }).groupBy('k'),
    base().where('a.stage', 'hired').select(knex.raw("DATE_FORMAT(a.stage_changed_at, '%Y-%m') as k"), knex.raw('DATEDIFF(a.stage_changed_at, a.created_at) as d')),
    base().leftJoin('application_events as ev', function j() { this.on('ev.application_id', 'a.id').andOn('ev.type', knex.raw('?', ['stage'])); })
      .select('a.id', 'a.stage', knex.raw("JSON_UNQUOTE(JSON_EXTRACT(ev.data, '$.to')) as reached")),
    base().groupBy('c.source').select('c.source').count({ apps: '*' }).select(knex.raw("SUM(a.stage = 'hired') as hired")).orderBy('apps', 'desc'),
  ]);
  const maxStage = new Map();
  for (const e of events) {
    const idx = Math.max(STAGES.indexOf(e.stage), STAGES.indexOf(e.reached || ''), 0);
    maxStage.set(e.id, Math.max(maxStage.get(e.id) ?? 0, idx));
  }
  const total = maxStage.size;
  const funnel = STAGES.map((s, i) => {
    const c = [...maxStage.values()].filter((v) => v >= i).length;
    return { key: s, value: c, pct: pct(c, total) };
  });
  const days = hires.map((h) => n(h.d));
  const hiresByMonth = f.buckets.map((b) => hires.filter((h) => h.k === b.key));
  return {
    kpis: {
      applications: total, hires: hires.length, conversion_pct: pct(hires.length, total),
      avg_days_to_hire: days.length ? r1(days.reduce((s, v) => s + v, 0) / days.length) : null,
    },
    applications: f.buckets.map((b, i) => ({ label: b.key, value: bucketBy(apps, f)[i] })),
    timeToHire: f.buckets.map((b, i) => ({ label: b.key, value: hiresByMonth[i].length ? r1(hiresByMonth[i].reduce((s, h) => s + n(h.d), 0) / hiresByMonth[i].length) : null })),
    funnel,
    sources: bySource.map((s) => ({ key: s.source, applications: n(s.apps), hires: n(s.hired), rate: pct(n(s.hired), n(s.apps)) })),
  };
}

// ---------- Payroll cost ----------
async function cost(f) {
  const base = () => {
    const q = knex('payslips as p').join('payroll_runs as r', 'r.id', 'p.run_id').join('employees as e', 'e.id', 'p.employee_id')
      .where('p.organization_id', f.orgId).whereIn('r.status', ['approved', 'paid']).whereBetween('r.period_start', [f.from, f.to]);
    if (f.departmentId) q.where('e.department_id', f.departmentId);
    return q;
  };
  const [monthly, byDept] = await Promise.all([
    base().groupBy('r.period').select('r.period as k').sum({ gross: 'p.gross', employer: 'p.employer_cost', net: 'p.net' }).count({ people: '*' }),
    base().groupBy('p.department_name').select('p.department_name as name').sum({ gross: 'p.gross', employer: 'p.employer_cost' }).count({ people: '*' }),
  ]);
  const get = (k) => monthly.find((r) => r.k === k) || {};
  // payslips.employer_cost is the full cost to the employer (gross pay + employer contributions).
  const total = (r) => n(r.employer);
  const periods = monthly.length;
  const all = monthly.reduce((s, r) => s + total(r), 0);
  const last = [...monthly].sort((a, b) => (a.k < b.k ? 1 : -1))[0];
  return {
    currency: f.org.currency,
    kpis: {
      total_cost: Math.round(all), avg_monthly_cost: periods ? Math.round(all / periods) : null,
      cost_per_employee: last && n(last.people) ? Math.round(total(last) / n(last.people)) : null,
      contributions_pct: all ? pct(monthly.reduce((s, r) => s + n(r.employer) - n(r.gross), 0), all) : null,
    },
    monthly: f.buckets.map((b) => ({ label: b.key, value: get(b.key).k ? Math.round(total(get(b.key))) : null })),
    byDepartment: byDept.map((d) => ({ label: d.name || null, value: periods ? Math.round(n(d.employer) / periods) : 0 })).sort((a, b) => b.value - a.value),
  };
}

const LOADERS = { workforce, retention, absence, attendance, hiring, cost };

async function section(ctx, key, filters) {
  await assertAccess(ctx, key);
  const f = { ...(await frame(ctx, filters)), orgId: ctx.organizationId };
  return { key, filters: { months: f.months, department_id: f.departmentId, from: f.from, to: f.to }, data: await LOADERS[key](f) };
}

module.exports = { SECTIONS, PERIODS, STAGES, TENURE_BANDS, sectionsFor, assertAccess, section, frame };
