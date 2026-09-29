// Company portal links (remoteway.net/<link>) and QR attendance with a code that changes every minute.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const pub = () => h.request.agent(h.getApp());
const csrfOf = (text) => text.match(/name="csrf-token" content="([^"]+)"/)[1];

before(async () => { await h.resetDatabase(); });
after(async () => { await h.knex.destroy(); });

describe('company portal link', () => {
  let co; let owner;
  test('the company chooses its link; reserved and taken names are refused', async () => {
    co = await h.createCompany({ name: 'Taawoni Co' });
    owner = await h.login(co.email, co.password);
    assert.equal((await owner.form('/app/settings/company-link', { slug: 'admin' })).status, 422);
    assert.equal((await owner.form('/app/settings/company-link', { slug: 'ab' })).status, 422);
    assert.equal((await owner.form('/app/settings/company-link', { slug: 'تعاوني' })).status, 422);
    const other = await h.createCompany({ name: 'Other' });
    await h.knex('organizations').where({ id: other.organizationId }).update({ slug: 'busy' });
    assert.equal((await owner.form('/app/settings/company-link', { slug: 'busy' })).status, 422);
    const ok = await owner.form('/app/settings/company-link', { slug: 'Taawoni' });
    assert.equal(ok.status, 302);
    assert.equal((await h.knex('organizations').where({ id: co.organizationId }).first()).slug, 'taawoni');
    assert.match((await owner.get('/app/settings/company')).text, /\/taawoni/);
  });

  test('the link shows the company and the ways in; unknown links are 404', async () => {
    const page = await pub().get('/taawoni');
    assert.equal(page.status, 200);
    assert.match(page.text, /Taawoni Co/);
    for (const k of ['employee', 'manager', 'hr', 'payroll', 'recruitment', 'admin']) assert.ok(page.text.includes(`?as=${k}`), k);
    assert.equal((await pub().get('/no-such-company')).status, 404);
    assert.equal((await pub().get('/pricing')).status, 200, 'real pages are not shadowed');
    // Starter plan: no payroll / recruitment entries
    const st = await h.createCompany({ plan: 'starter', name: 'Small' });
    await h.knex('organizations').where({ id: st.organizationId }).update({ slug: 'small-co' });
    h.cache.clear();
    const small = await pub().get('/small-co');
    assert.ok(!small.text.includes('?as=payroll') && !small.text.includes('?as=recruitment'));
  });

  test('signing in from the link opens the chosen area when allowed, only for members', async () => {
    const hr = await h.addMember(co.organizationId, 'hr_manager');
    const emp = await h.addMember(co.organizationId, 'employee');
    const a = pub();
    const page = await a.get('/taawoni?as=hr');
    assert.match(page.text, /name="portal" value="taawoni"/);
    const r = await a.post('/login').type('form').send({ _csrf: csrfOf(page.text), portal: 'taawoni', as: 'hr', email: hr.email, password: hr.password });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/app/employees');

    const b = pub();
    const p2 = await b.get('/taawoni?as=hr');
    const r2 = await b.post('/login').type('form').send({ _csrf: csrfOf(p2.text), portal: 'taawoni', as: 'hr', email: emp.email, password: emp.password });
    assert.equal(r2.headers.location, '/app', 'no HR permission: normal dashboard');

    const stranger = await h.createCompany({ name: 'Stranger' });
    const c = pub();
    const p3 = await c.get('/taawoni?as=employee');
    const r3 = await c.post('/login').type('form').send({ _csrf: csrfOf(p3.text), portal: 'taawoni', as: 'employee', email: stranger.email, password: stranger.password });
    assert.equal(r3.status, 409);
    assert.match(r3.text, /not a member/);
    assert.equal((await c.get('/app')).status, 302, 'not signed in');
  });

  test('a signed-in member picking an area goes straight there (form post, not a plain link)', async () => {
    const page = await owner.get('/taawoni');
    assert.match(page.text, /action="\/taawoni\/enter"/);
    const r = await owner.form('/taawoni/enter', { as: 'admin' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/app/settings/company');
    const noCsrf = await owner.agent.post('/taawoni/enter').type('form').send({ as: 'admin' });
    assert.notEqual(noCsrf.headers.location, '/app/settings/company', 'CSRF token required');
  });
});

describe('QR attendance', () => {
  const kioskSvc = require('../src/modules/attendance/kiosk.service');
  let co; let owner; let emp; let kioskId;
  async function linkedEmployee(orgId, member) {
    const [id] = await h.knex('employees').insert({ organization_id: orgId, first_name: 'Sara', last_name: 'QR', email: member.email, user_id: member.userId, status: 'active', employee_number: `E${Date.now()}` });
    return id;
  }
  const scanUrl = async () => {
    const k = await h.knex('attendance_kiosks').where({ id: kioskId }).first();
    return new URL((await kioskSvc.currentQr(k, '::ffff:127.0.0.1')).url).pathname;
  };

  test('HR adds a screen; the screen link shows a QR that refreshes', async () => {
    co = await h.createCompany();
    owner = await h.login(co.email, co.password);
    assert.equal((await owner.form('/app/attendance/qr', { name: '' })).status, 422);
    assert.equal((await owner.form('/app/attendance/qr', { name: 'Main entrance' })).status, 302);
    kioskId = (await h.knex('attendance_kiosks').where({ organization_id: co.organizationId }).first()).id;
    const open = await owner.get(`/app/attendance/qr/${kioskId}/open`);
    assert.equal(open.status, 302);
    const path = new URL(open.headers.location).pathname;
    const screen = await pub().get(path);
    assert.equal(screen.status, 200);
    assert.match(screen.text, /<svg/);
    assert.match(screen.text, /data-kiosk-src/);
    const json = await pub().get(`${path}/qr`).set('accept', 'application/json');
    assert.equal(json.status, 200);
    assert.match(json.body.data.svg, /<svg/);
    assert.ok(json.body.data.expiresIn > 0 && json.body.data.expiresIn <= 60);
    assert.equal((await pub().get('/kiosk/not-a-token')).status, 404);
    // Another company cannot open it
    const other = await h.createCompany();
    const os = await h.login(other.email, other.password);
    assert.equal((await os.get(`/app/attendance/qr/${kioskId}/open`)).status, 404);
  });

  test('an employee scans, signs in, and clocks in then out by QR', async () => {
    emp = await h.addMember(co.organizationId, 'employee');
    await linkedEmployee(co.organizationId, emp);
    // Not signed in: the scan is remembered while signing in
    const a = pub();
    const first = await a.get(await scanUrl());
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, '/login');
    const lp = await a.get('/login');
    const li = await a.post('/login').type('form').send({ _csrf: csrfOf(lp.text), email: emp.email, password: emp.password });
    assert.equal(li.headers.location, `/q/${(await h.knex('attendance_kiosks').where({ id: kioskId }).first()).public_id}`);
    const confirm = await a.get(li.headers.location);
    assert.equal(confirm.status, 200);
    assert.match(confirm.text, /value="in"/);
    const done = await a.post(li.headers.location).type('form').send({ _csrf: csrfOf(confirm.text), action: 'in' });
    assert.equal(done.status, 200);
    assert.match(done.text, /scan-done/);
    let row = await h.knex('attendance').where({ organization_id: co.organizationId }).first();
    assert.ok(row.clock_in);
    assert.equal(row.clock_in_method, 'qr');
    assert.equal(row.kiosk_id, kioskId);
    // The ticket is used up: posting again needs a new scan
    const again = await a.post(li.headers.location).type('form').send({ _csrf: csrfOf(confirm.text), action: 'out' });
    assert.equal(again.status, 410);
    // Scan again to clock out
    const s2 = await a.get(await scanUrl());
    assert.equal(s2.status, 302);
    const c2 = await a.get(s2.headers.location);
    assert.match(c2.text, /value="out"/);
    await a.post(s2.headers.location).type('form').send({ _csrf: csrfOf(c2.text), action: 'out' });
    row = await h.knex('attendance').where({ id: row.id }).first();
    assert.ok(row.clock_out);
    assert.equal(row.clock_out_method, 'qr');
  });

  test('screen link and QR use the address the site was opened on, not localhost', async () => {
    const open = await owner.agent.get(`/app/attendance/qr/${kioskId}/open`).set('Host', 'hr.example-co.test');
    assert.equal(open.status, 302);
    assert.match(open.headers.location, /^http:\/\/hr\.example-co\.test\/kiosk\/[a-f0-9]{48}$/);
    const token = open.headers.location.split('/kiosk/')[1];
    const q = await h.request(h.getApp()).get(`/kiosk/${token}/qr`).set('Host', 'hr.example-co.test');
    const k = await h.knex('attendance_kiosks').where({ id: kioskId }).first();
    const shown = await require('../src/modules/attendance/kiosk.service').currentQr(k, null, 'https://remoteway.net');
    assert.match(shown.url, /^https:\/\/remoteway\.net\/q\//);
    assert.equal(q.status, 200);
  });

  test('the code changes every 10 seconds and several people can scan it together', async () => {
    assert.equal(kioskSvc.STEP_MS, 10_000);
    const k = await h.knex('attendance_kiosks').where({ id: kioskId }).first();
    const secret = require('../src/core/secrets').decrypt(k.secret_enc);
    const now = Date.now();
    const step = kioskSvc.stepOf(now);
    const code = `${step}.${kioskSvc.codeFor(secret, k.public_id, step)}`;
    // Two phones, same code, same moment
    const [a, b] = await Promise.all([kioskSvc.checkScan(k.public_id, code, null, now), kioskSvc.checkScan(k.public_id, code, null, now)]);
    assert.equal(a.id, k.id);
    assert.equal(b.id, k.id);
    // A slow camera: a code from up to 30 seconds ago still works; older ones do not
    const at = (st) => `${st}.${kioskSvc.codeFor(secret, k.public_id, st)}`;
    assert.ok(await kioskSvc.checkScan(k.public_id, at(step - 2), null, now));
    await assert.rejects(kioskSvc.checkScan(k.public_id, at(step - 3), null, now), /expired/);
    const shown = await kioskSvc.currentQr(k, null);
    assert.ok(shown.expiresIn >= 1 && shown.expiresIn <= 10);
    assert.equal(shown.stepSeconds, 10);
  });

  test('old, forged and other-company codes are refused', async () => {
    const k = await h.knex('attendance_kiosks').where({ id: kioskId }).first();
    const secret = require('../src/core/secrets').decrypt(k.secret_enc);
    const step = kioskSvc.stepOf();
    const old = `/q/${k.public_id}/${step - 3}.${kioskSvc.codeFor(secret, k.public_id, step - 3)}`;
    assert.equal((await pub().get(old)).status, 410);
    assert.equal((await pub().get(`/q/${k.public_id}/${step}.aaaaaaaaaaaa`)).status, 404);
    assert.equal((await pub().get(`/q/${k.public_id}/${step + 5}.${kioskSvc.codeFor(secret, k.public_id, step + 5)}`)).status, 410, 'future codes too');
    // A member of another company scanning this company's screen
    const other = await h.createCompany();
    const os = await h.login(other.email, other.password);
    const s = await os.agent.get(await scanUrl());
    const c = await os.agent.get(s.headers.location);
    const r = await os.agent.post(s.headers.location).type('form').send({ _csrf: csrfOf(c.text), action: 'in' });
    assert.equal(r.status, 403);
  });

  test('a new screen link cancels open scans; off-network scans are marked for managers', async () => {
    const e3 = await h.addMember(co.organizationId, 'employee');
    await linkedEmployee(co.organizationId, e3);
    const s = await h.login(e3.email, e3.password);
    // Scan while the screen is seen from another network (off-network, but allowed: same_network is off)
    await h.knex('attendance_kiosks').where({ id: kioskId }).update({ last_ip: '203.0.113.9', recent_ips: null });
    const k0 = await h.knex('attendance_kiosks').where({ id: kioskId }).first();
    const sec0 = require('../src/core/secrets').decrypt(k0.secret_enc);
    const st = kioskSvc.stepOf();
    const first = await s.agent.get(`/q/${k0.public_id}/${st}.${kioskSvc.codeFor(sec0, k0.public_id, st)}`);
    const c1 = await s.agent.get(first.headers.location);
    // The screen link is regenerated before the person confirms: the scan no longer counts
    await owner.form(`/app/attendance/qr/${kioskId}/regenerate`, {});
    const late = await s.agent.post(first.headers.location).type('form').send({ _csrf: csrfOf(c1.text), action: 'in' });
    assert.equal(late.status, 404);
    // A fresh scan works and is flagged as off-network
    const k1 = await h.knex('attendance_kiosks').where({ id: kioskId }).first();
    const sec1 = require('../src/core/secrets').decrypt(k1.secret_enc);
    const again = await s.agent.get(`/q/${k1.public_id}/${st}.${kioskSvc.codeFor(sec1, k1.public_id, kioskSvc.stepOf())}`.replace(`/${st}.`, `/${kioskSvc.stepOf()}.`));
    const c2 = await s.agent.get(again.headers.location);
    await s.agent.post(again.headers.location).type('form').send({ _csrf: csrfOf(c2.text), action: 'in' });
    const row = await h.knex('attendance as a').join('employees as e', 'e.id', 'a.employee_id').where('e.user_id', e3.userId).first('a.*');
    assert.equal(row.clock_in_method, 'qr');
    assert.equal(Boolean(row.qr_off_network), true);
    assert.match((await owner.get('/app/attendance')).text, /qr-tag off/);
  });

  test('same-network screens refuse phones on another network', async () => {
    await h.knex('attendance_kiosks').where({ id: kioskId }).update({ same_network: true, last_ip: '203.0.113.9', recent_ips: null });
    const k = await h.knex('attendance_kiosks').where({ id: kioskId }).first();
    const secret = require('../src/core/secrets').decrypt(k.secret_enc);
    const step = kioskSvc.stepOf();
    const r = await pub().get(`/q/${k.public_id}/${step}.${kioskSvc.codeFor(secret, k.public_id, step)}`);
    assert.equal(r.status, 403);
    assert.match(r.text, /office network/);
    await h.knex('attendance_kiosks').where({ id: kioskId }).update({ same_network: false });
  });

  test('when QR is required the clock-in button is replaced and refused', async () => {
    assert.equal((await owner.form('/app/attendance/qr/settings', { qr_required: '1' })).status, 302);
    const e2 = await h.addMember(co.organizationId, 'employee');
    await linkedEmployee(co.organizationId, e2);
    const s = await h.login(e2.email, e2.password);
    const home = await s.get('/app');
    assert.match(home.text, /qr-hint/);
    const r = await s.form('/app/attendance/clock', { action: 'in' });
    assert.equal(r.status, 302);
    assert.equal(await h.knex('attendance').where({ organization_id: co.organizationId }).whereIn('employee_id', h.knex('employees').where({ user_id: e2.userId }).select('id')).first(), undefined);
  });
});
