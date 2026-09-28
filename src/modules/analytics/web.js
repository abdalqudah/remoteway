// Advanced Analytics (/app/analytics): one filter row (period, department) scoping every KPI and chart.
const express = require('express');
const knex = require('../../db/knex');
const csv = require('../../core/csv');
const charts = require('../../core/charts');
const fmtCore = require('../../core/format');
const { wrap } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const ent = require('../billing/entitlements.service');
const analytics = require('./analytics.service');

const router = express.Router();
router.use(can('reports.view'));

function formatters(req, currency) {
  const loc = req.locale === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB';
  const num = (v) => fmtCore.formatNumber(v, req.locale);
  const month = (key, style = 'short') => new Intl.DateTimeFormat(loc, { month: style, year: style === 'short' ? undefined : 'numeric', timeZone: 'UTC' }).format(new Date(`${key}-01T00:00:00Z`));
  return {
    num, month,
    pct: (v) => (v === null || v === undefined ? '—' : `${num(v)}%`),
    money: (v) => (v === null || v === undefined ? '—' : `${num(Math.round(v))} ${currency}`),
    compact: (v) => new Intl.NumberFormat(req.locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v),
  };
}

/** Builds KPIs, charts and tables for one section (all text translated here). */
function build(req, key, data, f) {
  const t = req.t;
  const pts = (arr) => arr.map((p) => ({ label: f.month(p.label, 'long'), short: f.month(p.label), value: p.value }));
  const table = (head, rows) => ({ head, rows });
  const series = (arr, valueHead, fmt) => table([t('analytics.month'), valueHead], arr.map((p) => [f.month(p.label, 'long'), p.value === null ? '—' : fmt(p.value)]));
  const cats = (arr, labelHead, valueHead, fmt) => table([labelHead, valueHead], arr.map((p) => [p.label || t('analytics.no_department'), p.value === null ? '—' : fmt(p.value)]));
  const band = (k) => t(`analytics.tenure_${k}`);
  const k = data.kpis;
  const out = { kpis: [], charts: [], tables: [] };
  if (key === 'workforce') {
    out.kpis = [
      { label: t('analytics.k_headcount'), value: f.num(k.headcount), hint: t('analytics.k_net', { n: `${k.net_change >= 0 ? '+' : ''}${f.num(k.net_change)}` }) },
      { label: t('analytics.k_hires'), value: f.num(k.hires), hint: t('analytics.k_exits', { n: f.num(k.exits) }) },
      { label: t('analytics.k_tenure'), value: k.avg_tenure_years === null ? '—' : t('analytics.years', { n: f.num(k.avg_tenure_years) }) },
      { label: t('analytics.k_saudization'), value: f.pct(k.saudization_pct), hint: t('analytics.k_saudization_hint') },
    ];
    out.charts = [
      { title: t('analytics.c_headcount'), sub: t('analytics.c_headcount_sub'), html: charts.line({ points: pts(data.headcount), title: t('analytics.c_headcount'), fmt: f.num, width: 800, height: 280 }), table: series(data.headcount, t('analytics.employees'), f.num), wide: true },
      { title: t('analytics.c_joins'), html: charts.columns({ points: pts(data.joins), title: t('analytics.c_joins'), fmt: f.num, yMax: Math.max(...data.exits.map((p) => p.value), 1) }), table: series(data.joins, t('analytics.employees'), f.num) },
      { title: t('analytics.c_exits'), sub: t('analytics.same_scale'), html: charts.columns({ points: pts(data.exits), title: t('analytics.c_exits'), fmt: f.num, yMax: Math.max(...data.joins.map((p) => p.value), 1) }), table: series(data.exits, t('analytics.employees'), f.num) },
      { title: t('analytics.c_departments'), html: charts.bars({ items: data.departments.map((d) => ({ ...d, label: d.label || t('analytics.no_department') })), fmt: f.num }), table: cats(data.departments, t('fields.department'), t('analytics.employees'), f.num) },
      { title: t('analytics.c_saudization'), sub: t('analytics.c_saudization_sub'), html: charts.bars({ items: data.saudization.map((d) => ({ ...d, label: d.label || t('analytics.no_department'), note: `(${f.num(d.count)})` })), fmt: f.pct, max: 100 }), table: cats(data.saudization, t('fields.department'), t('analytics.k_saudization'), f.pct) },
      { title: t('analytics.c_tenure'), html: charts.bars({ items: data.tenure.map((b) => ({ label: band(b.key), value: b.value })), fmt: f.num }), table: table([t('analytics.tenure'), t('analytics.employees')], data.tenure.map((b) => [band(b.key), f.num(b.value)])) },
    ];
  } else if (key === 'retention') {
    out.kpis = [
      { label: t('analytics.k_turnover'), value: f.pct(k.turnover_pct), hint: t('analytics.k_exits', { n: f.num(k.exits) }) },
      { label: t('analytics.k_retention'), value: f.pct(k.retention_12m_pct), hint: t('analytics.k_retention_hint') },
      { label: t('analytics.k_early'), value: f.pct(k.early_attrition_pct), hint: t('analytics.k_early_hint') },
    ];
    out.charts = [
      { title: t('analytics.c_turnover'), sub: t('analytics.c_turnover_sub'), html: charts.line({ points: pts(data.monthly), title: t('analytics.c_turnover'), fmt: f.pct, width: 800, height: 280 }), table: series(data.monthly, t('analytics.k_turnover'), f.pct), wide: true },
      { title: t('analytics.c_turnover_dept'), html: data.byDepartment.some((d) => d.value) ? charts.bars({ items: data.byDepartment.map((d) => ({ ...d, label: d.label || t('analytics.no_department'), note: `(${f.num(d.exits)})` })), fmt: f.pct }) : null, table: cats(data.byDepartment, t('fields.department'), t('analytics.k_turnover'), f.pct) },
      { title: t('analytics.c_exit_tenure'), html: k.exits ? charts.bars({ items: data.tenureAtExit.map((b) => ({ label: band(b.key), value: b.value })), fmt: f.num }) : null, table: table([t('analytics.tenure'), t('analytics.exits')], data.tenureAtExit.map((b) => [band(b.key), f.num(b.value)])) },
    ];
  } else if (key === 'absence') {
    out.kpis = [
      { label: t('analytics.k_leave_days'), value: f.num(k.leave_days) },
      { label: t('analytics.k_days_per_emp'), value: k.days_per_employee === null ? '—' : f.num(k.days_per_employee) },
      { label: t('analytics.k_absence_rate'), value: f.pct(k.absence_rate_pct), hint: t('analytics.k_absence_hint') },
    ];
    const typeName = (x) => (req.locale === 'ar' && x.label_ar ? x.label_ar : x.label);
    out.charts = [
      { title: t('analytics.c_absence_rate'), sub: t('analytics.c_absence_rate_sub'), html: charts.line({ points: pts(data.rate), title: t('analytics.c_absence_rate'), fmt: f.pct, width: 800, height: 280 }), table: series(data.rate, t('analytics.k_absence_rate'), f.pct), wide: true },
      { title: t('analytics.c_leave_days'), html: charts.columns({ points: pts(data.days), title: t('analytics.c_leave_days'), fmt: f.num }), table: series(data.days, t('analytics.days'), f.num) },
      { title: t('analytics.c_leave_types'), html: data.byType.length ? charts.bars({ items: data.byType.map((x) => ({ label: typeName(x), value: x.value })), fmt: f.num }) : null, table: table([t('leave.type'), t('analytics.days'), t('analytics.requests')], data.byType.map((x) => [typeName(x), f.num(x.value), f.num(x.count)])) },
    ];
    out.tables.push({ title: t('analytics.bradford'), sub: t('analytics.bradford_sub'), head: [t('analytics.employee'), t('analytics.spells'), t('analytics.days'), t('analytics.score')], rows: data.bradford.map((b) => [b.name, f.num(b.spells), f.num(b.days), f.num(b.score)]), empty: t('analytics.no_sick') });
  } else if (key === 'attendance') {
    out.kpis = [
      { label: t('analytics.k_punctuality'), value: f.pct(k.punctuality_pct), hint: t('analytics.k_records', { n: f.num(k.records) }) },
      { label: t('analytics.k_hours'), value: k.avg_hours === null ? '—' : f.num(k.avg_hours) },
      { label: t('analytics.k_overtime'), value: f.num(k.overtime_hours) },
    ];
    out.charts = [
      { title: t('analytics.c_punctuality'), sub: t('analytics.c_punctuality_sub'), html: charts.line({ points: pts(data.punctuality), title: t('analytics.c_punctuality'), fmt: f.pct, yMax: 100, width: 800, height: 280 }), table: series(data.punctuality, t('analytics.k_punctuality'), f.pct), wide: true },
      { title: t('analytics.c_hours'), html: charts.line({ points: pts(data.hours), title: t('analytics.c_hours'), fmt: f.num, height: 200 }), table: series(data.hours, t('analytics.k_hours'), f.num) },
      { title: t('analytics.c_overtime_dept'), html: data.overtime.length ? charts.bars({ items: data.overtime.map((d) => ({ ...d, label: d.label || t('analytics.no_department') })), fmt: f.num }) : null, table: cats(data.overtime, t('fields.department'), t('analytics.k_overtime'), f.num) },
    ];
  } else if (key === 'hiring') {
    out.kpis = [
      { label: t('analytics.k_applications'), value: f.num(k.applications) },
      { label: t('analytics.k_hires_made'), value: f.num(k.hires), hint: t('analytics.k_conversion', { n: f.pct(k.conversion_pct) }) },
      { label: t('analytics.k_time_to_hire'), value: k.avg_days_to_hire === null ? '—' : t('analytics.days_n', { n: f.num(k.avg_days_to_hire) }) },
    ];
    out.charts = [
      { title: t('analytics.c_funnel'), sub: t('analytics.c_funnel_sub'), html: k.applications ? charts.bars({ items: data.funnel.map((s) => ({ label: t(`recruitment.stage_${s.key}`), value: s.value, note: s.pct === null ? '' : `(${f.pct(s.pct)})` })), fmt: f.num }) : null, table: table([t('analytics.stage'), t('analytics.k_applications'), '%'], data.funnel.map((s) => [t(`recruitment.stage_${s.key}`), f.num(s.value), f.pct(s.pct)])), wide: true },
      { title: t('analytics.c_applications'), html: charts.columns({ points: pts(data.applications), title: t('analytics.c_applications'), fmt: f.num }), table: series(data.applications, t('analytics.k_applications'), f.num) },
      { title: t('analytics.c_time_to_hire'), html: data.timeToHire.some((p) => p.value !== null) ? charts.line({ points: pts(data.timeToHire), title: t('analytics.c_time_to_hire'), fmt: f.num, height: 200 }) : null, table: series(data.timeToHire, t('analytics.days'), f.num) },
    ];
    out.tables.push({ title: t('analytics.sources'), head: [t('analytics.source'), t('analytics.k_applications'), t('analytics.k_hires_made'), t('analytics.hire_rate')], rows: data.sources.map((s) => [t(`recruitment.source_${s.key}`), f.num(s.applications), f.num(s.hires), f.pct(s.rate)]), empty: t('analytics.no_data') });
  } else if (key === 'cost') {
    out.kpis = [
      { label: t('analytics.k_total_cost'), value: f.money(k.total_cost), hint: t('analytics.k_cost_hint') },
      { label: t('analytics.k_avg_month'), value: f.money(k.avg_monthly_cost) },
      { label: t('analytics.k_per_employee'), value: f.money(k.cost_per_employee), hint: t('analytics.k_per_employee_hint') },
      { label: t('analytics.k_contributions'), value: f.pct(k.contributions_pct), hint: t('analytics.k_contributions_hint') },
    ];
    out.charts = [
      { title: t('analytics.c_cost'), sub: t('analytics.c_cost_sub', { currency: data.currency }), html: data.monthly.some((p) => p.value !== null) ? charts.columns({ points: pts(data.monthly), title: t('analytics.c_cost'), fmt: f.compact, width: 800, height: 280 }) : null, table: series(data.monthly, t('analytics.k_total_cost'), f.money), wide: true },
      { title: t('analytics.c_cost_dept'), sub: t('analytics.c_cost_dept_sub'), html: data.byDepartment.length ? charts.bars({ items: data.byDepartment.map((d) => ({ ...d, label: d.label || t('analytics.no_department') })), fmt: f.compact }) : null, table: cats(data.byDepartment, t('fields.department'), t('analytics.k_avg_month'), f.money), wide: true },
    ];
  }
  return out;
}

router.get('/', wrap(async (req, res) => {
  const inPlan = (await ent.getEntitlements(req.ctx.organizationId)).features.has('analytics');
  const sections = inPlan ? await analytics.sectionsFor(req.ctx) : [];
  const key = sections.includes(req.query.section) ? req.query.section : sections[0];
  const departments = await knex('departments').where({ organization_id: req.ctx.organizationId }).orderBy('name').select('id', 'name');
  if (!inPlan || !key) {
    return res.page('pages/analytics/index', { title: req.t('analytics.title'), inPlan, sections, key: null, view: null, departments, filters: {} });
  }
  const result = await analytics.section(req.ctx, key, { months: req.query.months, department_id: req.query.department_id });
  const f = formatters(req, req.organization.currency);
  const view = build(req, key, result.data, f);
  if (req.query.format === 'csv') {
    const rows = [];
    for (const c of [...view.charts, ...view.tables.map((tb) => ({ title: tb.title, table: tb }))]) {
      rows.push([c.title]); rows.push(c.table.head); for (const r of c.table.rows) rows.push(r); rows.push([]);
    }
    res.setHeader('Content-Disposition', `attachment; filename="analytics-${key}.csv"`);
    return csv.send(res, `analytics-${key}.csv`, [req.t(`analytics.s_${key}`), `${result.filters.from} → ${result.filters.to}`], rows);
  }
  return res.page('pages/analytics/index', { printable: true, title: req.t('analytics.title'), inPlan, sections, key, view, departments, filters: result.filters, PERIODS: analytics.PERIODS });
}));

module.exports = router;
