// CRM dashboard figures and insights. Rules always produce the lists; the existing AI layer (platform
// budget) can summarise a contact's history and explain priorities. The AI only suggests — the team acts.
const knex = require('../../db/knex');
const { z } = require('../../core/validate');
const ai = require('../ai/ai.service');
const crm = require('./crm.service');

const DAY = 86_400_000;
const range = (f) => ({
  from: /^\d{4}-\d{2}-\d{2}$/.test(String(f.from || '')) ? new Date(`${f.from}T00:00:00Z`) : new Date(Date.now() - 30 * DAY),
  to: /^\d{4}-\d{2}-\d{2}$/.test(String(f.to || '')) ? new Date(`${f.to}T23:59:59Z`) : new Date(),
});
const n = (rows) => Number((rows && rows[0] && (rows[0].n ?? Object.values(rows[0])[0])) || 0);

function scoped(f) {
  const q = knex('crm_contacts as c');
  if (f.owner === 'none') q.whereNull('c.owner_user_id'); else if (f.owner) q.where('c.owner_user_id', Number(f.owner));
  if (f.source) q.where('c.source', String(f.source));
  if (f.stage_id) q.where('c.stage_id', Number(f.stage_id));
  return q;
}

async function dashboard(f = {}) {
  const { from, to } = range(f);
  const stages = await crm.stages({ all: true });
  const id = (k) => (stages.find((s) => s.key === k) || {}).id || -1;
  const [total, newContacts, registrations, subscribedInRange, byStageRows, followOpen, followOverdue, commsRows, bySourceRows, byOwnerRows, weekly] = await Promise.all([
    scoped(f).count({ n: '*' }),
    scoped(f).whereBetween('c.created_at', [from, to]).count({ n: '*' }),
    scoped(f).whereBetween('c.registered_at', [from, to]).count({ n: '*' }),
    scoped(f).whereBetween('c.subscribed_at', [from, to]).count({ n: '*' }),
    scoped(f).groupBy('c.stage_id').select('c.stage_id').count({ n: '*' }),
    knex('crm_followups as fu').join('crm_contacts as c', 'c.id', 'fu.contact_id').where('fu.status', 'open').modify((q) => { if (f.owner && f.owner !== 'none') q.where('fu.assigned_to', Number(f.owner)); }).count({ n: '*' }),
    knex('crm_followups as fu').where('fu.status', 'open').where('fu.due_at', '<', new Date()).modify((q) => { if (f.owner && f.owner !== 'none') q.where('fu.assigned_to', Number(f.owner)); }).count({ n: '*' }),
    knex('crm_activities as a').where('a.direction', 'out').whereIn('a.channel', ['email', 'sms', 'whatsapp']).whereBetween('a.created_at', [from, to])
      .modify((q) => { if (f.owner && f.owner !== 'none') q.where('a.user_id', Number(f.owner)); }).groupBy('a.channel').select('a.channel').count({ n: '*' }),
    scoped(f).groupBy('c.source').select('c.source').count({ n: '*' }).select(knex.raw('SUM(c.registered_at IS NOT NULL) as registered'), knex.raw(`SUM(c.stage_id = ${Number(id('subscribed'))}) as subscribed`)),
    knex('users as u').where('u.is_super_admin', true).select('u.id', 'u.name',
      knex('crm_contacts').count('*').whereRaw('owner_user_id = u.id').as('owned'),
      knex('crm_contacts').count('*').whereRaw('owner_user_id = u.id').where('stage_id', id('subscribed')).as('subscribed'),
      knex('crm_activities').count('*').whereRaw('user_id = u.id').where('direction', 'out').whereIn('channel', ['email', 'sms', 'whatsapp']).whereBetween('created_at', [from, to]).as('sent'),
      knex('crm_activities').count('*').whereRaw('user_id = u.id').whereIn('type', ['call', 'meeting', 'note']).whereBetween('created_at', [from, to]).as('logged'),
      knex('crm_followups').count('*').whereRaw('assigned_to = u.id').where('status', 'open').as('open_followups')),
    scoped(f).whereBetween('c.created_at', [new Date(Date.now() - 12 * 7 * DAY), new Date()]).select(knex.raw("DATE_FORMAT(c.created_at, '%x-%v') as wk")).count({ n: '*' }).groupBy('wk'),
  ]);
  const byStage = stages.map((s) => ({ ...s, value: Number((byStageRows.find((r) => r.stage_id === s.id) || {}).n || 0) }));
  const count = (k) => (byStage.find((s) => s.key === k) || {}).value || 0;
  const comms = Object.fromEntries(commsRows.map((r) => [r.channel, Number(r.n)]));
  const reg = n(registrations); const sub = n(subscribedInRange);
  // Weekly new contacts (last 12 ISO weeks, gaps filled)
  const weeks = [];
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 7 * DAY);
    const key = isoWeek(d);
    weeks.push({ label: d.toISOString().slice(5, 10), value: Number((weekly.find((w) => w.wk === key) || {}).n || 0) });
  }
  return {
    range: { from, to },
    kpis: {
      total: n(total), new_contacts: n(newContacts), registrations: reg, pending_followups: n(followOpen), overdue_followups: n(followOverdue),
      interested: count('interested'), expected: count('expected_to_subscribe'), subscribed: count('subscribed'), inactive: count('inactive'), not_interested: count('not_interested'),
      comms_sent: Object.values(comms).reduce((a, b) => a + b, 0), subscribed_in_range: sub, conversion_pct: reg ? Math.round((sub / reg) * 1000) / 10 : null,
    },
    comms, byStage, weeks,
    bySource: bySourceRows.map((r) => ({ source: r.source, contacts: Number(r.n), registered: Number(r.registered || 0), subscribed: Number(r.subscribed || 0) })).sort((a, b) => b.contacts - a.contacts),
    byOwner: byOwnerRows.map((r) => ({ id: r.id, name: r.name, owned: Number(r.owned), subscribed: Number(r.subscribed), sent: Number(r.sent), logged: Number(r.logged), open_followups: Number(r.open_followups) })),
  };
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - yearStart) / DAY + 1) / 7);
  return `${t.getUTCFullYear()}-${String(wk).padStart(2, '0')}`;
}

// ---------- Rule-based insight lists ----------
/** Engagement over the last 30 days: inbound messages, platform activity (applications, profile, invoices), recent sign-ins. */
async function scored(limit = 400) {
  const since = new Date(Date.now() - 30 * DAY);
  const rows = await crm.listBase().select(
    knex('crm_activities').count('*').whereRaw('contact_id = c.id').where('direction', 'in').where('created_at', '>=', since).as('inbound_30'),
    knex('crm_activities').count('*').whereRaw('contact_id = c.id').whereIn('type', ['registration', 'profile_completed', 'applied', 'subscription_started', 'subscription_paid', 'demo_request']).where('created_at', '>=', since).as('events_30'),
    knex('users').select('last_login_at').whereRaw('id = c.user_id').as('last_login_at'),
  ).orderBy('c.updated_at', 'desc').limit(limit);
  const now = Date.now();
  return rows.map((c) => {
    const days = (d) => (d ? Math.floor((now - new Date(d).getTime()) / DAY) : null);
    const loginDays = days(c.last_login_at);
    const score = Math.min(100, Number(c.inbound_30) * 15 + Number(c.events_30) * 12 + (loginDays != null && loginDays <= 7 ? 25 : loginDays != null && loginDays <= 30 ? 10 : 0) + (c.stage_key === 'interested' ? 10 : 0) + (c.stage_key === 'expected_to_subscribe' ? 20 : 0));
    return { ...c, score, login_days: loginDays, contact_days: days(c.last_contact_at), inbound_30: Number(c.inbound_30), events_30: Number(c.events_30) };
  });
}

const OPEN_FUNNEL = ['new_lead', 'contacted', 'interested', 'registered', 'follow_up', 'expected_to_subscribe'];
async function ruleInsights() {
  const list = await scored();
  const now = Date.now();
  return {
    needFollowUp: list.filter((c) => OPEN_FUNNEL.includes(c.stage_key) && ((c.next_follow_up_at && new Date(c.next_follow_up_at).getTime() < now) || (!c.next_follow_up_at && (c.contact_days == null || c.contact_days > 14)))).slice(0, 15),
    mostEngaged: list.filter((c) => c.score >= 25).sort((a, b) => b.score - a.score).slice(0, 15),
    likelyToSubscribe: list.filter((c) => c.stage_key !== 'subscribed' && (c.stage_key === 'expected_to_subscribe' || (c.kind === 'company_owner' && c.score >= 35))).sort((a, b) => b.score - a.score).slice(0, 15),
    disengaged: list.filter((c) => !['subscribed', 'not_interested'].includes(c.stage_key) && c.score === 0 && (c.login_days == null || c.login_days > 30) && (c.contact_days == null || c.contact_days > 30)).slice(0, 15),
  };
}

// ---------- AI ----------
const text = (max) => z.string().trim().max(max);
const summarySchema = z.object({ summary: text(1500).min(1), interest_level: z.enum(['high', 'medium', 'low', 'unknown']).default('unknown'), next_action: text(400).default(''), suggested_message: text(1200).default(''), risks: z.array(text(200)).max(5).default([]) });

async function summarizeContact(ctx, contactId, locale = 'en') {
  const c = await crm.get(Number(contactId));
  const lines = c.activities.slice(0, 60).reverse().map((a) => `[${new Date(a.created_at).toISOString().slice(0, 16).replace('T', ' ')}] ${a.type}${a.direction ? ` (${a.direction})` : ''}${a.channel ? ` via ${a.channel}` : ''}${a.user_name ? ` by team member` : ''}: ${ai.redact(ai.clip([a.subject, a.body].filter(Boolean).join(' — '), 400))}`);
  const s = c.signals;
  const data = [`Stage: ${c.stage_name} | Kind: ${c.kind} | Source: ${c.source}`, `Company: ${c.company_name || '-'} | Plan: ${s.plan || '-'} (${s.sub_status || '-'}) | Employees: ${s.employees ?? '-'}`,
    `Last sign-in: ${s.last_login_at ? new Date(s.last_login_at).toISOString().slice(0, 10) : 'never'} | Profile completion: ${s.profile_completion ?? '-'} | Applications: ${s.applications}`,
    `Messages in/out: ${s.inbound}/${s.outbound} | Open follow-ups: ${c.followups.filter((f) => f.status === 'open').length}`, c.notes ? `Team notes: ${ai.redact(ai.clip(c.notes, 1500))}` : '', '## Timeline (oldest first)', ...lines].filter(Boolean).join('\n');
  const out = await ai.runPlatform(ctx.userId, {
    action: 'crm_contact_summary', entityType: 'crm_contact', entityId: c.id, locale, schema: summarySchema, maxTokens: 1200,
    instructions: 'You help the RemoteWay sales and success team. Summarise this contact\'s relationship with RemoteWay from the timeline. Return {"summary": "what happened so far, 3-5 sentences", "interest_level": "high|medium|low|unknown", "next_action": "the single best next step for the team", "suggested_message": "a short, friendly message the team could send (they will review it)", "risks": ["reasons they might not subscribe"]}. Suggest; never decide.',
    data,
  });
  await knex('crm_contacts').where({ id: c.id }).update({ ai_summary: JSON.stringify(out), ai_summary_at: new Date() });
  return out;
}

const insightSchema = z.object({
  groups: z.array(z.object({ key: z.enum(['need_follow_up', 'most_engaged', 'likely_to_subscribe', 'disengaged']), items: z.array(z.object({ ref: z.string().max(10), reason: text(300), action: text(300).default('') })).max(10).default([]) })).max(4).default([]),
  overview: text(1200).default(''),
});

async function aiInsights(ctx, locale = 'en') {
  const list = (await scored(300)).filter((c) => !['not_interested'].includes(c.stage_key)).sort((a, b) => b.score - a.score).slice(0, 40);
  const refs = list.map((c, i) => [`P${i + 1}`, c]);
  const data = refs.map(([ref, c]) => `${ref}: stage=${c.stage_key}; kind=${c.kind}; source=${c.source}; engagement=${c.score}; inbound_30d=${c.inbound_30}; platform_events_30d=${c.events_30}; last_sign_in_days=${c.login_days ?? 'never'}; last_contact_days=${c.contact_days ?? 'never'}; follow_up_due=${c.next_follow_up_at ? new Date(c.next_follow_up_at).toISOString().slice(0, 10) : 'none'}; company=${c.company_name ? 'yes' : 'no'}`).join('\n');
  const out = await ai.runPlatform(ctx.userId, {
    action: 'crm_pipeline_insights', locale, schema: insightSchema, maxTokens: 2000,
    instructions: 'You help the RemoteWay team prioritise their CRM. From these anonymised contacts return {"overview": "2-3 sentences on the pipeline", "groups": [{"key": "need_follow_up" | "most_engaged" | "likely_to_subscribe" | "disengaged", "items": [{"ref": "P1", "reason": "why", "action": "suggested next step"}]}]} with at most 8 people per group. Only suggest actions; the team decides.',
    data,
  });
  const byRef = Object.fromEntries(refs);
  const result = { overview: out.overview, groups: out.groups.map((g) => ({ key: g.key, items: g.items.filter((i) => byRef[i.ref]).map((i) => ({ contact: { id: byRef[i.ref].id, name: byRef[i.ref].name, stage_name: byRef[i.ref].stage_name, stage_color: byRef[i.ref].stage_color }, reason: i.reason, action: i.action })) })) };
  const value = JSON.stringify({ at: new Date().toISOString(), by: ctx.userId, result });
  await knex('platform_settings').insert({ key: 'crm_ai_insights', value }).onConflict('key').merge({ value, updated_at: new Date() });
  return result;
}

async function lastAiInsights() {
  const row = await knex('platform_settings').where({ key: 'crm_ai_insights' }).first();
  if (!row) return null;
  return typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
}

module.exports = { dashboard, ruleInsights, scored, summarizeContact, aiInsights, lastAiInsights };
