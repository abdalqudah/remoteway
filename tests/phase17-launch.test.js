// Launch hardening: password reset by email, two-step verification (TOTP + recovery codes) at sign-in,
// admin-team 2FA enforcement and reset, sessions ending after a password change.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
process.env.BACKUP_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-backups-'));
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers');
const mailer = require('../src/core/mailer');
const totp = require('../src/core/totp');

const pub = () => h.request.agent(h.getApp());
const csrfOf = (text) => text.match(/name="csrf-token" content="([^"]+)"/)[1];
async function startLogin(email, password) {
  const agent = pub();
  const csrf = csrfOf((await agent.get('/login')).text);
  const res = await agent.post('/login').type('form').send({ _csrf: csrf, email, password });
  return { agent, csrf, res };
}
async function superAdmin(role = 'owner') {
  const email = `${role}${Date.now()}${Math.random().toString(36).slice(2, 6)}@rw.test`;
  const [id] = await h.knex('users').insert({ name: `${role} person`, email, password_hash: await bcrypt.hash('Password#123', 4), is_super_admin: true, platform_role: role });
  return { id, email };
}
const nextCode = (secret, offset = 0) => totp.codeAt(secret, totp.stepOf(Date.now()) + offset);

before(async () => { await h.resetDatabase(); });
after(async () => { await h.knex.destroy(); fs.rmSync(process.env.BACKUP_PATH, { recursive: true, force: true }); });

describe('password reset', () => {
  test('sends a one-time link, sets the new password, ends old sessions', async () => {
    const co = await h.createCompany();
    const old = await h.login(co.email, co.password);
    assert.equal((await old.get('/app')).status, 200);

    mailer.testOutbox.length = 0;
    const a = pub();
    const page = await a.get('/forgot');
    assert.equal(page.status, 200);
    const sent = await a.post('/forgot').type('form').send({ _csrf: csrfOf(page.text), email: co.email.toUpperCase() });
    assert.equal(sent.status, 200);
    assert.match(sent.text, /reset link is on its way/);
    const mail = mailer.testOutbox.find((m) => m.to === co.email);
    assert.ok(mail, 'reset email sent');
    const token = mail.html.match(/\/reset\/([a-f0-9]{64})/)[1];
    const row = await h.knex('password_resets').first();
    assert.notEqual(row.token_hash, token, 'only the hash is stored');

    const form = await a.get(`/reset/${token}`);
    assert.equal(form.status, 200);
    assert.match(form.text, /name="password_confirm"/);
    const bad = await a.post(`/reset/${token}`).type('form').send({ _csrf: csrfOf(form.text), password: 'NewPass#2026', password_confirm: 'nope' });
    assert.equal(bad.status, 422);
    const ok = await a.post(`/reset/${token}`).type('form').send({ _csrf: csrfOf(form.text), password: 'NewPass#2026', password_confirm: 'NewPass#2026' });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.location, '/login');

    // Old session is gone; the link no longer works; the new password does
    assert.equal((await old.get('/app')).status, 302);
    const again = await a.get(`/reset/${token}`);
    assert.match(again.text, /expired or was already used/);
    const reused = await a.post(`/reset/${token}`).type('form').send({ _csrf: csrfOf(again.text), password: 'Another#2026', password_confirm: 'Another#2026' });
    assert.equal(reused.status, 404);
    await assert.rejects(h.login(co.email, co.password));
    await h.login(co.email, 'NewPass#2026');
  });

  test('same answer for unknown emails, no mail, and at most 3 links an hour', async () => {
    mailer.testOutbox.length = 0;
    const a = pub();
    const page = await a.get('/forgot');
    const r = await a.post('/forgot').type('form').send({ _csrf: csrfOf(page.text), email: 'nobody@nowhere.test' });
    assert.equal(r.status, 200);
    assert.match(r.text, /reset link is on its way/);
    assert.equal(mailer.testOutbox.length, 0);

    const co = await h.createCompany();
    for (let i = 0; i < 5; i += 1) await a.post('/forgot').type('form').send({ _csrf: csrfOf(page.text), email: co.email });
    assert.equal(mailer.testOutbox.filter((m) => m.to === co.email).length, 3);
    // An expired link is refused
    await h.knex('password_resets').update({ expires_at: new Date(Date.now() - 1000) });
    const token = mailer.testOutbox[0].html.match(/\/reset\/([a-f0-9]{64})/)[1];
    assert.match((await a.get(`/reset/${token}`)).text, /expired or was already used/);
  });

  test('login page links to the reset flow', async () => {
    assert.match((await pub().get('/login')).text, /href="\/forgot"/);
  });
});

describe('two-step verification', () => {
  let co; let recovery; let secret;
  test('set up from /security with a QR code, recovery codes shown once', async () => {
    co = await h.createCompany();
    const s = await h.login(co.email, co.password);
    assert.match((await s.get('/security')).text, /Set up two-step verification/);
    await s.form('/security/2fa/start', {});
    const page = await s.get('/security');
    assert.match(page.text, /<svg/);
    secret = page.text.match(/<code dir="ltr" class="select-all">([A-Z2-7 ]+)<\/code>/)[1].replace(/ /g, '');
    const wrong = await s.form('/security/2fa/enable', { code: '000000' });
    assert.equal(wrong.status, 422);
    const done = await s.form('/security/2fa/enable', { code: nextCode(secret) });
    assert.equal(done.status, 200);
    recovery = [...done.text.matchAll(/<span>([a-f0-9]{5}-[a-f0-9]{5})<\/span>/g)].map((m) => m[1]);
    assert.equal(recovery.length, 10);
    const u = await h.knex('users').where({ email: co.email }).first();
    assert.ok(u.two_factor_enabled_at);
    assert.ok(!String(u.two_factor_secret_enc).includes(secret), 'secret stored encrypted');
    assert.ok(!JSON.stringify(u.two_factor_recovery).includes(recovery[0]), 'recovery codes stored hashed');
  });

  test('sign-in asks for the code; a code cannot be reused; recovery codes work once', async () => {
    const { agent, csrf, res } = await startLogin(co.email, co.password);
    assert.equal(res.headers.location, '/login/2fa');
    assert.equal((await agent.get('/app')).status, 302, 'no session before the second step');
    const bad = await agent.post('/login/2fa').type('form').send({ _csrf: csrf, code: '123456' });
    assert.equal(bad.status, 422);
    // The step used at enable time cannot be replayed; the next one works
    const ok = await agent.post('/login/2fa').type('form').send({ _csrf: csrf, code: nextCode(secret, 1) });
    assert.equal(ok.status, 302);
    assert.equal((await agent.get('/app')).status, 200);

    const again = await startLogin(co.email, co.password);
    const replay = await again.agent.post('/login/2fa').type('form').send({ _csrf: again.csrf, code: nextCode(secret, 1) });
    assert.equal(replay.status, 422);
    assert.match(replay.text, /already used/);
    const rec = await again.agent.post('/login/2fa').type('form').send({ _csrf: again.csrf, code: recovery[0] });
    assert.equal(rec.status, 302);

    const third = await startLogin(co.email, co.password);
    const used = await third.agent.post('/login/2fa').type('form').send({ _csrf: third.csrf, code: recovery[0] });
    assert.equal(used.status, 422);
  });

  test('turning it off needs the current password', async () => {
    const { agent, csrf } = await startLogin(co.email, co.password);
    await agent.post('/login/2fa').type('form').send({ _csrf: csrf, code: recovery[1] });
    const tok = csrfOf((await agent.get('/security')).text);
    assert.equal((await agent.post('/security/2fa/disable').type('form').send({ _csrf: tok, password: 'wrong' })).status, 422);
    assert.equal((await agent.post('/security/2fa/disable').type('form').send({ _csrf: tok, password: co.password })).status, 302);
    const plain = await startLogin(co.email, co.password);
    assert.notEqual(plain.res.headers.location, '/login/2fa');
  });

  test('platform can require 2FA for the admin team; the owner can reset a teammate', async () => {
    const owner = await superAdmin('owner');
    const support = await superAdmin('support');
    const o = await h.login(owner.email, 'Password#123');
    assert.equal((await o.get('/admin/team')).status, 200);
    assert.equal((await o.form('/admin/team/security', { require_admin_2fa: '1' })).status, 302);
    const blocked = await o.get('/admin');
    assert.equal(blocked.status, 302);
    assert.equal(blocked.headers.location, '/security?required=1');
    assert.match((await o.get('/security?required=1')).text, /requires two-step verification/);

    // Support person cannot change the setting, and is also sent to set up 2FA
    const s = await h.login(support.email, 'Password#123');
    assert.equal((await s.get('/admin/crm')).headers.location, '/security?required=1');

    // Owner turns it on and gets back in
    await o.form('/security/2fa/start', {});
    const sec = (await o.get('/security')).text.match(/<code dir="ltr" class="select-all">([A-Z2-7 ]+)<\/code>/)[1].replace(/ /g, '');
    await o.form('/security/2fa/enable', { code: nextCode(sec) });
    assert.equal((await o.get('/admin')).status, 200);
    // Required: the team cannot switch it off
    assert.equal((await o.form('/security/2fa/disable', { password: 'Password#123' })).status, 409);

    // Owner resets a teammate's 2FA
    await h.knex('users').where({ id: support.id }).update({ two_factor_enabled_at: new Date(), two_factor_secret_enc: 'x' });
    assert.equal((await o.form(`/admin/team/${support.id}/reset-2fa`, {})).status, 302);
    const u = await h.knex('users').where({ id: support.id }).first();
    assert.equal(u.two_factor_enabled_at, null);
    assert.ok(await h.knex('audit_logs').where({ action: 'auth.2fa_reset' }).first());
    await o.form('/admin/team/security', {});
  });

  test('changing the password signs out other devices', async () => {
    const c = await h.createCompany();
    const one = await h.login(c.email, c.password);
    const two = await h.login(c.email, c.password);
    const r = await one.form('/app/settings/account/password', { current_password: c.password, new_password: 'Changed#2026' });
    assert.equal(r.status, 302);
    assert.equal((await one.get('/app')).status, 200, 'this device stays signed in');
    assert.equal((await two.get('/app')).status, 302, 'the other device is signed out');
  });
});

describe('database backups', () => {
  let o; let owner;
  test('only the platform owner opens backups', async () => {
    owner = await superAdmin('owner');
    o = await h.login(owner.email, 'Password#123');
    assert.equal((await o.get('/admin/backups')).status, 200);
    const fin = await h.login((await superAdmin('finance')).email, 'Password#123');
    assert.equal((await fin.get('/admin/backups')).status, 403);
  });

  test('backup, change data, restore: data comes back, a safety copy is kept', async () => {
    const co = await h.createCompany({ name: 'Backup Co' });
    await h.knex('organizations').where({ id: co.organizationId }).update({ name: 'Before «قبل» O\'Neil\n; line' });
    const r = await o.form('/admin/backups', {});
    assert.equal(r.status, 302);
    const files = fs.readdirSync(process.env.BACKUP_PATH);
    assert.equal(files.length, 1);
    const sql = zlib.gunzipSync(fs.readFileSync(path.join(process.env.BACKUP_PATH, files[0]))).toString();
    assert.match(sql, /^-- RemoteWay database backup/);
    assert.match(sql, /CREATE TABLE `organizations`/);
    assert.ok(!/INSERT INTO `sessions`/.test(sql), 'sessions are not backed up');

    // Download
    const dl = await o.get(`/admin/backups/${files[0]}/download`).buffer(true).parse((res, cb) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers['content-type'], 'application/gzip');
    assert.ok(dl.body.length > 100);
    assert.equal((await o.get('/admin/backups/..%2F..%2Fetc%2Fpasswd/download')).status, 404);

    await h.knex('organizations').where({ id: co.organizationId }).update({ name: 'After' });
    const wrong = await o.form(`/admin/backups/${files[0]}/restore`, { password: 'nope' });
    assert.equal(wrong.status, 422);
    const done = await o.form(`/admin/backups/${files[0]}/restore`, { password: 'Password#123' });
    assert.equal(done.status, 302);
    assert.match(done.headers.location, /^\/login\?restored=1/);
    const org = await h.knex('organizations').where({ id: co.organizationId }).first();
    assert.equal(org.name, 'Before «قبل» O\'Neil\n; line');
    const after = fs.readdirSync(process.env.BACKUP_PATH);
    assert.equal(after.length, 2);
    assert.ok(after.some((n) => n.includes('before-restore')));
    assert.ok(await h.knex('audit_logs').where({ action: 'platform.backup_restored' }).first());
    o = await h.login(owner.email, 'Password#123');
  });

  test('upload checks the file; daily schedule runs once a day and keeps the newest', async () => {
    const bad = await o.agent.post('/admin/backups/import').field('_csrf', o.csrf).attach('file', Buffer.from('hello'), 'x.sql.gz');
    assert.equal(bad.status, 422);
    const good = fs.readFileSync(path.join(process.env.BACKUP_PATH, fs.readdirSync(process.env.BACKUP_PATH)[0]));
    const ok = await o.agent.post('/admin/backups/import').field('_csrf', o.csrf).attach('file', good, 'copy.sql.gz');
    assert.equal(ok.status, 302);
    assert.ok(fs.readdirSync(process.env.BACKUP_PATH).some((n) => n.endsWith('-imported.sql.gz')));

    const backups = require('../src/modules/admin/backup.service');
    assert.equal((await o.form('/admin/backups/settings', { enabled: '1', hour: '0', keep: '3' })).status, 302);
    const first = await backups.autoBackup(new Date());
    assert.ok(first && first.name.endsWith('-auto.sql.gz'));
    assert.equal(await backups.autoBackup(new Date()), null, 'once a day');
    assert.equal(fs.readdirSync(process.env.BACKUP_PATH).length, 3, 'only the newest 3 kept');
    assert.equal((await o.form('/admin/backups/settings', { enabled: '1', hour: '30', keep: '3' })).status, 422);
  });
});

describe('error log', () => {
  test('unexpected errors are stored without secrets and shown to owners/admins', async () => {
    const errorsSvc = require('../src/modules/admin/errors.service');
    const err = new Error('DB exploded password=hunter2 token: abc123');
    await errorsSvc.record(err, { method: 'POST', originalUrl: '/app/x?token=zzz', ip: '1.2.3.4' });
    const row = await h.knex('app_errors').orderBy('id', 'desc').first();
    assert.equal(row.path, '/app/x');
    assert.ok(!row.message.includes('hunter2') && !row.message.includes('abc123'));
    const owner = await superAdmin('owner');
    const o = await h.login(owner.email, 'Password#123');
    const page = await o.get('/admin/errors');
    assert.equal(page.status, 200);
    assert.match(page.text, /DB exploded/);
    const sup = await h.login((await superAdmin('support')).email, 'Password#123');
    assert.equal((await sup.get('/admin/errors')).status, 403);
    await o.form('/admin/errors/clear', {});
    assert.equal(Number((await h.knex('app_errors').count({ n: '*' }).first()).n), 0);
  });
});

describe('privacy, terms and personal data rights', () => {
  test('public legal pages in both languages, editable by the platform', async () => {
    const en = await pub().get('/privacy');
    assert.equal(en.status, 200);
    assert.match(en.text, /Personal Data Protection Law/);
    assert.match(en.text, /<h2>Your rights<\/h2>/);
    const ar = await pub().get('/terms?lang=ar');
    assert.equal(ar.status, 200);
    assert.match(ar.text, /شروط الخدمة/);
    assert.match((await pub().get('/')).text, /href="\/privacy"/);
    assert.match((await pub().get('/signup')).text, /href="\/terms"/);

    const owner = await superAdmin('owner');
    const o = await h.login(owner.email, 'Password#123');
    assert.equal((await o.get('/admin/legal')).status, 200);
    const r = await o.form('/admin/legal', { company: 'RemoteWay Co. Ltd', email: 'privacy@remoteway.sa', privacy_en: '## Hello\n<script>alert(1)</script> {company} — {email}', privacy_ar: '', terms_en: '', terms_ar: '' });
    assert.equal(r.status, 302);
    const page = (await pub().get('/privacy')).text;
    assert.match(page, /<h2>Hello<\/h2>/);
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt; RemoteWay Co. Ltd/);
    assert.match(page, /mailto:privacy@remoteway.sa/);
    // Arabic keeps the starting text, with the entity filled in
    assert.match((await pub().get('/privacy?lang=ar')).text, /RemoteWay Co. Ltd/);
    const sup = await h.login((await superAdmin('support')).email, 'Password#123');
    assert.equal((await sup.get('/admin/legal')).status, 403);
  });

  test('cookie note can be dismissed; robots.txt and sitemap.xml', async () => {
    const a = pub();
    const home = await a.get('/');
    assert.match(home.text, /data-cookie-note/);
    await a.post('/preferences/cookies').type('form').send({ _csrf: csrfOf(home.text) });
    assert.ok(!/data-cookie-note/.test((await a.get('/')).text));
    const robots = await pub().get('/robots.txt');
    assert.match(robots.text, /Disallow: \/admin/);
    assert.match(robots.text, /Sitemap: .*\/sitemap.xml/);
    const map = await pub().get('/sitemap.xml');
    assert.equal(map.headers['content-type'].split(';')[0], 'application/xml');
    assert.match(map.text, /<loc>[^<]*\/privacy<\/loc>/);
  });

  test('a person downloads their data without secrets', async () => {
    const co = await h.createCompany();
    const s = await h.login(co.email, co.password);
    const r = await s.get('/security/export');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-disposition'], /remoteway-my-data/);
    const data = JSON.parse(r.text);
    assert.equal(data.account.email, co.email);
    assert.equal(data.account.password_hash, undefined);
    assert.equal(data.memberships[0].is_owner, true);
  });

  test('company owners must hand over first; others can delete their account', async () => {
    const co = await h.createCompany();
    const owner = await h.login(co.email, co.password);
    const blocked = await owner.form('/security/delete', { confirm: co.email, password: co.password });
    assert.equal(blocked.status, 409);

    const member = await h.addMember(co.organizationId, 'employee');
    const m = await h.login(member.email, member.password);
    assert.equal((await m.form('/security/delete', { confirm: 'wrong@x.com', password: member.password })).status, 422);
    const ok = await m.form('/security/delete', { confirm: member.email, password: member.password });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.location, '/?deleted=1');
    const u = await h.knex('users').where({ id: member.userId }).first();
    assert.ok(u.deleted_at);
    assert.equal(u.status, 'disabled');
    assert.equal(u.name, 'Deleted user');
    assert.ok(u.email.endsWith('@deleted.invalid'));
    assert.equal(await h.knex('memberships').where({ user_id: member.userId }).first(), undefined);
    assert.equal((await m.get('/app')).status, 302, 'signed out');
    await assert.rejects(h.login(member.email, member.password));
    const c = await h.knex('crm_contacts').where({ user_id: member.userId }).first();
    if (c) { assert.equal(c.email, null); assert.equal(c.opt_out_email, 1); }
  });
});

describe('launch readiness', () => {
  test('lists blocking items for a development setup; admins only', async () => {
    const owner = await superAdmin('owner');
    await h.knex('users').where({ id: owner.id }).update({ password_hash: await bcrypt.hash('Admin@12345', 4) });
    const o = await h.login(owner.email, 'Admin@12345');
    const r = await o.get('/admin/launch');
    assert.equal(r.status, 200);
    assert.match(r.text, /blocking item/);
    assert.match(r.text, /check-row is-fail/);
    assert.ok(r.text.includes(owner.email), 'default password is flagged');
    const sales = await h.login((await superAdmin('sales')).email, 'Password#123');
    assert.equal((await sales.get('/admin/launch')).status, 403);
  });
});

describe('security review fixes', () => {
  test('SSRF guard blocks IPv6 literals and IPv4-mapped forms', () => {
    const saved = process.env.INTEGRATIONS_ALLOW_PRIVATE;
    delete process.env.INTEGRATIONS_ALLOW_PRIVATE;
    const { validateUrl } = require('../src/core/http');
    for (const u of ['https://[::1]/', 'https://[::ffff:7f00:1]:9/', 'https://[::ffff:127.0.0.1]/', 'https://[fd00::1]/', 'https://[64:ff9b::a00:1]/', 'https://169.254.169.254/']) {
      assert.ok(validateUrl(u).error, u);
    }
    assert.equal(validateUrl('https://[2606:4700::1111]/').error, undefined);
    if (saved !== undefined) process.env.INTEGRATIONS_ALLOW_PRIVATE = saved;
  });

  test('five wrong 2FA codes lock the second step; wrong passwords slow down but never lock out', async () => {
    const co = await h.createCompany();
    const s = await h.login(co.email, co.password);
    await s.form('/security/2fa/start', {});
    const sec = (await s.get('/security')).text.match(/<code dir="ltr" class="select-all">([A-Z2-7 ]+)<\/code>/)[1].replace(/ /g, '');
    await s.form('/security/2fa/enable', { code: nextCode(sec) });
    const { agent, csrf } = await startLogin(co.email, co.password);
    for (let i = 0; i < 5; i += 1) await agent.post('/login/2fa').type('form').send({ _csrf: csrf, code: '000000' });
    const locked = await agent.post('/login/2fa').type('form').send({ _csrf: csrf, code: nextCode(sec, 1) });
    assert.equal(locked.status, 429);

    // Wrong passwords never lock the real owner out, and unknown addresses answer the same way
    const c2 = await h.createCompany();
    for (let i = 0; i < 11; i += 1) await startLogin(c2.email, 'wrong-password');
    const still = await startLogin(c2.email, 'wrong-password');
    const unknown = await startLogin('nobody-here@test.local', 'wrong-password');
    assert.equal(still.res.status, unknown.res.status);
    const right = await startLogin(c2.email, c2.password);
    assert.equal(right.res.status, 302, 'the right password still works');
  });

  test('the Back link on /security only accepts in-app paths', async () => {
    const co = await h.createCompany();
    const s = await h.login(co.email, co.password);
    const evil = await s.agent.get('/security').set('referer', 'https://evil.com//evil.com/app/');
    assert.ok(!/href="\/\/evil/.test(evil.text));
    const ok = await s.agent.get('/security').set('referer', 'http://localhost/app/leave');
    assert.match(ok.text, /href="\/app\/leave"/);
  });
});

describe('email verification', () => {
  const linkFor = (email) => { const m = mailer.testOutbox.filter((x) => x.to === email).pop(); return m && (m.html.match(/\/verify-email\/([a-f0-9]{64})/) || [])[1]; };
  async function signup(email) {
    const a = pub();
    const page = await a.get('/signup');
    const r = await a.post('/signup').type('form').send({ _csrf: csrfOf(page.text), name: 'New Owner', email, password: 'Password#123', company_name: `Co ${Date.now()}`, country_code: 'SA', plan: 'business', terms: 'on' });
    assert.equal(r.status, 302, r.text.slice(0, 400));
    return a;
  }

  test('a new company owner gets a link; unconfirmed accounts cannot invite; the link confirms', async () => {
    const email = `verify${Date.now()}@test.local`;
    const a = await signup(email);
    const token = linkFor(email);
    assert.ok(token, 'verification email sent');
    const app = await a.get('/app').redirects(2);
    assert.match(app.text, /verify-banner/);
    const csrf = csrfOf(app.text);
    const role = await h.knex('roles').whereNull('organization_id').where({ key: 'employee' }).first();
    const inv = await a.post('/app/settings/users/invite').type('form').send({ _csrf: csrf, email: 'x@test.local', role_id: role.id });
    assert.ok([409, 302].includes(inv.status));
    assert.equal(await h.knex('invitations').where({ email: 'x@test.local' }).first(), undefined, 'no invitation before confirming');

    assert.equal((await a.get(`/verify-email/${token}`)).status, 302);
    const u = await h.knex('users').where({ email }).first();
    assert.ok(u.email_verified_at);
    assert.ok(!/verify-banner/.test((await a.get('/app').redirects(2)).text));
    assert.equal((await pub().get(`/verify-email/${token}`)).status, 404, 'a link works once');
  });

  test('resend is limited; after 7 days the app asks to confirm first', async () => {
    const email = `late${Date.now()}@test.local`;
    const a = await signup(email);
    const csrf = csrfOf((await a.get('/app').redirects(2)).text);
    for (let i = 0; i < 4; i += 1) await a.post('/verify-email/resend').type('form').send({ _csrf: csrf });
    assert.equal(mailer.testOutbox.filter((m) => m.to === email).length, 3);
    await h.knex('users').where({ email }).update({ created_at: new Date(Date.now() - 8 * 86400_000) });
    const gated = await a.get('/app');
    assert.equal(gated.status, 302);
    assert.equal(gated.headers.location, '/verify-email');
    assert.match((await a.get('/verify-email')).text, /Confirm your email/);
    // A password reset link also proves the address
    await h.knex('email_verifications').del();
    const f = await pub().get('/forgot');
    await pub().post('/forgot').type('form').send({ _csrf: csrfOf(f.text), email });
  });

  test('accepting an invitation confirms the email', async () => {
    const co = await h.createCompany();
    const verifyService = require('../src/modules/auth/verify.service');
    const u = await h.knex('users').where({ id: co.userId }).first();
    assert.ok(verifyService.isVerified(u));
    const members = require('../src/modules/organizations/members.service');
    const role = await h.knex('roles').whereNull('organization_id').where({ key: 'employee' }).first();
    const { token } = await members.invite({ organizationId: co.organizationId, userId: co.userId }, { email: 'invitee@test.local', roleId: role.id });
    const r = await members.acceptInvitation(token, { account: { name: 'Invitee', password: 'Password#123' } });
    assert.ok((await h.knex('users').where({ id: r.userId }).first()).email_verified_at);
  });

  test('the backups page keeps the Arabic right-to-left direction', async () => {
    const owner = await superAdmin('owner');
    const o = await h.login(owner.email, 'Password#123');
    const page = await o.get('/admin/backups?lang=ar');
    assert.match(page.text, /<html lang="ar" dir="rtl"/);
  });
});

describe('password reset links without email', () => {
  test('forgot page says so when email is not set up', async () => {
    const config = require('../src/config');
    config.isTest = false; // behave like a server without SMTP
    try {
      const a = pub();
      const page = await a.get('/forgot');
      const r = await a.post('/forgot').type('form').send({ _csrf: csrfOf(page.text), email: 'someone@test.local' });
      assert.match(r.text, /not set up/);
    } finally { config.isTest = true; }
  });

  test('a company admin creates a one-time reset link for a member', async () => {
    const co = await h.createCompany();
    const member = await h.addMember(co.organizationId, 'employee');
    const owner = await h.login(co.email, co.password);
    mailer.testOutbox.length = 0;
    const config = require('../src/config');
    config.isTest = false; // no SMTP: the link is shown to copy
    let page;
    try {
      assert.equal((await owner.form(`/app/settings/users/${member.userId}/reset-link`, {})).status, 302);
      page = (await owner.get('/app/settings/users')).text;
    } finally { config.isTest = true; }
    const link = page.match(/\/reset\/([a-f0-9]{64})/)[1];
    const a = pub();
    const form = await a.get(`/reset/${link}`);
    assert.equal((await a.post(`/reset/${link}`).type('form').send({ _csrf: csrfOf(form.text), password: 'Fresh#2026x', password_confirm: 'Fresh#2026x' })).status, 302);
    await h.login(member.email, 'Fresh#2026x');
    // Someone who also uses the account elsewhere: email only, never shown to the company admin
    const shared = await h.addMember(co.organizationId, 'employee');
    const elsewhere = await h.createCompany();
    await h.knex('memberships').insert({ organization_id: elsewhere.organizationId, user_id: shared.userId });
    config.isTest = false;
    try {
      assert.equal((await owner.form(`/app/settings/users/${shared.userId}/reset-link`, {})).status, 409, 'no email set up: refused');
    } finally { config.isTest = true; }
    mailer.testOutbox.length = 0;
    assert.equal((await owner.form(`/app/settings/users/${shared.userId}/reset-link`, {})).status, 302);
    assert.ok(mailer.testOutbox.find((m) => m.to === shared.email), 'emailed to the person');
    assert.ok(!/\/reset\/[a-f0-9]{64}/.test((await owner.get('/app/settings/users')).text), 'link never shown to the admin');
    // Not for the owner, and not across companies
    const other = await h.createCompany();
    assert.equal((await owner.form(`/app/settings/users/${other.userId}/reset-link`, {})).status, 404);
    const hr = await h.addMember(co.organizationId, 'admin');
    const hrs = await h.login(hr.email, hr.password);
    assert.equal((await hrs.form(`/app/settings/users/${co.userId}/reset-link`, {})).status, 409);
  });

  test('platform support finds a user and creates a link; finance cannot', async () => {
    const co = await h.createCompany();
    const sup = await h.login((await superAdmin('support')).email, 'Password#123');
    const found = await sup.get(`/admin/users?q=${encodeURIComponent(co.email)}`);
    assert.equal(found.status, 200);
    assert.ok(found.text.includes(co.email));
    mailer.testOutbox.length = 0;
    const r = await sup.form(`/admin/users/${co.userId}/reset-link`, { back: '/admin/users' });
    assert.equal(r.status, 302);
    assert.ok(mailer.testOutbox.find((m) => m.to === co.email && /\/reset\//.test(m.html)), 'emailed when email works');
    assert.ok(await h.knex('audit_logs').where({ action: 'auth.password_reset_link_created' }).first());
    const fin = await h.login((await superAdmin('finance')).email, 'Password#123');
    assert.equal((await fin.form(`/admin/users/${co.userId}/reset-link`, {})).status, 403);
    assert.equal((await sup.get(`/admin/organizations/${co.organizationId}`)).status, 200);
  });
});

describe('launch tools', () => {
  test('anyone, including the platform owner, changes their password from Account security', async () => {
    const owner = await superAdmin('owner');
    await h.knex('users').where({ id: owner.id }).update({ password_hash: await bcrypt.hash('Admin@12345', 4) });
    const o = await h.login(owner.email, 'Admin@12345');
    assert.equal((await o.form('/security/password', { current_password: 'Admin@12345', new_password: 'Admin@12345', new_password_confirm: 'Admin@12345' })).status, 422, 'known default refused');
    assert.equal((await o.form('/security/password', { current_password: 'wrong', new_password: 'Strong#Pass2026', new_password_confirm: 'Strong#Pass2026' })).status, 422);
    assert.equal((await o.form('/security/password', { current_password: 'Admin@12345', new_password: 'Strong#Pass2026', new_password_confirm: 'nope' })).status, 422);
    assert.equal((await o.form('/security/password', { current_password: 'Admin@12345', new_password: 'Strong#Pass2026', new_password_confirm: 'Strong#Pass2026' })).status, 302);
    await h.login(owner.email, 'Strong#Pass2026');
  });

  test('the platform owner removes demo data (safety backup first); others cannot', async () => {
    // A small demo company with a demo employee and a demo individual
    const co = await h.createCompany({ name: 'Demo Co' });
    await h.knex('users').where({ id: co.userId }).update({ email: 'owner@demo.remoteway.local' });
    const emp = await h.addMember(co.organizationId, 'employee', { email: 'employee@demo.remoteway.local' });
    const [indId] = await h.knex('users').insert({ name: 'Talent', email: 'x@talent.demo.remoteway.local', password_hash: 'x' });
    const real = await h.createCompany({ name: 'Real Co' });
    const adminUser = await superAdmin('admin');
    const a = await h.login(adminUser.email, 'Password#123');
    assert.match((await a.get('/admin/launch')).text, /id="demo"/);
    assert.equal((await a.form('/admin/launch/remove-demo', { password: 'Password#123' })).status, 403, 'admins cannot');
    const owner = await superAdmin('owner');
    const o = await h.login(owner.email, 'Password#123');
    assert.equal((await o.form('/admin/launch/remove-demo', { password: 'wrong' })).status, 422);
    const r = await o.form('/admin/launch/remove-demo', { password: 'Password#123' });
    assert.equal(r.status, 302);
    assert.equal(await h.knex('organizations').where({ id: co.organizationId }).first(), undefined);
    assert.equal(await h.knex('users').whereIn('id', [co.userId, emp.userId, indId]).first(), undefined);
    assert.ok(await h.knex('organizations').where({ id: real.organizationId }).first(), 'real companies untouched');
    assert.ok(fs.readdirSync(process.env.BACKUP_PATH).some((n) => n.includes('before-demo-removal')));
    assert.ok(!/id="demo"/.test((await o.get('/admin/launch')).text));
  });
});
