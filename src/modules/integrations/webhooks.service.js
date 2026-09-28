// Outbound webhooks: endpoints subscribe to events; each delivery is signed with HMAC-SHA256,
// retried with back-off (1m, 5m, 30m, 2h, 12h, 24h) and logged. 15 consecutive failures disable the endpoint.
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const jobs = require('../../core/jobs');
const secrets = require('../../core/secrets');
const http = require('../../core/http');
const { E } = require('../../core/errors');
const ent = require('../billing/entitlements.service');
const notifications = require('../notifications/notification.service');
const { EVENTS } = require('./catalog');
const events = require('./events');

const DISABLE_AFTER = 15;
const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };

/** Signature header value for a raw body: "t=<unix>,v1=<hex hmac of '<t>.<body>'>". */
function sign(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { timestamp, header: `t=${timestamp},v1=${mac}` };
}

async function assertManage(ctx) {
  if (!ctx.permissions.has('integrations.manage')) throw E.forbidden('integrations.manage');
  await ent.assertFeature(ctx.organizationId, 'integrations');
  await ent.assertCanWrite(ctx.organizationId);
}

function cleanEvents(input) {
  const list = [].concat(input ?? []).map(String);
  if (list.includes('*')) return ['*'];
  return [...new Set(list.filter((e) => EVENTS.includes(e)))];
}

async function list(ctx) {
  const rows = await knex('webhook_endpoints').where({ organization_id: ctx.organizationId }).orderBy('id');
  return rows.map((r) => ({ ...r, events: parse(r.events, []), secret_enc: undefined }));
}

async function get(ctx, id) {
  const ep = await knex('webhook_endpoints').where({ id, organization_id: ctx.organizationId }).first();
  if (!ep) throw E.notFound('Webhook');
  ep.events = parse(ep.events, []);
  ep.secret = secrets.decrypt(ep.secret_enc);
  delete ep.secret_enc;
  ep.deliveries = await knex('webhook_deliveries').where({ endpoint_id: id }).orderBy('id', 'desc').limit(50)
    .select('id', 'event', 'event_id', 'status', 'attempts', 'response_status', 'error', 'duration_ms', 'next_retry_at', 'delivered_at', 'created_at');
  return ep;
}

async function save(ctx, id, input) {
  await assertManage(ctx);
  const errors = {};
  const check = http.validateUrl(input.url);
  if (check.error) errors.url = check.error;
  const evts = cleanEvents(input.events);
  if (!evts.length) errors.events = 'Choose at least one event.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const row = { url: check.url.toString().slice(0, 500), description: input.description ? String(input.description).slice(0, 200) : null, events: JSON.stringify(evts) };
  let endpointId = id ? Number(id) : null;
  if (endpointId) {
    const n = await knex('webhook_endpoints').where({ id: endpointId, organization_id: ctx.organizationId }).update({ ...row, is_active: input.is_active === 'on' || input.is_active === true, ...(input.is_active === 'on' || input.is_active === true ? { failure_count: 0, disabled_reason: null } : {}) });
    if (!n) throw E.notFound('Webhook');
    await audit.record(ctx, 'webhook.updated', { entityType: 'webhook', entityId: endpointId, newValues: { url: row.url } });
  } else {
    const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    [endpointId] = await knex('webhook_endpoints').insert({ ...row, organization_id: ctx.organizationId, secret_enc: secrets.encrypt(secret), is_active: true, created_by: ctx.userId });
    await audit.record(ctx, 'webhook.created', { entityType: 'webhook', entityId: endpointId, newValues: { url: row.url } });
  }
  events.invalidate(ctx.organizationId);
  return endpointId;
}

async function rotateSecret(ctx, id) {
  await assertManage(ctx);
  const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
  const n = await knex('webhook_endpoints').where({ id, organization_id: ctx.organizationId }).update({ secret_enc: secrets.encrypt(secret) });
  if (!n) throw E.notFound('Webhook');
  await audit.record(ctx, 'webhook.secret_rotated', { entityType: 'webhook', entityId: id });
}

async function remove(ctx, id) {
  await assertManage(ctx);
  const n = await knex('webhook_endpoints').where({ id, organization_id: ctx.organizationId }).del();
  if (!n) throw E.notFound('Webhook');
  events.invalidate(ctx.organizationId);
  await audit.record(ctx, 'webhook.deleted', { entityType: 'webhook', entityId: id });
}

/** Queues a "ping" event to one endpoint (works even for events it is not subscribed to). */
async function sendTest(ctx, id) {
  await assertManage(ctx);
  const ep = await knex('webhook_endpoints').where({ id, organization_id: ctx.organizationId }).first();
  if (!ep) throw E.notFound('Webhook');
  const payload = { id: `evt_${crypto.randomUUID().replace(/-/g, '')}`, type: 'ping', created_at: new Date().toISOString(), organization_id: ctx.organizationId, data: { message: 'Hello from RemoteWay' } };
  return knex.transaction(async (trx) => {
    const [deliveryId] = await trx('webhook_deliveries').insert({ organization_id: ctx.organizationId, endpoint_id: id, event: 'ping', event_id: payload.id, payload: JSON.stringify(payload), status: 'pending' });
    await jobs.enqueue(trx, { organizationId: ctx.organizationId, type: 'webhook.deliver', payload: { deliveryId }, maxAttempts: 1 });
    return deliveryId;
  });
}

async function redeliver(ctx, id, deliveryId) {
  await assertManage(ctx);
  const d = await knex('webhook_deliveries').where({ id: deliveryId, endpoint_id: id, organization_id: ctx.organizationId }).first();
  if (!d) throw E.notFound('Delivery');
  await knex.transaction(async (trx) => {
    await trx('webhook_deliveries').where({ id: deliveryId }).update({ status: 'pending', next_retry_at: null });
    await jobs.enqueue(trx, { organizationId: ctx.organizationId, type: 'webhook.deliver', payload: { deliveryId }, maxAttempts: 1 });
  });
}

/** Job handler: one delivery attempt. Throws to trigger a retry. */
async function deliver({ deliveryId }, { job, final }) {
  const d = await knex('webhook_deliveries').where({ id: deliveryId }).first();
  if (!d || d.status === 'success') return;
  const ep = await knex('webhook_endpoints').where({ id: d.endpoint_id }).first();
  if (!ep || (!ep.is_active && d.event !== 'ping')) {
    await knex('webhook_deliveries').where({ id: d.id }).update({ status: 'failed', error: 'Endpoint disabled or removed.', next_retry_at: null });
    return;
  }
  const secret = secrets.decrypt(ep.secret_enc);
  const body = typeof d.payload === 'string' ? d.payload : JSON.stringify(d.payload);
  const sig = sign(secret || '', body);
  let result = null; let error = null;
  try {
    result = await http.request(ep.url, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-remoteway-event': d.event, 'x-remoteway-delivery': d.event_id, 'x-remoteway-signature': sig.header },
    });
  } catch (err) {
    error = err.message;
  }
  const ok = result && result.status >= 200 && result.status < 300;
  const attempts = d.attempts + 1;
  const willRetry = !ok && !final;
  await knex('webhook_deliveries').where({ id: d.id }).update({
    attempts, status: ok ? 'success' : (willRetry ? 'pending' : 'failed'), response_status: result ? result.status : null,
    response_body: result ? result.body.slice(0, 1000) : null, error: ok ? null : String(error || `HTTP ${result.status}`).slice(0, 500),
    duration_ms: result ? result.durationMs : null, delivered_at: ok ? new Date() : null,
    next_retry_at: willRetry ? new Date(Date.now() + jobs.BACKOFF_SECONDS[Math.min(job.attempts - 1, jobs.BACKOFF_SECONDS.length - 1)] * 1000) : null,
  });
  if (d.event === 'ping') { if (!ok) throw new jobs.PermanentError(error || `HTTP ${result.status}`); return; }
  if (ok) {
    await knex('webhook_endpoints').where({ id: ep.id }).update({ failure_count: 0, last_success_at: new Date() });
    return;
  }
  if (!willRetry) {
    // Final failure of this delivery: count it against the endpoint.
    await knex('webhook_endpoints').where({ id: ep.id }).increment('failure_count', 1).update({ last_failure_at: new Date() });
    const fresh = await knex('webhook_endpoints').where({ id: ep.id }).first('failure_count', 'organization_id', 'url');
    if (fresh.failure_count >= DISABLE_AFTER) {
      await knex('webhook_endpoints').where({ id: ep.id }).update({ is_active: false, disabled_reason: `Disabled after ${DISABLE_AFTER} failed deliveries.` });
      events.invalidate(fresh.organization_id);
      const admins = await notifications.usersWithPermission(fresh.organization_id, 'integrations.manage');
      await notifications.notify(fresh.organization_id, admins, 'webhook_disabled', { url: fresh.url }, `/app/settings/integrations/webhooks/${ep.id}`);
    }
  }
  throw new Error(error || `HTTP ${result.status}`);
}

module.exports = { sign, list, get, save, rotateSecret, remove, sendTest, redeliver, deliver, cleanEvents, DISABLE_AFTER };
