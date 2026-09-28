// Compliance: rule-based checks over live HR data, a weighted score with daily history, upcoming
// expiries, one-click fixes where the fix is unambiguous, and policy acknowledgements.
// Saudi checks cite the Labor Law / programs they come from; they are guidance, not legal advice.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');
const { todayIn, addDays } = require('../../core/workdays');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');
const notifications = require('../notifications/notification.service');
const employees = require('../workforce/employee.service');
const leave = require('../leave/leave.service');

const DOC_CATEGORIES = ['contract', 'id', 'passport', 'iqama', 'certificate'];
const APPLIES = ['all', 'saudi', 'non_saudi'];
const WEIGHT = { critical: 3, high: 2, medium: 1, low: 1 };

function defaults(country) {
  const sa = country === 'SA';
  return {
    checks: {
      documents_required: true, documents_expired: true, documents_expiring: true, probation: true,
      annual_leave: sa, wps: sa, gosi: sa, working_hours: true, policies: true, nationality: sa,
    },
    required_documents: sa
      ? [{ category: 'contract', applies_to: 'all' }, { category: 'id', applies_to: 'saudi' }, { category: 'iqama', applies_to: 'non_saudi' }, { category: 'passport', applies_to: 'non_saudi' }]
      : [{ category: 'contract', applies_to: 'all' }],
    expiry_warning_days: 60,
    probation_max_days: 90,
    weekly_hours_limit: 48,
  };
}

// Check catalog: severity, country (null = everywhere), plan module needed, law reference key.
const CHECKS = {
  documents_expired: { severity: 'critical', feature: 'documents' },
  documents_required: { severity: 'high', feature: 'documents' },
  wps: { severity: 'high', feature: 'payroll', country: 'SA', law: 'wps' },
  gosi: { severity: 'high', feature: 'payroll', country: 'SA', law: 'gosi' },
  annual_leave: { severity: 'high', feature: 'leave', country: 'SA', law: 'art109' },
  probation: { severity: 'high', feature: 'employees', law: 'art53' },
  working_hours: { severity: 'medium', feature: 'attendance', law: 'art98' },
  policies: { severity: 'medium', feature: 'documents' },
  nationality: { severity: 'low', feature: 'employees', country: 'SA' },
  documents_expiring: { severity: 'warning', feature: 'documents' },
};

async function settings(organizationId) {
  const org = await orgs.get(organizationId);
  const base = defaults(org.country_code);
  const saved = (await orgs.getSettings(organizationId)).compliance || {};
  return { ...base, ...saved, checks: { ...base.checks, ...(saved.checks || {}) }, country: org.country_code, timezone: org.timezone };
}

async function saveSettings(ctx, input) {
  await ent.assertFeature(ctx.organizationId, 'compliance');
  const errors = {};
  const num = (v, lo, hi, key, msg) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) errors[key] = msg; return n; };
  const warn = num(input.expiry_warning_days, 7, 365, 'expiry_warning_days', 'Use 7 to 365 days.');
  const probation = num(input.probation_max_days, 30, 180, 'probation_max_days', 'Use 30 to 180 days.');
  const hours = num(input.weekly_hours_limit, 20, 72, 'weekly_hours_limit', 'Use 20 to 72 hours.');
  const cats = [].concat(input.req_category || []); const apps = [].concat(input.req_applies || []);
  const required = [];
  cats.forEach((c, i) => {
    if (!c) return;
    if (!DOC_CATEGORIES.includes(c) || !APPLIES.includes(apps[i])) { errors.required_documents = 'Choose a document type and who it applies to.'; return; }
    if (!required.some((r) => r.category === c && r.applies_to === apps[i])) required.push({ category: c, applies_to: apps[i] });
  });
  if (Object.keys(errors).length) throw E.validation(errors);
  const enabled = [].concat(input.checks || []);
  const checks = Object.fromEntries(Object.keys(CHECKS).map((k) => [k, enabled.includes(k)]));
  await orgs.updateSettings(ctx, { compliance: { checks, required_documents: required, expiry_warning_days: warn, probation_max_days: probation, weekly_hours_limit: hours } });
}

// ---------- Data helpers ----------
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
const nameOf = (e) => `${e.first_name} ${e.last_name}`;

async function activeEmployees(organizationId) {
  return knex('employees').where({ organization_id: organizationId }).whereNot('status', 'terminated')
    .select('id', 'first_name', 'last_name', 'nationality', 'status', 'joining_date', 'user_id', 'created_at').orderBy('first_name');
}

/** Latest expiry per employee and category (a document without an expiry date counts as valid). */
async function docIndex(organizationId) {
  const rows = await knex('documents').where({ organization_id: organizationId }).whereNotNull('employee_id')
    .groupBy('employee_id', 'category').select('employee_id', 'category', knex.raw('MAX(expires_at) as exp'), knex.raw('SUM(expires_at IS NULL) as open'));
  const map = new Map();
  for (const r of rows) map.set(`${r.employee_id}:${r.category}`, { exp: r.exp ? ymd(r.exp) : null, open: Number(r.open) > 0 });
  return map;
}

const appliesTo = (rule, e) => rule.applies_to === 'all' || (rule.applies_to === 'saudi' && e.nationality === 'SA') || (rule.applies_to === 'non_saudi' && e.nationality && e.nationality !== 'SA');

// ---------- Checks (each returns {total, items}) ----------
const RUNNERS = {
  async documents_required(c) {
    const items = [];
    let total = 0;
    for (const e of c.emps) {
      const missing = c.s.required_documents.filter((r) => appliesTo(r, e)).filter((r) => { total += 1; return !c.docs.has(`${e.id}:${r.category}`); });
      for (const r of missing) items.push({ employee_id: e.id, name: nameOf(e), reason: 'missing_doc', params: { category: r.category }, link: `/app/employees/${e.id}?tab=documents` });
    }
    return { total, items };
  },
  async documents_expired(c) {
    const items = [];
    let total = 0;
    for (const e of c.emps) {
      for (const cat of DOC_CATEGORIES) {
        const d = c.docs.get(`${e.id}:${cat}`);
        if (!d) continue;
        total += 1;
        if (!d.open && d.exp && d.exp < c.today) items.push({ employee_id: e.id, name: nameOf(e), reason: 'expired_doc', params: { category: cat, date: d.exp }, link: `/app/employees/${e.id}?tab=documents` });
      }
    }
    return { total, items };
  },
  async documents_expiring(c) {
    const until = addDays(c.today, c.s.expiry_warning_days);
    const items = [];
    let total = 0;
    for (const e of c.emps) {
      for (const cat of DOC_CATEGORIES) {
        const d = c.docs.get(`${e.id}:${cat}`);
        if (!d) continue;
        total += 1;
        if (!d.open && d.exp && d.exp >= c.today && d.exp <= until) items.push({ employee_id: e.id, name: nameOf(e), reason: 'expiring_doc', params: { category: cat, date: d.exp }, link: `/app/employees/${e.id}?tab=documents` });
      }
    }
    return { total, items };
  },
  async probation(c) {
    const limit = addDays(c.today, -c.s.probation_max_days);
    const on = c.emps.filter((e) => e.status === 'probation');
    const items = on.filter((e) => e.joining_date && ymd(e.joining_date) < limit)
      .map((e) => ({ employee_id: e.id, name: nameOf(e), reason: 'probation_over', params: { since: ymd(e.joining_date), days: c.s.probation_max_days }, link: `/app/employees/${e.id}` }));
    return { total: on.length, items };
  },
  async annual_leave(c) {
    const type = await knex('leave_types').where({ organization_id: c.orgId, key: 'annual' }).first();
    if (!type) return { total: 0, items: [] };
    const year = Number(c.today.slice(0, 4));
    const balances = await knex('leave_balances').where({ organization_id: c.orgId, leave_type_id: type.id, year }).select('employee_id', 'entitled_days', 'adjustment_days');
    const byEmp = new Map(balances.map((b) => [b.employee_id, Number(b.entitled_days) + Number(b.adjustment_days)]));
    const items = [];
    for (const e of c.emps) {
      const since = ymd(e.joining_date || e.created_at);
      const years = (new Date(`${c.today}T00:00:00Z`) - new Date(`${since}T00:00:00Z`)) / (365.25 * 86_400_000);
      const required = years >= 5 ? 30 : 21;
      const has = byEmp.has(e.id) ? byEmp.get(e.id) : Number(type.days_per_year);
      if (has < required) items.push({ employee_id: e.id, name: nameOf(e), reason: 'leave_short', params: { has, required, years: Math.floor(years) }, link: `/app/employees/${e.id}?tab=leave`, fix: { type: 'annual_leave', delta: required - has } });
    }
    return { total: c.emps.length, items };
  },
  async wps(c) {
    const profiles = await knex('employee_pay_profiles').where({ organization_id: c.orgId }).select('employee_id', 'payment_method', 'iban');
    const by = new Map(profiles.map((p) => [p.employee_id, p]));
    const items = [];
    for (const e of c.emps) {
      const p = by.get(e.id);
      if (!p) items.push({ employee_id: e.id, name: nameOf(e), reason: 'no_pay_profile', params: {}, link: `/app/employees/${e.id}?tab=payroll` });
      else if (p.payment_method === 'bank' && !p.iban) items.push({ employee_id: e.id, name: nameOf(e), reason: 'no_iban', params: {}, link: `/app/employees/${e.id}?tab=payroll` });
      else if (p.payment_method === 'cash') items.push({ employee_id: e.id, name: nameOf(e), reason: 'cash_pay', params: {}, link: `/app/employees/${e.id}?tab=payroll` });
    }
    return { total: c.emps.length, items };
  },
  async gosi(c) {
    const reg = new Set(await knex('employee_pay_profiles').where({ organization_id: c.orgId, gosi_registered: true }).pluck('employee_id'));
    const items = c.emps.filter((e) => !reg.has(e.id)).map((e) => ({ employee_id: e.id, name: nameOf(e), reason: 'not_gosi', params: {}, link: `/app/employees/${e.id}?tab=payroll` }));
    return { total: c.emps.length, items };
  },
  async working_hours(c) {
    const from = addDays(c.today, -28);
    const rows = await knex('attendance').where({ organization_id: c.orgId }).where('work_date', '>=', from).where('work_date', '<=', c.today)
      .groupBy('employee_id', knex.raw('YEARWEEK(work_date, 0)')).select('employee_id', knex.raw('YEARWEEK(work_date, 0) as wk'), knex.raw('SUM(worked_minutes) as mins'));
    const over = new Map();
    for (const r of rows) {
      const h = Number(r.mins) / 60;
      if (h > c.s.weekly_hours_limit) {
        const cur = over.get(r.employee_id) || { weeks: 0, max: 0 };
        over.set(r.employee_id, { weeks: cur.weeks + 1, max: Math.max(cur.max, Math.round(h * 10) / 10) });
      }
    }
    const tracked = new Set(rows.map((r) => r.employee_id));
    const items = c.emps.filter((e) => over.has(e.id)).map((e) => ({ employee_id: e.id, name: nameOf(e), reason: 'hours_over', params: { weeks: over.get(e.id).weeks, max: over.get(e.id).max, limit: c.s.weekly_hours_limit }, link: `/app/attendance?employee_id=${e.id}` }));
    return { total: tracked.size, items };
  },
  async policies(c) {
    const pols = await knex('documents').where({ organization_id: c.orgId, requires_ack: true }).whereNull('employee_id').select('id', 'title', 'current_version');
    if (!pols.length) return { total: 0, items: [] };
    const acks = await knex('policy_acknowledgements').where({ organization_id: c.orgId }).whereIn('document_id', pols.map((p) => p.id)).select('document_id', 'version', 'employee_id');
    const done = new Set(acks.map((a) => `${a.document_id}:${a.version}:${a.employee_id}`));
    const people = c.emps.filter((e) => e.user_id);
    const items = [];
    for (const e of people) {
      const pending = pols.filter((p) => !done.has(`${p.id}:${p.current_version}:${e.id}`));
      if (pending.length) items.push({ employee_id: e.id, name: nameOf(e), reason: 'policy_pending', params: { n: pending.length, titles: pending.map((p) => p.title).join(', ') }, link: `/app/employees/${e.id}` });
    }
    return { total: people.length, items };
  },
  async nationality(c) {
    const items = c.emps.filter((e) => !e.nationality).map((e) => ({ employee_id: e.id, name: nameOf(e), reason: 'no_nationality', params: {}, link: `/app/employees/${e.id}/edit` }));
    return { total: c.emps.length, items };
  },
};

/** Runs every enabled check. Returns checks with status, the weighted score and counts. */
async function evaluate(ctx) {
  await ent.assertFeature(ctx.organizationId, 'compliance');
  const s = await settings(ctx.organizationId);
  const e = await ent.getEntitlements(ctx.organizationId);
  const today = todayIn(s.timezone || 'UTC');
  const c = { orgId: ctx.organizationId, s, today, emps: await activeEmployees(ctx.organizationId), docs: await docIndex(ctx.organizationId) };
  const checks = [];
  for (const [key, def] of Object.entries(CHECKS)) {
    const applicable = (!def.country || def.country === s.country) && e.features.has(def.feature);
    if (!applicable || !s.checks[key]) { checks.push({ key, ...def, status: 'off', total: 0, items: [] }); continue; }
    const r = await RUNNERS[key](c);
    const status = r.total === 0 ? 'na' : !r.items.length ? 'pass' : def.severity === 'warning' ? 'warn' : 'fail';
    checks.push({ key, ...def, status, total: r.total, items: r.items });
  }
  let num = 0; let den = 0;
  for (const ch of checks) {
    if (!['pass', 'fail'].includes(ch.status) || !WEIGHT[ch.severity]) continue;
    // Each check counts equally (by severity), scaled by the share of its population that passes.
    den += WEIGHT[ch.severity];
    num += WEIGHT[ch.severity] * ((ch.total - Math.min(ch.items.length, ch.total)) / ch.total);
  }
  const score = den ? Math.round((num / den) * 1000) / 10 : 100;
  const issues = checks.filter((ch) => ch.status === 'fail').reduce((sum, ch) => sum + ch.items.length, 0);
  const warnings = checks.filter((ch) => ch.status === 'warn').reduce((sum, ch) => sum + ch.items.length, 0);
  await knex('compliance_snapshots').insert({ organization_id: ctx.organizationId, day: today, score, issues, warnings })
    .onConflict(['organization_id', 'day']).merge({ score, issues, warnings });
  return { today, settings: s, checks, score, issues, warnings, passed: checks.filter((ch) => ch.status === 'pass').length, active: checks.filter((ch) => ['pass', 'fail', 'warn'].includes(ch.status)).length };
}

async function history(organizationId, days = 90) {
  return knex('compliance_snapshots').where({ organization_id: organizationId }).where('day', '>=', knex.raw('DATE_SUB(CURDATE(), INTERVAL ? DAY)', [days])).orderBy('day');
}

/** Expiries in the next `days` days: employee and company documents, and training certificates. */
async function upcoming(ctx, days = 90) {
  const s = await settings(ctx.organizationId);
  const today = todayIn(s.timezone || 'UTC');
  const until = addDays(today, days);
  const [docs, certs] = await Promise.all([
    knex('documents as d').leftJoin('employees as e', 'e.id', 'd.employee_id').where('d.organization_id', ctx.organizationId)
      .whereBetween('d.expires_at', [addDays(today, -365), until]).where((w) => w.whereNull('e.id').orWhereNot('e.status', 'terminated'))
      .select('d.id', 'd.title', 'd.category', 'd.expires_at', 'e.first_name', 'e.last_name', 'e.id as employee_id'),
    (await ent.hasFeature(ctx.organizationId, 'learning'))
      ? knex('certificates as c').join('employees as e', 'e.id', 'c.employee_id').where('c.organization_id', ctx.organizationId).whereNot('e.status', 'terminated')
        .whereBetween('c.expires_on', [addDays(today, -365), until]).select('c.id', 'c.course_title', 'c.expires_on', 'e.first_name', 'e.last_name', 'e.id as employee_id')
      : [],
  ]);
  const rows = [
    ...docs.map((d) => ({ kind: 'document', title: d.title, category: d.category, date: ymd(d.expires_at), who: d.employee_id ? `${d.first_name} ${d.last_name}` : null, link: `/app/documents/${d.id}` })),
    ...certs.map((c) => ({ kind: 'certificate', title: c.course_title, date: ymd(c.expires_on), who: `${c.first_name} ${c.last_name}`, link: `/app/employees/${c.employee_id}?tab=training` })),
  ].map((r) => ({ ...r, expired: r.date < today }));
  // Expired items only while they are recent (last 365 days) — older ones are in the checks above.
  return rows.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------- Fixes ----------
async function fixAnnualLeave(ctx, employeeIds) {
  if (!ctx.permissions.has('compliance.manage')) throw E.forbidden('compliance.manage');
  const result = await evaluate(ctx);
  const check = result.checks.find((c) => c.key === 'annual_leave');
  const type = await knex('leave_types').where({ organization_id: ctx.organizationId, key: 'annual' }).first();
  const want = new Set([].concat(employeeIds || []).map(Number));
  let fixed = 0;
  for (const it of (check ? check.items : [])) {
    if (want.size && !want.has(it.employee_id)) continue;
    await leave.adjustBalance(ctx, it.employee_id, type.id, it.fix.delta, `Compliance: annual leave ${it.params.required} days (Saudi Labor Law, Art. 109)`);
    fixed += 1;
  }
  return fixed;
}

// ---------- Policy acknowledgements ----------
async function setRequiresAck(ctx, documentId, on) {
  if (!ctx.permissions.has('documents.manage')) throw E.forbidden('documents.manage');
  await ent.assertFeature(ctx.organizationId, 'compliance');
  const doc = await knex('documents').where({ id: documentId, organization_id: ctx.organizationId }).first();
  if (!doc) throw E.notFound('Document');
  if (doc.employee_id || doc.category !== 'policy') throw new AppError('ACK_POLICY_ONLY', 'Only company-wide policies can require acknowledgement.', 409);
  await knex('documents').where({ id: doc.id }).update({ requires_ack: Boolean(on), visible_to_employee: on ? true : doc.visible_to_employee });
  if (on && !doc.requires_ack) {
    const users = await knex('employees').where({ organization_id: ctx.organizationId }).whereNot('status', 'terminated').whereNotNull('user_id').pluck('user_id');
    await notifications.notify(ctx.organizationId, users.filter((u) => u !== ctx.userId), 'policy_ack_required', { title: doc.title }, `/app/documents/${doc.id}`);
  }
  await audit.record(ctx, on ? 'policy.ack_required' : 'policy.ack_removed', { entityType: 'document', entityId: doc.id, newValues: { name: doc.title } });
}

async function acknowledge(ctx, documentId, ip) {
  const self = await employees.linkedEmployeeId(ctx);
  if (!self) throw new AppError('EMPLOYEE_RECORD_REQUIRED', 'Your account is not linked to an employee record.', 409);
  const doc = await knex('documents').where({ id: documentId, organization_id: ctx.organizationId, requires_ack: true }).whereNull('employee_id').first();
  if (!doc) throw E.notFound('Policy');
  await knex('policy_acknowledgements').insert({ organization_id: ctx.organizationId, document_id: doc.id, version: doc.current_version, employee_id: self, user_id: ctx.userId, ip: ip ? String(ip).slice(0, 64) : null })
    .onConflict(['document_id', 'version', 'employee_id']).ignore();
  await audit.record(ctx, 'policy.acknowledged', { entityType: 'document', entityId: doc.id, newValues: { name: doc.title, version: doc.current_version } });
}

/** For a policy page: this user's acknowledgement and, for managers, who is still pending. */
async function ackStatus(ctx, doc) {
  if (!doc.requires_ack) return null;
  const self = await employees.linkedEmployeeId(ctx);
  const acks = await knex('policy_acknowledgements as a').join('employees as e', 'e.id', 'a.employee_id')
    .where({ 'a.document_id': doc.id, 'a.version': doc.current_version }).select('a.employee_id', 'a.acknowledged_at', 'e.first_name', 'e.last_name');
  const mine = self ? acks.find((a) => a.employee_id === self) : null;
  const out = { mine: mine || null, canAck: Boolean(self), version: doc.current_version };
  if (ctx.permissions.has('documents.manage')) {
    const people = await knex('employees').where({ organization_id: ctx.organizationId }).whereNot('status', 'terminated').whereNotNull('user_id').select('id', 'first_name', 'last_name').orderBy('first_name');
    const done = new Set(acks.map((a) => a.employee_id));
    out.total = people.length;
    out.done = people.filter((p) => done.has(p.id)).length;
    out.pending = people.filter((p) => !done.has(p.id));
  }
  return out;
}

/** Policies the signed-in employee still has to acknowledge (for the dashboard). */
async function pendingPolicies(ctx) {
  const self = await employees.linkedEmployeeId(ctx);
  if (!self) return [];
  return knex('documents as d').where({ 'd.organization_id': ctx.organizationId, 'd.requires_ack': true }).whereNull('d.employee_id')
    .whereNotExists(knex('policy_acknowledgements as a').whereRaw('a.document_id = d.id AND a.version = d.current_version AND a.employee_id = ?', [self]))
    .select('d.id', 'd.title').orderBy('d.id');
}

module.exports = {
  CHECKS, DOC_CATEGORIES, APPLIES, WEIGHT, defaults, settings, saveSettings, evaluate, history, upcoming, fixAnnualLeave,
  setRequiresAck, acknowledge, ackStatus, pendingPolicies,
};
