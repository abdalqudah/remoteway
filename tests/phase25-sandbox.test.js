// Test environment: test companies with sample data, kept apart from real customers, deleted in one step.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers');
const mailer = require('../src/core/mailer');

let root; let rootId; let real;
const csrfOf = (text) => text.match(/name="csrf-token" content="([^"]+)"/)[1];

before(async () => {
  await h.resetDatabase();
  const [id] = await h.knex('users').insert({ name: 'Root', email: `root${Date.now()}@test.local`, password_hash: await bcrypt.hash('Password#123', 4), is_super_admin: true, platform_role: 'owner', email_verified_at: new Date() });
  rootId = id;
  root = await h.login((await h.knex('users').where({ id }).first()).email, 'Password#123');
  real = await h.createCompany({ plan: 'business', name: 'Real Customer' });
});
after(async () => { await h.knex.destroy(); });

describe('Phase 25 — test environment', () => {
  let sb;
  test('create a test company with sample data and ready accounts', async () => {
    const before = await h.knex('organizations').count({ n: '*' }).first();
    assert.equal((await root.form('/admin/sandbox', { name: '', plan: 'enterprise' })).status, 422);
    const r = await root.form('/admin/sandbox', { name: 'QA October', plan: 'enterprise', sample: '1', note: 'leave flows' });
    assert.equal(r.status, 302);
    sb = await h.knex('organizations').where({ is_sandbox: true }).first();
    assert.ok(sb);
    const meta = JSON.parse(sb.sandbox_meta);
    assert.match(meta.domain, /^t[a-f0-9]{6}\.sandbox\.remoteway\.local$/);
    assert.ok(Number((await h.knex('employees').where({ organization_id: sb.id }).count({ n: '*' }).first()).n) >= 19, 'sample people');
    assert.ok(await h.knex('attendance').where({ organization_id: sb.id }).first('id'), 'sample attendance');
    const sub = await h.knex('subscriptions').where({ organization_id: sb.id }).first();
    assert.equal(sub.status, 'active');
    assert.equal(await h.knex('jobs').where({ organization_id: sb.id, marketplace: true }).first('id'), undefined);
    assert.equal(await h.knex('crm_contacts').where('email', 'like', `%@${meta.domain}`).first('id'), undefined, 'not in the CRM');
    // Overview figures ignore it
    const ov = await require('../src/modules/admin/admin.service').overview();
    assert.equal(ov.orgs, Number(before.n));
    // The page shows accounts and the password
    const page = await root.get('/admin/sandbox');
    assert.ok(page.text.includes(`hr@${meta.domain}`));
    const pw = page.text.match(/class="mono temp-password" dir="ltr">([^<]+)</)[1];
    // Team accounts sign in and see the test banner
    const a = h.request.agent(h.getApp());
    let lp = await a.get('/login');
    const s = await a.post('/login').type('form').send({ _csrf: csrfOf(lp.text), email: `hr@${meta.domain}`, password: pw });
    assert.equal(s.status, 302);
    const app = await a.get('/app');
    assert.equal(app.status, 200);
    assert.match(app.text, /sandbox-banner/);
    // No email ever leaves a test company
    mailer.testOutbox.length = 0;
    await mailer.send({ to: 'someone@real.test', subject: 'x', html: 'x', organizationId: sb.id });
    await mailer.send({ to: `hr@${meta.domain}`, subject: 'reset', html: 'x' });
    assert.deepEqual(mailer.testOutbox.map((m) => m.via), ['sandbox', 'sandbox']);
    assert.equal(await mailer.canSendFor(sb.id), false);
  });

  test('team members join with their own accounts; reset keeps them; delete removes everything else', async () => {
    const teammate = await h.addMember(real.organizationId, 'employee'); // a real account elsewhere
    assert.equal((await root.form(`/admin/sandbox/${sb.id}/members`, { email: 'nobody@x.test', role: 'hr_manager' })).status, 302);
    assert.equal((await root.form(`/admin/sandbox/${sb.id}/members`, { email: teammate.email, role: 'hr_manager' })).status, 302);
    assert.ok(await h.knex('memberships').where({ organization_id: sb.id, user_id: teammate.userId }).first());
    // Wrong password: nothing happens
    await root.form(`/admin/sandbox/${sb.id}/delete`, { password: 'nope' });
    assert.ok(await h.knex('organizations').where({ id: sb.id }).first());
    // Reset: a fresh company, the teammate keeps access
    await root.form(`/admin/sandbox/${sb.id}/reset`, { password: 'Password#123' });
    assert.equal(await h.knex('organizations').where({ id: sb.id }).first(), undefined);
    const fresh = await h.knex('organizations').where({ is_sandbox: true }).first();
    assert.ok(fresh && fresh.id !== sb.id);
    assert.equal(fresh.name, 'QA October');
    assert.ok(await h.knex('memberships').where({ organization_id: fresh.id, user_id: teammate.userId }).first(), 'team access kept');
    // Delete: records, generated accounts go; the teammate and the real company stay
    const domain = JSON.parse(fresh.sandbox_meta).domain;
    assert.equal((await root.form(`/admin/sandbox/${fresh.id}/delete`, { password: 'Password#123' })).status, 302);
    assert.equal(await h.knex('organizations').where({ id: fresh.id }).first(), undefined);
    assert.equal(await h.knex('employees').where({ organization_id: fresh.id }).first(), undefined);
    assert.equal(await h.knex('users').where('email', 'like', `%@${domain}`).first(), undefined);
    assert.ok(await h.knex('users').where({ id: teammate.userId }).first(), 'own accounts are kept');
    assert.ok(await h.knex('organizations').where({ id: real.organizationId }).first(), 'real companies untouched');
    assert.ok(await h.knex('users').where({ id: rootId }).first());
  });

  test('only the platform owner/admin can use it; real companies cannot be deleted from here', async () => {
    await root.form('/admin/team', { name: 'Sam Support', email: 'sam.sb@rw.test', role: 'support', password: 'Support12345' });
    const sup = await h.login('sam.sb@rw.test', 'Support12345');
    assert.equal((await sup.get('/admin/sandbox')).status, 403);
    await root.form(`/admin/sandbox/${real.organizationId}/delete`, { password: 'Password#123' });
    assert.ok(await h.knex('organizations').where({ id: real.organizationId }).first());
  });
});
