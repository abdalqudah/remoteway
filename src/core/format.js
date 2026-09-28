// View helpers for dates and money that respect the active locale.
function formatDate(value, locale = 'en', opts = { year: 'numeric', month: 'short', day: 'numeric' }) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { ...opts, timeZone: 'UTC' }).format(d);
}

function formatMoney(amount, currency = 'SAR', locale = 'en') {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US', {
    style: 'currency', currency, maximumFractionDigits: Number(amount) % 1 === 0 ? 0 : 2,
  }).format(Number(amount));
}

function formatNumber(n, locale = 'en') {
  if (n === null || n === undefined) return '∞';
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US').format(Number(n));
}

function formatBytesMb(mb, locale) {
  if (mb === null || mb === undefined) return '∞';
  return mb >= 1024 ? `${formatNumber(Math.round((mb / 1024) * 10) / 10, locale)} GB` : `${formatNumber(mb, locale)} MB`;
}

function toDateInput(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

module.exports = { formatDate, formatMoney, formatNumber, formatBytesMb, toDateInput };
