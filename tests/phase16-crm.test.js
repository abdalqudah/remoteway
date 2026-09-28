// RemoteWay internal CRM: platform events keep contacts live, manual contacts, customisable pipeline
// with recorded changes, follow-ups and reminders, email / SMS / WhatsApp (incl. signed inbound webhook
// and the 24-hour rule), opt-outs, demo requests, dashboard, AI summaries/insights, team permissions.
process.env.INTEGRATIONS_ALLOW_PRIVATE = 'true';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const h = require('./helpers');
const aiStub = require('./ai-stub');
const secrets = require('../src/core/secrets');
const mailer = require('../src/core/mailer');
const ai = require('../src/modules/ai/ai.service');
const crm = require('../src/modules/crm/crm.service');

let admin; let adminId; let stubAi; let waStub; let smsStub;
const pub = () => h.request(h.getApp());
const contactOf = (email) => h.knex('crm_contacts').where({ email }).first();
const stageKey = async (c) => (await h.knex('crm_stages').where({ id: c.stage_id }).first()).key;
const j = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const acts = (id, type) => h.knex('crm_activities').where({ contact_id: id, ...(type ? { type } : {}) }).orderBy('id');

function recorder(reply) {
  const s = { requests: [] };
  s.server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { s.requests.push({ url: req.url, headers: req.headers, body: b }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply(req, b))); }); });
  return new Promise((r) => s.server.listen(0, '127.0.0.1', () => { s.url = `http://127.0.0.1:${s.server.address().port}`; r(s); }));
}
async function staff(role) {
  const email = `${role}${Date.now()}@rw.test`;
  await h.knex('users').insert({ name: `${role} person`, email, password_hash: await bcrypt.hash('Password#123', 4), is_super_admin: true, platform_role: role });
  return h.login(email, 'Password#123');
}

before(async () => {
  await h.resetDatabase();
  stubAi = await aiStub.start();
  process.env.AI_PROVIDER_BASE_URL = stubAi.url;
  waStub = await recorder(() => ({ messaging_product: 'whatsapp', messages: [{ id: `wamid.${Date.now()}` }] }));
  process.env.WHATSAPP_BASE_URL = waStub.url;
  smsStub = await recorder(() => ({ ok: true }));
  process.env.SMS_PROVIDER_BASE_URL = smsStub.url;
  [adminId] = await h.knex('users').insert({ name: 'Rana Admin', email: `root${Date.now()}@rw.test`, password_hash: await bcrypt.hash('Password#123', 4), is_super_admin: true, platform_role: 'owner' });
  admin = await h.login((await h.knex('users').where({ id: adminId }).first()).email, 'Password#123');
});
after(async () => {
  for (const k of ['AI_PROVIDER_BASE_URL', 'WHATSAPP_BASE_URL', 'SMS_PROVIDER_BASE_URL']) delete process.env[k];
  stubAi.server.close(); waStub.server.close(); smsStub.server.close();
  await h.knex.destroy();
});

describe('Phase 16 — RemoteWay internal CRM', () => {
  let co;
  test('platform events create and move contacts: sign-up → expected to subscribe → subscribed', async () => {
    co = await h.createCompany({ plan: 'business' });
    let c = await contactOf(co.email);
    assert.ok(c, 'company sign-up creates a contact');
    assert.equal(c.kind, 'company_owner');
    assert.equal(c.source, 'company_signup');
    assert.equal(await stageKey(c), 'registered');
    assert.ok(c.company_name);
    assert.equal((await acts(c.id, 'registration')).length, 1);
    const owner = await h.login(co.email, co.password);
    const r = await owner.form('/app/billing/activate', {});
    assert.equal(r.status, 302);
    c = await contactOf(co.email);
    assert.equal(await stageKey(c), 'expected_to_subscribe');
    const inv = await h.knex('invoices').where({ organization_id: co.organizationId, status: 'issued' }).first();
    await admin.form(`/admin/invoices/${inv.id}/paid`, { reference: 'TRX-1' });
    c = await contactOf(co.email);
    assert.equal(await stageKey(c), 'subscribed');
    assert.ok(c.subscribed_at);
    const changes = await acts(c.id, 'stage_change');
    assert.deepEqual(changes.map((a) => j(a.meta).to), ['expected_to_subscribe', 'subscribed']);
    assert.ok(changes.every((a) => a.user_id === null), 'recorded as system changes');
  });

  test('individuals: sign-up, profile completion and applications are tracked', async () => {
    const agent = h.request.agent(h.getApp());
    const page = await agent.get('/join');
    const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    await agent.post('/join').type('form').send({ _csrf: csrf, name: 'Huda Salem', email: 'huda@people.test', password: 'Password#123', terms: 'on' });
    const c = await contactOf('huda@people.test');
    assert.equal(c.kind, 'individual');
    assert.equal(c.source, 'individual_signup');
    assert.equal((await acts(c.id, 'registration')).length, 1);
    await crm.track('profile_completed', { userId: c.user_id, completion: 85 });
    await crm.track('applied', { userId: c.user_id, jobTitle: 'Designer', company: 'Acme' });
    assert.equal((await acts(c.id, 'profile_completed')).length, 1);
    assert.equal((await acts(c.id, 'applied'))[0].subject, 'Applied: Designer · Acme');
    assert.equal((await contactOf('huda@people.test')).kind, 'applicant');
    // A broken event never breaks the platform
    await crm.track('applied', { userId: 999999 });
  });

  test('manual contacts, validation, duplicates, assignment, stage changes (form and board) and notes', async () => {
    let r = await admin.form('/admin/crm/contacts', { name: 'X' });
    assert.equal(r.status, 422, 'email or phone required');
    r = await admin.form('/admin/crm/contacts', { name: 'Majed Lead', email: 'majed@lead.test', phone: '0551234567', company_name: 'Lead Co', source: 'event', kind: 'lead' });
    assert.equal(r.status, 302);
    const c = await contactOf('majed@lead.test');
    assert.equal(c.phone, '966551234567');
    assert.equal(c.owner_user_id, adminId);
    assert.equal((await admin.form('/admin/crm/contacts', { name: 'Dup', email: 'majed@lead.test' })).status, 409);
    const sales = await h.knex('users').insert({ name: 'Sami Sales', email: `sami${Date.now()}@rw.test`, password_hash: 'x', is_super_admin: true, platform_role: 'sales' });
    await admin.form(`/admin/crm/contacts/${c.id}/assign`, { owner_user_id: String(sales[0]) });
    assert.equal((await contactOf('majed@lead.test')).owner_user_id, sales[0]);
    assert.equal((await admin.form(`/admin/crm/contacts/${c.id}/assign`, { owner_user_id: String(co.userId) })).status, 422, 'only team members');
    const interested = await h.knex('crm_stages').where({ key: 'interested' }).first();
    r = await admin.form(`/admin/crm/contacts/${c.id}/stage`, { stage_id: String(interested.id), note: 'Liked the demo' });
    assert.equal(r.status, 302);
    const contacted = await h.knex('crm_stages').where({ key: 'contacted' }).first();
    r = await admin.agent.post(`/admin/crm/contacts/${c.id}/stage`).type('form').set('x-requested-with', 'fetch').set('x-csrf-token', admin.csrf).send({ _csrf: admin.csrf, stage_id: String(contacted.id) });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    const changes = await acts(c.id, 'stage_change');
    assert.equal(changes.length, 2);
    assert.equal(changes[0].body, 'Liked the demo');
    assert.equal(changes[0].user_id, adminId);
    await admin.form(`/admin/crm/contacts/${c.id}/note`, { type: 'call', body: 'Called, wants pricing for 40 people.' });
    const after = await contactOf('majed@lead.test');
    assert.equal(after.last_contact_by, adminId);
    assert.ok(after.last_contact_at);
    const page = await admin.get(`/admin/crm/contacts/${c.id}`);
    assert.match(page.text, /Called, wants pricing/);
    assert.match(page.text, /Liked the demo/);
    const csvRes = await admin.get('/admin/crm/contacts?format=csv');
    assert.match(csvRes.text, /Majed Lead/);
  });

  test('follow-ups: plan, remind once, complete; next follow-up date follows', async () => {
    const c = await contactOf('majed@lead.test');
    await admin.form(`/admin/crm/contacts/${c.id}/followups`, { due_at: '2020-01-01T10:00', note: 'Send the proposal' });
    await admin.form(`/admin/crm/contacts/${c.id}/followups`, { due_at: '2099-01-01T10:00', note: 'Quarterly check-in' });
    let x = await contactOf('majed@lead.test');
    assert.equal(new Date(x.next_follow_up_at).getUTCFullYear(), 2020);
    assert.equal(await crm.sendReminders(), 1);
    assert.equal(await crm.sendReminders(), 0, 'reminded once');
    assert.match((await admin.get('/admin/crm/followups')).text, /Send the proposal/);
    const fu = await h.knex('crm_followups').where({ contact_id: c.id, note: 'Send the proposal' }).first();
    await admin.form(`/admin/crm/followups/${fu.id}/status`, { status: 'done' });
    x = await contactOf('majed@lead.test');
    assert.equal(new Date(x.next_follow_up_at).getUTCFullYear(), 2099);
    assert.equal((await acts(c.id, 'follow_up_done')).length, 1);
  });

  test('email and SMS from the CRM are logged with who sent them; opt-outs block sending', async () => {
    const c = await contactOf('majed@lead.test');
    let r = await admin.form(`/admin/crm/contacts/${c.id}/email`, { subject: 'Hello', body: 'Hi {{first_name}}' });
    assert.equal(r.status, 409, 'email not configured');
    const orig = mailer.enabled;
    mailer.enabled = () => true;
    mailer.testOutbox.length = 0;
    r = await admin.form(`/admin/crm/contacts/${c.id}/email`, { subject: 'Pricing for {{company}}', body: 'Hi {{first_name}}, here is the pricing.' });
    mailer.enabled = orig;
    assert.equal(r.status, 302);
    const m = mailer.testOutbox.pop();
    assert.equal(m.to, 'majed@lead.test');
    assert.equal(m.subject, 'Pricing for Lead Co');
    assert.match(m.html, /Hi Majed/);
    const email = (await acts(c.id, 'email'))[0];
    assert.equal(email.direction, 'out');
    assert.equal(email.user_id, adminId);
    assert.equal(email.status, 'sent');
    // SMS
    r = await admin.form('/admin/crm/settings/channels/sms', { provider: 'taqnyat', token: 'tq-token-123', sender: 'RemoteWay' });
    assert.equal(r.status, 302);
    r = await admin.form(`/admin/crm/contacts/${c.id}/sms`, { body: 'Hi {{first_name}}' });
    assert.equal(r.status, 302);
    const sent = JSON.parse(smsStub.requests.pop().body);
    assert.deepEqual(sent.recipients, ['966551234567']);
    assert.equal(sent.body, 'Hi Majed');
    // Opt-out
    await admin.form(`/admin/crm/contacts/${c.id}`, { name: 'Majed Lead', email: 'majed@lead.test', phone: '+966551234567', company_name: 'Lead Co', opt_out_sms: 'on' });
    assert.equal((await admin.form(`/admin/crm/contacts/${c.id}/sms`, { body: 'Again' })).status, 409);
  });

  test('WhatsApp: template outside the 24-hour window, signed inbound webhook, then free text', async () => {
    let r = await admin.form('/admin/crm/settings/channels/whatsapp', { phone_number_id: '1234567890', access_token: 'EAAG-test-token', app_secret: 'app-secret-1' });
    assert.equal(r.status, 302);
    const settings = j((await h.knex('platform_settings').where({ key: 'crm_channels' }).first()).value);
    assert.ok(!JSON.stringify(settings).includes('EAAG-test-token'), 'token encrypted');
    const c = await contactOf('majed@lead.test');
    r = await admin.form(`/admin/crm/contacts/${c.id}/whatsapp`, { body: 'Hello!' });
    assert.equal(r.status, 409, 'free text needs the 24h window');
    await admin.form('/admin/crm/settings/templates', { channel: 'whatsapp', name: 'Welcome', body: 'Hi {{1}}, welcome to RemoteWay', wa_template: 'welcome_v1', wa_language: 'ar' });
    const tpl = await h.knex('crm_templates').where({ name: 'Welcome' }).first();
    r = await admin.form(`/admin/crm/contacts/${c.id}/whatsapp`, { template_id: String(tpl.id) });
    assert.equal(r.status, 302);
    let sent = JSON.parse(waStub.requests.pop().body);
    assert.equal(sent.type, 'template');
    assert.equal(sent.template.name, 'welcome_v1');
    assert.equal(sent.template.components[0].parameters[0].text, 'Majed');
    assert.equal(sent.to, '966551234567');
    // Verification handshake
    assert.equal((await pub().get(`/webhooks/crm/whatsapp?hub.mode=subscribe&hub.verify_token=${settings.whatsapp.verify_token}&hub.challenge=42`)).text, '42');
    assert.equal((await pub().get('/webhooks/crm/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42')).status, 403);
    // Inbound message (signed)
    const payload = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '966551234567', profile: { name: 'Majed' } }], messages: [{ from: '966551234567', id: 'wamid.in1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Yes, send me the details' } }] } }] }] });
    const sig = `sha256=${crypto.createHmac('sha256', 'app-secret-1').update(payload).digest('hex')}`;
    assert.equal((await pub().post('/webhooks/crm/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', 'sha256=bad').send(payload)).status, 401);
    r = await pub().post('/webhooks/crm/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', sig).send(payload);
    assert.equal(r.status, 200);
    await pub().post('/webhooks/crm/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', sig).send(payload); // duplicate delivery
    const inbound = await h.knex('crm_activities').where({ contact_id: c.id, type: 'whatsapp', direction: 'in' });
    assert.equal(inbound.length, 1, 'deduplicated');
    assert.equal(inbound[0].body, 'Yes, send me the details');
    // Now free text is allowed
    r = await admin.form(`/admin/crm/contacts/${c.id}/whatsapp`, { body: 'Great, here you go {{first_name}}' });
    assert.equal(r.status, 302);
    sent = JSON.parse(waStub.requests.pop().body);
    assert.equal(sent.type, 'text');
    assert.equal(sent.text.body, 'Great, here you go Majed');
    // A message from an unknown number creates a lead
    const p2 = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '966500000001', profile: { name: 'New Person' } }], messages: [{ from: '966500000001', id: 'wamid.in2', type: 'text', text: { body: 'Hi' } }] } }] }] });
    await pub().post('/webhooks/crm/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', `sha256=${crypto.createHmac('sha256', 'app-secret-1').update(p2).digest('hex')}`).send(p2);
    const lead = await h.knex('crm_contacts').where({ phone: '966500000001' }).first();
    assert.equal(lead.source, 'whatsapp');
    assert.equal(lead.name, 'New Person');
  });

  test('website demo requests become leads (with a honeypot against bots)', async () => {
    const agent = h.request.agent(h.getApp());
    const page = await agent.get('/demo');
    const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    let r = await agent.post('/demo').type('form').send({ _csrf: csrf, name: 'Bot', email: 'bot@spam.test', website: 'http://spam' });
    assert.equal(r.status, 200);
    assert.equal(await contactOf('bot@spam.test'), undefined);
    r = await agent.post('/demo').type('form').send({ _csrf: csrf, name: 'Salma Nour', email: 'salma@bigco.test', phone: '0559998877', company_name: 'BigCo', company_size: '51-200', message: 'Payroll for 120 people' });
    assert.match(r.text, /We received your request/);
    const c = await contactOf('salma@bigco.test');
    assert.equal(c.source, 'website_demo');
    assert.equal(await stageKey(c), 'new_lead');
    assert.match((await acts(c.id, 'demo_request'))[0].body, /Payroll for 120 people/);
  });

  test('dashboard with filters, pipeline board, sync of existing users', async () => {
    let r = await admin.get('/admin/crm');
    assert.equal(r.status, 200);
    assert.match(r.text, /Total contacts/);
    assert.match(r.text, /Messages sent/);
    r = await admin.get(`/admin/crm?owner=${adminId}&from=2020-01-01&to=2099-12-31`);
    assert.equal(r.status, 200);
    assert.equal((await admin.get('/admin/crm/pipeline')).status, 200);
    // An existing user without a contact is picked up by sync
    await h.knex('users').insert({ name: 'Old User', email: 'old@user.test', password_hash: 'x' });
    await admin.form('/admin/crm/sync', {});
    assert.ok(await contactOf('old@user.test'));
    const { dashboard } = require('../src/modules/crm/insights.service');
    const d = await dashboard({});
    assert.ok(d.kpis.total >= 5);
    assert.ok(d.kpis.comms_sent >= 3);
    assert.equal(d.kpis.subscribed, 1);
  });

  test('AI: contact summary and pipeline priorities through the existing AI layer', async () => {
    const value = JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5', api_key_enc: secrets.encrypt('sk-test-123'), enabled: true, max_tokens: 1500 });
    await h.knex('platform_settings').insert({ key: 'ai', value }).onConflict('key').merge({ value });
    ai.invalidateConfig();
    const c = await contactOf('majed@lead.test');
    stubAi.requests.length = 0;
    let r = await admin.form(`/admin/crm/contacts/${c.id}/summary`, {});
    assert.equal(r.status, 302);
    assert.ok(!stubAi.requests[0].prompt.includes('majed@lead.test') && !stubAi.requests[0].prompt.includes('551234567'), 'contact details are not sent');
    const x = await contactOf('majed@lead.test');
    assert.equal(j(x.ai_summary).interest_level, 'high');
    assert.match((await admin.get(`/admin/crm/contacts/${c.id}`)).text, /Call to walk through the Business plan/);
    r = await admin.form('/admin/crm/insights', {});
    assert.equal(r.status, 302);
    assert.match((await admin.get('/admin/crm')).text, /Most activity comes from new sign-ups/);
    const log = await h.knex('ai_requests').where({ feature: 'crm' }).whereNull('organization_id');
    assert.equal(log.length, 2);
    // Nothing was changed by the AI
    assert.equal(await stageKey(await contactOf('majed@lead.test')), 'contacted');
  });

  test('team permissions: sales and support use the CRM, only owners/admins change its settings, finance has no access', async () => {
    const sales = await staff('sales');
    assert.equal((await sales.get('/admin/crm')).status, 200);
    assert.equal((await sales.get('/admin/crm/settings')).status, 403);
    const c = await contactOf('salma@bigco.test');
    assert.equal((await sales.form(`/admin/crm/contacts/${c.id}/note`, { body: 'Sent deck' })).status, 302);
    assert.equal((await sales.get('/admin/plans')).status, 403);
    const support = await staff('support');
    assert.equal((await support.get('/admin/crm/contacts')).status, 200);
    const finance = await staff('finance');
    assert.equal((await finance.get('/admin/crm')).status, 403);
    // Companies never see the internal CRM
    const owner = await h.login(co.email, co.password);
    assert.equal((await owner.get('/admin/crm')).status, 403);
  });
});
