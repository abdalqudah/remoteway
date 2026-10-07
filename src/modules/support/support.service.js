// Client success portal: companies open support tickets with the platform team; the Super Admin
// works them from an inbox with first-response SLA targets. Enterprise (client_success) gets faster targets.
const knex = require('../../db/knex');
const config = require('../../config');
const jobs = require('../../core/jobs');
const mailer = require('../../core/mailer');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');
const ent = require('../billing/entitlements.service');
const notifications = require('../notifications/notification.service');

const CATEGORIES = ['technical', 'billing', 'account', 'data', 'feature_request', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'];
// First-response targets in hours (calendar hours).
const SLA = {
  standard: { urgent: 8, high: 24, normal: 48, low: 72 },
  priority: { urgent: 2, high: 4, normal: 8, low: 24 },
};

async function slaHours(organizationId, priority) {
  const tier = (await ent.hasFeature(organizationId, 'client_success')) ? 'priority' : 'standard';
  return { tier, hours: SLA[tier][priority] };
}

function validateMessage(body) {
  const b = String(body || '').trim();
  if (b.length < 2) throw E.validation({ body: 'Write a message.' });
  if (b.length > 10_000) throw E.validation({ body: 'Keep the message under 10,000 characters.' });
  return b;
}

// ---------- Company side ----------
async function create(ctx, input) {
  const subject = String(input.subject || '').trim();
  const errors = {};
  if (subject.length < 3 || subject.length > 200) errors.subject = 'Enter a short subject.';
  const category = CATEGORIES.includes(input.category) ? input.category : null;
  if (!category) errors.category = 'Choose a category.';
  const priority = PRIORITIES.includes(input.priority) ? input.priority : 'normal';
  let body;
  try { body = validateMessage(input.body); } catch (e) { Object.assign(errors, e.details); }
  if (Object.keys(errors).length) throw E.validation(errors);
  const { hours } = await slaHours(ctx.organizationId, priority);
  const now = new Date();
  const id = await knex.transaction(async (trx) => {
    const [tid] = await trx('support_tickets').insert({
      organization_id: ctx.organizationId, subject, category, priority, status: 'open', created_by: ctx.userId,
      sla_hours: hours, first_response_due: new Date(now.getTime() + hours * 3_600_000), last_activity_at: now,
    });
    await trx('ticket_messages').insert({ ticket_id: tid, organization_id: ctx.organizationId, user_id: ctx.userId, body });
    await audit.record(ctx, 'support.ticket_created', { entityType: 'ticket', entityId: tid, newValues: { subject, priority } }, trx);
    await jobs.enqueue(trx, { organizationId: ctx.organizationId, type: 'support.notify_staff', payload: { ticketId: tid, kind: 'new' }, maxAttempts: 5 });
    return tid;
  });
  return id;
}

function base() {
  return knex('support_tickets as t').join('organizations as o', 'o.id', 't.organization_id')
    .leftJoin('users as c', 'c.id', 't.created_by').leftJoin('users as a', 'a.id', 't.assigned_to')
    .select('t.*', 'o.name as organization_name', 'c.name as created_by_name', 'c.email as created_by_email', 'a.name as assigned_name');
}

const withSla = (t, now = Date.now()) => ({
  ...t,
  breached: !t.first_response_at && ['open', 'in_progress'].includes(t.status) && new Date(t.first_response_due).getTime() < now,
  responded_late: t.first_response_at && new Date(t.first_response_at) > new Date(t.first_response_due),
});

async function list(ctx) {
  return (await base().where('t.organization_id', ctx.organizationId).orderBy('t.last_activity_at', 'desc').limit(200)).map((t) => withSla(t));
}

async function messages(ticketId, { internal = false } = {}) {
  const q = knex('ticket_messages as m').leftJoin('users as u', 'u.id', 'm.user_id').where('m.ticket_id', ticketId).orderBy('m.id')
    .select('m.*', 'u.name as user_name');
  if (!internal) q.where('m.is_internal', false);
  return q;
}

async function get(ctx, id) {
  const t = await base().where({ 't.id': id, 't.organization_id': ctx.organizationId }).first();
  if (!t) throw E.notFound('Ticket');
  return { ...withSla(t), messages: await messages(id) };
}

async function reply(ctx, id, body) {
  const t = await get(ctx, id);
  if (t.status === 'closed') throw new AppError('TICKET_CLOSED', 'This ticket is closed. Open a new ticket or reopen it.', 409);
  const text = validateMessage(body);
  await knex.transaction(async (trx) => {
    await trx('ticket_messages').insert({ ticket_id: id, organization_id: ctx.organizationId, user_id: ctx.userId, body: text });
    await trx('support_tickets').where({ id }).update({
      last_activity_at: new Date(), status: ['waiting_customer', 'resolved'].includes(t.status) ? 'open' : t.status, resolved_at: null,
    });
    await jobs.enqueue(trx, { organizationId: ctx.organizationId, type: 'support.notify_staff', payload: { ticketId: id, kind: 'reply' }, maxAttempts: 5 });
  });
}

async function setStatus(ctx, id, action) {
  const t = await get(ctx, id);
  if (action === 'close') await knex('support_tickets').where({ id }).update({ status: 'closed', resolved_at: t.resolved_at || new Date(), last_activity_at: new Date() });
  else if (action === 'reopen') {
    if (!['resolved', 'closed'].includes(t.status)) return;
    await knex('support_tickets').where({ id }).update({ status: 'open', resolved_at: null, last_activity_at: new Date() });
  } else throw E.validation({ action: 'Invalid action.' });
}

async function rate(ctx, id, score) {
  const t = await get(ctx, id);
  const n = Number(score);
  if (!['resolved', 'closed'].includes(t.status)) throw new AppError('TICKET_NOT_RESOLVED', 'You can rate the support once the ticket is resolved.', 409);
  if (!(Number.isInteger(n) && n >= 1 && n <= 5)) throw E.validation({ satisfaction: 'Choose 1 to 5.' });
  await knex('support_tickets').where({ id }).update({ satisfaction: n });
}

// ---------- Platform side (Super Admin) ----------
async function adminList({ status = 'active', q } = {}) {
  const query = base();
  if (status === 'active') query.whereIn('t.status', ['open', 'in_progress', 'waiting_customer']);
  else if (STATUSES.includes(status)) query.where('t.status', status);
  if (q) query.where((w) => w.where('t.subject', 'like', `%${q}%`).orWhere('o.name', 'like', `%${q}%`));
  // Unanswered tickets first, by how soon their first-response target falls due.
  query.orderByRaw('t.first_response_at IS NOT NULL, CASE WHEN t.first_response_at IS NULL THEN t.first_response_due END ASC, t.last_activity_at DESC').limit(300);
  return (await query).map((t) => withSla(t));
}

async function adminStats() {
  const rows = await knex('support_tickets').whereIn('status', ['open', 'in_progress', 'waiting_customer']).select('status', 'first_response_at', 'first_response_due');
  const now = Date.now();
  const [sat] = await knex('support_tickets').whereNotNull('satisfaction').avg({ a: 'satisfaction' }).count({ n: '*' });
  return {
    open: rows.filter((r) => r.status !== 'waiting_customer').length,
    waiting: rows.filter((r) => r.status === 'waiting_customer').length,
    unanswered: rows.filter((r) => !r.first_response_at).length,
    breached: rows.filter((r) => !r.first_response_at && r.status !== 'waiting_customer' && new Date(r.first_response_due).getTime() < now).length,
    satisfaction: sat.n ? Math.round(Number(sat.a) * 10) / 10 : null,
  };
}

async function adminGet(id) {
  const t = await base().where('t.id', id).first();
  if (!t) throw E.notFound('Ticket');
  const plan = await knex('subscriptions as s').join('plans as p', 'p.id', 's.plan_id').where('s.organization_id', t.organization_id).first('p.name');
  return { ...withSla(t), plan: plan ? plan.name : null, messages: await messages(id, { internal: true }) };
}

async function adminReply(adminCtx, id, input) {
  const t = await adminGet(id);
  const internal = input.internal === 'on';
  const body = String(input.body || '').trim();
  const status = STATUSES.includes(input.status) ? input.status : (internal ? t.status : 'waiting_customer');
  if (!body && status === t.status) throw E.validation({ body: 'Write a message.' });
  if (body) validateMessage(body);
  const now = new Date();
  await knex.transaction(async (trx) => {
    if (body) await trx('ticket_messages').insert({ ticket_id: id, organization_id: t.organization_id, user_id: adminCtx.userId, is_staff: true, is_internal: internal, body });
    const patch = { status, last_activity_at: now };
    if (body && !internal && !t.first_response_at) patch.first_response_at = now;
    if (!t.assigned_to) patch.assigned_to = adminCtx.userId;
    if (['resolved', 'closed'].includes(status) && !t.resolved_at) patch.resolved_at = now;
    if (!['resolved', 'closed'].includes(status)) patch.resolved_at = null;
    await trx('support_tickets').where({ id }).update(patch);
    if (!internal && t.created_by && (body || status !== t.status)) {
      await notifications.notify(t.organization_id, [t.created_by], body ? 'support_reply' : 'support_status', { subject: t.subject, status }, `/app/support/${id}`, trx);
    }
  });
}

async function assign(adminCtx, id, userId) {
  await adminGet(id);
  const staff = userId ? await knex('users').where({ id: userId, is_super_admin: true }).first('id') : null;
  await knex('support_tickets').where({ id }).update({ assigned_to: staff ? staff.id : null });
}

/** Job: emails platform staff about a new ticket or a customer reply. */
async function notifyStaff({ ticketId, kind }) {
  const t = await base().where('t.id', ticketId).first();
  if (!t) return;
  const staff = t.assigned_to && kind === 'reply'
    ? await knex('users').where({ id: t.assigned_to, status: 'active' }).select('email')
    : await knex('users').where({ is_super_admin: true, status: 'active' }).select('email');
  for (const s of staff) {
    await mailer.send({ kind: 'support',
      to: s.email,
      subject: `[RemoteWay support] ${kind === 'new' ? 'New' : 'Reply'} · ${t.priority.toUpperCase()} · ${t.subject}`,
      html: mailer.layout({ locale: 'en', title: t.subject, body: `${t.organization_name} · ${t.created_by_name || ''} (${t.category}, ${t.priority}). First response due ${new Date(t.first_response_due).toISOString().replace('T', ' ').slice(0, 16)} UTC.`, cta: 'Open ticket', href: `${config.appUrl}/admin/support/${t.id}` }),
    });
  }
}
jobs.register('support.notify_staff', notifyStaff);

module.exports = {
  CATEGORIES, PRIORITIES, STATUSES, SLA, slaHours, create, list, get, reply, setStatus, rate,
  adminList, adminStats, adminGet, adminReply, assign, notifyStaff,
};
