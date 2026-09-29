// Flexible SMTP: presets, security modes, relay without authentication, clear errors, masked settings.
// Local stub servers stand in for real mail servers; no external server is contacted here.
process.env.INTEGRATIONS_ALLOW_PRIVATE = 'true';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const bcrypt = require('bcryptjs');
const h = require('./helpers');
const smtp = require('../src/core/smtp');
const mailer = require('../src/core/mailer');

/** A tiny SMTP server. `auth` = { user, pass } requires a login; `require530` refuses MAIL before login. */
function stub({ auth = null, require530 = false } = {}) {
  const log = { commands: [], messages: [] };
  const srv = net.createServer((sock) => {
    let data = false; let buf = ''; let authed = false;
    sock.write('220 stub ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') { data = false; sock.write('250 OK queued\r\n'); } else log.messages[log.messages.length - 1] += `${line}\n`;
          continue;
        }
        log.commands.push(line);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') sock.write(auth ? '250-stub\r\n250 AUTH PLAIN LOGIN\r\n' : '250 stub\r\n');
        else if (cmd === 'HELO') sock.write('250 stub\r\n');
        else if (cmd === 'STAR') sock.write('502 5.5.1 STARTTLS not supported\r\n'); // like a real server without TLS
        else if (cmd === 'AUTH') {
          const [, , b64] = line.split(' ');
          const [, u, p] = Buffer.from(b64 || '', 'base64').toString('utf8').split('\0');
          if (auth && u === auth.user && p === auth.pass) { authed = true; sock.write('235 2.7.0 Accepted\r\n'); } else sock.write('535 5.7.8 Username and Password not accepted\r\n');
        } else if (cmd === 'MAIL') {
          if ((auth || require530) && !authed) sock.write('530 5.7.0 Authentication Required\r\n');
          else sock.write('250 OK\r\n');
        } else if (cmd === 'DATA') { data = true; log.messages.push(''); sock.write('354 go\r\n'); } else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, log })));
}

/** A port nobody listens on. */
async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

let open; let relay; let root;
before(async () => {
  await h.resetDatabase();
  open = await stub({ auth: { user: 'mailer@example.test', pass: 'S3cret-pass!' } });
  relay = await stub();
  const [id] = await h.knex('users').insert({ name: 'Root', email: `root${Date.now()}@test.local`, password_hash: await bcrypt.hash('Password#123', 4), is_super_admin: true, platform_role: 'owner', email_verified_at: new Date() });
  root = await h.login((await h.knex('users').where({ id }).first()).email, 'Password#123');
});
after(async () => { open.srv.close(); relay.srv.close(); await h.knex.destroy(); });

describe('SMTP configuration logic', () => {
  test('security modes map to nodemailer options', () => {
    const base = { host: 'smtp.example.test', port: 587, authentication: 'none', fromEmail: 'a@example.test' };
    const none = smtp.transportOptions({ ...base, port: 25, security: 'none' });
    assert.equal(none.secure, false); assert.equal(none.requireTLS, false);
    const st = smtp.transportOptions({ ...base, security: 'starttls' });
    assert.equal(st.secure, false); assert.equal(st.requireTLS, true);
    const ssl = smtp.transportOptions({ ...base, port: 465, security: 'ssl' });
    assert.equal(ssl.secure, true);
  });

  test('no auth key at all when authentication is none (relay / IP allowlist)', () => {
    const o = smtp.transportOptions({ host: 'smtp-relay.example.test', port: 587, security: 'starttls', authentication: 'none', username: 'left@over.test', password: 'x', fromEmail: 'a@example.test' });
    assert.equal('auth' in o, false);
    const p = smtp.transportOptions({ host: 'h.example.test', port: 587, security: 'starttls', authentication: 'password', username: 'u@example.test', password: 'pw', fromEmail: 'u@example.test' });
    assert.deepEqual(p.auth, { user: 'u@example.test', pass: 'pw' });
  });

  test('presets only fill values; any host works (custom)', () => {
    for (const k of ['custom', 'gmail', 'google_relay', 'microsoft365', 'outlook', 'cpanel']) assert.ok(smtp.PRESETS[k], k);
    assert.equal(smtp.PRESETS.google_relay.authentication, 'none');
    const v = smtp.validate({ provider: 'gmail', host: 'mail.any-company.test', port: 2526, security: 'none', authentication: 'none', fromEmail: 'x@any-company.test' });
    assert.deepEqual(v.errors, {});
    assert.equal(v.settings.host, 'mail.any-company.test', 'the preset does not override what was entered');
  });

  test('older saved settings (host/port/user/password/from) still work', () => {
    const s = smtp.normalize({ host: 'mail.example.test', port: 465, user: 'hr@example.test', password: 'pw', from: 'Example HR <hr@example.test>' });
    assert.equal(s.security, 'ssl');
    assert.equal(s.authentication, 'password');
    assert.equal(s.username, 'hr@example.test');
    assert.equal(s.fromEmail, 'hr@example.test');
    assert.equal(s.fromName, 'Example HR');
    const n = smtp.normalize({ host: 'relay.example.test', port: 25, from: 'noreply@example.test' });
    assert.equal(n.security, 'none'); assert.equal(n.authentication, 'none');
  });

  test('validation and warnings', () => {
    const bad = smtp.validate({ host: '', port: 0, authentication: 'password', username: '', fromEmail: 'nope' });
    for (const f of ['host', 'port', 'username', 'password', 'from_email']) assert.ok(bad.errors[f], f);
    const w = smtp.validate({ host: 'h.example.test', port: 587, security: 'ssl', authentication: 'password', username: 'a@example.test', password: 'x', fromEmail: 'b@example.test' });
    assert.ok(w.warnings.includes('port587_ssl'));
    assert.ok(w.warnings.includes('from_differs'));
    const w2 = smtp.validate({ host: 'h.example.test', port: 25, security: 'none', authentication: 'password', username: 'a@example.test', password: 'x', fromEmail: 'a@example.test' });
    assert.ok(w2.warnings.includes('password_without_tls'));
  });

  test('errors are explained by type, never with the password', () => {
    const E = (m, o = {}) => Object.assign(new Error(m), o);
    const cases = [
      [E('getaddrinfo ENOTFOUND smtp.nowhere.invalid', { code: 'EDNS' }), 'dns', 'ENOTFOUND'],
      [E('connect ECONNREFUSED 127.0.0.1:1', { code: 'ESOCKET' }), 'refused', 'ECONNREFUSED'],
      [E('Connection timeout', { code: 'ETIMEDOUT' }), 'timeout', 'ETIMEDOUT'],
      [E('read ECONNRESET', { code: 'ESOCKET' }), 'reset', 'ECONNRESET'],
      [E('Invalid login: 535 5.7.8 Username and Password not accepted', { code: 'EAUTH', responseCode: 535 }), 'auth', 'EAUTH'],
      [E('530 5.7.0 Must issue a STARTTLS command first', { responseCode: 530 }), 'auth_required', '530'],
      [E('550 5.7.1 Relaying denied', { responseCode: 550 }), 'rejected', '550'],
      [E('routines:ssl3_get_record:wrong version number', { code: 'ESOCKET' }), 'tls', 'ESOCKET'],
      [E("Hostname/IP does not match certificate's altnames", { code: 'ESOCKET' }), 'certificate', 'ESOCKET'],
    ];
    for (const [err, kind, code] of cases) {
      const x = smtp.explain(err, { host: 'h', port: 1 });
      assert.equal(x.kind, kind, err.message);
      assert.equal(x.code, code, err.message);
      assert.ok(x.hints.length > 0);
    }
    assert.doesNotMatch(smtp.explain(E('bad password=hunter2 given')).detail, /hunter2/);
  });

  test('environment fallback, admin settings first', () => {
    const keep = { ...process.env };
    Object.assign(process.env, { SMTP_HOST: 'smtp.env.test', SMTP_PORT: '587', SMTP_SECURITY: 'starttls', SMTP_AUTH: 'none', SMTP_FROM: 'Env <env@example.test>' });
    const s = smtp.fromEnv();
    assert.equal(s.host, 'smtp.env.test'); assert.equal(s.security, 'starttls'); assert.equal(s.authentication, 'none'); assert.equal(s.fromEmail, 'env@example.test');
    assert.equal('auth' in smtp.transportOptions(s), false);
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  });
});

describe('SMTP against local servers', () => {
  const S = (o) => ({ host: '127.0.0.1', security: 'none', fromEmail: 'mailer@example.test', fromName: 'Example', ...o });

  test('relay without authentication: connection and email work, and no AUTH is sent', async () => {
    const c = await smtp.verifyConnection(S({ port: relay.port, authentication: 'none' }));
    assert.equal(c.ok, true, c.error && c.error.message);
    const r = await smtp.sendTestEmail(S({ port: relay.port, authentication: 'none', replyTo: 'hr@example.test' }), 'someone@example.test', { subject: 'Test', html: '<p>x</p>' });
    assert.equal(r.ok, true, r.error && r.error.message);
    assert.equal(relay.log.commands.some((l) => /^AUTH/i.test(l)), false);
    assert.match(relay.log.messages.pop(), /Reply-To: hr@example\.test/);
  });

  test('username & password: correct login works, wrong one is EAUTH', async () => {
    const good = await smtp.verifyConnection(S({ port: open.port, authentication: 'password', username: 'mailer@example.test', password: 'S3cret-pass!' }));
    assert.equal(good.ok, true, good.error && good.error.message);
    const bad = await smtp.verifyConnection(S({ port: open.port, authentication: 'password', username: 'mailer@example.test', password: 'wrong' }));
    assert.equal(bad.ok, false);
    assert.equal(bad.error.kind, 'auth');
    assert.equal(bad.error.code, 'EAUTH');
    assert.doesNotMatch(JSON.stringify(bad.error), /wrong|S3cret/);
  });

  test('a server that needs a login refuses a relay attempt with 530', async () => {
    const r = await smtp.sendTestEmail(S({ port: open.port, authentication: 'none' }), 'someone@example.test', { subject: 'x', html: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'send');
    assert.equal(r.error.kind, 'auth_required');
  });

  test('invalid host → ENOTFOUND', async () => {
    const r = await smtp.verifyConnection(S({ host: 'smtp.does-not-exist.invalid', port: 587, authentication: 'none' }));
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, 'dns', `${r.error.code} ${r.error.detail}`);
    assert.equal(r.error.code, 'ENOTFOUND');
  });

  test('closed port → ECONNREFUSED', async () => {
    const r = await smtp.verifyConnection(S({ port: await closedPort(), authentication: 'none' }));
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, 'refused');
    assert.equal(r.error.code, 'ECONNREFUSED');
  });

  test('TLS mismatch: SSL/TLS against a plain server, STARTTLS against a server without it', async () => {
    const ssl = await smtp.verifyConnection(S({ port: relay.port, security: 'ssl', authentication: 'none' }));
    assert.equal(ssl.ok, false);
    assert.ok(['tls', 'timeout', 'reset'].includes(ssl.error.kind), `${ssl.error.kind} ${ssl.error.detail}`);
    const st = await smtp.verifyConnection(S({ port: relay.port, security: 'starttls', authentication: 'none' }));
    assert.equal(st.ok, false);
    assert.equal(st.error.kind, 'tls', `${st.error.kind} ${st.error.detail}`);
  });
});

describe('Super Admin → Email', () => {
  const body = () => ({ provider: 'custom', host: '127.0.0.1', port: String(open.port), security: 'none', authentication: 'password', username: 'mailer@example.test', password: 'S3cret-pass!', from_email: 'mailer@example.test', from_name: 'Platform', reply_to: 'help@example.test' });

  test('saves encrypted; GET never returns the password; an empty password keeps the stored one', async () => {
    assert.equal((await root.form('/admin/email', body())).status, 302);
    const raw = JSON.stringify((await h.knex('platform_settings').where({ key: 'smtp' }).first()).value);
    assert.doesNotMatch(raw, /S3cret-pass!/, 'stored encrypted');
    const g = await root.get('/admin/email/settings');
    assert.equal(g.status, 200);
    assert.doesNotMatch(g.text, /S3cret-pass!|password_enc/);
    assert.equal(g.body.data.settings.smtpPassword, '********');
    assert.equal(g.body.data.settings.security, 'none');
    assert.equal(g.body.data.settings.replyTo, 'help@example.test');
    assert.doesNotMatch((await root.get('/admin/email')).text, /S3cret-pass!/);
    // Save again without retyping the password
    assert.equal((await root.form('/admin/email', { ...body(), password: '' })).status, 302);
    const conn = await root.api('post', '/admin/email/test-connection', { ...body(), password: '' });
    assert.equal(conn.body.data.ok, true, JSON.stringify(conn.body.data.error));
    // Mail from the platform uses the saved server
    const current = mailer.currentConfig();
    assert.equal(current.source, 'admin');
    assert.equal(current.password, 'S3cret-pass!');
  });

  test('test connection and test email report the real result', async () => {
    const bad = await root.api('post', '/admin/email/test-connection', { ...body(), password: 'nope' });
    assert.equal(bad.body.data.ok, false);
    assert.equal(bad.body.data.error.kind, 'auth');
    const page = await root.form('/admin/email/test-connection', { ...body(), port: String(await closedPort()) });
    assert.equal(page.status, 200);
    assert.match(page.text, /ECONNREFUSED/);
    const sent = await root.api('post', '/admin/email/test', { ...body(), password: '', test_to: 'check@example.test' });
    assert.equal(sent.body.data.ok, true, JSON.stringify(sent.body.data.error));
    assert.equal(sent.body.data.stage, 'sent');
    assert.equal((await root.api('post', '/admin/email/test', { ...body(), test_to: 'not-an-email' })).status, 422);
    const events = await h.knex('smtp_events').where({ scope: 'platform' });
    assert.ok(events.length >= 3);
    assert.doesNotMatch(JSON.stringify(events), /S3cret-pass!|nope/);
  });

  test('relay mode stores no username or password', async () => {
    assert.equal((await root.form('/admin/email', { ...body(), port: String(relay.port), authentication: 'none', username: '', password: '' })).status, 302);
    const v = ((v) => (typeof v === 'string' ? JSON.parse(v) : v))((await h.knex('platform_settings').where({ key: 'smtp' }).first()).value);
    assert.equal(v.authentication, 'none'); assert.equal(v.user, ''); assert.equal(v.password_enc, null);
    assert.equal('auth' in smtp.transportOptions(mailer.currentConfig()), false);
  });

  test('regular users cannot read or change SMTP settings', async () => {
    const co = await h.createCompany({ plan: 'business' });
    const owner = await h.login(co.email, co.password);
    for (const url of ['/admin/email', '/admin/email/settings']) assert.notEqual((await owner.get(url)).status, 200, url);
    assert.notEqual((await owner.form('/admin/email/test-connection', body())).status, 200);
    const e = await h.addMember(co.organizationId, 'employee');
    const s = await h.login(e.email, e.password);
    assert.equal((await s.get('/app/settings/email/settings')).status, 403);
    const own = await owner.get('/app/settings/email/settings');
    assert.equal(own.status, 200);
  });
});
