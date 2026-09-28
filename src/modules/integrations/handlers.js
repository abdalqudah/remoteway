// Registers every job type with the queue. Required once at startup (server, cron script, tests).
const jobs = require('../../core/jobs');
const mailer = require('../../core/mailer');
const webhooks = require('./webhooks.service');
const messaging = require('./messaging.service');

jobs.register('webhook.deliver', webhooks.deliver);
jobs.register('sms.notify', messaging.handleSmsNotify);
jobs.register('chat.post', messaging.handleChatPost);
jobs.register('email.notification', async ({ userId, type, data, link }) => {
  if (!mailer.enabled()) return; // email switched off since the job was queued
  await mailer.sendNotificationEmail(userId, type, data, link);
});
jobs.register('maintenance.prune', async () => {
  await jobs.prune(30);
  // eslint-disable-next-line global-require
  await require('../../db/knex')('webhook_deliveries').where('created_at', '<', new Date(Date.now() - 30 * 86_400_000)).del();
});

module.exports = jobs;
