const knex = require('../db/knex');

const SENSITIVE = new Set(['password', 'password_hash', 'token', 'token_hash']);

function scrub(values) {
  if (!values) return null;
  const out = {};
  for (const [k, v] of Object.entries(values)) out[k] = SENSITIVE.has(k) ? '[redacted]' : v;
  return JSON.stringify(out);
}

// Returns only the fields that changed between two records.
function diff(before, after) {
  const oldValues = {};
  const newValues = {};
  for (const key of Object.keys(after)) {
    const a = before?.[key] instanceof Date ? before[key].toISOString().slice(0, 10) : before?.[key];
    const b = after[key];
    if (String(a ?? '') !== String(b ?? '')) {
      oldValues[key] = a ?? null;
      newValues[key] = b ?? null;
    }
  }
  return { oldValues, newValues, changed: Object.keys(newValues).length > 0 };
}

/**
 * @param {object} ctx  { organizationId, userId, ip, userAgent }
 */
async function record(ctx, action, { entityType, entityId, oldValues, newValues } = {}, trx = knex) {
  await trx('audit_logs').insert({
    organization_id: ctx.organizationId ?? null,
    user_id: ctx.userId ?? null,
    action,
    entity_type: entityType ?? null,
    entity_id: entityId != null ? String(entityId) : null,
    old_values: scrub(oldValues),
    new_values: scrub(newValues),
    ip: ctx.ip ? String(ctx.ip).slice(0, 64) : null,
    user_agent: ctx.userAgent ? String(ctx.userAgent).slice(0, 255) : null,
  });
  // Outbound integrations (webhooks, chat) for public events — queued in the same transaction.
  // eslint-disable-next-line global-require
  await require('../modules/integrations/events').dispatch(ctx, action, { entityType, entityId, newValues: newValues ? JSON.parse(scrub(newValues)) : null }, trx);
}

module.exports = { record, diff };
