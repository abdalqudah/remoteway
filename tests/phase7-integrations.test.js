// Integrations: queue, webhooks (signing, retries, auto-disable), SSRF protection, SMS/chat providers, calendar feeds.
process.env.INTEGRATIONS_ALLOW_PRIVATE = 'true'; // talk to local stub servers in these tests only
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const h = require('./helpers');
const jobs = require('../src/core/jobs');
const secrets = require('../src/core/secrets');
const safeHttp = require('../src/core/http');
const webhooks = require('../src/modules/integrations/webhooks.service');
const messaging = require('../src/modules/integrations/messaging.service');
const calendar = require('../src/modules/integrations/calendar.service');

// A local HTTP server that records requests and answers with a configurable status.
function stub() {
  const s = { requests: [], status: 200, body: '{"ok":true}' };
  s.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { s.requests.push({ method: req.method, url: req.url, headers: req.headers, body }); res.writeHead(s.status, { 'content-type': 'application/json' }); res.end(typeof s.body === 'function' ? s.body(req) : s.body); });
  });
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => { s.url = `http://127.0.0.1:${s.server.address().port}`; resolve(s); }));
}
const drain = async () => { for (let i = 0; i < 5; i += 1) await jobs.runDue({ limit: 50 }); };
const makeDue = () => h.knex('background_jobs').where('status', 'pending').update({ run_at: new Date(Date.now() - 1000) });

describe('Phase 7 — integrations (units)', () => {
  test('secrets round-trip and detect tampering', () => {
    const enc = secrets.encrypt({ token: 'abc' });
    assert.deepEqual(secrets.decrypt(enc), { token: 'abc' });
    assert.equal(secrets.decrypt(`${enc.slice(0, -2)}xx`), null);
    assert.notEqual(secrets.encrypt({ token: 'abc' }), enc); // random IV
  });

  test('SSRF guard rejects private and loopback targets', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.10', '169.254.169.254', '::1', '::ffff:10.0.0.1', 'fd00::1']) assert.ok(safeHttp.isPrivateIp(ip), ip);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!safeHttp.isPrivateIp(ip), ip);
    const saved = process.env.INTEGRATIONS_ALLOW_PRIVATE;
    process.env.INTEGRATIONS_ALLOW_PRIVATE = 'false';
    try {
      assert.ok(safeHttp.validateUrl('http://example.com').error);
      assert.ok(safeHttp.validateUrl('https://127.0.0.1/x').error);
      assert.ok(safeHttp.validateUrl('https://localhost/x').error);
      assert.ok(safeHttp.validateUrl('https://u:p@example.com').error);
      assert.equal(safeHttp.validateUrl('https://hooks.slack.com/services/x').error, undefined);
    } finally { process.env.INTEGRATIONS_ALLOW_PRIVATE = saved; }
  });

  test('webhook signature is HMAC-SHA256 of "timestamp.body"', () => {
    const { header } = webhooks.sign('whsec_abc', '{"a":1}', 1700000000);
    const expected = crypto.createHmac('sha256', 'whsec_abc').update('1700000000.{"a":1}').digest('hex');
    assert.equal(header, `t=1700000000,v1=${expected}`);
  });

  test('phone numbers are normalised to international digits', () => {
    assert.equal(messaging.normalizePhone('0551234567', 'SA'), '966551234567');
    assert.equal(messaging.normalizePhone('+966 55 123 4567', 'SA'), '966551234567');
    assert.equal(messaging.normalizePhone('00971501234567', 'SA'), '971501234567');
    assert.equal(messaging.normalizePhone('12', 'SA'), null);
  });

  test('iCalendar output escapes text and folds long lines at 75 octets', () => {
    const ics = calendar.buildIcs('A, B', [{ uid: 'x@y', allDay: true, start: '2026-10-01', end: '2026-10-02', summary: `إجازة; ${'طويلة '.repeat(30)}` }]);
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(ics, /X-WR-CALNAME:A\\, B/);
    assert.ok(ics.includes('SUMMARY:إجازة\\;'), 'semicolon escaped');
    assert.match(ics, /DTEND;VALUE=DATE:20261003/); // exclusive end date
    for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  });
});

describe('Phase 7 — integrations (end to end)', () => {
  let C; let O; let owner; let other; let emp; let empU; let sink; let smsStub;

  before(async () => {
    await h.resetDatabase();
    C = await h.createCompany({ plan: 'business' });
    O = await h.createCompany({ plan: 'business' });
    owner = await h.login(C.email, C.password);
    other = await h.login(O.email, O.password);
    empU = await h.addMember(C.organizationId, 'employee');
    emp = await h.login(empU.email, empU.password);
    sink = await stub();
    smsStub = await stub();
    process.env.SMS_PROVIDER_BASE_URL = smsStub.url;
  });
  after(async () => { sink.server.close(); smsStub.server.close(); delete process.env.SMS_PROVIDER_BASE_URL; await h.knex.destroy(); });

  let hookId;
  test('only integration admins manage webhooks; Starter plans cannot', async () => {
    assert.equal((await emp.get('/app/settings/integrations')).status, 403);
    const S = await h.createCompany({ plan: 'starter' });
    const s = await h.login(S.email, S.password);
    assert.equal((await s.get('/app/settings/integrations/webhooks/new')).status, 402);
    const bad = await owner.form('/app/settings/integrations/webhooks', { url: 'ftp://nope', events: 'employee.created' });
    assert.equal(bad.status, 422);
    const res = await owner.form('/app/settings/integrations/webhooks', { url: `${sink.url}/hook`, events: ['employee.created', 'leave.requested'] });
    assert.equal(res.status, 302, res.text.slice(0, 200));
    hookId = Number(res.headers.location.match(/webhooks\/(\d+)/)[1]);
    const row = await h.knex('webhook_endpoints').where({ id: hookId }).first();
    assert.match(secrets.decrypt(row.secret_enc), /^whsec_/);
    assert.doesNotMatch(row.secret_enc, /whsec_/); // stored encrypted
    assert.equal((await other.get(`/app/settings/integrations/webhooks/${hookId}`)).status, 404);
  });

  test('events are queued with the action (outbox) and delivered signed', async () => {
    h.cache.clear();
    const e = await h.createEmployee(owner, { first_name: 'Hooked' });
    assert.equal(e.status, 201);
    const delivery = await h.knex('webhook_deliveries').where({ endpoint_id: hookId, event: 'employee.created' }).first();
    assert.ok(delivery, 'delivery queued in the same transaction');
    await drain();
    const req = sink.requests.find((r) => r.headers['x-remoteway-event'] === 'employee.created');
    assert.ok(req, 'delivered');
    const payload = JSON.parse(req.body);
    assert.equal(payload.type, 'employee.created');
    assert.equal(payload.organization_id, C.organizationId);
    assert.equal(payload.data.entity_id, String(e.body.data.id));
    const secret = await webhooks.get({ organizationId: C.organizationId }, hookId).then((x) => x.secret);
    const [t, v1] = req.headers['x-remoteway-signature'].split(',').map((p) => p.split('=')[1]);
    assert.equal(v1, crypto.createHmac('sha256', secret).update(`${t}.${req.body}`).digest('hex'));
    assert.equal((await h.knex('webhook_deliveries').where({ id: delivery.id }).first()).status, 'success');
    // Events the endpoint did not subscribe to are not sent.
    const before = sink.requests.length;
    await owner.form('/app/structure/departments', { name: 'Ops' });
    await drain();
    assert.equal(sink.requests.length, before);
  });

  test('failed deliveries retry with back-off, then count against the endpoint', async () => {
    sink.status = 500;
    await h.createEmployee(owner, { first_name: 'Failing' });
    await drain();
    let d = await h.knex('webhook_deliveries').where({ endpoint_id: hookId }).orderBy('id', 'desc').first();
    assert.equal(d.status, 'pending');
    assert.equal(d.attempts, 1);
    assert.equal(d.response_status, 500);
    const job = await h.knex('background_jobs').where({ type: 'webhook.deliver' }).orderBy('id', 'desc').first();
    assert.ok(new Date(job.run_at) > new Date(Date.now() + 50_000), 'next try about a minute later');
    for (let i = 0; i < 8; i += 1) { await makeDue(); await drain(); }
    d = await h.knex('webhook_deliveries').where({ id: d.id }).first();
    assert.equal(d.status, 'failed');
    assert.equal(d.attempts, 7);
    const ep = await h.knex('webhook_endpoints').where({ id: hookId }).first();
    assert.equal(ep.failure_count, 1);
    // Redeliver once the receiver is fixed.
    sink.status = 200;
    await owner.form(`/app/settings/integrations/webhooks/${hookId}/deliveries/${d.id}/redeliver`, {});
    assert.equal((await h.knex('webhook_deliveries').where({ id: d.id }).first()).status, 'success');
    assert.equal((await h.knex('webhook_endpoints').where({ id: hookId }).first()).failure_count, 0);
  });

  test('an endpoint is switched off after repeated final failures', async () => {
    await h.knex('webhook_endpoints').where({ id: hookId }).update({ failure_count: webhooks.DISABLE_AFTER - 1 });
    sink.status = 503;
    h.cache.clear();
    await h.createEmployee(owner, { first_name: 'LastStraw' });
    for (let i = 0; i < 9; i += 1) { await makeDue(); await drain(); }
    const ep = await h.knex('webhook_endpoints').where({ id: hookId }).first();
    assert.equal(ep.is_active, 0);
    assert.ok(ep.disabled_reason);
    assert.ok(await h.knex('notifications').where({ user_id: C.userId, type: 'webhook_disabled' }).first());
    sink.status = 200;
  });

  test('ping test delivers immediately and reports the result', async () => {
    await h.knex('webhook_endpoints').where({ id: hookId }).update({ is_active: true, failure_count: 0 });
    const n = sink.requests.length;
    await owner.form(`/app/settings/integrations/webhooks/${hookId}/test`, {});
    assert.equal(sink.requests.length, n + 1);
    assert.equal(JSON.parse(sink.requests.at(-1).body).type, 'ping');
  });

  test('SMS: credentials stored encrypted, provider request shape, notifications by SMS', async () => {
    const bad = await owner.form('/app/settings/integrations/sms', { provider: 'taqnyat', sender: 'TooLongSenderName' });
    assert.equal(bad.status, 422);
    const ok = await owner.form('/app/settings/integrations/sms', { provider: 'taqnyat', token: 'tq-secret-token', sender: 'RemoteWay', events: ['leave_rejected', 'leave_approved'], is_active: 'on' });
    assert.equal(ok.status, 302);
    const row = await h.knex('integration_settings').where({ organization_id: C.organizationId, kind: 'sms' }).first();
    assert.doesNotMatch(row.config_enc, /tq-secret-token/);
    // Test SMS hits the provider with the bearer token and JSON body.
    smsStub.status = 201;
    await owner.form('/app/settings/integrations/sms/test', { phone: '0551234567' });
    const r = smsStub.requests.at(-1);
    assert.equal(r.url, '/taqnyat');
    assert.equal(r.headers.authorization, 'Bearer tq-secret-token');
    assert.deepEqual(JSON.parse(r.body), { recipients: ['966551234567'], body: JSON.parse(r.body).body, sender: 'RemoteWay' });
    // A notification of an enabled type is queued as SMS for users with a phone number.
    const e = (await h.createEmployee(owner, { first_name: 'Texted', email: empU.email, phone: '0559876543' })).body.data;
    await messaging.queueSmsForNotification(C.organizationId, [empU.userId], 'leave_approved', { type: 'Annual', days: 2, start: '2026-10-01' });
    await drain();
    const sms = smsStub.requests.at(-1);
    assert.deepEqual(JSON.parse(sms.body).recipients, ['966559876543']);
    assert.ok(e.id);
    // Provider 4xx is permanent (no endless retries) and logged.
    smsStub.status = 401;
    await messaging.queueSmsForNotification(C.organizationId, [empU.userId], 'leave_rejected', { type: 'Annual', days: 1, start: '2026-10-02' });
    await drain();
    const dead = await h.knex('background_jobs').where({ type: 'sms.notify' }).orderBy('id', 'desc').first();
    assert.equal(dead.status, 'dead');
    assert.equal(dead.attempts, 1);
    const log = await h.knex('integration_logs').where({ organization_id: C.organizationId, channel: 'sms', status: 'failed' }).first();
    assert.ok(log);
    assert.doesNotMatch(log.target, /9876543$/); // number is masked
    // Types that were not enabled are not texted.
    const count = smsStub.requests.length;
    await messaging.queueSmsForNotification(C.organizationId, [empU.userId], 'payslip_available', { period: '2026-09' });
    await drain();
    assert.equal(smsStub.requests.length, count);
  });

  test('Unifonic and Msegat request formats', async () => {
    smsStub.status = 200;
    smsStub.body = (req) => (req.url === '/unifonic' ? '{"success":true}' : '{"code":"1","message":"Success"}');
    await messaging.sendSms('unifonic', { app_sid: 'APP123' }, 'RW', '966551234567', 'Hello');
    const u = smsStub.requests.at(-1);
    assert.equal(u.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(u.body)), { AppSid: 'APP123', SenderID: 'RW', Body: 'Hello', Recipient: '966551234567' });
    await messaging.sendSms('msegat', { username: 'me', api_key: 'KEY' }, 'RW', '966551234567', 'Hi');
    assert.deepEqual(JSON.parse(smsStub.requests.at(-1).body), { userName: 'me', apiKey: 'KEY', numbers: '966551234567', userSender: 'RW', msg: 'Hi', msgEncoding: 'UTF8' });
    smsStub.body = '{"code":"M0002","message":"Invalid login"}';
    await assert.rejects(() => messaging.sendSms('msegat', { username: 'me', api_key: 'bad' }, 'RW', '966551234567', 'Hi'));
    smsStub.body = '{"ok":true}';
  });

  test('chat: events post a message to the channel', async () => {
    const res = await owner.form('/app/settings/integrations/chat', { provider: 'slack', url: `${sink.url}/slack`, events: ['employee.created'], is_active: 'on' });
    assert.equal(res.status, 302, res.text.slice(0, 200));
    h.cache.clear();
    await h.createEmployee(owner, { first_name: 'Chatty', last_name: 'Person' });
    await drain();
    const msg = sink.requests.find((r) => r.url === '/slack');
    assert.ok(msg);
    assert.match(JSON.parse(msg.body).text, /Chatty Person/);
  });

  test('calendar feeds: secret URL, revocable, respects permissions', async () => {
    assert.equal((await emp.form('/app/settings/calendar/company_leave', {})).status, 403);
    assert.equal((await emp.form('/app/settings/calendar/personal', {})).status, 302);
    const feeds = await calendar.feeds({ organizationId: C.organizationId, userId: empU.userId });
    const token = feeds.personal.token;
    const anon = h.request(h.getApp());
    const ics = await anon.get(`/calendar/${token}.ics`);
    assert.equal(ics.status, 200);
    assert.match(ics.headers['content-type'], /text\/calendar/);
    assert.match(ics.text, /BEGIN:VCALENDAR/);
    assert.equal((await anon.get('/calendar/cal_doesnotexistdoesnotexist123.ics')).status, 404);
    // Regenerating invalidates the old link; revoking removes it.
    await emp.form('/app/settings/calendar/personal', {});
    assert.equal((await anon.get(`/calendar/${token}.ics`)).status, 404);
    await emp.form('/app/settings/calendar/personal', { action: 'revoke' });
    assert.equal((await h.knex('calendar_tokens').where({ user_id: empU.userId })).length, 0);
    // Leaving the company kills the feed.
    await owner.form('/app/settings/calendar/company_leave', {});
    const ownerToken = (await calendar.feeds({ organizationId: C.organizationId, userId: C.userId })).company_leave.token;
    assert.equal((await anon.get(`/calendar/${ownerToken}.ics`)).status, 200);
    await h.knex('memberships').where({ organization_id: C.organizationId, user_id: C.userId }).update({ status: 'disabled' });
    assert.equal((await anon.get(`/calendar/${ownerToken}.ics`)).status, 404);
    await h.knex('memberships').where({ organization_id: C.organizationId, user_id: C.userId }).update({ status: 'active' });
  });

  test('queue: jobs are claimed once, stuck jobs recover, missing handlers fail permanently', async () => {
    const id = await jobs.enqueue(null, { type: 'no.such.handler' });
    await jobs.runDue();
    const j = await h.knex('background_jobs').where({ id }).first();
    assert.equal(j.status, 'dead');
    const stuck = await jobs.enqueue(null, { type: 'maintenance.prune' });
    await h.knex('background_jobs').where({ id: stuck }).update({ status: 'running', locked_at: new Date(Date.now() - 20 * 60_000) });
    await jobs.runDue();
    assert.equal((await h.knex('background_jobs').where({ id: stuck }).first()).status, 'done');
    // A job already taken by another worker is skipped.
    const taken = await jobs.enqueue(null, { type: 'maintenance.prune' });
    const row = await h.knex('background_jobs').where({ id: taken }).first();
    await h.knex('background_jobs').where({ id: taken }).update({ status: 'running', locked_at: new Date() });
    assert.equal(await jobs.runOne(row), null);
  });
});
