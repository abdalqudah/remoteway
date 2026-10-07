// CRM communication centre: email (platform mailer), SMS (Taqnyat / Unifonic / Msegat, the same
// adapters companies use) and WhatsApp Business (Meta Cloud API) — with incoming WhatsApp messages
// through a signed webhook. Every message is written to the contact's timeline with who sent it.
const crypto = require('crypto');
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const secrets = require('../../core/secrets');
const http = require('../../core/http');
const mailer = require('../../core/mailer');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const messaging = require('../integrations/messaging.service');
const { SMS_PROVIDERS } = require('../integrations/catalog');
const crm = require('./crm.service');

const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const WA_BASE = () => (process.env.WHATSAPP_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, '');

// ---------- Channel settings (Super Admin → CRM → Channels) ----------
async function rawSettings() {
  const row = await knex('platform_settings').where({ key: 'crm_channels' }).first();
  return row ? parse(row.value, {}) : {};
}
function settings() {
  return cache.remember('crm:channels', async () => {
    const s = await rawSettings();
    const out = { sms: null, whatsapp: null };
    if (s.sms && s.sms.config_enc) out.sms = { provider: s.sms.provider, sender: s.sms.sender, config: secrets.decrypt(s.sms.config_enc) || {} };
    if (s.whatsapp && s.whatsapp.token_enc) {
      out.whatsapp = { phone_number_id: s.whatsapp.phone_number_id, api_version: s.whatsapp.api_version || 'v21.0', token: secrets.decrypt(s.whatsapp.token_enc), app_secret: s.whatsapp.app_secret_enc ? secrets.decrypt(s.whatsapp.app_secret_enc) : null, verify_token: s.whatsapp.verify_token };
    }
    return out;
  }, 30_000);
}
const invalidate = () => cache.forgetPrefix('crm:channels');

async function saveChannel(ctx, channel, body) {
  const s = await rawSettings();
  if (body.action === 'remove') { delete s[channel]; } else if (channel === 'sms') {
    const provider = String(body.provider || '');
    if (!SMS_PROVIDERS[provider]) throw E.validation({ provider: 'Choose an SMS provider.' });
    const old = s.sms && s.sms.provider === provider ? secrets.decrypt(s.sms.config_enc) || {} : {};
    const config = {};
    for (const f of SMS_PROVIDERS[provider].fields) {
      config[f] = String(body[f] || '').trim() || old[f] || '';
      if (!config[f]) throw E.validation({ [f]: 'This field is required.' });
    }
    const sender = String(body.sender || '').trim().slice(0, 20);
    if (!sender) throw E.validation({ sender: 'Enter the registered sender name.' });
    s.sms = { provider, sender, config_enc: secrets.encrypt(config) };
  } else if (channel === 'whatsapp') {
    const old = s.whatsapp || {};
    const phoneNumberId = String(body.phone_number_id || '').trim();
    if (!/^\d{5,25}$/.test(phoneNumberId)) throw E.validation({ phone_number_id: 'Enter the Phone number ID from Meta (digits).' });
    const token = String(body.access_token || '').trim() || (old.token_enc ? secrets.decrypt(old.token_enc) : '');
    if (!token) throw E.validation({ access_token: 'Enter the permanent access token.' });
    const appSecret = String(body.app_secret || '').trim() || (old.app_secret_enc ? secrets.decrypt(old.app_secret_enc) : '');
    s.whatsapp = {
      phone_number_id: phoneNumberId, api_version: /^v\d+\.\d+$/.test(String(body.api_version || '')) ? body.api_version : 'v21.0',
      token_enc: secrets.encrypt(token), token_hint: secrets.mask(token), app_secret_enc: appSecret ? secrets.encrypt(appSecret) : null,
      verify_token: old.verify_token || crypto.randomBytes(16).toString('hex'),
    };
  } else throw E.notFound('Channel');
  const value = JSON.stringify(s);
  await knex('platform_settings').insert({ key: 'crm_channels', value }).onConflict('key').merge({ value, updated_at: new Date() });
  invalidate();
  await audit.record(ctx, 'crm.channel_updated', { entityType: 'platform', newValues: { channel, removed: body.action === 'remove' } });
}

// ---------- Placeholders ----------
function render(text, c) {
  const first = String(c.name || '').trim().split(/\s+/)[0] || '';
  const vars = { name: c.name || '', first_name: first, company: c.company_name || '', email: c.email || '' };
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : ''));
}

async function contactFor(id) {
  const c = await knex('crm_contacts').where({ id: Number(id) }).first();
  if (!c) throw E.notFound('Contact');
  return c;
}
const failed = (message) => new AppError('CRM_SEND_FAILED', message, 502, { reason: message });

// ---------- Email ----------
async function sendEmail(ctx, contactId, { subject, body }) {
  const c = await contactFor(contactId);
  if (!c.email) throw E.validation({ email: 'This contact has no email address.' });
  if (c.opt_out_email) throw E.conflict('CRM_OPTED_OUT', 'This contact opted out of this channel.');
  if (!mailer.enabled()) throw E.conflict('CRM_CHANNEL_OFF', 'Email is not set up (Super Admin → Email).');
  const s = render(subject, c).trim().slice(0, 200); const b = render(body, c).trim().slice(0, 10000);
  if (!s || !b) throw E.validation({ body: 'Write a subject and a message.' });
  const sender = await knex('users').where({ id: ctx.userId }).first('name');
  let status = 'sent'; let error = null;
  try {
    await mailer.send({ kind: 'crm_email', to: c.email, subject: s, html: mailer.layout({ locale: c.locale, title: s, body: b }), fromName: sender ? `${sender.name} · RemoteWay` : 'RemoteWay' });
  } catch (e) { status = 'failed'; error = e.message; }
  await crm.addActivity(c.id, { type: 'email', direction: 'out', channel: 'email', subject: s, body: b, status, userId: ctx.userId, meta: error ? { error: String(error).slice(0, 300) } : {} });
  if (status === 'failed') throw failed(error);
}

// ---------- SMS ----------
async function sendSms(ctx, contactId, { body }) {
  const c = await contactFor(contactId);
  if (!c.phone) throw E.validation({ phone: 'This contact has no phone number.' });
  if (c.opt_out_sms) throw E.conflict('CRM_OPTED_OUT', 'This contact opted out of this channel.');
  const cfg = (await settings()).sms;
  if (!cfg) throw E.conflict('CRM_CHANNEL_OFF', 'SMS is not set up (CRM → Channels).');
  const text = render(body, c).trim().slice(0, 900);
  if (!text) throw E.validation({ body: 'Write the message.' });
  let status = 'sent'; let error = null;
  try { await messaging.sendSms(cfg.provider, cfg.config, cfg.sender, c.phone, text); } catch (e) { status = 'failed'; error = e.message; }
  await crm.addActivity(c.id, { type: 'sms', direction: 'out', channel: 'sms', body: text, status, userId: ctx.userId, meta: error ? { error: String(error).slice(0, 300), provider: cfg.provider } : { provider: cfg.provider } });
  if (status === 'failed') throw failed(error);
}

// ---------- WhatsApp (Meta Cloud API) ----------
/** WhatsApp allows free text only within 24 hours of the person's last message; otherwise an approved template. */
function inWindow(c) { return Boolean(c.last_inbound_at && Date.now() - new Date(c.last_inbound_at).getTime() < 24 * 3600_000); }

async function sendWhatsApp(ctx, contactId, { body, template_id: templateId }) {
  const c = await contactFor(contactId);
  if (!c.phone) throw E.validation({ phone: 'This contact has no phone number.' });
  if (c.opt_out_whatsapp) throw E.conflict('CRM_OPTED_OUT', 'This contact opted out of this channel.');
  const cfg = (await settings()).whatsapp;
  if (!cfg) throw E.conflict('CRM_CHANNEL_OFF', 'WhatsApp is not connected (CRM → Channels).');
  const tpl = templateId ? await knex('crm_templates').where({ id: Number(templateId), channel: 'whatsapp' }).first() : null;
  let payload; let text;
  if (tpl && tpl.wa_template) {
    text = render(tpl.body, c);
    payload = { messaging_product: 'whatsapp', to: c.phone, type: 'template', template: { name: tpl.wa_template, language: { code: tpl.wa_language || 'ar' } } };
    if (/\{\{\s*1\s*\}\}/.test(tpl.body)) payload.template.components = [{ type: 'body', parameters: [{ type: 'text', text: String(c.name || '').split(/\s+/)[0] || c.name }] }];
  } else {
    if (!inWindow(c)) throw E.conflict('CRM_WA_TEMPLATE_REQUIRED', 'This person has not written in the last 24 hours. WhatsApp only allows an approved template message now.');
    text = render(tpl ? tpl.body : body, c).trim().slice(0, 4000);
    if (!text) throw E.validation({ body: 'Write the message.' });
    payload = { messaging_product: 'whatsapp', to: c.phone, type: 'text', text: { body: text, preview_url: true } };
  }
  let status = 'sent'; let error = null; let waId = null;
  try {
    const res = await http.request(`${WA_BASE()}/${cfg.api_version}/${cfg.phone_number_id}/messages`, { headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` }, body: JSON.stringify(payload), timeoutMs: 20_000 });
    const j = parse(res.body, {});
    if (res.status >= 300 || !j.messages) throw new Error((j.error && j.error.message) || `WhatsApp returned HTTP ${res.status}`);
    waId = j.messages[0].id;
  } catch (e) { status = 'failed'; error = e.message; }
  await crm.addActivity(c.id, { type: 'whatsapp', direction: 'out', channel: 'whatsapp', body: text, status, userId: ctx.userId, meta: { wa_id: waId, template: tpl ? tpl.wa_template : null, error: error ? String(error).slice(0, 300) : undefined } });
  if (status === 'failed') throw failed(error);
}

/** Meta webhook verification handshake (GET). */
async function verifyWebhook(query) {
  const cfg = (await settings()).whatsapp;
  if (cfg && query['hub.mode'] === 'subscribe' && query['hub.verify_token'] && query['hub.verify_token'] === cfg.verify_token) return String(query['hub.challenge'] || '');
  return null;
}

/** Incoming messages and delivery statuses (POST), authenticated with the app secret signature. */
async function receiveWebhook(rawBody, signature) {
  const cfg = (await settings()).whatsapp;
  if (!cfg || !cfg.app_secret) return { ok: false, reason: 'not_configured' };
  const expected = `sha256=${crypto.createHmac('sha256', cfg.app_secret).update(rawBody || '').digest('hex')}`;
  const a = Buffer.from(String(signature || '')); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  const body = parse(rawBody && rawBody.toString('utf8'), {});
  let received = 0;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = Object.fromEntries((v.contacts || []).map((x) => [x.wa_id, x.profile && x.profile.name]));
      for (const m of v.messages || []) {
        const phone = messaging.normalizePhone(m.from);
        if (!phone) continue; // eslint-disable-line no-continue
        if (await knex('crm_activities').where({ type: 'whatsapp', direction: 'in' }).whereRaw("JSON_UNQUOTE(JSON_EXTRACT(meta, '$.wa_id')) = ?", [m.id]).first('id')) continue; // eslint-disable-line no-continue
        let c = await knex('crm_contacts').where({ phone }).first();
        if (!c) {
          const stage = await crm.stageByKey('new_lead');
          const [id] = await knex('crm_contacts').insert({ name: names[m.from] || `+${phone}`, phone, source: 'whatsapp', kind: 'lead', stage_id: stage.id, stage_changed_at: new Date() });
          c = { id };
        }
        const text = m.type === 'text' ? m.text?.body : m.type === 'button' ? m.button?.text : m.type === 'interactive' ? (m.interactive?.button_reply?.title || m.interactive?.list_reply?.title) : `[${m.type}]`;
        await crm.addActivity(c.id, { type: 'whatsapp', direction: 'in', channel: 'whatsapp', body: text || `[${m.type}]`, status: 'received', meta: { wa_id: m.id }, at: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date() });
        received += 1;
      }
      for (const st of v.statuses || []) {
        if (['delivered', 'read', 'failed'].includes(st.status)) {
          await knex('crm_activities').where({ type: 'whatsapp', direction: 'out' }).whereRaw("JSON_UNQUOTE(JSON_EXTRACT(meta, '$.wa_id')) = ?", [st.id]).update({ status: st.status });
        }
      }
    }
  }
  return { ok: true, received };
}

// ---------- Templates ----------
async function saveTemplate(ctx, id, input) {
  const channel = ['email', 'sms', 'whatsapp'].includes(input.channel) ? input.channel : null;
  const name = String(input.name || '').trim().slice(0, 120); const body = String(input.body || '').trim().slice(0, 5000);
  if (!channel) throw E.validation({ channel: 'Choose a channel.' });
  if (!name || !body) throw E.validation({ name: !name ? 'Enter a name.' : undefined, body: !body ? 'Write the message.' : undefined });
  const row = { channel, name, body, subject: channel === 'email' ? String(input.subject || '').trim().slice(0, 200) || null : null,
    wa_template: channel === 'whatsapp' ? String(input.wa_template || '').trim().slice(0, 120) || null : null, wa_language: channel === 'whatsapp' ? String(input.wa_language || 'ar').slice(0, 10) : null };
  if (id) await knex('crm_templates').where({ id }).update({ ...row, updated_at: new Date() });
  else await knex('crm_templates').insert({ ...row, created_by: ctx.userId });
}
const templates = () => knex('crm_templates').orderBy('channel').orderBy('name');

async function status() {
  const s = await settings();
  return { email: mailer.enabled(), sms: Boolean(s.sms), whatsapp: Boolean(s.whatsapp), smsProvider: s.sms?.provider || null };
}

module.exports = { rawSettings, settings, saveChannel, render, sendEmail, sendSms, sendWhatsApp, verifyWebhook, receiveWebhook, inWindow, saveTemplate, templates, status };
