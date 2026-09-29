// Company mailboxes: each company sends its people's emails from its own address; the platform can
// require it. A tiny local SMTP server stands in for the company's mail server.
process.env.INTEGRATIONS_ALLOW_PRIVATE = 'true';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const bcrypt = require('bcryptjs');
const h = require('./helpers');
const mailer = require('../src/core/mailer');

let co; let owner; let root; let smtp; const received = [];

function startSmtp(port) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let data = false; let buf = '';
      sock.write('220 test ESMTP\r\n');
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (data) {
            if (line === '.') { data = false; sock.write('250 OK queued\r\n'); } else received[received.length - 1] += `${line}\n`;
            continue;
          }
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 test\r\n');
          else if (cmd === 'MAIL' || cmd === 'RCPT' || cmd === 'RSET' || cmd === 'NOOP') sock.write('250 OK\r\n');
          else if (cmd === 'DATA') { data = true; received.push(''); sock.write('354 go\r\n'); } else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 OK\r\n');
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

before(async () => {
  await h.resetDatabase();
  smtp = await startSmtp(2525);
  co = await h.createCompany({ plan: 'business', name: 'Taawoni' });
  owner = await h.login(co.email, co.password);
  const [id] = await h.knex('users').insert({ name: 'Root', email: `root${Date.now()}@test.local`, password_hash: await bcrypt.hash('Password#123', 4), is_super_admin: true, platform_role: 'owner', email_verified_at: new Date() });
  root = await h.login((await h.knex('users').where({ id }).first()).email, 'Password#123');
});
after(async () => { smtp.close(); await h.knex.destroy(); });

describe('Phase 24 — company email', () => {
  test('the platform can require company mailboxes; until connected nothing is sent for the company', async () => {
    assert.equal((await root.form('/admin/email/policy', { require_company_email: '1' })).status, 302);
    assert.equal(await mailer.requireCompanyEmail(), true);
    const page = await owner.get('/app');
    assert.match(page.text, /href="\/app\/settings\/email"/, 'reminder banner for the admin');
    mailer.testOutbox.length = 0;
    await mailer.send({ to: 'x@y.test', subject: 'Hello', html: '<p>x</p>', organizationId: co.organizationId });
    assert.equal(mailer.testOutbox.pop().via, 'blocked');
    assert.equal(await mailer.canSendFor(co.organizationId), false);
    // Account emails (no company) still go through the platform
    await mailer.send({ to: 'x@y.test', subject: 'Reset', html: '<p>x</p>' });
    assert.equal(mailer.testOutbox.pop().via, 'platform');
  });

  test('connecting: validation, internal addresses refused in production, test message from the company address', async () => {
    assert.equal((await owner.form('/app/settings/email', { host: 'not a host', port: '99', from_email: 'nope' })).status, 422);
    const r = await owner.form('/app/settings/email', { host: '127.0.0.1', port: '2525', username: '', from_email: 'hr@taawoni.test', from_name: 'Taawoni HR' });
    assert.equal(r.status, 302);
    const row = await h.knex('organization_mail').where({ organization_id: co.organizationId }).first();
    assert.equal(Boolean(row.enabled), true, row.last_error || 'enabled after a delivered test');
    const msg = received.pop();
    assert.match(msg, /From: "?Taawoni HR"? <hr@taawoni\.test>/);
    assert.ok(msg.includes(`To: ${co.email}`));
    // Company emails now use the mailbox, from the company's address
    mailer.testOutbox.length = 0;
    await mailer.send({ to: 'emp@taawoni.test', subject: 'Leave approved', html: '<p>x</p>', organizationId: co.organizationId });
    const m = mailer.testOutbox.pop();
    assert.equal(m.via, 'company');
    assert.equal(m.from, '"Taawoni HR" <hr@taawoni.test>');
    assert.equal(await mailer.canSendFor(co.organizationId), true);
    assert.doesNotMatch((await owner.get('/app')).text, /banner warning"><svg[^>]*><use[^>]*#i-mail/, 'no reminder once connected');
    // Another company is not affected
    const other = await h.createCompany({ plan: 'business' });
    await mailer.send({ to: 'a@b.test', subject: 'x', html: 'x', organizationId: other.organizationId });
    assert.equal(mailer.testOutbox.pop().via, 'blocked');
    // A mail server inside RemoteWay's network is refused when private addresses are not allowed
    delete process.env.INTEGRATIONS_ALLOW_PRIVATE;
    const bad = await owner.form('/app/settings/email', { host: '127.0.0.1', port: '2525', from_email: 'hr@taawoni.test' });
    assert.equal(bad.status, 400);
    process.env.INTEGRATIONS_ALLOW_PRIVATE = 'true';
  });

  test('a failed test leaves the mailbox off; only admins manage it; disconnect', async () => {
    const r = await owner.form('/app/settings/email', { host: '127.0.0.1', port: '587', from_email: 'hr@taawoni.test' });
    assert.equal(r.status, 302);
    const row = await h.knex('organization_mail').where({ organization_id: co.organizationId }).first();
    assert.equal(Boolean(row.enabled), false);
    assert.ok(row.last_error);
    const page = await owner.get('/app/settings/email');
    assert.match(page.text, /alert alert-error/);
    const e = await h.addMember(co.organizationId, 'employee');
    const s = await h.login(e.email, e.password);
    assert.equal((await s.get('/app/settings/email')).status, 403);
    assert.equal((await owner.form('/app/settings/email/remove', {})).status, 302);
    assert.equal(await h.knex('organization_mail').where({ organization_id: co.organizationId }).first(), undefined);
    await root.form('/admin/email/policy', {});
    assert.equal(await mailer.requireCompanyEmail(), false);
  });
});
