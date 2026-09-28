// Platform team roles, company management from Super Admin (add-ons, extra features, invoices,
// paid-until), company logos on printouts, and white label (name, colour, domain, emails).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers');
const mailer = require('../src/core/mailer');
const branding = require('../src/modules/branding/branding.service');
const ent = require('../src/modules/billing/entitlements.service');

// A tiny real PNG (1×1)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let owner; let ownerId; let co; let cs;

before(async () => {
  await h.resetDatabase();
  const [id] = await h.knex('users').insert({ name: 'Root', email: `root${Date.now()}@test.local`, password_hash: await bcrypt.hash('Password#123', 4), is_super_admin: true, platform_role: 'owner' });
  ownerId = id;
  owner = await h.login((await h.knex('users').where({ id }).first()).email, 'Password#123');
  co = await h.createCompany({ plan: 'business' });
  cs = await h.login(co.email, co.password);
});
after(async () => { await h.knex.destroy(); });

describe('Phase 14 — platform team, company management, branding', () => {
  test('platform team: roles limit what each member can open and change', async () => {
    let r = await owner.form('/admin/team', { name: 'Sara Support', email: 'sara@rw.test', role: 'support', password: 'short' });
    assert.equal(r.status, 422);
    r = await owner.form('/admin/team', { name: 'Sara Support', email: 'sara@rw.test', role: 'support', password: 'Support12345' });
    assert.equal(r.status, 302);
    await owner.form('/admin/team', { name: 'Fadi Finance', email: 'fadi@rw.test', role: 'finance', password: 'Finance12345' });
    // An existing company user joins with their own password
    r = await owner.form('/admin/team', { email: co.email, role: 'admin' });
    assert.equal(r.status, 302);
    assert.equal((await owner.form('/admin/team', { email: co.email, role: 'admin' })).status, 409);

    const sup = await h.login('sara@rw.test', 'Support12345');
    assert.equal((await sup.get(`/admin/organizations/${co.organizationId}`)).status, 200);
    assert.equal((await sup.get('/admin/support')).status, 200);
    for (const p of ['/admin/plans', '/admin/invoices', '/admin/payments', '/admin/team', '/admin/system']) assert.equal((await sup.get(p)).status, 403, p);
    assert.equal((await sup.form(`/admin/organizations/${co.organizationId}/features`, { features: ['white_label'] })).status, 403, 'support reads, does not change');
    const nav = (await sup.get('/admin')).text;
    assert.ok(!nav.includes('href="/admin/plans"') && nav.includes('href="/admin/support"'));

    const fin = await h.login('fadi@rw.test', 'Finance12345');
    assert.equal((await fin.get('/admin/invoices')).status, 200);
    assert.equal((await fin.get('/admin/payments')).status, 200);
    assert.equal((await fin.form('/admin/payments/mode', { mode: 'live' })).status, 403, 'gateway settings stay with owners and admins');
    assert.equal((await fin.get('/admin/support')).status, 403);

    const members = await h.knex('users').where({ is_super_admin: true });
    assert.equal(members.find((m) => m.email === co.email).platform_role, 'admin');
    // Safeguards
    assert.equal((await owner.form(`/admin/team/${ownerId}/remove`, {})).status, 409);
    assert.equal((await owner.form(`/admin/team/${ownerId}/role`, { role: 'support' })).status, 409);
    const supId = members.find((m) => m.email === 'sara@rw.test').id;
    await owner.form(`/admin/team/${supId}/remove`, {});
    assert.equal((await sup.get('/admin')).status, 403, 'removed at once');
    const admin = await h.login(co.email, co.password);
    assert.equal((await admin.get('/admin/team')).status, 403, 'only owners manage the team');
    await owner.form(`/admin/team/${members.find((m) => m.email === co.email).id}/remove`, {});
    assert.ok(await h.knex('audit_logs').where({ action: 'platform.team_added' }).first());
  });

  test('company management: add-ons, extra features, paid-until, invoices', async () => {
    const id = co.organizationId;
    const before = (await ent.getEntitlements(id)).limits.employees;
    let r = await owner.form(`/admin/organizations/${id}/addons`, { 'addons[extra_employees]': '2', 'addons[sso]': ['0', '1'] });
    assert.equal(r.status, 302);
    let e = await ent.getEntitlements(id);
    assert.equal(e.limits.employees, before + 20);
    assert.ok(e.features.has('sso'));
    r = await owner.form(`/admin/organizations/${id}/features`, { features: ['white_label', 'automation', 'employees', 'nope'] });
    assert.equal(r.status, 302);
    const sub = await h.knex('subscriptions').where({ organization_id: id }).first();
    const granted = typeof sub.custom_features === 'string' ? JSON.parse(sub.custom_features) : sub.custom_features;
    assert.deepEqual(granted, ['automation', 'white_label'], 'plan features and unknown keys are not stored');
    e = await ent.getEntitlements(id);
    assert.ok(e.features.has('white_label') && e.features.has('automation'));
    const plan = await h.knex('plans').where({ key: 'business' }).first();
    r = await owner.form(`/admin/organizations/${id}/subscription`, { plan_id: String(plan.id), status: 'active', billing_cycle: 'yearly', current_period_end: '2027-06-30' });
    assert.equal(r.status, 302);
    const s2 = await h.knex('subscriptions').where({ organization_id: id }).first();
    assert.equal(s2.billing_cycle, 'yearly');
    assert.equal(new Date(s2.current_period_end).toISOString().slice(0, 10), '2027-06-30');
    r = await owner.form(`/admin/organizations/${id}/invoice`, { amount: '5000', description: 'Agreed annual price' });
    assert.equal(r.status, 302);
    const inv = await h.knex('invoices').where({ organization_id: id, status: 'issued' }).first();
    assert.equal(Number(inv.subtotal), 5000);
    assert.equal(Number(inv.total), 5750);
    assert.equal((await h.knex('invoice_items').where({ invoice_id: inv.id }).first()).description, 'Agreed annual price');
    assert.ok(await h.knex('notifications').where({ user_id: co.userId, type: 'invoice_issued' }).first());
    assert.equal((await owner.form(`/admin/organizations/${id}/invoice`, {})).status, 409, 'one open invoice at a time');
    await owner.form(`/admin/invoices/${inv.id}/void`, { back: 'org', org: String(id) });
    assert.equal((await h.knex('invoices').where({ id: inv.id }).first()).status, 'void');
    const page = await owner.get(`/admin/organizations/${id}`);
    assert.match(page.text, /Extra features/);
    assert.match(page.text, /name="addons\[extra_employees\]" value="2"/);
  });

  test('company logo: stored in the database, shown on printouts, SVG refused', async () => {
    const up = (buf, name, kind = 'logo') => cs.agent.post('/app/settings/branding/logo').field('_csrf', cs.csrf).field('kind', kind).attach('file', buf, name);
    let r = await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.svg');
    assert.equal(r.status, 422);
    r = await up(Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]), 'big.png');
    assert.equal(r.status, 422);
    r = await up(PNG, 'logo.png');
    assert.equal(r.status, 302);
    const row = await h.knex('organization_branding').where({ organization_id: co.organizationId }).first();
    assert.ok(Buffer.isBuffer(row.logo) && row.logo.equals(PNG));
    const file = await h.request(h.getApp()).get(`/org-brand/${co.organizationId}/logo/${row.logo_sha}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers['content-type'], 'image/png');
    assert.equal((await h.request(h.getApp()).get(`/org-brand/${co.organizationId}/logo/0000000000000000`)).status, 404);
    // Printed report on the company letterhead, still "Generated with RemoteWay" (no white label yet)
    const print = await cs.get('/app/compliance?print=1');
    assert.equal(print.status, 200);
    assert.match(print.text, /class="print-letterhead"/);
    assert.ok(print.text.includes(`/org-brand/${co.organizationId}/logo/${row.logo_sha}`));
    assert.match(print.text, /Generated with RemoteWay/);
    // The app keeps the RemoteWay identity, with the logo next to the company name only
    const app = await cs.get('/app');
    assert.match(app.text, /<title>[^<]*RemoteWay<\/title>/);
    assert.match(app.text, /org-mark-logo/);
    assert.match(app.text, /\/brand\/logo-primary\.png/);
  });

  test('white label: plan-gated; name, colour, domain, printouts and emails', async () => {
    const other = await h.createCompany({ plan: 'business' });
    const os = await h.login(other.email, other.password);
    assert.equal((await os.form('/app/settings/branding/white-label', { white_label: 'on', brand_name: 'Other' })).status, 402);

    let r = await cs.form('/app/settings/branding/white-label', { white_label: 'on', brand_name: 'Acme HR', brand_color: '#zz', custom_domain: 'nope' });
    assert.equal(r.status, 422);
    r = await cs.form('/app/settings/branding/white-label', { white_label: 'on', brand_name: 'Acme HR', brand_color: '#1a73e8', custom_domain: 'https://HR.Acme.test/', email_sender_name: 'Acme People' });
    assert.equal(r.status, 302);
    const row = await h.knex('organization_branding').where({ organization_id: co.organizationId }).first();
    assert.equal(row.custom_domain, 'hr.acme.test');
    assert.equal(row.brand_color, '#1A73E8');

    const app = await cs.get('/app');
    assert.match(app.text, /<title>[^<]*Acme HR<\/title>/);
    assert.match(app.text, /href="\/org-brand\/\d+\/theme\/1a73e8\.css"/);
    assert.ok(!app.text.includes('/brand/logo-primary.png'), 'the RemoteWay logo is replaced');
    const css = await h.request(h.getApp()).get(`/org-brand/${co.organizationId}/theme/1a73e8.css`);
    assert.match(css.text, /--rw-green: #1A73E8/);
    assert.match(css.headers['content-type'], /text\/css/);
    assert.doesNotMatch((await cs.get('/app/compliance?print=1')).text, /Generated with RemoteWay/);
    // The platform's own invoice keeps the RemoteWay identity
    const inv = await h.knex('invoices').where({ organization_id: co.organizationId }).first();
    assert.match((await cs.get(`/app/billing/invoices/${inv.id}`)).text, /\/brand\/logo-primary\.png/);

    // Sign-in on the company's own domain
    const login = await h.request(h.getApp()).get('/login').set('Host', 'hr.acme.test');
    assert.equal(login.status, 200);
    assert.match(login.text, /<title>[^<]*Acme HR<\/title>/);
    assert.ok(login.text.includes(`/org-brand/${co.organizationId}/logo/`));
    assert.doesNotMatch((await h.request(h.getApp()).get('/login').set('Host', 'unknown.example.com')).text, /Acme HR/);
    // Another company cannot take the domain
    const p = await h.knex('plans').where({ key: 'enterprise' }).first();
    await h.knex('subscriptions').where({ organization_id: other.organizationId }).update({ plan_id: p.id });
    h.cache.clear();
    assert.equal((await os.form('/app/settings/branding/white-label', { white_label: 'on', brand_name: 'Other', custom_domain: 'hr.acme.test' })).status, 422);

    // Emails about this company carry its identity
    mailer.testOutbox.length = 0;
    await mailer.sendNotificationEmail(co.userId, 'invoice_issued', { number: 'X-1' }, '/app/billing', co.organizationId);
    const m = mailer.testOutbox.pop();
    assert.equal(m.subject, 'Acme HR — Invoice X-1 is ready');
    assert.match(m.from, /^"Acme People" </);
    assert.ok(m.html.includes(`https://hr.acme.test/org-brand/${co.organizationId}/logo/`));
    assert.ok(!m.html.includes('Remote<span'));
    // Taking the feature away brings RemoteWay back
    await owner.form(`/admin/organizations/${co.organizationId}/features`, { features: [] });
    await owner.form(`/admin/organizations/${co.organizationId}/addons`, { 'addons[extra_employees]': '0', 'addons[sso]': '0' });
    assert.match((await cs.get('/app')).text, /<title>[^<]*RemoteWay<\/title>/);
  });

  test('theme colours stay readable', () => {
    const css = branding.themeCss('#FFE600');
    assert.match(css, /--accent-ink: #000000/);
    const deep = css.match(/--rw-green-deep: (#[0-9A-F]{6})/)[1];
    assert.ok(branding.contrast(deep, '#FFFFFF') >= 4.5);
    const darkDeep = css.match(/:root\[data-theme="dark"\] \{[^}]*--rw-green-deep: (#[0-9A-F]{6})/)[1];
    assert.ok(branding.contrast(darkDeep, '#121212') >= 4.5);
    const navy = branding.themeCss('#0B3D91');
    assert.match(navy, /--accent-ink: #FFFFFF/);
    const darkAccent = navy.match(/:root\[data-theme="dark"\] \{ --rw-green: (#[0-9A-F]{6})/)[1];
    assert.ok(branding.contrast(darkAccent, '#121212') >= 3, 'a dark brand colour is lifted in dark mode');
  });
});
