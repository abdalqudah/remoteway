// SMS (Taqnyat, Unifonic, Msegat) and chat (Slack, Google Chat incoming webhooks).
// Credentials are stored encrypted; messages go through the job queue and every send is logged.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const jobs = require('../../core/jobs');
const secrets = require('../../core/secrets');
const http = require('../../core/http');
const { E } = require('../../core/errors');
const { translator } = require('../../core/i18n');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');
const { SMS_PROVIDERS, CHAT_PROVIDERS, SMS_EVENTS, EVENTS } = require('./catalog');
const events = require('./events');

const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const maskPhone = (p) => (p ? `${String(p).slice(0, 4)}•••${String(p).slice(-3)}` : null);

/** Phone → international digits (Saudi local numbers 05xxxxxxxx become 9665xxxxxxxx). */
function normalizePhone(raw, countryCode = 'SA') {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (countryCode === 'SA' && /^05\d{8}$/.test(d)) d = `966${d.slice(1)}`;
  else if (countryCode === 'SA' && /^5\d{8}$/.test(d)) d = `966${d}`;
  return /^\d{9,15}$/.test(d) ? d : null;
}

async function assertManage(ctx) {
  if (!ctx.permissions.has('integrations.manage')) throw E.forbidden('integrations.manage');
  await ent.assertFeature(ctx.organizationId, 'integrations');
  await ent.assertCanWrite(ctx.organizationId);
}

async function getSetting(organizationId, kind) {
  const row = await knex('integration_settings').where({ organization_id: organizationId, kind }).first();
  if (!row) return null;
  return { ...row, options: parse(row.options, {}), config: secrets.decrypt(row.config_enc) || {} };
}

/** Public view of a setting: secrets masked. */
async function view(ctx, kind) {
  const s = await getSetting(ctx.organizationId, kind);
  if (!s) return null;
  const masked = Object.fromEntries(Object.entries(s.config).map(([k, v]) => [k, secrets.mask(v)]));
  return { id: s.id, provider: s.provider, is_active: Boolean(s.is_active), options: s.options, masked, updated_at: s.updated_at };
}

// ---------- SMS ----------
const SMS_URLS = {
  taqnyat: 'https://api.taqnyat.sa/v1/messages',
  unifonic: 'https://el.cloud.unifonic.com/rest/SMS/messages',
  msegat: 'https://www.msegat.com/gw/sendsms.php',
};
const smsUrl = (provider) => (process.env.SMS_PROVIDER_BASE_URL ? `${process.env.SMS_PROVIDER_BASE_URL.replace(/\/$/, '')}/${provider}` : SMS_URLS[provider]);

/** Sends one SMS through the provider's HTTP API. Resolves with the provider response; throws on failure. */
async function sendSms(provider, config, sender, to, text) {
  let res;
  if (provider === 'taqnyat') {
    res = await http.request(smsUrl('taqnyat'), { headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` }, body: JSON.stringify({ recipients: [to], body: text, sender }) });
    if (res.status >= 200 && res.status < 300) return res;
  } else if (provider === 'unifonic') {
    const form = new URLSearchParams({ AppSid: config.app_sid, SenderID: sender, Body: text, Recipient: to });
    res = await http.request(smsUrl('unifonic'), { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    const j = parse(res.body, {});
    if (res.status >= 200 && res.status < 300 && (j.success === true || j.success === 'true')) return res;
  } else if (provider === 'msegat') {
    res = await http.request(smsUrl('msegat'), { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userName: config.username, apiKey: config.api_key, numbers: to, userSender: sender, msg: text, msgEncoding: 'UTF8' }) });
    const j = parse(res.body, {});
    if (res.status >= 200 && res.status < 300 && ['1', 'M0000', 1].includes(j.code)) return res;
  } else {
    throw new jobs.PermanentError('Unknown SMS provider.');
  }
  const message = `${SMS_PROVIDERS[provider].name}: HTTP ${res.status} ${String(res.body || '').slice(0, 200)}`;
  // Client errors (bad credentials, unregistered sender) will not fix themselves: no retry.
  if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new jobs.PermanentError(message);
  throw new Error(message);
}

async function saveSms(ctx, input) {
  await assertManage(ctx);
  const provider = input.provider;
  if (!SMS_PROVIDERS[provider]) throw E.validation({ provider: 'Choose a provider.' });
  const existing = await getSetting(ctx.organizationId, 'sms');
  const config = {};
  const errors = {};
  for (const f of SMS_PROVIDERS[provider].fields) {
    const v = String(input[f] || '').trim();
    // Leaving a secret empty keeps the saved one (the form never shows it).
    if (v) config[f] = v.slice(0, 300);
    else if (existing && existing.provider === provider && existing.config[f]) config[f] = existing.config[f];
    else errors[f] = 'Required.';
  }
  const sender = String(input.sender || '').trim();
  if (!sender || sender.length > 11) errors.sender = 'Enter the sender name registered with your provider (up to 11 characters).';
  if (Object.keys(errors).length) throw E.validation(errors);
  const smsEvents = [].concat(input.events ?? []).filter((e) => SMS_EVENTS.includes(e));
  const row = { provider, config_enc: secrets.encrypt(config), options: JSON.stringify({ sender, events: smsEvents }), is_active: input.is_active === 'on' || input.is_active === true, updated_by: ctx.userId };
  await knex('integration_settings').insert({ ...row, organization_id: ctx.organizationId, kind: 'sms' }).onConflict(['organization_id', 'kind']).merge({ ...row, updated_at: new Date() });
  await audit.record(ctx, 'integration.sms_updated', { entityType: 'integration', newValues: { provider, active: row.is_active } });
}

/** Sends a test SMS immediately and returns the outcome (does not use the queue, so the admin sees the result). */
async function testSms(ctx, phone) {
  await assertManage(ctx);
  const s = await getSetting(ctx.organizationId, 'sms');
  if (!s) throw E.validation({ phone: 'Save the SMS settings first.' });
  const org = await orgs.get(ctx.organizationId);
  const to = normalizePhone(phone, org.country_code);
  if (!to) throw E.validation({ phone: 'Enter a valid mobile number.' });
  try {
    await sendSms(s.provider, s.config, s.options.sender, to, `RemoteWay: test message from ${org.name}`);
    await log(ctx.organizationId, 'sms', maskPhone(to), 'Test SMS', null);
    return { ok: true };
  } catch (err) {
    await log(ctx.organizationId, 'sms', maskPhone(to), 'Test SMS', err.message);
    return { ok: false, error: err.message };
  }
}

async function log(organizationId, channel, target, summary, error) {
  await knex('integration_logs').insert({ organization_id: organizationId, channel, target: target ? String(target).slice(0, 190) : null, summary: String(summary || '').slice(0, 255), status: error ? 'failed' : 'sent', error: error ? String(error).slice(0, 500) : null });
}

/** Queues SMS copies of a notification for users who have a phone number, if the organization enabled that type. */
async function queueSmsForNotification(organizationId, userIds, type, data, trx = knex) {
  if (!SMS_EVENTS.includes(type)) return;
  const row = await trx('integration_settings').where({ organization_id: organizationId, kind: 'sms', is_active: true }).first('options');
  if (!row || !(parse(row.options, {}).events || []).includes(type)) return;
  for (const userId of userIds) await jobs.enqueue(trx, { organizationId, type: 'sms.notify', payload: { organizationId, userId, type, data }, maxAttempts: 4 });
}

/** Job handler for notification SMS. */
async function handleSmsNotify({ organizationId, userId, type, data }) {
  const s = await getSetting(organizationId, 'sms');
  if (!s || !s.is_active) return;
  const person = await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where({ 'e.organization_id': organizationId, 'e.user_id': userId }).first('e.phone', 'u.locale');
  const org = await orgs.get(organizationId);
  const to = person && normalizePhone(person.phone, org.country_code);
  if (!to) return; // nobody to text
  const t = translator(person.locale || org.locale);
  const text = `${t('notif.' + type, data)} — RemoteWay`.slice(0, 300);
  try {
    await sendSms(s.provider, s.config, s.options.sender, to, text);
    await log(organizationId, 'sms', maskPhone(to), type, null);
  } catch (err) {
    await log(organizationId, 'sms', maskPhone(to), type, err.message);
    throw err;
  }
}

// ---------- Chat ----------
function validateChatUrl(provider, url) {
  const check = http.validateUrl(url);
  if (check.error) return check.error;
  if (process.env.INTEGRATIONS_ALLOW_PRIVATE !== 'true' && check.url.hostname !== CHAT_PROVIDERS[provider].host) return 'Use the incoming-webhook URL copied from the provider.';
  return null;
}

async function saveChat(ctx, input) {
  await assertManage(ctx);
  const provider = input.provider;
  if (!CHAT_PROVIDERS[provider]) throw E.validation({ provider: 'Choose a provider.' });
  const existing = await getSetting(ctx.organizationId, 'chat');
  let url = String(input.url || '').trim();
  if (!url && existing && existing.provider === provider) url = existing.config.url;
  const errors = {};
  const urlError = validateChatUrl(provider, url);
  if (urlError) errors.url = urlError;
  const evts = [].concat(input.events ?? []).filter((e) => EVENTS.includes(e));
  if (!evts.length) errors.events = 'Choose at least one event.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const row = { provider, config_enc: secrets.encrypt({ url }), options: JSON.stringify({ events: evts }), is_active: input.is_active === 'on' || input.is_active === true, updated_by: ctx.userId };
  await knex('integration_settings').insert({ ...row, organization_id: ctx.organizationId, kind: 'chat' }).onConflict(['organization_id', 'kind']).merge({ ...row, updated_at: new Date() });
  events.invalidate(ctx.organizationId);
  await audit.record(ctx, 'integration.chat_updated', { entityType: 'integration', newValues: { provider, active: row.is_active } });
}

async function postChat(provider, url, text) {
  const res = await http.request(url, { headers: { 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text }) });
  if (res.status >= 200 && res.status < 300) return res;
  const message = `${CHAT_PROVIDERS[provider].name}: HTTP ${res.status} ${String(res.body || '').slice(0, 200)}`;
  if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new jobs.PermanentError(message);
  throw new Error(message);
}

async function testChat(ctx) {
  await assertManage(ctx);
  const s = await getSetting(ctx.organizationId, 'chat');
  if (!s) throw E.validation({ url: 'Save the chat settings first.' });
  const org = await orgs.get(ctx.organizationId);
  try {
    await postChat(s.provider, s.config.url, `✅ RemoteWay is connected to ${org.name}.`);
    await log(ctx.organizationId, 'chat', CHAT_PROVIDERS[s.provider].name, 'Test message', null);
    return { ok: true };
  } catch (err) {
    await log(ctx.organizationId, 'chat', CHAT_PROVIDERS[s.provider].name, 'Test message', err.message);
    return { ok: false, error: err.message };
  }
}

/** Job handler: a short message about an event, in the organization's language. */
async function handleChatPost({ organizationId, action, userId, subject, text: custom }) {
  const s = await getSetting(organizationId, 'chat');
  if (!s || !s.is_active) return;
  const org = await orgs.get(organizationId);
  const t = translator(org.locale);
  const user = userId ? await knex('users').where({ id: userId }).first('name') : null;
  const verb = t(`audit.${action}`);
  // Automations send their own message text; events describe the action.
  const text = custom || `*${user ? user.name : 'RemoteWay'}* ${verb === `audit.${action}` ? action : verb}${subject ? ` · ${subject}` : ''}`;
  try {
    await postChat(s.provider, s.config.url, text.slice(0, 1000));
    await log(organizationId, 'chat', CHAT_PROVIDERS[s.provider].name, action, null);
  } catch (err) {
    await log(organizationId, 'chat', CHAT_PROVIDERS[s.provider].name, action, err.message);
    throw err;
  }
}

async function disable(ctx, kind) {
  await assertManage(ctx);
  await knex('integration_settings').where({ organization_id: ctx.organizationId, kind }).del();
  events.invalidate(ctx.organizationId);
  await audit.record(ctx, `integration.${kind}_removed`, { entityType: 'integration' });
}

async function logs(ctx, channel) {
  return knex('integration_logs').where({ organization_id: ctx.organizationId, channel }).orderBy('id', 'desc').limit(20);
}

module.exports = {
  normalizePhone, getSetting, view, sendSms, saveSms, testSms, queueSmsForNotification, handleSmsNotify,
  saveChat, testChat, handleChatPost, postChat, disable, logs, log,
};
