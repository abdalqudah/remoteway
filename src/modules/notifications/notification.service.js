// In-app notifications (+ optional email). Messages are stored as a type + data and
// translated when displayed, so each user reads them in their own language.
const knex = require('../../db/knex');
const mailer = require('../../core/mailer');
const jobs = require('../../core/jobs');

async function notify(organizationId, userIds, type, data = {}, link = null, trx = knex) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(Number))];
  if (!ids.length) return;
  await trx('notifications').insert(ids.map((userId) => ({
    organization_id: organizationId, user_id: userId, type, data: JSON.stringify(data), link,
  })));
  // Email and SMS copies go through the job queue (retried, logged) in the same transaction,
  // so a mail or SMS problem never breaks the action that triggered it.
  if (await mailer.canSendFor(organizationId)) {
    for (const userId of ids) await jobs.enqueue(trx, { organizationId, type: 'email.notification', payload: { userId, type, data, link, organizationId }, maxAttempts: 5 });
  }
  // eslint-disable-next-line global-require
  await require('../integrations/messaging.service').queueSmsForNotification(organizationId, ids, type, data, trx);
}

/** Users in the organization holding a permission (active members only). */
async function usersWithPermission(organizationId, permission, trx = knex) {
  const rows = await trx('user_roles as ur')
    .join('memberships as m', function joinM() { this.on('m.user_id', 'ur.user_id').andOn('m.organization_id', 'ur.organization_id'); })
    .join('role_permissions as rp', 'rp.role_id', 'ur.role_id')
    .join('permissions as p', 'p.id', 'rp.permission_id')
    .where({ 'ur.organization_id': organizationId, 'm.status': 'active', 'p.key': permission })
    .distinct('ur.user_id');
  return rows.map((r) => r.user_id);
}

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v) || {};

async function list(ctx, { limit = 30, unreadOnly = false } = {}) {
  const q = knex('notifications').where({ organization_id: ctx.organizationId, user_id: ctx.userId });
  if (unreadOnly) q.whereNull('read_at');
  const rows = await q.orderBy('id', 'desc').limit(limit);
  return rows.map((r) => ({ ...r, data: parse(r.data) }));
}

async function unreadCount(ctx) {
  const [{ n }] = await knex('notifications').where({ organization_id: ctx.organizationId, user_id: ctx.userId }).whereNull('read_at').count({ n: '*' });
  return Number(n);
}

async function markRead(ctx, id) {
  const q = knex('notifications').where({ organization_id: ctx.organizationId, user_id: ctx.userId }).whereNull('read_at');
  if (id) q.where({ id });
  await q.update({ read_at: new Date() });
}

module.exports = { notify, usersWithPermission, list, unreadCount, markRead };
