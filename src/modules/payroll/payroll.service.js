// Payroll: pay components, employee compensation, monthly runs (draft → review → approved → paid) and payslips.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');
const { toMils, fromMils } = require('../../core/money');
const { isDateStr, todayIn, countWorkingDays } = require('../../core/workdays');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');
const notifications = require('../notifications/notification.service');
const { effectiveRules } = require('./country-rules');
const engine = require('./engine');

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const parseJson = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const dstr = (v) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);

// ---------- Settings & rules ----------
async function rulesFor(organizationId) {
  const [org, settings] = await Promise.all([orgs.get(organizationId), orgs.getSettings(organizationId)]);
  return { org, settings, rules: effectiveRules(org.country_code, settings) };
}

async function saveSettings(ctx, input) {
  await ent.assertFeature(ctx.organizationId, 'payroll');
  const num = (v, min, max, field) => {
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    if (Number.isNaN(n) || n < min || n > max) throw E.validation({ [field]: 'Enter a valid number.' });
    return n;
  };
  const values = {
    payroll_proration: input.proration === 'calendar' ? 'calendar' : 'thirty',
    payroll_four_eyes: input.four_eyes === 'on' || input.four_eyes === true,
  };
  const { rules } = await rulesFor(ctx.organizationId);
  if (rules.gosi) {
    const gosi = {
      enabled: input.gosi_enabled === 'on' || input.gosi_enabled === true,
      wage_floor: num(input.wage_floor, 0, 1e7, 'wage_floor'),
      wage_ceiling: num(input.wage_ceiling, 0, 1e7, 'wage_ceiling'),
      national_employee_rate: num(input.national_employee_rate, 0, 50, 'national_employee_rate'),
      national_employer_rate: num(input.national_employer_rate, 0, 50, 'national_employer_rate'),
      expat_employee_rate: num(input.expat_employee_rate, 0, 50, 'expat_employee_rate'),
      expat_employer_rate: num(input.expat_employer_rate, 0, 50, 'expat_employer_rate'),
    };
    if (gosi.wage_floor !== undefined && gosi.wage_ceiling !== undefined && gosi.wage_ceiling < gosi.wage_floor) throw E.validation({ wage_ceiling: 'Maximum must be above minimum.' });
    values.payroll_gosi = gosi;
  }
  await orgs.updateSettings(ctx, values);
}

// ---------- Pay components ----------
const DEFAULT_COMPONENTS = [
  { code: 'HOUSING', name: 'Housing allowance', name_ar: 'بدل السكن', kind: 'earning', calc: 'percent_basic', default_value: 25, in_gosi_base: true, prorate: true },
  { code: 'TRANSPORT', name: 'Transport allowance', name_ar: 'بدل النقل', kind: 'earning', calc: 'percent_basic', default_value: 10, in_gosi_base: false, prorate: true },
  { code: 'OTHER', name: 'Other allowance', name_ar: 'بدلات أخرى', kind: 'earning', calc: 'fixed', default_value: null, in_gosi_base: false, prorate: true },
  { code: 'LOAN', name: 'Loan instalment', name_ar: 'قسط سلفة', kind: 'deduction', calc: 'fixed', default_value: null, in_gosi_base: false, prorate: false },
];

async function listComponents(organizationId, { activeOnly = false } = {}) {
  const existing = await knex('pay_components').where({ organization_id: organizationId }).first('id');
  if (!existing) {
    await knex('pay_components').insert(DEFAULT_COMPONENTS.map((c, i) => ({ ...c, organization_id: organizationId, sort_order: i })))
      .onConflict(['organization_id', 'code']).ignore();
  }
  const q = knex('pay_components').where({ organization_id: organizationId }).orderBy(['sort_order', 'id']);
  if (activeOnly) q.where('is_active', true);
  return q;
}

async function saveComponent(ctx, id, input) {
  await ent.assertFeature(ctx.organizationId, 'payroll');
  await ent.assertCanWrite(ctx.organizationId);
  const name = String(input.name || '').trim();
  const code = String(input.code || name).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  if (!name) throw E.validation({ name: 'Name is required.' });
  if (!code) throw E.validation({ code: 'Enter a code.' });
  const value = input.default_value === '' || input.default_value === undefined ? null : Number(input.default_value);
  if (value !== null && (Number.isNaN(value) || value < 0 || value > 99_999_999)) throw E.validation({ default_value: 'Enter a valid number.' });
  const row = {
    name: name.slice(0, 100), name_ar: input.name_ar ? String(input.name_ar).trim().slice(0, 100) : null, code,
    kind: input.kind === 'deduction' ? 'deduction' : 'earning', calc: input.calc === 'percent_basic' ? 'percent_basic' : 'fixed',
    default_value: value, in_gosi_base: input.in_gosi_base === 'on' || input.in_gosi_base === true,
    prorate: input.prorate === 'on' || input.prorate === true, is_active: id ? input.is_active === 'on' || input.is_active === true : true,
  };
  if (row.calc === 'percent_basic' && value !== null && value > 100) throw E.validation({ default_value: 'A percentage must be between 0 and 100.' });
  const dup = knex('pay_components').where({ organization_id: ctx.organizationId, code });
  if (id) dup.whereNot('id', id);
  if (await dup.first('id')) throw E.validation({ code: 'This code is already used.' });
  if (id) {
    const before = await knex('pay_components').where({ id, organization_id: ctx.organizationId }).first();
    if (!before) throw E.notFound('Pay component');
    await knex('pay_components').where({ id }).update(row);
    const d = audit.diff(before, row);
    if (d.changed) await audit.record(ctx, 'pay_component.updated', { entityType: 'pay_component', entityId: id, oldValues: d.oldValues, newValues: { ...d.newValues, name } });
    return Number(id);
  }
  const [{ n }] = await knex('pay_components').where({ organization_id: ctx.organizationId }).count({ n: '*' });
  const [newId] = await knex('pay_components').insert({ ...row, organization_id: ctx.organizationId, sort_order: Number(n) });
  await audit.record(ctx, 'pay_component.created', { entityType: 'pay_component', entityId: newId, newValues: { name } });
  return newId;
}

// ---------- Employee compensation ----------
/** ISO 13616 IBAN check (country format + mod-97). */
function normalizeIban(value) {
  const iban = String(value || '').replace(/\s+/g, '').toUpperCase();
  if (!iban) return null;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  if (iban.startsWith('SA') && iban.length !== 24) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  const digits = moved.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1 ? iban : false;
}

async function getCompensation(ctx, employeeId) {
  const employee = await knex('employees').where({ id: employeeId, organization_id: ctx.organizationId }).first();
  if (!employee) throw E.notFound('Employee');
  const [profile, assigned, components] = await Promise.all([
    knex('employee_pay_profiles').where({ employee_id: employeeId, organization_id: ctx.organizationId }).first(),
    knex('employee_pay_components').where({ employee_id: employeeId, organization_id: ctx.organizationId }),
    listComponents(ctx.organizationId),
  ]);
  const values = Object.fromEntries(assigned.map((a) => [a.component_id, Number(a.value)]));
  return {
    employee,
    profile: profile || { payment_method: 'bank', gosi_registered: true },
    components: components.map((c) => ({ ...c, assigned: values[c.id] !== undefined, value: values[c.id] })),
  };
}

async function saveCompensation(ctx, employeeId, input) {
  await ent.assertFeature(ctx.organizationId, 'payroll');
  await ent.assertCanWrite(ctx.organizationId);
  const employee = await knex('employees').where({ id: employeeId, organization_id: ctx.organizationId }).first();
  if (!employee) throw E.notFound('Employee');
  const errors = {};
  const base = input.base_salary === '' || input.base_salary === undefined ? null : Number(input.base_salary);
  if (base !== null && (Number.isNaN(base) || base < 0 || base > 99_999_999)) errors.base_salary = 'Enter a valid number.';
  const iban = normalizeIban(input.iban);
  if (iban === false) errors.iban = 'Enter a valid IBAN.';
  const method = input.payment_method === 'cash' ? 'cash' : 'bank';
  const components = await listComponents(ctx.organizationId);
  const values = [];
  for (const c of components) {
    const raw = input[`component_${c.id}`];
    if (raw === undefined || raw === '') continue;
    const v = Number(raw);
    if (Number.isNaN(v) || v < 0 || (c.calc === 'percent_basic' && v > 100) || v > 99_999_999) { errors[`component_${c.id}`] = 'Enter a valid number.'; continue; }
    values.push({ component_id: c.id, value: v });
  }
  if (Object.keys(errors).length) throw E.validation(errors);
  const org = await orgs.get(ctx.organizationId);
  const profile = {
    payment_method: method, bank_name: input.bank_name ? String(input.bank_name).trim().slice(0, 100) : null, iban: iban || null,
    account_name: input.account_name ? String(input.account_name).trim().slice(0, 150) : null,
    gosi_registered: input.gosi_registered === 'on' || input.gosi_registered === true, gosi_number: input.gosi_number ? String(input.gosi_number).trim().slice(0, 30) : null,
  };
  const before = await getCompensation(ctx, employeeId);
  await knex.transaction(async (trx) => {
    await trx('employees').where({ id: employeeId }).update({ base_salary: base, salary_currency: base === null ? null : (employee.salary_currency || org.currency) });
    await trx('employee_pay_profiles').insert({ ...profile, organization_id: ctx.organizationId, employee_id: employeeId })
      .onConflict(['employee_id']).merge({ ...profile, updated_at: new Date() });
    await trx('employee_pay_components').where({ employee_id: employeeId, organization_id: ctx.organizationId }).del();
    if (values.length) await trx('employee_pay_components').insert(values.map((v) => ({ ...v, organization_id: ctx.organizationId, employee_id: employeeId })));
    await audit.record(ctx, 'compensation.updated', {
      entityType: 'employee', entityId: employeeId,
      oldValues: { base_salary: before.employee.base_salary === null ? null : Number(before.employee.base_salary), iban: before.profile.iban ? `…${before.profile.iban.slice(-4)}` : null },
      newValues: { name: `${employee.first_name} ${employee.last_name}`, base_salary: base, iban: iban ? `…${iban.slice(-4)}` : null, components: values.length },
    }, trx);
  });
}

// ---------- Runs ----------
async function assertRunCtx(ctx) {
  await ent.assertFeature(ctx.organizationId, 'payroll');
  await ent.assertCanWrite(ctx.organizationId);
}

async function getRunRow(ctx, id, trx = knex) {
  const run = await trx('payroll_runs').where({ id, organization_id: ctx.organizationId }).first();
  if (!run) throw E.notFound('Payroll run');
  return run;
}

const assertStatus = (run, ...allowed) => {
  if (!allowed.includes(run.status)) throw new AppError('PAYROLL_STATUS', `This payroll is ${run.status}.`, 409, { status: run.status });
};

async function createRun(ctx, period) {
  await assertRunCtx(ctx);
  if (!PERIOD_RE.test(String(period || ''))) throw E.validation({ period: 'Choose a month.' });
  const { org } = await rulesFor(ctx.organizationId);
  const current = todayIn(org.timezone).slice(0, 7);
  const [cy, cm] = current.split('-').map(Number);
  const next = `${cm === 12 ? cy + 1 : cy}-${String(cm === 12 ? 1 : cm + 1).padStart(2, '0')}`;
  if (period > next) throw E.validation({ period: 'Payroll can be prepared up to next month.' });
  const { start, end } = engine.periodBounds(period);
  const id = await knex.transaction(async (trx) => {
    await ent.lockSubscription(ctx.organizationId, trx); // one run creation at a time per company
    const existing = await trx('payroll_runs').where({ organization_id: ctx.organizationId, period }).whereNot('status', 'cancelled').first('id');
    if (existing) throw new AppError('PAYROLL_EXISTS', 'A payroll for this month already exists.', 409, { id: existing.id });
    const [runId] = await trx('payroll_runs').insert({
      organization_id: ctx.organizationId, period, period_start: start, period_end: end, status: 'draft', currency: org.currency, created_by: ctx.userId,
    });
    await audit.record(ctx, 'payroll.created', { entityType: 'payroll_run', entityId: runId, newValues: { name: period } }, trx);
    return runId;
  });
  await calculateRun(ctx, id);
  return id;
}

/** Unpaid approved leave (working days) per employee inside [start, end]. */
async function unpaidLeaveDays(organizationId, start, end, workingDays) {
  const rows = await knex('leave_requests as r').join('leave_types as t', 't.id', 'r.leave_type_id')
    .where({ 'r.organization_id': organizationId, 'r.status': 'approved', 't.is_paid': false })
    .where('r.start_date', '<=', end).where('r.end_date', '>=', start)
    .select('r.employee_id', 'r.start_date', 'r.end_date', 'r.days');
  const out = {};
  for (const r of rows) {
    const s = dstr(r.start_date); const e = dstr(r.end_date);
    const total = countWorkingDays(s, e, workingDays) || 1;
    const inside = countWorkingDays(s > start ? s : start, e < end ? e : end, workingDays);
    const days = Math.round(Number(r.days) * (inside / total) * 100) / 100;
    out[r.employee_id] = (out[r.employee_id] || 0) + days;
  }
  return out;
}

/** (Re)calculates every payslip of a draft run from current employee data. Manual adjustments are kept. */
async function calculateRun(ctx, id) {
  await assertRunCtx(ctx);
  const run = await getRunRow(ctx, id);
  assertStatus(run, 'draft');
  const { settings, rules } = await rulesFor(ctx.organizationId);
  const start = dstr(run.period_start); const end = dstr(run.period_end);
  const employees = await knex('employees as e').leftJoin('departments as d', 'd.id', 'e.department_id')
    .leftJoin('employee_pay_profiles as p', 'p.employee_id', 'e.id')
    .where('e.organization_id', ctx.organizationId)
    .where((w) => w.whereNull('e.joining_date').orWhere('e.joining_date', '<=', end))
    .where((w) => w.whereNull('e.termination_date').orWhere('e.termination_date', '>=', start))
    .where((w) => w.whereNot('e.status', 'terminated').orWhereNotNull('e.termination_date'))
    .select('e.*', 'd.name as department_name', 'p.payment_method', 'p.bank_name', 'p.iban', 'p.gosi_registered')
    .orderBy(['e.first_name', 'e.last_name']);
  const [assigned, components, leave, adjustments] = await Promise.all([
    knex('employee_pay_components').where({ organization_id: ctx.organizationId }),
    listComponents(ctx.organizationId, { activeOnly: true }),
    unpaidLeaveDays(ctx.organizationId, start, end, settings.working_days),
    knex('payroll_adjustments').where({ organization_id: ctx.organizationId, run_id: id }),
  ]);
  const byId = Object.fromEntries(components.map((c) => [c.id, c]));
  const warnings = { no_salary: 0, no_iban: 0, negative_net: 0, deduction_limit: 0 };
  const slips = [];
  for (const e of employees) {
    const comps = assigned.filter((a) => a.employee_id === e.id && byId[a.component_id]).map((a) => ({ ...byId[a.component_id], value: a.value }))
      .sort((a, b) => a.sort_order - b.sort_order);
    const result = engine.calculate({
      period: { start, end }, rules, currency: run.currency,
      employee: { ...e, payment_method: e.payment_method || 'bank', gosi_registered: e.gosi_registered === null || e.gosi_registered === undefined ? true : Boolean(e.gosi_registered) },
      components: comps, unpaidLeaveDays: leave[e.id] || 0, adjustments: adjustments.filter((a) => a.employee_id === e.id),
    });
    if (!result) continue;
    for (const w of result.warnings) warnings[w] = (warnings[w] || 0) + 1;
    slips.push({ e, result });
  }
  await knex.transaction(async (trx) => {
    const locked = await trx('payroll_runs').where({ id }).forUpdate().first();
    assertStatus(locked, 'draft');
    await trx('payslips').where({ run_id: id }).del();
    const totals = { gross: 0, deductions: 0, net: 0, employer: 0 };
    for (const { e, result: r } of slips) {
      const [slipId] = await trx('payslips').insert({
        organization_id: ctx.organizationId, run_id: id, employee_id: e.id, employee_number: e.employee_number, employee_name: `${e.first_name} ${e.last_name}`,
        job_title: e.job_title, department_name: e.department_name, nationality: e.nationality, payment_method: e.payment_method || 'bank', bank_name: e.bank_name, iban: e.iban,
        paid_days: r.paidDays, period_days: r.periodDays, unpaid_leave_days: r.unpaidLeaveDays, basic: fromMils(r.basic), gross: fromMils(r.gross),
        total_deductions: fromMils(r.deductions), net: fromMils(r.net), employer_cost: fromMils(r.employerCost), gosi_base: fromMils(r.gosiBase), warnings: JSON.stringify(r.warnings),
      });
      if (r.lines.length) {
        await trx('payslip_lines').insert(r.lines.map((l) => ({
          organization_id: ctx.organizationId, payslip_id: slipId, kind: l.kind, source: l.source, code: l.code, name: l.name, name_ar: l.name_ar,
          amount: fromMils(l.amount), note: l.note, sort_order: l.sort_order,
        })));
      }
      totals.gross += r.gross; totals.deductions += r.deductions; totals.net += r.net; totals.employer += r.employer;
    }
    await trx('payroll_runs').where({ id }).update({
      employee_count: slips.length, total_gross: fromMils(totals.gross), total_deductions: fromMils(totals.deductions), total_net: fromMils(totals.net),
      total_employer: fromMils(totals.employer), warnings: JSON.stringify(warnings), calculated_at: new Date(),
    });
  });
}

async function addAdjustment(ctx, runId, input) {
  await assertRunCtx(ctx);
  const run = await getRunRow(ctx, runId);
  assertStatus(run, 'draft');
  const employeeId = Number(input.employee_id);
  const slip = await knex('payslips').where({ run_id: runId, employee_id: employeeId }).first('id');
  if (!slip) throw E.validation({ employee_id: 'Choose an employee in this payroll.' });
  const name = String(input.name || '').trim();
  const amount = Number(input.amount);
  const errors = {};
  if (!name) errors.name = 'Name is required.';
  if (!(amount > 0) || amount > 99_999_999) errors.amount = 'Enter an amount above zero.';
  if (Object.keys(errors).length) throw E.validation(errors);
  await knex('payroll_adjustments').insert({
    organization_id: ctx.organizationId, run_id: runId, employee_id: employeeId, kind: input.kind === 'deduction' ? 'deduction' : 'earning',
    name: name.slice(0, 120), amount: fromMils(toMils(amount)), note: input.note ? String(input.note).slice(0, 500) : null, created_by: ctx.userId,
  });
  await audit.record(ctx, 'payroll.adjusted', { entityType: 'payroll_run', entityId: runId, newValues: { name: run.period, item: name, amount } });
  await calculateRun(ctx, runId);
}

async function removeAdjustment(ctx, runId, adjustmentId) {
  await assertRunCtx(ctx);
  const run = await getRunRow(ctx, runId);
  assertStatus(run, 'draft');
  const n = await knex('payroll_adjustments').where({ id: adjustmentId, run_id: runId, organization_id: ctx.organizationId }).del();
  if (!n) throw E.notFound('Adjustment');
  await calculateRun(ctx, runId);
}

/** Status transitions. Approved and paid payrolls are locked. */
async function transition(ctx, id, action, input = {}) {
  await assertRunCtx(ctx);
  const { rules } = await rulesFor(ctx.organizationId);
  let employeesToNotify = [];
  let run;
  await knex.transaction(async (trx) => {
    run = await trx('payroll_runs').where({ id, organization_id: ctx.organizationId }).forUpdate().first();
    if (!run) throw E.notFound('Payroll run');
    const now = new Date();
    if (action === 'submit') {
      assertStatus(run, 'draft');
      if (!run.employee_count) throw new AppError('PAYROLL_EMPTY', 'There is nobody to pay in this payroll.', 409);
      const negatives = await trx('payslips').where({ run_id: id }).where('net', '<', 0).count({ n: '*' });
      if (Number(negatives[0].n)) throw new AppError('PAYROLL_NEGATIVE_NET', 'Some payslips have a negative net pay. Fix them before submitting.', 409);
      await trx('payroll_runs').where({ id }).update({ status: 'review', submitted_by: ctx.userId, submitted_at: now });
    } else if (action === 'reopen') {
      assertStatus(run, 'review');
      await trx('payroll_runs').where({ id }).update({ status: 'draft', submitted_by: null, submitted_at: null });
    } else if (action === 'approve') {
      if (!ctx.permissions.has('payroll.approve')) throw E.forbidden('payroll.approve');
      assertStatus(run, 'review');
      if (rules.fourEyes && run.submitted_by === ctx.userId) throw new AppError('PAYROLL_FOUR_EYES', 'Another person must approve a payroll you submitted.', 409);
      await trx('payroll_runs').where({ id }).update({ status: 'approved', approved_by: ctx.userId, approved_at: now });
    } else if (action === 'pay') {
      assertStatus(run, 'approved');
      const paymentDate = isDateStr(input.payment_date) ? input.payment_date : todayIn((await orgs.get(ctx.organizationId)).timezone);
      await trx('payroll_runs').where({ id }).update({ status: 'paid', paid_by: ctx.userId, paid_at: now, payment_date: paymentDate });
      employeesToNotify = await trx('payslips as s').join('employees as e', 'e.id', 's.employee_id').where('s.run_id', id).whereNotNull('e.user_id').select('s.id', 'e.user_id');
    } else if (action === 'cancel') {
      assertStatus(run, 'draft', 'review');
      await trx('payroll_runs').where({ id }).update({ status: 'cancelled' });
    } else {
      throw E.validation({ action: 'Invalid action.' });
    }
    await audit.record(ctx, `payroll.${{ submit: 'submitted', reopen: 'reopened', approve: 'approved', pay: 'paid', cancel: 'cancelled' }[action]}`,
      { entityType: 'payroll_run', entityId: id, oldValues: { status: run.status }, newValues: { name: run.period } }, trx);
    if (action === 'submit') {
      const approvers = (await notifications.usersWithPermission(ctx.organizationId, 'payroll.approve', trx)).filter((u) => u !== ctx.userId);
      await notifications.notify(ctx.organizationId, approvers, 'payroll_submitted', { period: run.period }, `/app/payroll/runs/${id}`, trx);
    }
    for (const s of employeesToNotify) {
      await notifications.notify(ctx.organizationId, [s.user_id], 'payslip_available', { period: run.period }, `/app/payroll/payslips/${s.id}`, trx);
    }
  });
}

function runBase(organizationId) {
  return knex('payroll_runs as r').leftJoin('users as c', 'c.id', 'r.created_by').leftJoin('users as s', 's.id', 'r.submitted_by')
    .leftJoin('users as a', 'a.id', 'r.approved_by').leftJoin('users as p', 'p.id', 'r.paid_by')
    .where('r.organization_id', organizationId)
    .select('r.*', 'c.name as created_by_name', 's.name as submitted_by_name', 'a.name as approved_by_name', 'p.name as paid_by_name');
}

async function listRuns(ctx, { status } = {}) {
  const q = runBase(ctx.organizationId).orderBy('r.period', 'desc').orderBy('r.id', 'desc').limit(60);
  if (status) q.where('r.status', status);
  return (await q).map((r) => ({ ...r, warnings: parseJson(r.warnings, {}) }));
}

async function getRun(ctx, id) {
  const run = await runBase(ctx.organizationId).where('r.id', id).first();
  if (!run) throw E.notFound('Payroll run');
  run.warnings = parseJson(run.warnings, {});
  run.payslips = (await knex('payslips').where({ run_id: id, organization_id: ctx.organizationId }).orderBy('employee_name'))
    .map((s) => ({ ...s, warnings: parseJson(s.warnings, []) }));
  const lines = await knex('payslip_lines').whereIn('payslip_id', run.payslips.map((s) => s.id)).orderBy(['payslip_id', 'sort_order']);
  for (const s of run.payslips) {
    const mine = lines.filter((l) => l.payslip_id === s.id);
    s.allowances = mine.filter((l) => l.kind === 'earning' && l.source !== 'basic').reduce((a, l) => a + toMils(l.amount), 0) / 1000;
    s.gosi_employee = mine.filter((l) => l.code === 'GOSI').reduce((a, l) => a + toMils(l.amount), 0) / 1000;
    s.gosi_employer = mine.filter((l) => l.code === 'GOSI_ER').reduce((a, l) => a + toMils(l.amount), 0) / 1000;
  }
  run.adjustments = await knex('payroll_adjustments as a').join('employees as e', 'e.id', 'a.employee_id').where({ 'a.run_id': id, 'a.organization_id': ctx.organizationId })
    .select('a.*', knex.raw("CONCAT(e.first_name, ' ', e.last_name) as employee_name")).orderBy('a.id');
  return run;
}

/** Payslip detail. Payroll staff see every payslip; employees see their own once the payroll is paid. */
async function getPayslip(ctx, id) {
  const slip = await knex('payslips as s').join('payroll_runs as r', 'r.id', 's.run_id').join('employees as e', 'e.id', 's.employee_id')
    .where({ 's.id': id, 's.organization_id': ctx.organizationId })
    .first('s.*', 'r.period', 'r.period_start', 'r.period_end', 'r.status as run_status', 'r.currency', 'r.payment_date', 'e.user_id as employee_user_id');
  if (!slip) throw E.notFound('Payslip');
  const staff = ctx.permissions.has('payroll.view');
  const own = slip.employee_user_id === ctx.userId && slip.run_status === 'paid';
  if (!staff && !own) throw E.notFound('Payslip');
  slip.lines = await knex('payslip_lines').where({ payslip_id: id }).orderBy('sort_order');
  slip.warnings = parseJson(slip.warnings, []);
  return slip;
}

async function payslipsForEmployee(ctx, employeeId, { paidOnly = true } = {}) {
  const q = knex('payslips as s').join('payroll_runs as r', 'r.id', 's.run_id')
    .where({ 's.organization_id': ctx.organizationId, 's.employee_id': employeeId })
    .select('s.id', 's.gross', 's.total_deductions', 's.net', 'r.period', 'r.status as run_status', 'r.currency', 'r.payment_date', 'r.id as run_id')
    .orderBy('r.period', 'desc').limit(36);
  if (paidOnly) q.where('r.status', 'paid'); else q.whereNot('r.status', 'cancelled');
  return q;
}

async function myPayslips(ctx) {
  const me = await knex('employees').where({ organization_id: ctx.organizationId, user_id: ctx.userId }).first('id');
  if (!me) return [];
  return payslipsForEmployee(ctx, me.id, { paidOnly: true });
}

async function readiness(organizationId) {
  const base = knex('employees as e').leftJoin('employee_pay_profiles as p', 'p.employee_id', 'e.id')
    .where('e.organization_id', organizationId).whereNot('e.status', 'terminated');
  const [[{ total }], [{ noSalary }], [{ noIban }]] = await Promise.all([
    base.clone().count({ total: '*' }),
    base.clone().where((w) => w.whereNull('e.base_salary').orWhere('e.base_salary', 0)).count({ noSalary: '*' }),
    base.clone().where((w) => w.whereNull('p.id').orWhere((x) => x.where('p.payment_method', 'bank').whereNull('p.iban'))).count({ noIban: '*' }),
  ]);
  return { employees: Number(total), noSalary: Number(noSalary), noIban: Number(noIban) };
}

async function summary(organizationId) {
  const last = await knex('payroll_runs').where({ organization_id: organizationId }).whereNot('status', 'cancelled').orderBy('period', 'desc').first();
  return { last: last || null };
}

async function missingProfiles(organizationId, kind) {
  const q = knex('employees as e').leftJoin('employee_pay_profiles as p', 'p.employee_id', 'e.id')
    .where('e.organization_id', organizationId).whereNot('e.status', 'terminated')
    .select('e.id', 'e.first_name', 'e.last_name', 'e.job_title').orderBy('e.first_name').limit(100);
  if (kind === 'salary') q.where((w) => w.whereNull('e.base_salary').orWhere('e.base_salary', 0));
  else q.where((w) => w.whereNull('p.id').orWhere((x) => x.where('p.payment_method', 'bank').whereNull('p.iban')));
  return q;
}

module.exports = {
  rulesFor, saveSettings, listComponents, saveComponent, normalizeIban, getCompensation, saveCompensation,
  createRun, calculateRun, addAdjustment, removeAdjustment, transition, listRuns, getRun, getPayslip, payslipsForEmployee, myPayslips,
  readiness, summary, missingProfiles, PERIOD_RE,
};
