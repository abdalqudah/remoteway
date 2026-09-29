// RemoteWay's internal CRM (Super Admin only). Contacts are the people the RemoteWay team works with;
// a contact linked to a platform user is kept up to date by platform events (sign-up, profile, applications,
// subscription), so the CRM stays live instead of being a separate list.
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const { normalizePhone } = require('../integrations/messaging.service');

const KINDS = ['lead', 'company_owner', 'company_user', 'individual', 'applicant', 'contact'];
const SOURCES = ['website_demo', 'company_signup', 'individual_signup', 'manual', 'import', 'referral', 'event', 'social', 'whatsapp', 'other'];
const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const str = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };

// ---------- Stages (customisable pipeline) ----------
function stages({ all = false } = {}) {
  return cache.remember(`crm:stages:${all}`, () => {
    const q = knex('crm_stages').orderBy('sort_order').orderBy('id');
    if (!all) q.where('is_active', true);
    return q;
  }, 60_000);
}
const invalidateStages = () => cache.forgetPrefix('crm:stages');
async function stageByKey(key) { return (await stages({ all: true })).find((s) => s.key === key); }

async function saveStage(ctx, id, input) {
  const name = str(input.name, 80); const nameAr = str(input.name_ar, 80);
  const color = /^#[0-9A-Fa-f]{6}$/.test(String(input.color || '')) ? String(input.color).toUpperCase() : '#64748B';
  if (!name) throw E.validation({ name: 'Enter the stage name.' });
  if (id) {
    await knex('crm_stages').where({ id }).update({ name, name_ar: nameAr, color, is_active: input.is_active !== 'off' && input.is_active !== false });
  } else {
    const key = `custom_${Date.now().toString(36)}`;
    const max = (await knex('crm_stages').max({ m: 'sort_order' }).first()).m || 0;
    await knex('crm_stages').insert({ key, name, name_ar: nameAr, color, sort_order: max + 1 });
  }
  invalidateStages();
  await audit.record(ctx, 'crm.stage_saved', { entityType: 'crm_stage', entityId: id || null, newValues: { name } });
}

async function reorderStages(ctx, ids) {
  let i = 0;
  for (const id of ids.map(Number).filter(Boolean)) await knex('crm_stages').where({ id }).update({ sort_order: (i += 1) });
  invalidateStages();
}

async function deleteStage(ctx, id) {
  const s = await knex('crm_stages').where({ id }).first();
  if (!s) throw E.notFound('Stage');
  if (s.is_system) throw E.conflict('CRM_STAGE_SYSTEM', 'Built-in stages are used by platform events. Rename or hide them instead.');
  const fallback = await stageByKey('new_lead');
  await knex('crm_contacts').where({ stage_id: id }).update({ stage_id: fallback.id });
  await knex('crm_stages').where({ id }).del();
  invalidateStages();
}

// ---------- Activities ----------
async function addActivity(contactId, a, trx = knex) {
  const [id] = await trx('crm_activities').insert({
    contact_id: contactId, type: a.type, direction: a.direction || null, channel: a.channel || null, subject: a.subject ? String(a.subject).slice(0, 200) : null,
    body: a.body != null ? String(a.body).slice(0, 20000) : null, status: a.status || null, meta: a.meta ? JSON.stringify(a.meta) : null, user_id: a.userId || null,
    created_at: a.at || new Date(),
  });
  // "Last contact" is the team reaching out (or a logged call/meeting), not system events or inbound messages.
  if (a.direction === 'out' || ['call', 'meeting'].includes(a.type)) {
    await trx('crm_contacts').where({ id: contactId }).update({ last_contact_at: new Date(), last_contact_by: a.userId || null, updated_at: new Date() });
  }
  if (a.direction === 'in') await trx('crm_contacts').where({ id: contactId }).update({ last_inbound_at: new Date() });
  return id;
}

async function changeStage(ctx, contactId, stageId, { note, system = false } = {}, trx = knex) {
  const c = await trx('crm_contacts').where({ id: contactId }).first();
  if (!c) throw E.notFound('Contact');
  const to = (await stages({ all: true })).find((s) => s.id === Number(stageId));
  if (!to) throw E.validation({ stage_id: 'Choose a stage.' });
  if (c.stage_id === to.id) return false;
  const from = (await stages({ all: true })).find((s) => s.id === c.stage_id);
  const patch = { stage_id: to.id, stage_changed_at: new Date(), updated_at: new Date() };
  if (to.key === 'subscribed' && !c.subscribed_at) patch.subscribed_at = new Date();
  await trx('crm_contacts').where({ id: c.id }).update(patch);
  await addActivity(c.id, { type: 'stage_change', subject: `${from ? from.name : '—'} → ${to.name}`, body: note ? String(note).slice(0, 2000) : null, meta: { from: from?.key, to: to.key, system }, userId: system ? null : ctx.userId }, trx);
  return true;
}

// ---------- Contacts ----------
const contactSchema = (input) => {
  const errors = {};
  const name = str(input.name, 150);
  const email = str(input.email, 190)?.toLowerCase() || null;
  const phone = input.phone ? normalizePhone(input.phone, input.country_code || 'SA') : null;
  if (!name) errors.name = 'Enter the name.';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.';
  if (input.phone && !phone) errors.phone = 'Enter a valid phone number with country code.';
  if (!email && !phone) errors.email = 'Add an email or a phone number.';
  if (Object.keys(errors).length) throw E.validation(errors);
  return {
    name, email, phone, company_name: str(input.company_name, 150), job_title: str(input.job_title, 150),
    country_code: /^[A-Za-z]{2}$/.test(String(input.country_code || '')) ? String(input.country_code).toUpperCase() : null, city: str(input.city, 100),
    kind: KINDS.includes(input.kind) ? input.kind : 'lead', source: SOURCES.includes(input.source) ? input.source : 'manual',
    notes: str(input.notes, 10000), locale: input.locale === 'en' ? 'en' : 'ar',
    tags: JSON.stringify(String(input.tags || '').split(/[,،]/).map((t) => t.trim()).filter(Boolean).slice(0, 15)),
    opt_out_email: input.opt_out_email === 'on', opt_out_sms: input.opt_out_sms === 'on', opt_out_whatsapp: input.opt_out_whatsapp === 'on',
  };
};

async function create(ctx, input) {
  const d = contactSchema(input);
  if (d.email && await knex('crm_contacts').where({ email: d.email }).first('id')) throw E.conflict('CRM_DUPLICATE', 'A contact with this email already exists.');
  const stage = input.stage_id ? (await stages()).find((s) => s.id === Number(input.stage_id)) : await stageByKey('new_lead');
  const user = d.email ? await knex('users').where({ email: d.email }).first('id', 'created_at') : null;
  const [id] = await knex('crm_contacts').insert({
    ...d, stage_id: (stage || await stageByKey('new_lead')).id, stage_changed_at: new Date(), owner_user_id: input.owner_user_id ? Number(input.owner_user_id) : ctx.userId,
    user_id: user && !(await knex('crm_contacts').where({ user_id: user.id }).first('id')) ? user.id : null, registered_at: user ? user.created_at : null, created_by: ctx.userId,
  });
  await addActivity(id, { type: 'system', subject: 'Contact created', userId: ctx.userId, meta: { source: d.source } });
  await audit.record(ctx, 'crm.contact_created', { entityType: 'crm_contact', entityId: id });
  return id;
}

async function update(ctx, id, input) {
  const c = await knex('crm_contacts').where({ id }).first();
  if (!c) throw E.notFound('Contact');
  const d = contactSchema({ ...input, kind: input.kind || c.kind, source: input.source || c.source });
  if (d.email && d.email !== c.email && await knex('crm_contacts').where({ email: d.email }).whereNot({ id }).first('id')) throw E.conflict('CRM_DUPLICATE', 'A contact with this email already exists.');
  await knex('crm_contacts').where({ id }).update({ ...d, updated_at: new Date() });
  for (const ch of ['email', 'sms', 'whatsapp']) {
    if (Boolean(c[`opt_out_${ch}`]) !== d[`opt_out_${ch}`]) await addActivity(id, { type: 'system', subject: d[`opt_out_${ch}`] ? `Opted out of ${ch}` : `Opted back in to ${ch}`, userId: ctx.userId });
  }
  await audit.record(ctx, 'crm.contact_updated', { entityType: 'crm_contact', entityId: id });
}

async function assign(ctx, id, ownerUserId) {
  const c = await knex('crm_contacts').where({ id }).first();
  if (!c) throw E.notFound('Contact');
  const owner = ownerUserId ? await knex('users').where({ id: Number(ownerUserId), is_super_admin: true }).first('id', 'name') : null;
  if (ownerUserId && !owner) throw E.validation({ owner_user_id: 'Choose a member of the RemoteWay team.' });
  await knex('crm_contacts').where({ id }).update({ owner_user_id: owner ? owner.id : null, updated_at: new Date() });
  await addActivity(id, { type: 'assigned', subject: owner ? `Assigned to ${owner.name}` : 'Unassigned', userId: ctx.userId });
}

async function remove(ctx, id) {
  await knex('crm_contacts').where({ id }).del();
  await audit.record(ctx, 'crm.contact_deleted', { entityType: 'crm_contact', entityId: id });
}

const listBase = () => knex('crm_contacts as c').join('crm_stages as s', 's.id', 'c.stage_id').leftJoin('users as o', 'o.id', 'c.owner_user_id').leftJoin('users as lc', 'lc.id', 'c.last_contact_by')
  .select('c.*', 's.key as stage_key', 's.name as stage_name', 's.name_ar as stage_name_ar', 's.color as stage_color', 'o.name as owner_name', 'lc.name as last_contact_by_name');

function applyFilters(q, f = {}) {
  const text = str(f.q, 100);
  if (text) q.where((w) => w.where('c.name', 'like', `%${text}%`).orWhere('c.email', 'like', `%${text}%`).orWhere('c.phone', 'like', `%${text.replace(/\D/g, '') || text}%`).orWhere('c.company_name', 'like', `%${text}%`));
  if (f.stage_id) q.where('c.stage_id', Number(f.stage_id));
  if (f.owner === 'none') q.whereNull('c.owner_user_id'); else if (f.owner) q.where('c.owner_user_id', Number(f.owner));
  if (SOURCES.includes(f.source)) q.where('c.source', f.source);
  if (KINDS.includes(f.kind)) q.where('c.kind', f.kind);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(f.from || ''))) q.where('c.created_at', '>=', new Date(`${f.from}T00:00:00Z`));
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(f.to || ''))) q.where('c.created_at', '<=', new Date(`${f.to}T23:59:59Z`));
  if (f.follow === 'due') q.where('c.next_follow_up_at', '<=', new Date());
  if (f.follow === 'none') q.whereNull('c.next_follow_up_at');
  return q;
}

async function list(f = {}, { page = 1, perPage = 50 } = {}) {
  const base = applyFilters(listBase(), f);
  const [{ n }] = await base.clone().clearSelect().count({ n: 'c.id' });
  const sort = { name: 'c.name', last_contact: 'c.last_contact_at', follow_up: 'c.next_follow_up_at', created: 'c.created_at' }[f.sort] || 'c.updated_at';
  const items = await base.orderBy(sort, f.sort === 'name' || f.sort === 'follow_up' ? 'asc' : 'desc').limit(perPage).offset((Math.max(1, page) - 1) * perPage);
  return { total: Number(n), page, perPage, items: items.map((c) => ({ ...c, tags: parse(c.tags, []) })) };
}

async function get(id) {
  const c = await listBase().where('c.id', id).first();
  if (!c) throw E.notFound('Contact');
  c.tags = parse(c.tags, []);
  c.ai_summary = parse(c.ai_summary, null);
  const [activities, followups] = await Promise.all([
    knex('crm_activities as a').leftJoin('users as u', 'u.id', 'a.user_id').where('a.contact_id', id).orderBy('a.created_at', 'desc').orderBy('a.id', 'desc').limit(300).select('a.*', 'u.name as user_name'),
    knex('crm_followups as f').leftJoin('users as u', 'u.id', 'f.assigned_to').where('f.contact_id', id).orderByRaw("FIELD(f.status, 'open', 'done', 'cancelled')").orderBy('f.due_at').select('f.*', 'u.name as assignee_name'),
  ]);
  c.activities = activities.map((a) => ({ ...a, meta: parse(a.meta, {}) }));
  c.followups = followups;
  c.signals = await signals(c);
  return c;
}

/** What the platform knows about this person (for the team and for AI insights). */
async function signals(c) {
  const out = { last_login_at: null, profile_completion: null, applications: 0, company: null, plan: null, sub_status: null, invoices_open: 0, invoices_paid: 0, inbound: 0, outbound: 0 };
  if (c.user_id) {
    const u = await knex('users').where({ id: c.user_id }).first('last_login_at', 'created_at', 'status');
    out.last_login_at = u?.last_login_at || null;
    const p = await knex('talent_profiles').where({ user_id: c.user_id }).first('completion', 'slug');
    if (p) { out.profile_completion = p.completion; out.profile_slug = p.slug; }
    out.applications = Number((await knex('applications as a').join('candidates as ca', 'ca.id', 'a.candidate_id').where('ca.user_id', c.user_id).count({ n: '*' }))[0].n);
  }
  if (c.organization_id) {
    const o = await knex('organizations as o').leftJoin('subscriptions as s', 's.organization_id', 'o.id').leftJoin('plans as p', 'p.id', 's.plan_id').where('o.id', c.organization_id)
      .first('o.name', 's.status as sub_status', 'p.name as plan_name', 's.trial_ends_at');
    if (o) { out.company = o.name; out.plan = o.plan_name; out.sub_status = o.sub_status; out.trial_ends_at = o.trial_ends_at; }
    const inv = await knex('invoices').where({ organization_id: c.organization_id }).groupBy('status').select('status').count({ n: '*' });
    for (const r of inv) { if (r.status === 'issued') out.invoices_open = Number(r.n); if (r.status === 'paid') out.invoices_paid = Number(r.n); }
    out.employees = Number((await knex('employees').where({ organization_id: c.organization_id }).whereNot('status', 'terminated').count({ n: '*' }))[0].n);
  }
  const dirs = await knex('crm_activities').where({ contact_id: c.id }).whereNotNull('direction').groupBy('direction').select('direction').count({ n: '*' });
  for (const r of dirs) out[r.direction === 'in' ? 'inbound' : 'outbound'] = Number(r.n);
  return out;
}

async function addNote(ctx, id, { type = 'note', body, subject }) {
  if (!(await knex('crm_contacts').where({ id }).first('id'))) throw E.notFound('Contact');
  const t = ['note', 'call', 'meeting'].includes(type) ? type : 'note';
  const text = str(body, 10000);
  if (!text) throw E.validation({ body: 'Write the note or a summary of the call.' });
  await addActivity(id, { type: t, channel: t === 'call' ? 'phone' : t === 'meeting' ? 'meeting' : null, direction: t === 'note' ? null : 'out', subject: str(subject, 200), body: text, userId: ctx.userId });
}

// ---------- Follow-ups ----------
async function refreshNext(contactId, trx = knex) {
  const next = await trx('crm_followups').where({ contact_id: contactId, status: 'open' }).min({ d: 'due_at' }).first();
  await trx('crm_contacts').where({ id: contactId }).update({ next_follow_up_at: next?.d || null });
}

async function addFollowUp(ctx, contactId, input) {
  if (!(await knex('crm_contacts').where({ id: contactId }).first('id'))) throw E.notFound('Contact');
  const due = new Date(String(input.due_at || ''));
  if (Number.isNaN(due.getTime()) || due.getUTCFullYear() < 2000 || due.getUTCFullYear() > 2100) throw E.validation({ due_at: 'Choose the follow-up date and time.' });
  const assignee = input.assigned_to ? await knex('users').where({ id: Number(input.assigned_to), is_super_admin: true }).first('id', 'name') : { id: ctx.userId };
  if (!assignee) throw E.validation({ assigned_to: 'Choose a member of the RemoteWay team.' });
  const [id] = await knex('crm_followups').insert({ contact_id: contactId, assigned_to: assignee.id, due_at: due, note: str(input.note, 2000), remind: input.remind !== 'off', created_by: ctx.userId });
  await addActivity(contactId, { type: 'follow_up', subject: `Follow-up on ${due.toISOString().slice(0, 16).replace('T', ' ')} UTC`, body: str(input.note, 2000), userId: ctx.userId, meta: { followup_id: id, assigned_to: assignee.id } });
  await refreshNext(contactId);
  return id;
}

async function setFollowUpStatus(ctx, followupId, status, note) {
  const f = await knex('crm_followups').where({ id: followupId }).first();
  if (!f) throw E.notFound('Follow-up');
  if (!['done', 'cancelled'].includes(status)) throw E.validation({ status: 'Invalid status.' });
  await knex('crm_followups').where({ id: f.id }).update({ status, completed_at: new Date(), completed_by: ctx.userId });
  await addActivity(f.contact_id, { type: 'follow_up_done', subject: status === 'done' ? 'Follow-up done' : 'Follow-up cancelled', body: str(note, 2000) || f.note, userId: ctx.userId, meta: { followup_id: f.id, status } });
  await refreshNext(f.contact_id);
}

async function followUps({ assignedTo, scope = 'open' } = {}) {
  const q = knex('crm_followups as f').join('crm_contacts as c', 'c.id', 'f.contact_id').leftJoin('users as u', 'u.id', 'f.assigned_to')
    .select('f.*', 'c.name as contact_name', 'c.company_name', 'c.phone', 'c.email', 'u.name as assignee_name').orderBy('f.due_at');
  if (assignedTo) q.where('f.assigned_to', assignedTo);
  if (scope === 'open') q.where('f.status', 'open');
  if (scope === 'overdue') q.where('f.status', 'open').where('f.due_at', '<', new Date());
  return q.limit(300);
}

/** Emails each team member their due follow-ups once (run every 15 minutes). */
async function sendReminders(now = new Date()) {
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  const config = require('../../config'); // eslint-disable-line global-require
  const due = await knex('crm_followups as f').join('crm_contacts as c', 'c.id', 'f.contact_id').join('users as u', 'u.id', 'f.assigned_to')
    .where({ 'f.status': 'open', 'f.remind': true }).whereNull('f.reminded_at').where('f.due_at', '<=', now).select('f.id', 'f.contact_id', 'f.note', 'c.name', 'u.email', 'u.locale').limit(200);
  for (const f of due) {
    await knex('crm_followups').where({ id: f.id }).update({ reminded_at: new Date() });
    if (mailer.enabled()) {
      await mailer.send({ to: f.email, subject: `CRM follow-up: ${f.name}`, html: mailer.layout({ locale: f.locale || 'en', title: `Follow up with ${f.name}`, body: f.note || '', cta: 'Open contact', href: `${config.appUrl}/admin/crm/contacts/${f.contact_id}` }) }).catch(() => {});
    }
  }
  return due.length;
}

// ---------- Platform events → CRM ----------
const RANK = ['new_lead', 'contacted', 'interested', 'follow_up', 'registered', 'expected_to_subscribe', 'subscribed'];
/** Moves forward only (a system event never pulls someone back, and never overrides "not interested" by a person). */
async function advance(contact, key, trx) {
  const cur = (await stages({ all: true })).find((s) => s.id === contact.stage_id);
  const target = await stageByKey(key);
  if (!target || !cur) return;
  const ci = RANK.indexOf(cur.key); const ti = RANK.indexOf(key);
  const movable = ci === -1 ? ['inactive'].includes(cur.key) || (key === 'subscribed') : ci < ti;
  if (movable) await changeStage({ userId: null }, contact.id, target.id, { system: true }, trx);
}

async function upsertForUser(userId, { kind, source, organizationId } = {}, trx = knex) {
  const u = await trx('users').where({ id: userId }).first('id', 'name', 'email', 'created_at', 'locale', 'is_super_admin');
  if (!u || u.is_super_admin) return null;
  let c = await trx('crm_contacts').where({ user_id: u.id }).first();
  if (!c && u.email) c = await trx('crm_contacts').where({ email: u.email }).whereNull('user_id').first();
  if (c) {
    const patch = { user_id: u.id, registered_at: c.registered_at || u.created_at, updated_at: new Date() };
    if (organizationId && !c.organization_id) patch.organization_id = organizationId;
    if (kind && (c.kind === 'lead' || c.kind === 'contact' || (kind === 'company_owner' && c.kind !== 'company_owner') || (kind === 'applicant' && c.kind === 'individual'))) patch.kind = kind;
    await trx('crm_contacts').where({ id: c.id }).update(patch);
    return { ...c, ...patch };
  }
  const reg = await stageByKey('registered');
  const [id] = await trx('crm_contacts').insert({
    user_id: u.id, organization_id: organizationId || null, kind: kind || 'individual', name: u.name, email: u.email, source: source || 'individual_signup',
    stage_id: reg.id, stage_changed_at: new Date(), registered_at: u.created_at, locale: u.locale === 'en' ? 'en' : 'ar',
  });
  return trx('crm_contacts').where({ id }).first();
}

async function ownerContact(organizationId, trx) {
  const o = await trx('organizations').where({ id: organizationId }).first('owner_user_id', 'name', 'phone');
  if (!o) return null;
  const c = await upsertForUser(o.owner_user_id, { kind: 'company_owner', source: 'company_signup', organizationId }, trx);
  if (c && !c.company_name) await trx('crm_contacts').where({ id: c.id }).update({ company_name: o.name, phone: c.phone || (o.phone ? normalizePhone(o.phone) : null) });
  return c;
}

/**
 * One entry point for platform events. Never throws: the CRM must not break sign-up, payments or applications.
 *   company_signup {organizationId} · individual_signup {userId} · profile_completed {userId}
 *   applied {userId, jobTitle, company} · subscription_started {organizationId, invoiceNumber} · subscription_paid {organizationId, invoiceNumber}
 */
async function track(event, data = {}, trx = knex) {
  try {
    // Test companies and their generated accounts (Super Admin → Test environment) stay out of the CRM.
    if (data.userId && await trx('users').where({ id: data.userId }).where('email', 'like', '%.sandbox.remoteway.local').first('id')) return;
    if (data.organizationId && await trx('organizations').where({ id: data.organizationId, is_sandbox: true }).first('id')) return;
    if (event === 'company_signup') {
      const c = await ownerContact(data.organizationId, trx);
      if (c) { await addActivity(c.id, { type: 'registration', channel: 'platform', subject: 'Registered a company workspace', meta: data }, trx); await advance(c, 'registered', trx); }
    } else if (event === 'individual_signup') {
      const c = await upsertForUser(data.userId, { kind: 'individual', source: 'individual_signup' }, trx);
      if (c) { await addActivity(c.id, { type: 'registration', channel: 'platform', subject: 'Created a professional profile', meta: data }, trx); await advance(c, 'registered', trx); }
    } else if (event === 'profile_completed') {
      const c = await upsertForUser(data.userId, {}, trx);
      if (c) await addActivity(c.id, { type: 'profile_completed', channel: 'platform', subject: `Profile ${data.completion}% complete`, meta: data }, trx);
    } else if (event === 'applied') {
      const c = await upsertForUser(data.userId, { kind: 'applicant' }, trx);
      if (c) await addActivity(c.id, { type: 'applied', channel: 'platform', subject: `Applied: ${data.jobTitle} · ${data.company}`, meta: data }, trx);
    } else if (event === 'subscription_started') {
      const c = await ownerContact(data.organizationId, trx);
      if (c) { await addActivity(c.id, { type: 'subscription_started', channel: 'platform', subject: `Invoice ${data.invoiceNumber || ''} issued`.trim(), meta: data }, trx); await advance(c, 'expected_to_subscribe', trx); }
    } else if (event === 'subscription_paid') {
      const c = await ownerContact(data.organizationId, trx);
      if (c) {
        await addActivity(c.id, { type: 'subscription_paid', channel: 'platform', subject: `Paid ${data.invoiceNumber || ''}`.trim(), meta: data }, trx);
        await advance(c, 'subscribed', trx);
        await trx('crm_contacts').where({ id: c.id }).whereNull('subscribed_at').update({ subscribed_at: new Date() });
      }
    }
  } catch (e) {
    console.error('[crm] event', event, e.message); // eslint-disable-line no-console
  }
}

/** Website "book a demo" form → a lead (or an update to an existing contact). */
async function demoRequest(input, { ip } = {}) {
  const d = contactSchema({ ...input, source: 'website_demo', kind: 'lead' });
  let c = d.email ? await knex('crm_contacts').where({ email: d.email }).first() : null;
  if (!c) {
    const stage = await stageByKey('new_lead');
    const [id] = await knex('crm_contacts').insert({ ...d, notes: null, stage_id: stage.id, stage_changed_at: new Date() });
    c = { id };
  }
  const message = [str(input.company_size, 20) ? `Company size: ${input.company_size}` : '', str(input.message, 3000)].filter(Boolean).join('\n');
  await addActivity(c.id, { type: 'demo_request', direction: 'in', channel: 'website', subject: 'Requested a demo', body: message || null, status: 'received', meta: { ip } });
  return c.id;
}

/** Brings every platform user into the CRM (idempotent). Runs once automatically and from a button. */
async function syncAll() {
  let created = 0;
  const members = await knex('users as u').leftJoin('crm_contacts as c', 'c.user_id', 'u.id').whereNull('c.id').where('u.is_super_admin', false).select('u.id', 'u.email');
  for (const u of members) {
    const owned = await knex('organizations').where({ owner_user_id: u.id }).first('id');
    const member = owned ? null : await knex('memberships').where({ user_id: u.id }).first('organization_id');
    const talent = await knex('talent_profiles').where({ user_id: u.id }).first('id');
    const c = await upsertForUser(u.id, owned ? { kind: 'company_owner', source: 'company_signup', organizationId: owned.id }
      : member ? { kind: 'company_user', source: 'company_signup', organizationId: member.organization_id } : { kind: talent ? 'individual' : 'contact', source: 'individual_signup' });
    if (!c) continue; // eslint-disable-line no-continue
    created += 1;
    if (owned) {
      const org = await knex('organizations').where({ id: owned.id }).first('name');
      await knex('crm_contacts').where({ id: c.id }).update({ company_name: org.name });
      const paid = await knex('invoices').where({ organization_id: owned.id, status: 'paid' }).first('id');
      const open = await knex('invoices').where({ organization_id: owned.id, status: 'issued' }).first('id');
      if (paid) await advance(c, 'subscribed'); else if (open) await advance(c, 'expected_to_subscribe');
    }
  }
  const value = JSON.stringify({ synced_at: new Date().toISOString() });
  await knex('platform_settings').insert({ key: 'crm_sync', value }).onConflict('key').merge({ value, updated_at: new Date() });
  return created;
}

async function ensureSynced() {
  if (!(await knex('platform_settings').where({ key: 'crm_sync' }).first('key'))) await syncAll();
}

async function team() {
  return knex('users').where({ is_super_admin: true, status: 'active' }).orderBy('name').select('id', 'name', 'platform_role');
}

module.exports = {
  KINDS, SOURCES, stages, stageByKey, saveStage, reorderStages, deleteStage, invalidateStages, addActivity, changeStage, create, update, assign, remove,
  list, get, signals, addNote, addFollowUp, setFollowUpStatus, followUps, sendReminders, track, demoRequest, syncAll, ensureSynced, team, applyFilters, listBase,
};
