// Date helpers working on plain 'YYYY-MM-DD' strings (UTC) so results never shift with server timezones.
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const toDate = (s) => new Date(`${s}T00:00:00Z`);
const toStr = (d) => d.toISOString().slice(0, 10);
const isDateStr = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toDate(s).getTime());

function addDays(s, n) {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toStr(d);
}

function dayKey(s) {
  return DAY_KEYS[toDate(s).getUTCDay()];
}

/** Working days between two dates inclusive, using the organization's working week. */
function countWorkingDays(start, end, workingDays) {
  const set = new Set(workingDays && workingDays.length ? workingDays : ['sun', 'mon', 'tue', 'wed', 'thu']);
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) if (set.has(dayKey(d))) n += 1;
  return n;
}

/** Today's date in the organization's timezone, as YYYY-MM-DD. */
function todayIn(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return toStr(new Date());
  }
}

/** Minutes since midnight for "now" in the organization's timezone. */
function minutesNowIn(timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

const hhmmToMinutes = (s) => {
  const [h, m] = String(s || '09:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

module.exports = { DAY_KEYS, toDate, toStr, isDateStr, addDays, dayKey, countWorkingDays, todayIn, minutesNowIn, hhmmToMinutes };
