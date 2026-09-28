// Calendar feeds (iCalendar / .ics) that Google Calendar, Outlook and Apple Calendar can subscribe to.
// Each feed has a secret URL; regenerating it invalidates the old one.
const crypto = require('crypto');
const knex = require('../../db/knex');
const secrets = require('../../core/secrets');
const { E } = require('../../core/errors');
const { translator } = require('../../core/i18n');
const { addDays, todayIn } = require('../../core/workdays');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');
const rbac = require('../rbac/rbac.service');

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const dstr = (v) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);

// ---------- iCalendar formatting (RFC 5545) ----------
const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  // Lines longer than 75 octets are folded (continuation lines start with a space). Never split a UTF-8 character.
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const ymd = (d) => d.replace(/-/g, '');
const stamp = (dt) => new Date(dt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function buildIcs(name, events) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RemoteWay//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  const now = stamp(Date.now());
  for (const ev of events) {
    lines.push('BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${now}`);
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${ymd(ev.start)}`, `DTEND;VALUE=DATE:${ymd(addDays(ev.end || ev.start, 1))}`);
    } else {
      lines.push(`DTSTART:${stamp(ev.start)}`, `DTEND:${stamp(ev.end)}`);
    }
    lines.push(`SUMMARY:${icsText(ev.summary)}`);
    if (ev.description) lines.push(`DESCRIPTION:${icsText(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${icsText(ev.location)}`);
    if (ev.url) lines.push(`URL:${ev.url}`);
    if (ev.transparent) lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// ---------- Tokens ----------
async function feeds(ctx) {
  const rows = await knex('calendar_tokens').where({ organization_id: ctx.organizationId, user_id: ctx.userId });
  return Object.fromEntries(rows.map((r) => [r.kind, { token: secrets.decrypt(r.token_enc), last_used_at: r.last_used_at, created_at: r.created_at }]));
}

async function generate(ctx, kind) {
  if (!['personal', 'company_leave'].includes(kind)) throw E.validation({ kind: 'Invalid feed.' });
  await ent.assertFeature(ctx.organizationId, 'integrations');
  if (kind === 'company_leave' && !ctx.permissions.has('leave.view') && !ctx.permissions.has('employees.view')) throw E.forbidden('leave.view');
  const token = `cal_${crypto.randomBytes(24).toString('base64url')}`;
  const row = { token_hash: hash(token), token_hint: token.slice(-6), token_enc: secrets.encrypt(token), last_used_at: null };
  await knex('calendar_tokens').insert({ ...row, organization_id: ctx.organizationId, user_id: ctx.userId, kind })
    .onConflict(['organization_id', 'user_id', 'kind']).merge({ ...row, updated_at: new Date() });
  return token;
}

async function revoke(ctx, kind) {
  await knex('calendar_tokens').where({ organization_id: ctx.organizationId, user_id: ctx.userId, kind }).del();
}

// ---------- Feeds ----------
async function personalEvents(organizationId, userId, t, base) {
  const self = await knex('employees').where({ organization_id: organizationId, user_id: userId }).first('id');
  const from = addDays(new Date().toISOString().slice(0, 10), -90);
  const events = [];
  if (self) {
    const leave = await knex('leave_requests as r').join('leave_types as t', 't.id', 'r.leave_type_id')
      .where({ 'r.organization_id': organizationId, 'r.employee_id': self.id }).whereIn('r.status', ['approved', 'pending']).where('r.end_date', '>=', from)
      .select('r.id', 'r.start_date', 'r.end_date', 'r.status', 't.name', 't.name_ar');
    for (const l of leave) {
      events.push({ uid: `leave-${l.id}@remoteway`, allDay: true, start: dstr(l.start_date), end: dstr(l.end_date),
        summary: `${t.locale === 'ar' && l.name_ar ? l.name_ar : l.name}${l.status === 'pending' ? ` (${t('leave.status_pending')})` : ''}`, url: `${base}/app/leave` });
    }
    const training = await knex('enrollments as e').join('courses as c', 'c.id', 'e.course_id').where({ 'e.organization_id': organizationId, 'e.employee_id': self.id })
      .whereNot('e.status', 'completed').whereNotNull('e.due_date').select('e.id', 'e.due_date', 'c.title', 'c.id as course_id');
    for (const e of training) events.push({ uid: `training-${e.id}@remoteway`, allDay: true, start: dstr(e.due_date), summary: `${t('learning.due')}: ${e.title}`, url: `${base}/app/learning/courses/${e.course_id}`, transparent: true });
  }
  const interviews = await knex('interviews as i').join('applications as a', 'a.id', 'i.application_id').join('candidates as c', 'c.id', 'a.candidate_id').join('jobs as j', 'j.id', 'a.job_id')
    .where({ 'i.organization_id': organizationId, 'i.interviewer_user_id': userId, 'i.status': 'scheduled' }).where('i.scheduled_at', '>=', new Date(Date.now() - 30 * 86_400_000))
    .select('i.id', 'i.scheduled_at', 'i.duration_minutes', 'i.location', 'c.first_name', 'c.last_name', 'j.title');
  for (const i of interviews) {
    const start = new Date(i.scheduled_at);
    events.push({ uid: `interview-${i.id}@remoteway`, start, end: new Date(start.getTime() + i.duration_minutes * 60_000),
      summary: t('recruitment.interview_with', { name: `${i.first_name} ${i.last_name}` }), description: i.title, location: i.location, url: `${base}/app/recruitment/interviews/${i.id}` });
  }
  const tasks = await knex('onboarding_tasks as t').join('onboarding_plans as p', 'p.id', 't.plan_id').join('employees as e', 'e.id', 'p.employee_id')
    .where({ 't.organization_id': organizationId, 't.assignee_user_id': userId, 'p.status': 'active' }).whereNull('t.completed_at').whereNotNull('t.due_date')
    .select('t.id', 't.title', 't.due_date', 'p.id as plan_id', 'e.first_name', 'e.last_name');
  for (const tk of tasks) events.push({ uid: `onboarding-${tk.id}@remoteway`, allDay: true, start: dstr(tk.due_date), summary: `${tk.title} · ${tk.first_name} ${tk.last_name}`, url: `${base}/app/employee-onboarding/${tk.plan_id}`, transparent: true });
  return events;
}

async function companyLeaveEvents(organizationId, t, base) {
  const from = addDays(new Date().toISOString().slice(0, 10), -60);
  const to = addDays(new Date().toISOString().slice(0, 10), 365);
  const rows = await knex('leave_requests as r').join('employees as e', 'e.id', 'r.employee_id').join('leave_types as lt', 'lt.id', 'r.leave_type_id')
    .where({ 'r.organization_id': organizationId, 'r.status': 'approved' }).where('r.end_date', '>=', from).where('r.start_date', '<=', to)
    .select('r.id', 'r.start_date', 'r.end_date', 'e.first_name', 'e.last_name', 'lt.name', 'lt.name_ar').limit(2000);
  return rows.map((l) => ({ uid: `company-leave-${l.id}@remoteway`, allDay: true, start: dstr(l.start_date), end: dstr(l.end_date), transparent: true,
    summary: `${l.first_name} ${l.last_name} — ${t.locale === 'ar' && l.name_ar ? l.name_ar : l.name}`, url: `${base}/app/leave?tab=calendar` }));
}

/** Resolves a feed token and renders the calendar; null if the token is unknown or no longer allowed. */
async function render(token, base) {
  if (!/^cal_[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
  const row = await knex('calendar_tokens').where({ token_hash: hash(token) }).first();
  if (!row) return null;
  const member = await knex('memberships').where({ organization_id: row.organization_id, user_id: row.user_id, status: 'active' }).first('id');
  const user = await knex('users').where({ id: row.user_id, status: 'active' }).first('locale');
  if (!member || !user || !(await ent.hasFeature(row.organization_id, 'integrations'))) return null;
  const org = await orgs.get(row.organization_id);
  const t = translator(user.locale || org.locale);
  t.locale = user.locale || org.locale;
  let events;
  let name;
  if (row.kind === 'company_leave') {
    const perms = await rbac.getUserPermissions(row.organization_id, row.user_id);
    if (!perms.has('leave.view') && !perms.has('employees.view')) return null;
    events = await companyLeaveEvents(row.organization_id, t, base);
    name = `${org.name} — ${t('integrations.feed_company_leave')}`;
  } else {
    events = await personalEvents(row.organization_id, row.user_id, t, base);
    name = `RemoteWay — ${org.name}`;
  }
  await knex('calendar_tokens').where({ id: row.id }).update({ last_used_at: new Date() });
  return buildIcs(name, events);
}

module.exports = { buildIcs, fold, icsText, feeds, generate, revoke, render, todayIn };
