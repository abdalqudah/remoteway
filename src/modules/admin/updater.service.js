// In-app system update for hosts without shell access (cPanel).
// Flow: validate the uploaded package → back up the running version → copy new files over the app
// → install dependencies only if they changed → restart. Migrations run on the next start (AUTO_MIGRATE).
// Never touched: .env, node_modules, uploaded documents (they live outside the app folder), tmp/.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');
const config = require('../../config');
const audit = require('../../core/audit');
const { AppError } = require('../../core/errors');

// UPDATER_APP_ROOT exists for automated tests only (they update a scratch copy, never the running app).
const APP_ROOT = path.resolve(process.env.UPDATER_APP_ROOT || path.join(__dirname, '..', '..', '..'));
const WORK_ROOT = path.resolve(process.env.UPDATES_PATH || path.join(APP_ROOT, '..', 'remoteway-updates'));
const BACKUPS = path.join(WORK_ROOT, 'backups');
const LOG_FILE = path.join(WORK_ROOT, 'update-log.json');

// What an update package may contain and what gets backed up / replaced.
const MANAGED = ['app.js', 'knexfile.js', 'package.json', 'package-lock.json', 'build.json', 'README.md', '.env.example', 'src', 'public', 'scripts', 'docs'];
const NEVER = new Set(['.env', 'node_modules', 'tmp', 'stderr.log']);
const MAX_ZIP_BYTES = 30 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 120 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const KEEP_BACKUPS = 3;

const fail = (code, message) => new AppError(code, message, 422);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function currentVersion() {
  const pkg = readJson(path.join(APP_ROOT, 'package.json')) || {};
  const build = readJson(path.join(APP_ROOT, 'build.json')) || {};
  return { version: pkg.version || 'unknown', commit: build.commit || null, builtAt: build.builtAt || null, node: process.version, root: APP_ROOT };
}

/** Parses and validates an uploaded package without writing anything. */
function inspect(buffer) {
  if (!buffer?.length) throw fail('UPDATE_FILE_REQUIRED', 'Choose the RemoteWay update package (.zip).');
  if (buffer.length > MAX_ZIP_BYTES) throw fail('UPDATE_TOO_LARGE', 'The package is larger than 30 MB.');
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw fail('UPDATE_NOT_ZIP', 'This is not a .zip file.');
  let zip;
  try { zip = new AdmZip(buffer); } catch { throw fail('UPDATE_NOT_ZIP', 'The zip file could not be read.'); }
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) throw fail('UPDATE_TOO_LARGE', 'The package contains too many files.');

  // Accept packages whose files sit inside a single top folder (e.g. "dist/").
  const names = entries.map((e) => e.entryName.replace(/\\/g, '/'));
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const prefix = tops.size === 1 && !names.includes('app.js') && names.some((n) => n.endsWith('/app.js')) ? `${[...tops][0]}/` : '';

  let unpacked = 0;
  const files = [];
  for (const e of entries) {
    const name = e.entryName.replace(/\\/g, '/');
    if (!name.startsWith(prefix)) continue;
    const rel = name.slice(prefix.length);
    if (!rel || e.isDirectory) continue;
    // Zip-slip protection: no absolute paths, no "..", only known top-level entries.
    if (rel.startsWith('/') || rel.split('/').some((p) => p === '..' || p === '') || /^[a-zA-Z]:/.test(rel)) throw fail('UPDATE_UNSAFE_PATH', `Unsafe path in package: ${rel}`);
    const top = rel.split('/')[0];
    if (NEVER.has(top)) continue;
    if (!MANAGED.includes(top)) continue;
    unpacked += e.header.size;
    if (unpacked > MAX_UNPACKED_BYTES) throw fail('UPDATE_TOO_LARGE', 'The package is too large when unpacked.');
    files.push({ rel, entry: e });
  }
  const has = (p) => files.some((f) => f.rel === p);
  if (!has('app.js') || !has('package.json') || !has('src/server.js')) throw fail('UPDATE_INVALID', 'This is not a RemoteWay package (app.js, package.json and src/ are required).');
  const pkg = JSON.parse(files.find((f) => f.rel === 'package.json').entry.getData().toString('utf8'));
  if (pkg.name !== 'remoteway') throw fail('UPDATE_INVALID', 'This package is not RemoteWay.');
  const buildFile = files.find((f) => f.rel === 'build.json');
  const build = buildFile ? JSON.parse(buildFile.entry.getData().toString('utf8')) : {};
  return { files, pkg, build, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

function depsChanged(oldPkg, newPkg) {
  return JSON.stringify(oldPkg?.dependencies || {}) !== JSON.stringify(newPkg?.dependencies || {});
}

function copyManaged(fromRoot, toRoot) {
  for (const item of MANAGED) {
    const src = path.join(fromRoot, item);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(toRoot, item), { recursive: true, force: true });
  }
}

function backup(label) {
  const dir = path.join(BACKUPS, `${new Date().toISOString().replace(/[:.]/g, '-')}_${label.replace(/[^a-z0-9.-]/gi, '')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  copyManaged(APP_ROOT, dir);
  // Keep only the newest backups.
  const all = fs.readdirSync(BACKUPS).sort().reverse();
  for (const old of all.slice(KEEP_BACKUPS)) fs.rmSync(path.join(BACKUPS, old), { recursive: true, force: true });
  return dir;
}

function listBackups() {
  if (!fs.existsSync(BACKUPS)) return [];
  return fs.readdirSync(BACKUPS).sort().reverse().map((id) => {
    const pkg = readJson(path.join(BACKUPS, id, 'package.json')) || {};
    const build = readJson(path.join(BACKUPS, id, 'build.json')) || {};
    return { id, version: pkg.version || '?', commit: build.commit || null, createdAt: fs.statSync(path.join(BACKUPS, id)).mtime };
  });
}

function readLog() {
  return readJson(LOG_FILE) || [];
}

function writeLog(entry) {
  fs.mkdirSync(WORK_ROOT, { recursive: true, mode: 0o700 });
  const log = [entry, ...readLog()].slice(0, 20);
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

/** Runs `npm install --omit=dev` with the same Node that runs the app (works inside cPanel's nodevenv). */
function npmInstall() {
  const candidates = [
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const cli = candidates.find((c) => fs.existsSync(c));
  return new Promise((resolve) => {
    const [cmd, args] = cli ? [process.execPath, [cli]] : ['npm', []];
    execFile(cmd, [...args, 'install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: APP_ROOT, timeout: 5 * 60_000, maxBuffer: 5 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, output: String(err ? (stderr || err.message) : stdout).slice(-2000) }));
  });
}

/** Asks the host to restart the app (Passenger / LiteSpeed watch tmp/restart.txt), then exits this process. */
function scheduleRestart() {
  const tmp = path.join(APP_ROOT, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'restart.txt'), new Date().toISOString());
  if (config.isTest) return;
  setTimeout(() => process.exit(0), 1500).unref();
}

async function apply(ctx, buffer, originalName) {
  const pkgBefore = readJson(path.join(APP_ROOT, 'package.json'));
  const info = inspect(buffer);
  const from = currentVersion();
  const backupDir = backup(`v${from.version}`);
  try {
    for (const f of info.files) {
      const dest = path.join(APP_ROOT, f.rel);
      if (!dest.startsWith(APP_ROOT + path.sep)) throw fail('UPDATE_UNSAFE_PATH', 'Unsafe path in package.');
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
      fs.writeFileSync(dest, f.entry.getData(), { mode: 0o644 });
      fs.chmodSync(dest, 0o644); // existing files keep old modes otherwise (e.g. unreadable 0600 assets)
    }
    let npm = null;
    if (depsChanged(pkgBefore, info.pkg)) {
      npm = await npmInstall();
      if (!npm.ok) throw new AppError('UPDATE_NPM_FAILED', 'New dependencies could not be installed automatically. The previous version was restored. Upload the files manually and click "Run NPM Install" in cPanel.', 500, { output: npm.output });
    }
    const entry = {
      at: new Date().toISOString(), by: ctx.userEmail, action: 'update', from: from.version, to: info.pkg.version, commit: info.build.commit || null,
      file: String(originalName || '').slice(0, 120), sha256: info.sha256, files: info.files.length, npm: npm ? 'installed' : 'unchanged', ok: true,
    };
    writeLog(entry);
    await audit.record(ctx, 'platform.system_updated', { entityType: 'system', newValues: { from: from.version, to: info.pkg.version, sha256: info.sha256 } });
    scheduleRestart();
    return entry;
  } catch (err) {
    copyManaged(backupDir, APP_ROOT);
    writeLog({ at: new Date().toISOString(), by: ctx.userEmail, action: 'update', from: from.version, to: info.pkg.version, ok: false, error: err.message });
    throw err;
  }
}

async function restore(ctx, backupId) {
  const id = path.basename(String(backupId || ''));
  const dir = path.join(BACKUPS, id);
  if (!id || !fs.existsSync(path.join(dir, 'package.json'))) throw new AppError('NOT_FOUND', 'Backup not found.', 404);
  const pkgBefore = readJson(path.join(APP_ROOT, 'package.json'));
  const target = readJson(path.join(dir, 'package.json'));
  const from = currentVersion();
  backup(`v${from.version}-before-restore`);
  copyManaged(dir, APP_ROOT);
  if (depsChanged(pkgBefore, target)) await npmInstall();
  writeLog({ at: new Date().toISOString(), by: ctx.userEmail, action: 'restore', from: from.version, to: target.version, ok: true });
  await audit.record(ctx, 'platform.system_restored', { entityType: 'system', newValues: { from: from.version, to: target.version, backup: id } });
  scheduleRestart();
  return { to: target.version };
}

module.exports = { APP_ROOT, WORK_ROOT, currentVersion, inspect, apply, restore, listBackups, readLog, MAX_ZIP_BYTES };
