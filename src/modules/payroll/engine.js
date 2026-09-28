// Payroll calculation for one employee and one month. Pure: no database access, fully unit-tested.
const { toMils, roundMils, scale } = require('../../core/money');
const { addDays } = require('../../core/workdays');

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
const toDateStr = (v) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);

/**
 * Which part of the period the employee is paid for.
 * "thirty" basis (common in the Gulf): a full month is 30 days; partial months pay the calendar days worked (max 30).
 * "calendar" basis: the month's real number of days.
 */
function coverage(period, employee, basis) {
  const joining = toDateStr(employee.joining_date);
  const leaving = toDateStr(employee.termination_date);
  const start = joining && joining > period.start ? joining : period.start;
  const end = leaving && leaving < period.end ? leaving : period.end;
  if (start > end) return null;
  const monthDays = daysBetween(period.start, period.end);
  const worked = daysBetween(start, end);
  const full = start === period.start && end === period.end;
  if (basis === 'calendar') return { start, end, periodDays: monthDays, paidDays: worked, full };
  return { start, end, periodDays: 30, paidDays: full ? 30 : Math.min(30, worked), full };
}

/**
 * @param {object} p
 * @param {{start:string,end:string}} p.period
 * @param {object} p.rules      effectiveRules() result
 * @param {string} p.currency
 * @param {object} p.employee   { base_salary, joining_date, termination_date, nationality, gosi_registered, payment_method, iban }
 * @param {Array}  p.components [{ code, name, name_ar, kind, calc, value, in_gosi_base, prorate }]
 * @param {number} p.unpaidLeaveDays
 * @param {Array}  p.adjustments [{ kind, name, amount, note }]
 */
function calculate({ period, rules, currency, employee, components = [], unpaidLeaveDays = 0, adjustments = [] }) {
  const warnings = [];
  const cov = coverage(period, employee, rules.proration);
  if (!cov) return null;
  const factor = cov.paidDays / cov.periodDays;
  const lines = [];
  const add = (line) => { if (line.amount !== 0) lines.push({ sort_order: lines.length, note: null, name_ar: null, ...line }); };

  const basicMonthly = toMils(employee.base_salary);
  if (!basicMonthly) warnings.push('no_salary');
  add({ kind: 'earning', source: 'basic', code: 'BASIC', name: 'Basic salary', name_ar: 'الراتب الأساسي', amount: scale(basicMonthly, factor, currency) });

  // Recurring components (allowances and deductions) from the employee's compensation.
  let fixedMonthly = basicMonthly; // monthly wage used for the daily rate (basic + prorated earnings)
  let gosiWage = basicMonthly;
  for (const c of components) {
    const monthly = c.calc === 'percent_basic' ? roundMils(basicMonthly * (Number(c.value) / 100), currency) : toMils(c.value);
    if (!monthly) continue;
    const amount = c.prorate ? scale(monthly, factor, currency) : monthly;
    if (c.kind === 'earning') {
      if (c.prorate) fixedMonthly += monthly;
      if (c.in_gosi_base) gosiWage += monthly;
    }
    add({ kind: c.kind, source: 'component', code: c.code, name: c.name, name_ar: c.name_ar, amount });
  }

  // Unpaid leave: the daily rate of the fixed monthly wage for each unpaid day (never more than the days paid).
  const leaveDays = Math.min(Number(unpaidLeaveDays) || 0, cov.paidDays);
  if (leaveDays > 0) {
    add({ kind: 'deduction', source: 'leave', code: 'UNPAID_LEAVE', name: 'Unpaid leave', name_ar: 'إجازة بدون راتب', amount: scale(fixedMonthly, leaveDays / cov.periodDays, currency), note: `${leaveDays}` });
  }

  // Statutory contributions (Country Policy Engine).
  let gosiBase = 0;
  const g = rules.gosi;
  if (g && g.enabled && employee.gosi_registered !== false && employee.gosi_registered !== 0 && gosiWage > 0) {
    const clamped = Math.min(Math.max(gosiWage, toMils(g.wage_floor)), toMils(g.wage_ceiling));
    gosiBase = scale(clamped, factor, currency);
    const national = employee.nationality === g.national;
    const eeRate = national ? g.national_employee_rate : g.expat_employee_rate;
    const erRate = national ? g.national_employer_rate : g.expat_employer_rate;
    add({ kind: 'deduction', source: 'statutory', code: 'GOSI', name: 'GOSI (employee share)', name_ar: 'التأمينات الاجتماعية (حصة الموظف)', amount: scale(gosiBase, eeRate / 100, currency), note: `${eeRate}%` });
    add({ kind: 'employer', source: 'statutory', code: 'GOSI_ER', name: 'GOSI (employer share)', name_ar: 'التأمينات الاجتماعية (حصة المنشأة)', amount: scale(gosiBase, erRate / 100, currency), note: `${erRate}%` });
  }

  // One-off adjustments entered for this run (bonus, overtime, loan instalment…). Never prorated.
  for (const a of adjustments) {
    add({ kind: a.kind, source: 'adjustment', code: 'ADJ', name: a.name, amount: roundMils(toMils(a.amount), currency), note: a.note || null });
  }

  const sum = (kind, filter = () => true) => lines.filter((l) => l.kind === kind && filter(l)).reduce((s, l) => s + l.amount, 0);
  const gross = sum('earning');
  const deductions = sum('deduction');
  const employer = sum('employer');
  const net = gross - deductions;
  if (net < 0) warnings.push('negative_net');
  // Discretionary deductions (not statutory, not unpaid leave) above the legal share of the wage.
  if (rules.maxDeductionRatio && sum('deduction', (l) => l.source === 'component' || l.source === 'adjustment') > gross * rules.maxDeductionRatio) warnings.push('deduction_limit');
  if (employee.payment_method !== 'cash' && !employee.iban) warnings.push('no_iban');

  return {
    periodDays: cov.periodDays, paidDays: cov.paidDays, unpaidLeaveDays: leaveDays, coverage: cov,
    basic: lines.find((l) => l.code === 'BASIC')?.amount || 0, gross, deductions, net, employer, employerCost: gross + employer, gosiBase, lines, warnings,
  };
}

/** First and last day of a YYYY-MM period. */
function periodBounds(period) {
  const [y, m] = period.split('-').map(Number);
  const start = `${period}-01`;
  const end = addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1);
  return { start, end };
}

module.exports = { calculate, coverage, periodBounds };
