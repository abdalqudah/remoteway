// Pure payroll calculation tests (no database).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/modules/payroll/engine');
const { effectiveRules } = require('../src/modules/payroll/country-rules');
const money = require('../src/core/money');

const SA = effectiveRules('SA', {});
const HOUSING = { code: 'HOUSING', name: 'Housing', kind: 'earning', calc: 'percent_basic', value: 25, in_gosi_base: true, prorate: true };
const TRANSPORT = { code: 'TRANSPORT', name: 'Transport', kind: 'earning', calc: 'fixed', value: 800, in_gosi_base: false, prorate: true };
const LOAN = { code: 'LOAN', name: 'Loan', kind: 'deduction', calc: 'fixed', value: 1000, in_gosi_base: false, prorate: false };
const SEPT = engine.periodBounds('2026-09');
const line = (r, code) => (r.lines.find((l) => l.code === code) || { amount: 0 }).amount / 1000;

describe('payroll engine', () => {
  test('period bounds handle month lengths and December', () => {
    assert.deepEqual(engine.periodBounds('2028-02'), { start: '2028-02-01', end: '2028-02-29' });
    assert.deepEqual(engine.periodBounds('2026-12'), { start: '2026-12-01', end: '2026-12-31' });
  });

  test('Saudi employee: allowances, GOSI employee and employer shares', () => {
    const r = engine.calculate({ period: SEPT, rules: SA, currency: 'SAR', employee: { base_salary: 10000, nationality: 'SA', joining_date: '2020-01-01', iban: 'x' }, components: [HOUSING, TRANSPORT] });
    assert.equal(r.paidDays, 30);
    assert.equal(line(r, 'HOUSING'), 2500);
    assert.equal(line(r, 'TRANSPORT'), 800);
    assert.equal(r.gross / 1000, 13300);
    assert.equal(r.gosiBase / 1000, 12500); // basic + housing only
    assert.equal(line(r, 'GOSI'), 1218.75); // 9.75%
    assert.equal(line(r, 'GOSI_ER'), 1468.75); // 11.75%
    assert.equal(r.net / 1000, 13300 - 1218.75);
    assert.deepEqual(r.warnings, []);
  });

  test('non-Saudi employee: only the employer\'s occupational hazards share', () => {
    const r = engine.calculate({ period: SEPT, rules: SA, currency: 'SAR', employee: { base_salary: 8000, nationality: 'EG', iban: 'x' }, components: [HOUSING] });
    assert.equal(line(r, 'GOSI'), 0);
    assert.equal(line(r, 'GOSI_ER'), 200); // 2% of 10,000
    assert.equal(r.deductions, 0);
  });

  test('GOSI wage is capped at the ceiling and raised to the floor', () => {
    const high = engine.calculate({ period: SEPT, rules: SA, currency: 'SAR', employee: { base_salary: 60000, nationality: 'SA', iban: 'x' }, components: [HOUSING] });
    assert.equal(high.gosiBase / 1000, 45000);
    assert.equal(line(high, 'GOSI'), 4387.5);
    const low = engine.calculate({ period: SEPT, rules: SA, currency: 'SAR', employee: { base_salary: 1000, nationality: 'EG', iban: 'x' } });
    assert.equal(low.gosiBase / 1000, 1500);
  });

  test('not registered in GOSI, or GOSI switched off → no contributions', () => {
    const r1 = engine.calculate({ period: SEPT, rules: SA, currency: 'SAR', employee: { base_salary: 10000, nationality: 'SA', gosi_registered: false, iban: 'x' } });
    assert.equal(r1.lines.some((l) => l.source === 'statutory'), false);
    const off = effectiveRules('SA', { payroll_gosi: { enabled: false } });
    const r2 = engine.calculate({ period: SEPT, rules: off, currency: 'SAR', employee: { base_salary: 10000, nationality: 'SA', iban: 'x' } });
    assert.equal(r2.lines.some((l) => l.source === 'statutory'), false);
  });

  test('company overrides of GOSI rates are applied', () => {
    const rules = effectiveRules('SA', { payroll_gosi: { enabled: true, national_employee_rate: 10.25 } });
    const r = engine.calculate({ period: SEPT, rules, currency: 'SAR', employee: { base_salary: 10000, nationality: 'SA', iban: 'x' } });
    assert.equal(line(r, 'GOSI'), 1025);
  });

  test('countries without statutory rules get no automatic deductions', () => {
    const rules = effectiveRules('AE', {});
    assert.equal(rules.hasStatutory, false);
    const r = engine.calculate({ period: SEPT, rules, currency: 'AED', employee: { base_salary: 10000, nationality: 'AE', iban: 'x' } });
    assert.equal(r.net / 1000, 10000);
  });

  test('joiners are prorated on a 30-day month; non-prorated deductions are not', () => {
    const r = engine.calculate({ period: SEPT, rules: SA, currency: 'SAR', employee: { base_salary: 9000, nationality: 'EG', joining_date: '2026-09-21', iban: 'x' }, components: [LOAN] });
    assert.equal(r.paidDays, 10);
    assert.equal(line(r, 'BASIC'), 3000);
    assert.equal(line(r, 'LOAN'), 1000);
  });

  test('calendar-day proration uses the month\'s real length', () => {
    const rules = effectiveRules('SA', { payroll_proration: 'calendar' });
    const r = engine.calculate({ period: engine.periodBounds('2026-10'), rules, currency: 'SAR', employee: { base_salary: 3100, nationality: 'EG', termination_date: '2026-10-10', iban: 'x' } });
    assert.equal(r.paidDays, 10);
    assert.equal(r.periodDays, 31);
    assert.equal(line(r, 'BASIC'), 1000);
  });

  test('a full 31-day month is 30 paid days, and nobody is paid outside employment', () => {
    const r = engine.calculate({ period: engine.periodBounds('2026-10'), rules: SA, currency: 'SAR', employee: { base_salary: 3000, nationality: 'EG', iban: 'x' } });
    assert.equal(r.paidDays, 30);
    assert.equal(line(r, 'BASIC'), 3000);
    assert.equal(engine.calculate({ period: SEPT, rules: SA, currency: 'SAR', employee: { base_salary: 3000, joining_date: '2026-10-01' } }), null);
    assert.equal(engine.calculate({ period: SEPT, rules: SA, currency: 'SAR', employee: { base_salary: 3000, termination_date: '2026-08-31' } }), null);
  });

  test('unpaid leave deducts the daily rate of basic + prorated allowances', () => {
    const r = engine.calculate({ period: SEPT, rules: SA, currency: 'SAR', employee: { base_salary: 10000, nationality: 'EG', iban: 'x' }, components: [HOUSING, TRANSPORT], unpaidLeaveDays: 2 });
    assert.equal(line(r, 'UNPAID_LEAVE'), 886.67); // 13,300 / 30 × 2, rounded
  });

  test('adjustments and warnings', () => {
    const r = engine.calculate({ period: SEPT, rules: SA, currency: 'SAR', employee: { base_salary: 1000, nationality: 'EG' },
      adjustments: [{ kind: 'earning', name: 'Bonus', amount: 100 }, { kind: 'deduction', name: 'Damage', amount: 1500 }] });
    assert.equal(r.gross / 1000, 1100);
    assert.ok(r.warnings.includes('negative_net'));
    assert.ok(r.warnings.includes('deduction_limit'));
    assert.ok(r.warnings.includes('no_iban'));
    const noSalary = engine.calculate({ period: SEPT, rules: SA, currency: 'SAR', employee: { nationality: 'EG', payment_method: 'cash' } });
    assert.deepEqual(noSalary.warnings, ['no_salary']);
  });

  test('3-decimal currencies stay exact; 2-decimal currencies round half away from zero', () => {
    const kw = engine.calculate({ period: SEPT, rules: effectiveRules('KW', {}), currency: 'KWD', employee: { base_salary: 1000.125, iban: 'x' }, components: [{ ...HOUSING, value: 12.5 }] });
    assert.equal(line(kw, 'BASIC'), 1000.125);
    assert.equal(line(kw, 'HOUSING'), 125.016); // 125.015625 → 3 decimals
    assert.equal(money.roundMils(2803125, 'SAR'), 2803130);
    assert.equal(money.roundMils(-2803125, 'SAR'), -2803130);
    assert.equal(money.decimalsOf('BHD'), 3);
  });
});
