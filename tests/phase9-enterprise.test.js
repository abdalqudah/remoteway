// Enterprise: SSO (OIDC with real RS256 signatures from a local identity provider), approval workflows,
// reports (templates, builder, saved, scheduled delivery) and the client success portal.
process.env.INTEGRATIONS_ALLOW_PRIVATE = 'true'; // local identity-provider stub
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const h = require('./helpers');
const oidc = require('../src/modules/sso/oidc');
const jobs = require('../src/modules/integrations/handlers');
const mailer = require('../src/core/mailer');
const reports = require('../src/modules/reports/reports.service');

const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function idp() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const s = { claims: {}, requests: [], tokenStatus: 200, signWith: privateKey };
  s.sign = (claims, key = s.signWith) => {
    const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
    const body = b64url(JSON.stringify(claims));
    return `${head}.${body}.${b64url(crypto.sign('sha256', Buffer.from(`${head}.${body}`), key))}`;
  };
  s.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      s.requests.push({ url: req.url, headers: req.headers, body });
      const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/.well-known/openid-configuration') {
        return json(200, { issuer: s.url, authorization_endpoint: `${s.url}/authorize`, token_endpoint: `${s.url}/token`, jwks_uri: `${s.url}/jwks`, token_endpoint_auth_methods_supported: ['client_secret_basic'] });
      }
      if (req.url === '/jwks') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
      if (req.url === '/token') {
        if (s.tokenStatus !== 200) return json(s.tokenStatus, { error: 'invalid_grant' });
        const now = Math.floor(Date.now() / 1000);
        return json(200, { access_token: 'x', token_type: 'Bearer', id_token: s.sign({ iss: s.url, aud: 'client-1', iat: now, exp: now + 300, sub: 'sub-1', ...s.claims }) });
      }
      return json(404, {});
    });
  });
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => { s.url = `http://127.0.0.1:${s.server.address().port}`; resolve(s); }));
}

async function setPlan(organizationId, key) {
  const plan = await h.knex('plans').where({ key }).first();
  await h.knex('subscriptions').where({ organization_id: organizationId }).update({ plan_id: plan.id, status: 'active' });
  h.cache.clear();
}

/** Starts an SSO sign-in and follows it through the identity provider. */
async function ssoLogin(agent, csrf, email, provider, claims) {
  const start = await agent.post('/sso').type('form').send({ _csrf: csrf, email });
  assert.equal(start.status, 200, start.text.slice(0, 300));
  const url = providerUrl(start);
  provider.claims = { email, nonce: url.searchParams.get('nonce'), ...claims };
  return agent.get(`/sso/callback?code=abc&state=${url.searchParams.get('state')}`);
}

/** The provider URL from the hand-off page (Refresh header, same as the Continue link). */
function providerUrl(res) {
  const m = /^0; url=(.+)$/.exec(res.headers.refresh || '');
  assert.ok(m, 'hand-off page with a Refresh header');
  assert.ok(res.text.includes('data-sso-url'));
  return new URL(m[1]);
}

async function anonymous() {
  const agent = h.request.agent(h.getApp());
  const page = await agent.get('/login');
  return { agent, csrf: page.text.match(/name="csrf-token" content="([^"]+)"/)[1] };
}

let provider;
before(async () => {
  await h.resetDatabase();
  provider = await idp();
});
after(async () => {
  provider.server.close();
  await h.knex.destroy();
});

describe('Phase 9 — SSO (OIDC)', () => {
  test('ID tokens are verified: signature, issuer, audience, expiry and nonce', async () => {
    const meta = await oidc.discover(provider.url);
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: provider.url, aud: 'client-1', exp: now + 60, iat: now, sub: 's', nonce: 'n1' };
    assert.equal((await oidc.verifyIdToken(meta, provider.sign(good), { clientId: 'client-1', nonce: 'n1' })).sub, 's');
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const bad = [
      [provider.sign({ ...good, aud: 'someone-else' }), /different application/],
      [provider.sign({ ...good, exp: now - 600 }), /expired/],
      [provider.sign({ ...good, iss: 'https://evil.example' }), /different provider/],
      [provider.sign(good, other), /signature is invalid/],
      [provider.sign({ ...good, nonce: 'other' }), /does not match/],
    ];
    for (const [tok, re] of bad) await assert.rejects(oidc.verifyIdToken(meta, tok, { clientId: 'client-1', nonce: 'n1' }), re);
    assert.equal(oidc.emailFrom({ preferred_username: 'A@Corp.com' }), 'a@corp.com');
  });

  let co; let owner; let member;
  test('setup needs the SSO feature; a successful test sign-in is required before enforcing', async () => {
    co = await h.createCompany({ plan: 'business' });
    owner = await h.login(co.email, co.password);
    const input = { issuer: provider.url, client_id: 'client-1', client_secret: 'secret-1', domains: 'test.local', enabled: 'on', default_role: 'employee' };
    let r = await owner.form('/app/settings/sso', input);
    assert.equal(r.status, 402);
    await setPlan(co.organizationId, 'enterprise');
    r = await owner.form('/app/settings/sso', { ...input, enforce: 'on' });
    assert.equal(r.status, 422, 'enforcing before a test is refused');
    r = await owner.form('/app/settings/sso', input);
    assert.equal(r.status, 302);
    const row = await h.knex('sso_connections').where({ organization_id: co.organizationId }).first();
    assert.ok(row.client_secret_enc && !row.client_secret_enc.includes('secret-1'));
    // Test sign-in with the admin's own account
    const start = await owner.form('/app/settings/sso/test', {});
    const url = providerUrl(start);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    provider.claims = { email: co.email, nonce: url.searchParams.get('nonce') };
    const cb = await owner.get(`/sso/callback?code=abc&state=${url.searchParams.get('state')}`);
    assert.equal(cb.headers.location, '/app/settings/sso');
    assert.ok((await h.knex('sso_connections').where({ organization_id: co.organizationId }).first()).verified_at);
    const tokenReq = provider.requests.find((x) => x.url === '/token');
    assert.equal(tokenReq.headers.authorization, `Basic ${Buffer.from('client-1:secret-1').toString('base64')}`);
    assert.match(tokenReq.body, /code_verifier=/);
    // Another company cannot claim the same domain
    const other = await h.createCompany({ plan: 'business' });
    await setPlan(other.organizationId, 'enterprise');
    const os = await h.login(other.email, other.password);
    assert.equal((await os.form('/app/settings/sso', { ...input })).status, 422);
  });

  test('members sign in with SSO; unknown people need JIT; wrong domains and replays are refused', async () => {
    member = await h.addMember(co.organizationId, 'hr_manager');
    let s = await anonymous();
    let cb = await ssoLogin(s.agent, s.csrf, member.email, provider, { sub: 'sub-member' });
    assert.equal(cb.status, 302); assert.equal(cb.headers.location, '/app');
    assert.equal((await s.agent.get('/app/employees')).status, 200);
    assert.ok(await h.knex('user_identities').where({ user_id: member.userId, subject: 'sub-member' }).first());
    // The provider's subject identifies the person: a later sign-in with the same subject is the same account.
    s = await anonymous();
    cb = await ssoLogin(s.agent, s.csrf, member.email, provider, { sub: 'sub-member' });
    assert.equal(cb.status, 302);
    // Same state cannot be used twice
    const replay = await s.agent.get('/sso/callback?code=abc&state=anything');
    assert.equal(replay.status, 400);

    s = await anonymous();
    cb = await ssoLogin(s.agent, s.csrf, 'new.person@test.local', provider, { sub: 'sub-new', name: 'New Person' });
    assert.equal(cb.status, 403, 'no account without JIT');
    await h.knex('sso_connections').where({ organization_id: co.organizationId }).update({ jit: true, default_role: 'employee' });
    s = await anonymous();
    cb = await ssoLogin(s.agent, s.csrf, 'new.person@test.local', provider, { sub: 'sub-new', name: 'New Person' });
    assert.equal(cb.status, 302);
    const created = await h.knex('users').where({ email: 'new.person@test.local' }).first();
    assert.equal(created.name, 'New Person');
    const role = await h.knex('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').where({ 'ur.user_id': created.id }).first('r.key');
    assert.equal(role.key, 'employee');

    s = await anonymous();
    cb = await ssoLogin(s.agent, s.csrf, member.email, provider, { email: 'x@evil.com', sub: 'sub-2' });
    assert.equal(cb.status, 403);
    s = await anonymous();
    cb = await ssoLogin(s.agent, s.csrf, member.email, provider, { email_verified: false, sub: 'sub-3' });
    assert.equal(cb.status, 400);
    s = await anonymous();
    const none = await s.agent.post('/sso').type('form').send({ _csrf: s.csrf, email: 'someone@unknown-domain.com' });
    assert.equal(none.status, 404);
  });

  test('when SSO is required, members cannot use passwords but owners can', async () => {
    const r = await owner.form('/app/settings/sso', { issuer: provider.url, client_id: 'client-1', domains: 'test.local', enabled: 'on', enforce: 'on', jit: 'on', default_role: 'employee' });
    assert.equal(r.status, 302);
    const s = await anonymous();
    const res = await s.agent.post('/login').type('form').send({ _csrf: s.csrf, email: member.email, password: member.password });
    assert.equal(res.status, 409);
    assert.match(res.text, /single sign-on/i);
    await h.login(co.email, co.password); // owner break-glass works (throws otherwise)
  });
});

describe('Phase 9 — approval workflows', () => {
  let co; let owner; let emp; let mgr; let hr; let empId;
  const leaveReq = async (s, start, end) => s.api('post', '/api/v1/leave/requests', { leave_type_id: (await h.knex('leave_types').where({ organization_id: co.organizationId, key: 'annual' }).first()).id, start_date: start, end_date: end });
  before(async () => {
    co = await h.createCompany({ plan: 'business' });
    await setPlan(co.organizationId, 'enterprise');
    owner = await h.login(co.email, co.password);
    await owner.get('/app/leave'); // creates default leave types
    emp = await h.addMember(co.organizationId, 'employee');
    mgr = await h.addMember(co.organizationId, 'team_manager');
    hr = await h.addMember(co.organizationId, 'hr_manager');
    const m = await h.createEmployee(owner, { email: 'mgr@x.test' });
    const e = await h.createEmployee(owner, { email: 'emp@x.test', manager_id: m.body.data.id });
    empId = e.body.data.id;
    await h.knex('employees').where({ id: m.body.data.id }).update({ user_id: mgr.userId });
    await h.knex('employees').where({ id: empId }).update({ user_id: emp.userId });
    h.cache.clear();
  });

  test('workflow is saved from the form (manager, then any HR manager)', async () => {
    const r = await owner.form('/app/settings/workflows', { name: 'Manager then HR', step: ['manager', 'role:hr_manager'], is_active: 'on', priority: '1' });
    assert.equal(r.status, 302, r.text.slice(0, 200));
    const bad = await owner.form('/app/settings/workflows', { name: 'Broken', step: ['role:does_not_exist'] });
    assert.equal(bad.status, 422);
  });

  test('steps run in order; only the current approver decides; balance is used at the end', async () => {
    const es = await h.login(emp.email, emp.password);
    const r = await leaveReq(es, '2027-03-01', '2027-03-02');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.data.id;
    const req = await h.knex('leave_requests').where({ id }).first();
    assert.ok(req.workflow_id); assert.equal(req.current_step, 1);
    const hs = await h.login(hr.email, hr.password);
    let d = await hs.form(`/app/leave/${id}/decide`, { decision: 'approved' });
    assert.equal(d.status, 403, 'HR waits for the manager step');
    const ms = await h.login(mgr.email, mgr.password);
    const queue = await ms.get('/app/leave?tab=approvals');
    assert.match(queue.text, new RegExp(`/app/leave/${id}/decide`));
    d = await ms.form(`/app/leave/${id}/decide`, { decision: 'approved' });
    assert.equal(d.status, 302);
    assert.equal((await h.knex('leave_requests').where({ id }).first()).status, 'pending');
    const annual = await h.knex('leave_types').where({ organization_id: co.organizationId, key: 'annual' }).first();
    const bal = () => h.knex('leave_balances').where({ employee_id: empId, leave_type_id: annual.id, year: 2027 }).first();
    const usedBefore = Number((await bal()).used_days);
    assert.match((await hs.get('/app/leave?tab=approvals')).text, new RegExp(`/app/leave/${id}/decide`));
    d = await hs.form(`/app/leave/${id}/decide`, { decision: 'approved' });
    assert.equal(d.status, 302);
    assert.equal((await h.knex('leave_requests').where({ id }).first()).status, 'approved');
    assert.equal(Number((await bal()).used_days), usedBefore + 2);
    const steps = await h.knex('leave_request_steps').where({ leave_request_id: id }).orderBy('step_no');
    assert.deepEqual(steps.map((s) => s.status), ['approved', 'approved']);
    assert.deepEqual(steps.map((s) => s.decided_by), [mgr.userId, hr.userId]);
  });

  test('a rejection ends the request; a step without an approver is skipped', async () => {
    const es = await h.login(emp.email, emp.password);
    const r = await leaveReq(es, '2027-04-05', '2027-04-05');
    const ms = await h.login(mgr.email, mgr.password);
    await ms.form(`/app/leave/${r.body.data.id}/decide`, { decision: 'rejected', note: 'Busy week' });
    assert.equal((await h.knex('leave_requests').where({ id: r.body.data.id }).first()).status, 'rejected');
    const steps = await h.knex('leave_request_steps').where({ leave_request_id: r.body.data.id }).orderBy('step_no');
    assert.deepEqual(steps.map((s) => s.status), ['rejected', 'cancelled']);
    // No manager → the manager step is skipped and HR decides
    await h.knex('employees').where({ id: empId }).update({ manager_id: null });
    const r2 = await leaveReq(es, '2027-05-03', '2027-05-03');
    const steps2 = await h.knex('leave_request_steps').where({ leave_request_id: r2.body.data.id }).orderBy('step_no');
    assert.deepEqual(steps2.map((s) => s.status), ['skipped', 'pending']);
  });

  test('without the Enterprise feature leave uses the standard approval', async () => {
    const biz = await h.createCompany({ plan: 'business' });
    const s = await h.login(biz.email, biz.password);
    const page = await s.get('/app/settings/workflows');
    assert.equal(page.status, 200);
    assert.equal((await s.form('/app/settings/workflows', { name: 'X', step: ['manager'] })).status, 402);
  });
});

describe('Phase 9 — reports', () => {
  let co; let owner;
  before(async () => {
    co = await h.createCompany({ plan: 'business' });
    owner = await h.login(co.email, co.password);
    const dept = await owner.api('post', '/api/v1/departments', { name: 'Finance' });
    for (let i = 0; i < 3; i += 1) await h.createEmployee(owner, { department_id: dept.body.data?.id, base_salary: 10000 + i });
  });

  test('templates and builder run from dataset definitions only; unknown columns are ignored', async () => {
    const tpl = await owner.get('/app/reports/templates/headcount_by_department');
    assert.equal(tpl.status, 200);
    assert.match(tpl.text, /Finance/);
    const r = await owner.get('/app/reports/builder?dataset=employees&columns=name&columns=base_salary&columns=password_hash&group_by=1%3D1&period=all');
    assert.equal(r.status, 200);
    assert.match(r.text, /10,002|10002/);
    const csvRes = await owner.get('/app/reports/builder?dataset=employees&columns=name&columns=department&period=all&format=csv');
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers['content-type'], /text\/csv/);
    assert.match(csvRes.text, /Name,Department/);
    // Salary column only for people allowed to see salaries
    const cfg = reports.normalize({ permissions: new Set(['employees.view']) }, 'employees', { columns: ['name', 'base_salary'] });
    assert.deepEqual(cfg.columns, ['name']);
  });

  test('plan tiers: Starter has templates only; scheduling needs Enterprise', async () => {
    const st = await h.createCompany({ plan: 'starter' });
    const s = await h.login(st.email, st.password);
    assert.equal((await s.get('/app/reports/templates/employee_directory')).status, 200);
    assert.equal((await s.get('/app/reports/builder?dataset=employees')).status, 402);
    const saved = await owner.form('/app/reports/saved', { name: 'Team list', dataset: 'employees', columns: ['name', 'department'], period: 'all', is_shared: 'on' });
    assert.equal(saved.status, 302);
    const id = Number(saved.headers.location.split('/').pop());
    assert.equal((await owner.get(`/app/reports/saved/${id}`)).status, 200);
    const sch = await owner.form(`/app/reports/saved/${id}/schedules`, { frequency: 'weekly', weekday: '0', hour: '8', recipients: [String(co.userId)] });
    assert.equal(sch.status, 402);
  });

  test('scheduled delivery emails a CSV to recipients who may see the data', async () => {
    await setPlan(co.organizationId, 'enterprise');
    const emp = await h.addMember(co.organizationId, 'employee');
    const saved = await owner.form('/app/reports/saved', { name: 'Weekly headcount', dataset: 'employees', columns: ['department'], group_by: 'department', period: 'all' });
    const id = Number(saved.headers.location.split('/').pop());
    const sch = await owner.form(`/app/reports/saved/${id}/schedules`, { frequency: 'weekly', weekday: '0', hour: '8', recipients: [String(co.userId), String(emp.userId)] });
    assert.equal(sch.status, 302);
    const row = await h.knex('report_schedules').where({ report_id: id }).first();
    assert.ok(new Date(row.next_run_at) > new Date());
    mailer.testOutbox.length = 0;
    assert.equal(await reports.dispatchDue(new Date(new Date(row.next_run_at).getTime() + 1000)), 1);
    assert.equal(await reports.dispatchDue(new Date(new Date(row.next_run_at).getTime() + 1000)), 0, 'claimed once');
    await jobs.runDue({ limit: 20 });
    const mails = mailer.testOutbox.filter((m) => m.subject.includes('Weekly headcount'));
    assert.equal(mails.length, 1, 'the employee without report access gets nothing');
    assert.equal(mails[0].to, co.email);
    assert.match(mails[0].attachments[0].content, /Finance/);
    assert.match((await h.knex('report_schedules').where({ id: row.id }).first()).last_status, /Sent to 1/);
  });

  test('next run respects the organization time zone', () => {
    const next = reports.nextRun({ frequency: 'weekly', weekday: 0, hour: 8 }, 'Asia/Riyadh', new Date('2026-09-28T12:00:00Z')); // Monday
    assert.equal(next.toISOString(), '2026-10-04T05:00:00.000Z'); // Sunday 08:00 Riyadh
    const monthly = reports.nextRun({ frequency: 'monthly', day_of_month: 31, hour: 9 }, 'UTC', new Date('2026-02-01T00:00:00Z'));
    assert.equal(monthly.toISOString(), '2026-02-28T09:00:00.000Z');
  });
});

describe('Phase 9 — client success portal', () => {
  let co; let owner; let admin; let ticketId;
  before(async () => {
    co = await h.createCompany({ plan: 'business' });
    owner = await h.login(co.email, co.password);
    const bcrypt = require('bcryptjs');
    const [id] = await h.knex('users').insert({ name: 'Staff', email: `staff${Date.now()}@remoteway.test`, password_hash: await bcrypt.hash('Password#123', 4), is_super_admin: true });
    admin = await h.login((await h.knex('users').where({ id }).first()).email, 'Password#123');
  });

  test('a ticket gets an SLA by plan and alerts platform staff', async () => {
    mailer.testOutbox.length = 0;
    const r = await owner.form('/app/support', { subject: 'Cannot export payroll', category: 'technical', priority: 'normal', body: 'The export button shows an error.' });
    assert.equal(r.status, 302);
    ticketId = Number(r.headers.location.split('/').pop());
    const t = await h.knex('support_tickets').where({ id: ticketId }).first();
    assert.equal(t.sla_hours, 48);
    await jobs.runDue({ limit: 20 });
    assert.ok(mailer.testOutbox.some((m) => m.subject.includes('Cannot export payroll')));
    const ent = await h.createCompany({ plan: 'business' });
    await setPlan(ent.organizationId, 'enterprise');
    const es = await h.login(ent.email, ent.password);
    const r2 = await es.form('/app/support', { subject: 'Urgent issue', category: 'account', priority: 'normal', body: 'Help please' });
    assert.equal((await h.knex('support_tickets').where({ id: Number(r2.headers.location.split('/').pop()) }).first()).sla_hours, 8);
  });

  test('staff replies, internal notes stay internal, and the customer can reply and rate', async () => {
    let r = await admin.form(`/admin/support/${ticketId}/reply`, { body: 'Checking the logs (internal)', internal: 'on', status: 'in_progress' });
    assert.equal(r.status, 302);
    assert.equal((await h.knex('support_tickets').where({ id: ticketId }).first()).first_response_at, null, 'internal notes are not a response');
    r = await admin.form(`/admin/support/${ticketId}/reply`, { body: 'Fixed — please try again.', status: 'waiting_customer' });
    const t = await h.knex('support_tickets').where({ id: ticketId }).first();
    assert.ok(t.first_response_at); assert.equal(t.status, 'waiting_customer');
    const page = await owner.get(`/app/support/${ticketId}`);
    assert.match(page.text, /Fixed — please try again\./);
    assert.ok(!page.text.includes('Checking the logs'));
    const n = await h.knex('notifications').where({ user_id: co.userId, type: 'support_reply' }).first();
    assert.ok(n);
    assert.equal((await owner.form(`/app/support/${ticketId}/rate`, { satisfaction: '5' })).status, 409);
    await owner.form(`/app/support/${ticketId}/reply`, { body: 'Still failing.' });
    assert.equal((await h.knex('support_tickets').where({ id: ticketId }).first()).status, 'open');
    await admin.form(`/admin/support/${ticketId}/reply`, { body: 'Deployed a fix.', status: 'resolved' });
    assert.equal((await owner.form(`/app/support/${ticketId}/rate`, { satisfaction: '5' })).status, 302);
    assert.equal((await h.knex('support_tickets').where({ id: ticketId }).first()).satisfaction, 5);
    assert.equal((await admin.get('/admin/support')).status, 200);
  });

  test('tickets are private to the company and to people allowed to contact support', async () => {
    const other = await h.createCompany({ plan: 'business' });
    const os = await h.login(other.email, other.password);
    assert.equal((await os.get(`/app/support/${ticketId}`)).status, 404);
    const emp = await h.addMember(co.organizationId, 'employee');
    const es = await h.login(emp.email, emp.password);
    assert.equal((await es.get('/app/support')).status, 403);
    assert.equal((await owner.get('/admin/support')).status, 403);
  });
});
