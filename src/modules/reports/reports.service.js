// Reports: ready-made templates (Basic Reports), a custom builder with saved reports (Advanced Reports)
// and scheduled email delivery (Enterprise Reporting). Queries are built only from the dataset
// definitions — user input selects columns and filter values, never SQL.
const knex = require('../../db/knex');
const config = require('../../config');
const csv = require('../../core/csv');
const jobs = require('../../core/jobs');
const mailer = require('../../core/mailer');
const audit = require('../../core/audit');
const { translator } = require('../../core/i18n');
const { E, AppError } = require('../../core/errors');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');
const rbac = require('../rbac/rbac.service');
const { DATASETS, TEMPLATES, PERIODS } = require('./datasets');

const MAX_ROWS = 1000;
const MAX_EXPORT = 50_000;
const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// ---------- Access ----------
async function tiers(organizationId) {
  const e = await ent.getEntitlements(organizationId);
  return { basic: e.features.has('basic_reports'), advanced: e.features.has('advanced_reports'), scheduled: e.features.has('enterprise_reporting') };
}

function canUseDataset(ctx, entitlements, key) {
  const ds = DATASETS[key];
  return Boolean(ds && entitlements.features.has(ds.feature) && ds.permissions.every((p) => ctx.permissions.has(p)));
}

async function datasetsFor(ctx) {
  const e = await ent.getEntitlements(ctx.organizationId);
  return Object.keys(DATASETS).filter((k) => canUseDataset(ctx, e, k));
}

async function assertDataset(ctx, key) {
  if (!ctx.permissions.has('reports.view')) throw E.forbidden('reports.view');
  const e = await ent.getEntitlements(ctx.organizationId);
  if (!DATASETS[key]) throw E.notFound('Report');
  if (!e.features.has(DATASETS[key].feature)) throw E.featureNotInPlan(DATASETS[key].feature);
  if (!canUseDataset(ctx, e, key)) throw E.forbidden(DATASETS[key].permissions.join('+'));
}

// ---------- Config ----------
function periodRange(period, today, from, to) {
  const d = new Date(`${today}T00:00:00Z`);
  const ymd = (x) => x.toISOString().slice(0, 10);
  const add = (days) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + days); return ymd(x); };
  const y = d.getUTCFullYear(); const m = d.getUTCMonth();
  switch (period) {
    case 'this_month': return [ymd(new Date(Date.UTC(y, m, 1))), ymd(new Date(Date.UTC(y, m + 1, 0)))];
    case 'last_month': return [ymd(new Date(Date.UTC(y, m - 1, 1))), ymd(new Date(Date.UTC(y, m, 0)))];
    case 'this_year': return [`${y}-01-01`, `${y}-12-31`];
    case 'last_90_days': return [add(-90), today];
    case 'last_12_months': return [add(-365), today];
    case 'next_30_days': return [today, add(30)];
    case 'next_60_days': return [today, add(60)];
    case 'custom': return [isDate(from) ? from : null, isDate(to) ? to : null];
    default: return [null, null];
  }
}

/** Cleans a report configuration against its dataset and the user's permissions. */
function normalize(ctx, key, raw = {}) {
  const ds = DATASETS[key];
  const allowed = (c) => ds.columns[c] && (!ds.columns[c].permission || ctx.permissions.has(ds.columns[c].permission));
  const groupBy = raw.group_by && allowed(raw.group_by) && ['text', 'enum', 'date'].includes(ds.columns[raw.group_by].type) ? raw.group_by : null;
  let columns = arr(raw.columns).filter((c) => allowed(c) && (groupBy || !ds.columns[c].groupOnly));
  columns = [...new Set(columns)];
  if (!columns.length && !groupBy) columns = ds.defaults.filter(allowed);
  const f = raw.filters || {};
  const filters = {
    period: PERIODS.includes(f.period) ? f.period : 'all',
    from: isDate(f.from) ? f.from : null,
    to: isDate(f.to) ? f.to : null,
    department_id: ds.department && Number(f.department_id) > 0 ? Number(f.department_id) : null,
    status: ds.status ? arr(f.status).filter((s) => ds.status.values.includes(s)) : [],
  };
  const sort = raw.sort && allowed(raw.sort) && !ds.columns[raw.sort].groupOnly ? raw.sort : ds.sort;
  return { columns, group_by: groupBy, filters, sort, desc: raw.desc === undefined ? Boolean(ds.desc) : Boolean(raw.desc) };
}

/** Builds a config from the builder form (arrays of column keys, filter fields). */
function configFromForm(body) {
  return {
    columns: arr(body.columns), group_by: body.group_by || null, sort: body.sort || null, desc: body.desc === 'on' || body.desc === '1',
    filters: { period: body.period, from: body.from, to: body.to, department_id: body.department_id, status: arr(body.status) },
  };
}

// ---------- Running ----------
const num = (v) => (v === null || v === undefined ? null : Number(v));

async function run(ctx, key, rawConfig, { limit = MAX_ROWS } = {}) {
  await assertDataset(ctx, key);
  const ds = DATASETS[key];
  const cfg = normalize(ctx, key, rawConfig);
  const org = await orgs.get(ctx.organizationId);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone || 'UTC' }).format(new Date());
  const q = ds.base(knex, ctx.organizationId);
  const [from, to] = periodRange(cfg.filters.period, today, cfg.filters.from, cfg.filters.to);
  if (from) q.whereRaw(`DATE(${ds.date}) >= ?`, [from]);
  if (to) q.whereRaw(`DATE(${ds.date}) <= ?`, [to]);
  if (cfg.filters.department_id) q.where(ds.department, cfg.filters.department_id);
  if (cfg.filters.status.length) q.whereIn(ds.status.expr, cfg.filters.status);

  let columns; let rows;
  if (cfg.group_by) {
    const g = ds.columns[cfg.group_by];
    const measures = cfg.columns.filter((c) => c !== cfg.group_by && ['number', 'money'].includes(ds.columns[c].type));
    q.select(knex.raw(`${g.expr} as g`)).count({ count: '*' }).groupByRaw(g.expr);
    for (const m of measures) q.select(knex.raw(`${ds.columns[m].agg === 'avg' ? 'AVG' : 'SUM'}(${ds.columns[m].expr}) as ??`, [`m_${m}`]));
    q.orderBy('count', 'desc').limit(limit + 1);
    const data = await q;
    columns = [{ key: cfg.group_by, type: g.type, labels: g.labels }, { key: 'count', type: 'number' },
      ...measures.map((m) => ({ key: m, type: ds.columns[m].type, agg: ds.columns[m].agg === 'avg' ? 'avg' : 'sum' }))];
    rows = data.map((r) => [r.g, Number(r.count), ...measures.map((m) => (r[`m_${m}`] == null ? null : Math.round(Number(r[`m_${m}`]) * 100) / 100))]);
  } else {
    for (const c of cfg.columns) q.select(knex.raw(`${ds.columns[c].expr} as ??`, [`c_${c}`]));
    q.orderByRaw(`${ds.columns[cfg.sort].expr} ${cfg.desc ? 'DESC' : 'ASC'}`).limit(limit + 1);
    const data = await q;
    columns = cfg.columns.map((c) => ({ key: c, type: ds.columns[c].type, labels: ds.columns[c].labels }));
    rows = data.map((r) => cfg.columns.map((c) => (['number', 'money'].includes(ds.columns[c].type) ? num(r[`c_${c}`]) : r[`c_${c}`])));
  }
  const truncated = rows.length > limit;
  if (truncated) rows = rows.slice(0, limit);
  return { dataset: key, config: cfg, columns, rows, truncated, range: [from, to], currency: org.currency };
}

/** Translated header and plain cell values for CSV output. */
function toTable(result, t) {
  const header = result.columns.map((c) => (c.key === 'count' ? t('reports.count') : `${t(`reports.col_${result.dataset}_${c.key}`)}${c.agg === 'avg' ? ` (${t('reports.avg')})` : c.agg === 'sum' ? ` (${t('reports.sum')})` : ''}`));
  const rows = result.rows.map((r) => r.map((v, i) => {
    const c = result.columns[i];
    if (v === null || v === undefined) return '';
    if (c.labels) { const l = t(`${c.labels}${v}`); return l === `${c.labels}${v}` ? v : l; }
    if (c.type === 'date') return (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
    if (c.type === 'datetime') return v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 16) : String(v);
    return v;
  }));
  return { header, rows };
}

// ---------- Templates ----------
async function templatesFor(ctx) {
  const e = await ent.getEntitlements(ctx.organizationId);
  return TEMPLATES.filter((tpl) => canUseDataset(ctx, e, tpl.dataset));
}

// ---------- Saved reports ----------
async function listSaved(ctx) {
  const usable = await datasetsFor(ctx);
  if (!usable.length) return [];
  const rows = await knex('saved_reports as r').leftJoin('users as u', 'u.id', 'r.created_by').where('r.organization_id', ctx.organizationId)
    .whereIn('r.dataset', usable).where((w) => w.where('r.created_by', ctx.userId).orWhere('r.is_shared', true))
    .select('r.*', 'u.name as created_by_name').orderBy('r.name');
  const schedules = await knex('report_schedules').where({ organization_id: ctx.organizationId }).whereIn('report_id', rows.map((r) => r.id)).select('report_id', 'frequency', 'is_active');
  return rows.map((r) => ({ ...r, config: parse(r.config, {}), schedules: schedules.filter((s) => s.report_id === r.id) }));
}

async function getSaved(ctx, id) {
  const r = await knex('saved_reports').where({ id, organization_id: ctx.organizationId }).first();
  if (!r || (r.created_by !== ctx.userId && !r.is_shared)) throw E.notFound('Report');
  await assertDataset(ctx, r.dataset);
  return { ...r, config: parse(r.config, {}) };
}

const canEditSaved = (ctx, r) => r.created_by === ctx.userId || ctx.permissions.has('reports.manage');

async function save(ctx, id, input) {
  if (!ctx.permissions.has('reports.manage')) throw E.forbidden('reports.manage');
  if (!(await tiers(ctx.organizationId)).advanced) throw E.featureNotInPlan('advanced_reports');
  await ent.assertCanWrite(ctx.organizationId);
  const key = String(input.dataset || '');
  await assertDataset(ctx, key);
  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 150) throw E.validation({ name: 'Give the report a name.' });
  const cfg = normalize(ctx, key, configFromForm(input));
  const row = { name, dataset: key, config: JSON.stringify(cfg), is_shared: input.is_shared === 'on' };
  if (id) {
    const existing = await getSaved(ctx, id);
    if (!canEditSaved(ctx, existing)) throw E.forbidden('reports.manage');
    await knex('saved_reports').where({ id }).update({ ...row, updated_at: new Date() });
  } else {
    [id] = await knex('saved_reports').insert({ ...row, organization_id: ctx.organizationId, created_by: ctx.userId });
  }
  await audit.record(ctx, 'report.saved', { entityType: 'report', entityId: id, newValues: { name, dataset: key } });
  return id;
}

async function remove(ctx, id) {
  const r = await getSaved(ctx, id);
  if (!canEditSaved(ctx, r)) throw E.forbidden('reports.manage');
  await knex('saved_reports').where({ id }).del();
  await audit.record(ctx, 'report.deleted', { entityType: 'report', entityId: id, newValues: { name: r.name } });
}

// ---------- Schedules ----------
function tzParts(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
/** UTC instant of a wall-clock time in a time zone. */
function zonedTime(y, m, d, h, timeZone) {
  const guess = Date.UTC(y, m - 1, d, h, 0);
  const p = tzParts(new Date(guess), timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  return new Date(guess - (asUtc - guess));
}

/** Next delivery time strictly after `after`, in the organization's time zone. */
function nextRun(s, timeZone, after = new Date()) {
  const start = tzParts(after, timeZone);
  for (let i = 0; i < 400; i += 1) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const y = day.getUTCFullYear(); const m = day.getUTCMonth() + 1; const d = day.getUTCDate(); const wd = day.getUTCDay();
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const ok = s.frequency === 'daily' || (s.frequency === 'weekly' && wd === Number(s.weekday))
      || (s.frequency === 'monthly' && d === Math.min(Number(s.day_of_month), lastDay));
    if (!ok) continue;
    const at = zonedTime(y, m, d, Number(s.hour), timeZone);
    if (at > after) return at;
  }
  throw new Error('Could not compute the next run');
}

async function listSchedules(ctx, reportId) {
  return knex('report_schedules').where({ organization_id: ctx.organizationId, report_id: reportId }).orderBy('id');
}

async function saveSchedule(ctx, reportId, input) {
  if (!ctx.permissions.has('reports.manage')) throw E.forbidden('reports.manage');
  if (!(await tiers(ctx.organizationId)).scheduled) throw E.featureNotInPlan('enterprise_reporting');
  await ent.assertCanWrite(ctx.organizationId);
  const report = await getSaved(ctx, reportId);
  const errors = {};
  const frequency = String(input.frequency || '');
  if (!['daily', 'weekly', 'monthly'].includes(frequency)) errors.frequency = 'Choose how often.';
  const weekday = Number(input.weekday ?? 0);
  const dayOfMonth = Number(input.day_of_month || 1);
  const hour = Number(input.hour ?? 8);
  if (frequency === 'weekly' && !(weekday >= 0 && weekday <= 6)) errors.weekday = 'Choose a day.';
  if (frequency === 'monthly' && !(dayOfMonth >= 1 && dayOfMonth <= 31)) errors.day_of_month = 'Choose a day between 1 and 31.';
  if (!(Number.isInteger(hour) && hour >= 0 && hour <= 23)) errors.hour = 'Choose an hour.';
  const ids = [...new Set(arr(input.recipients).map(Number).filter((n) => n > 0))];
  const members = ids.length ? await knex('memberships').where({ organization_id: ctx.organizationId, status: 'active' }).whereIn('user_id', ids).pluck('user_id') : [];
  if (!members.length) errors.recipients = 'Choose at least one recipient.';
  if (members.length > 20) errors.recipients = 'Choose at most 20 recipients.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const org = await orgs.get(ctx.organizationId);
  const s = { frequency, weekday: frequency === 'weekly' ? weekday : null, day_of_month: frequency === 'monthly' ? dayOfMonth : null, hour };
  const [id] = await knex('report_schedules').insert({
    ...s, organization_id: ctx.organizationId, report_id: report.id, recipients: JSON.stringify(members), next_run_at: nextRun(s, org.timezone || 'UTC'), created_by: ctx.userId,
  });
  await audit.record(ctx, 'report.scheduled', { entityType: 'report', entityId: report.id, newValues: { name: report.name, frequency, recipients: members.length } });
  return id;
}

async function removeSchedule(ctx, reportId, scheduleId) {
  const report = await getSaved(ctx, reportId);
  if (!canEditSaved(ctx, report)) throw E.forbidden('reports.manage');
  await knex('report_schedules').where({ id: scheduleId, report_id: report.id, organization_id: ctx.organizationId }).del();
}

/** Queues deliveries for schedules that are due. Safe to call from several processes. */
async function dispatchDue(now = new Date()) {
  const due = await knex('report_schedules as s').join('organizations as o', 'o.id', 's.organization_id')
    .where('s.is_active', true).where('s.next_run_at', '<=', now).select('s.*', 'o.timezone').limit(50);
  let queued = 0;
  for (const s of due) {
    const next = nextRun(s, s.timezone || 'UTC', now);
    const claimed = await knex('report_schedules').where({ id: s.id, next_run_at: s.next_run_at }).update({ next_run_at: next });
    if (!claimed) continue;
    await jobs.enqueue(null, { organizationId: s.organization_id, type: 'report.deliver', payload: { scheduleId: s.id }, maxAttempts: 3 });
    queued += 1;
  }
  return queued;
}

async function ctxFor(organizationId, userId) {
  const m = await knex('memberships').where({ organization_id: organizationId, user_id: userId, status: 'active' }).first();
  if (!m) return null;
  return { organizationId, userId, permissions: await rbac.getUserPermissions(organizationId, userId) };
}

/** Job handler: runs the report as its author and emails a CSV to recipients who may see it. */
async function deliver({ scheduleId }) {
  const s = await knex('report_schedules').where({ id: scheduleId, is_active: true }).first();
  if (!s) return;
  const finish = (status, extra = {}) => knex('report_schedules').where({ id: s.id }).update({ last_run_at: new Date(), last_status: String(status).slice(0, 255), ...extra });
  const report = await knex('saved_reports').where({ id: s.report_id }).first();
  const author = report && report.created_by ? await ctxFor(s.organization_id, report.created_by) : null;
  if (!report || !author) return finish('Stopped: the report author no longer has access.', { is_active: false });
  if (!(await tiers(s.organization_id)).scheduled) return finish('Stopped: scheduled reports are not included in the plan.', { is_active: false });
  if (!mailer.enabled() && !config.isTest) return finish('Skipped: email is not configured on the platform.');
  let result;
  try {
    result = await run(author, report.dataset, parse(report.config, {}), { limit: MAX_EXPORT });
  } catch (e) {
    if (e instanceof AppError) return finish(`Stopped: ${e.message}`, { is_active: false });
    throw e;
  }
  let sent = 0;
  const brand = await require('../branding/branding.service').forEmail(s.organization_id); // eslint-disable-line global-require
  const base = brand ? brand.base : config.appUrl;
  for (const userId of parse(s.recipients, [])) {
    const rctx = await ctxFor(s.organization_id, userId);
    if (!rctx || !rctx.permissions.has('reports.view')) continue;
    const e = await ent.getEntitlements(s.organization_id);
    if (!canUseDataset(rctx, e, report.dataset)) continue; // recipients only get data they could open themselves
    const user = await knex('users').where({ id: userId, status: 'active' }).first('email', 'locale');
    if (!user) continue;
    const t = translator(user.locale);
    const table = toTable(result, t);
    await mailer.send({
      to: user.email,
      subject: `${brand ? brand.name : 'RemoteWay'} — ${report.name}`,
      html: mailer.layout({ locale: user.locale, title: report.name, body: t('reports.email_body', { rows: result.rows.length }), cta: t('reports.open'), href: `${base}/app/reports/saved/${report.id}`, brand }),
      fromName: brand ? brand.senderName : null,
      attachments: [{ filename: `${report.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'report'}.csv`, content: csv.build(table.header, table.rows), contentType: 'text/csv; charset=utf-8' }],
    });
    sent += 1;
  }
  return finish(`Sent to ${sent} recipient(s), ${result.rows.length} rows.`);
}

jobs.register('report.deliver', deliver);

module.exports = {
  DATASETS, TEMPLATES, PERIODS, MAX_ROWS, MAX_EXPORT, tiers, datasetsFor, assertDataset, normalize, configFromForm, periodRange, run, toTable,
  templatesFor, listSaved, getSaved, save, remove, canEditSaved, listSchedules, saveSchedule, removeSchedule, nextRun, dispatchDue, deliver,
};
