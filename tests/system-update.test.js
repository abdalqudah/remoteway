const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const bcrypt = require('bcryptjs');
const h = require('./helpers');

const ROOT = process.env.UPDATER_APP_ROOT;
const realPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

function makePackage({ version = '9.9.9', name = 'remoteway', extra = {}, deps = realPkg.dependencies } = {}) {
  const zip = new AdmZip();
  zip.addFile('app.js', Buffer.from("require('./src/server');\n"), '', 0o644);
  zip.addFile('src/server.js', Buffer.from(`// v${version}\n`), '', 0o644);
  zip.addFile('package.json', Buffer.from(JSON.stringify({ name, version, dependencies: deps })), '', 0o644);
  zip.addFile('build.json', Buffer.from(JSON.stringify({ version, commit: 'abc1234' })), '', 0o644);
  zip.addFile('public/brand/logo.png', Buffer.from('png'), '', 0o600);
  for (const [k, v] of Object.entries(extra)) zip.addFile(k, Buffer.from(v), '', 0o644);
  return zip.toBuffer();
}

describe('super admin system update', () => {
  let admin; let owner;

  before(async () => {
    await h.resetDatabase();
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({ name: 'remoteway', version: '0.1.0', dependencies: realPkg.dependencies }));
    fs.writeFileSync(path.join(ROOT, 'app.js'), '// old\n');
    fs.writeFileSync(path.join(ROOT, 'src', 'server.js'), '// v0.1.0\n');
    fs.writeFileSync(path.join(ROOT, '.env'), 'SECRET=keep-me\n');
    await h.knex('users').insert({ name: 'Root', email: 'root@test.local', password_hash: bcrypt.hashSync('Password#123', 4), is_super_admin: true });
    admin = h.request.agent(h.getApp());
    const lp = await admin.get('/login');
    await admin.post('/login').type('form').send({ _csrf: lp.text.match(/name="csrf-token" content="([^"]+)"/)[1], email: 'root@test.local', password: 'Password#123' });
    const c = await h.createCompany();
    owner = await h.login(c.email, c.password);
  });
  after(() => h.knex.destroy());

  const token = async () => (await admin.get('/admin/system')).text.match(/name="csrf-token" content="([^"]+)"/)[1];
  const upload = async (buffer, password = 'Password#123', name = 'remoteway-dist.zip') => {
    const csrf = await token();
    return admin.post('/admin/system/update').field('_csrf', csrf).field('password', password).attach('file', buffer, name);
  };

  test('only super admins can open or use the update page', async () => {
    assert.equal((await owner.get('/admin/system')).status, 403);
    const res = await owner.agent.post('/admin/system/update').field('_csrf', owner.csrf).field('password', 'x').attach('file', makePackage(), 'a.zip');
    assert.equal(res.status, 403);
    assert.equal((await admin.get('/admin/system')).status, 200);
  });

  test('wrong password, non-zip, foreign and unsafe packages are rejected without changes', async () => {
    assert.equal((await upload(makePackage(), 'wrong-password')).status, 422);
    assert.equal((await upload(Buffer.from('not a zip'))).status, 422);
    assert.equal((await upload(makePackage({ name: 'something-else' }))).status, 422);
    const slip = new AdmZip(makePackage());
    slip.addFile('evil.js', Buffer.from('x'));
    slip.getEntries().find((e) => e.entryName === 'evil.js').entryName = 'src/../../evil.js'; // raw traversal, as in a crafted zip
    const res = await upload(slip.toBuffer());
    assert.equal(res.status, 422);
    assert.equal(fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8'), '// v0.1.0\n');
    assert.equal(fs.existsSync(path.join(ROOT, '..', 'evil.js')), false);
  });

  test('a valid package is installed with a backup, readable files and an untouched .env', async () => {
    const res = await upload(makePackage({ extra: { '.env': 'SECRET=overwritten\n', 'node_modules/x/index.js': 'bad' } }));
    assert.equal(res.status, 302, res.text.slice(0, 200));
    assert.match(res.headers.location, /updated=9\.9\.9/);
    assert.equal(fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8'), '// v9.9.9\n');
    assert.equal(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'), 'SECRET=keep-me\n');
    assert.equal(fs.existsSync(path.join(ROOT, 'node_modules', 'x')), false);
    assert.equal(fs.statSync(path.join(ROOT, 'public', 'brand', 'logo.png')).mode & 0o777, 0o644);
    assert.ok(fs.existsSync(path.join(ROOT, 'tmp', 'restart.txt')));
    const page = await admin.get('/admin/system');
    assert.match(page.text, /v0\.1\.0/); // backup listed
    assert.ok(await h.knex('audit_logs').where({ action: 'platform.system_updated' }).first());
  });

  test('a previous version can be restored', async () => {
    const updater = require('../src/modules/admin/updater.service');
    const [backup] = updater.listBackups();
    const csrf = await token();
    const res = await admin.post('/admin/system/restore').type('form').send({ _csrf: csrf, password: 'Password#123', backup: backup.id });
    assert.equal(res.status, 302);
    assert.equal(fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8'), '// v0.1.0\n');
    assert.equal(updater.currentVersion().version, '0.1.0');
    const bad = await admin.post('/admin/system/restore').type('form').send({ _csrf: csrf, password: 'Password#123', backup: '../../etc' });
    assert.equal(bad.status, 404);
  });
});
