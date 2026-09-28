// Exact money arithmetic. Amounts are handled as integers in thousandths ("mils") so that
// 3-decimal currencies (KWD, BHD, OMR, JOD) stay exact and 2-decimal ones round once per line.
const THREE_DECIMALS = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'LYD', 'IQD']);

const decimalsOf = (currency) => (THREE_DECIMALS.has(String(currency || '').toUpperCase()) ? 3 : 2);

/** Decimal (number or DB string) → integer mils. */
const toMils = (v) => (v === null || v === undefined || v === '' ? 0 : Math.round(Number(v) * 1000));

/** Integer mils → number with 3 decimals (for DB columns). */
const fromMils = (m) => Number((m / 1000).toFixed(3));

/** Round mils to the currency's precision (half away from zero). */
function roundMils(m, currency) {
  const step = 10 ** (3 - decimalsOf(currency));
  if (step === 1) return Math.round(m);
  const sign = m < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(m) / step) * step;
}

/** mils × ratio, rounded to the currency. */
const scale = (m, ratio, currency) => roundMils(m * ratio, currency);

module.exports = { decimalsOf, toMils, fromMils, roundMils, scale };
