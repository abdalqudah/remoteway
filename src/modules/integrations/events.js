// Turns audit actions into outbound integration work (webhook deliveries, chat messages) inside the
// same transaction as the action — an "outbox": if the action rolls back, nothing is sent.
const crypto = require('crypto');
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const jobs = require('../../core/jobs');
const { EVENTS } = require('./catalog');

const EVENT_SET = new Set(EVENTS);
const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };

/** Active webhook endpoints and chat settings for an organization (cached briefly; invalidated on change). */
function targets(organizationId) {
  return cache.remember(`integrations:${organizationId}`, async () => {
    const [endpoints, chat] = await Promise.all([
      knex('webhook_endpoints').where({ organization_id: organizationId, is_active: true }).select('id', 'events'),
      knex('integration_settings').where({ organization_id: organizationId, kind: 'chat', is_active: true }).first('id', 'options'),
    ]);
    return {
      endpoints: endpoints.map((e) => ({ id: e.id, events: parse(e.events, []) })),
      chat: chat ? { events: parse(chat.options, {}).events || [] } : null,
    };
  }, 30_000);
}

const invalidate = (organizationId) => cache.forgetPrefix(`integrations:${organizationId}`);
const matches = (list, event) => list.includes('*') || list.includes(event);

async function dispatch(ctx, action, details, trx) {
  if (!ctx.organizationId || !EVENT_SET.has(action)) return;
  const t = await targets(ctx.organizationId);
  const endpoints = t.endpoints.filter((e) => matches(e.events, action));
  const toChat = t.chat && matches(t.chat.events, action);
  if (!endpoints.length && !toChat) return;
  const payload = {
    id: `evt_${crypto.randomUUID().replace(/-/g, '')}`,
    type: action,
    created_at: new Date().toISOString(),
    organization_id: ctx.organizationId,
    data: { entity_type: details.entityType ?? null, entity_id: details.entityId != null ? String(details.entityId) : null, ...(details.newValues || {}) },
  };
  for (const e of endpoints) {
    const [deliveryId] = await trx('webhook_deliveries').insert({
      organization_id: ctx.organizationId, endpoint_id: e.id, event: action, event_id: payload.id, payload: JSON.stringify(payload), status: 'pending',
    });
    await jobs.enqueue(trx, { organizationId: ctx.organizationId, type: 'webhook.deliver', payload: { deliveryId }, maxAttempts: 7 });
  }
  if (toChat) {
    const subject = details.newValues && (details.newValues.name || details.newValues.title || details.newValues.email) ? String(details.newValues.name || details.newValues.title || details.newValues.email) : '';
    await jobs.enqueue(trx, { organizationId: ctx.organizationId, type: 'chat.post', payload: { organizationId: ctx.organizationId, action, userId: ctx.userId || null, subject }, maxAttempts: 4 });
  }
}

module.exports = { dispatch, invalidate, targets };
