// Country Policy Engine — payroll rules per country.
// Only countries with verified statutory rules get automatic deductions; others run payroll
// with the company's own components and adjustments. Companies can review and override the
// rates in Payroll → Settings (rates change; the platform never hides them).

// Saudi Arabia — GOSI (General Organization for Social Insurance).
// Contribution wage = basic + housing (components flagged "in GOSI wage"), within a monthly floor/ceiling.
//  • Saudi nationals: annuities 9% employee + 9% employer, unemployment insurance (SANED) 0.75% + 0.75%,
//    occupational hazards 2% employer.
//  • Non-Saudi employees: occupational hazards 2% employer only.
const SA = {
  gosi: {
    enabled: true,
    wage_floor: 1500,
    wage_ceiling: 45000,
    national: 'SA',
    national_employee_rate: 9.75, // annuities 9 + SANED 0.75
    national_employer_rate: 11.75, // annuities 9 + SANED 0.75 + hazards 2
    expat_employee_rate: 0,
    expat_employer_rate: 2, // occupational hazards
  },
  max_deduction_ratio: 0.5, // Saudi Labor Law art. 92: deductions may not exceed half of the wage
};

const RULES = { SA };

const numberOr = (v, d) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

/** Effective payroll rules for an organization: country defaults, then the company's own overrides. */
function effectiveRules(countryCode, settings = {}) {
  const base = RULES[countryCode] || null;
  const override = settings.payroll_gosi || {};
  const gosi = base && base.gosi ? {
    ...base.gosi,
    enabled: override.enabled === undefined ? base.gosi.enabled : Boolean(override.enabled),
    wage_floor: numberOr(override.wage_floor, base.gosi.wage_floor),
    wage_ceiling: numberOr(override.wage_ceiling, base.gosi.wage_ceiling),
    national_employee_rate: numberOr(override.national_employee_rate, base.gosi.national_employee_rate),
    national_employer_rate: numberOr(override.national_employer_rate, base.gosi.national_employer_rate),
    expat_employee_rate: numberOr(override.expat_employee_rate, base.gosi.expat_employee_rate),
    expat_employer_rate: numberOr(override.expat_employer_rate, base.gosi.expat_employer_rate),
  } : null;
  return {
    country: countryCode,
    hasStatutory: Boolean(gosi),
    gosi,
    maxDeductionRatio: base ? base.max_deduction_ratio : null,
    proration: settings.payroll_proration === 'calendar' ? 'calendar' : 'thirty',
    fourEyes: Boolean(settings.payroll_four_eyes),
  };
}

module.exports = { effectiveRules, RULES };
