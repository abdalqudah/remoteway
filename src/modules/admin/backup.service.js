// Database backups in pure Node (no mysqldump needed — works on shared cPanel hosting).
// A backup is a gzip'd SQL file: every table's CREATE statement followed by its rows as INSERTs.
// Files live outside the app folder (next to the updater's folder) so updates never touch them.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const cache = require('../../core/cache');
const { AppError, E } = require('../../core/errors');
const { WORK_ROOT } = require('./updater.service');

const DIR = path.resolve(process.env.BACKUP_PATH || path.join(WORK_ROOT, 'db-backups'));
const HEADER = '-- RemoteWay database backup';
const NAME_RE = /^remoteway-db-\d{8}-\d{6}(-[a-z0-9-]{1,40})?\.sql\.gz$/;
const SKIP_DATA = new Set(['sessions']); // signed-in sessions are not worth restoring
const CHUNK = 500;
const DEFAULTS = { enabled: true, hour: 2, keep: 14 };

const ensureDir = () => fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const fileOf = (name) => {
  const n = path.basename(String(name || ''));
  if (!NAME_RE.test(n) || !fs.existsSync(path.join(DIR, n))) throw new AppError('NOT_FOUND', 'Backup not found.', 404);
  return path.join(DIR, n);
};

async function settings() {
  const row = await knex('platform_settings').where({ key: 'backups' }).first();
  const v = row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : {};
  return { ...DEFAULTS, ...v };
}

async function saveSettings(ctx, input) {
  const hour = Number(input.hour);
  const keep = Number(input.keep);
  const errors = {};
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) errors.hour = 'Choose an hour between 0 and 23.';
  if (!Number.isInteger(keep) || keep < 1 || keep > 90) errors.keep = 'Keep between 1 and 90 backups.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const value = JSON.stringify({ enabled: Boolean(input.enabled), hour, keep });
  await knex('platform_settings').insert({ key: 'backups', value }).onConflict('key').merge({ value, updated_at: new Date() });
  await audit.record(ctx, 'platform.backups_updated', { newValues: JSON.parse(value) });
}

function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((n) => NAME_RE.test(n)).map((name) => {
    const st = fs.statSync(path.join(DIR, name));
    const label = (name.match(/-\d{6}-([a-z0-9-]+)\.sql\.gz$/) || [])[1] || 'manual';
    return { name, size: st.size, createdAt: st.mtime, label };
  }).sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
}

const val = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) return v.length ? `X'${v.toString('hex')}'` : "''";
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'object') return mysql.escape(JSON.stringify(v)); // JSON columns arrive parsed
  return mysql.escape(String(v));
};

/** Streams every table (schema + rows) into a new gzip'd SQL file. */
async function create(ctx, { label = 'manual' } = {}) {
  ensureDir();
  const name = `remoteway-db-${stamp()}-${String(label).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'manual'}.sql.gz`;
  const target = path.join(DIR, name);
  const conn = await knex.client.acquireConnection();
  const q = (sql, opts = {}) => new Promise((resolve, reject) => conn.query({ sql, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, ...opts }, (e, rows) => (e ? reject(e) : resolve(rows))));
  let tables = 0; let rowsOut = 0;
  // TIMESTAMP values are written in UTC so a restore on a server in another time zone keeps them right.
  const [{ tz }] = await q('SELECT @@session.time_zone AS tz');
  await q("SET time_zone = '+00:00'");
  async function* sql() {
    const [{ v }] = await q('SELECT VERSION() AS v');
    yield `${HEADER}\n-- Created: ${new Date().toISOString()}\n-- Server: ${v}\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nSET time_zone='+00:00';\n\n`;
    const all = (await q("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'")).map((r) => Object.values(r)[0]);
    for (const t of all) {
      tables += 1;
      const create = (await q(`SHOW CREATE TABLE \`${t}\``))[0]['Create Table'];
      yield `DROP TABLE IF EXISTS \`${t}\`;\n${create};\n`;
      if (SKIP_DATA.has(t)) { yield '\n'; continue; }
      const cols = (await q(`SHOW COLUMNS FROM \`${t}\``)).map((c) => c.Field);
      const colSql = cols.map((c) => `\`${c}\``).join(',');
      for (let offset = 0; ; offset += CHUNK) {
        const rows = await q(`SELECT * FROM \`${t}\` LIMIT ${CHUNK} OFFSET ${offset}`, { rowsAsArray: true });
        if (!rows.length) break;
        rowsOut += rows.length;
        yield `INSERT INTO \`${t}\` (${colSql}) VALUES\n${rows.map((r) => `(${r.map(val).join(',')})`).join(',\n')};\n`;
        if (rows.length < CHUNK) break;
      }
      yield '\n';
    }
    yield 'SET FOREIGN_KEY_CHECKS=1;\n-- End of backup\n';
  }
  const started = Date.now();
  try {
    await pipeline(Readable.from(sql()), zlib.createGzip({ level: 6 }), fs.createWriteStream(`${target}.part`, { mode: 0o600 }));
    fs.renameSync(`${target}.part`, target);
  } catch (e) {
    fs.rmSync(`${target}.part`, { force: true });
    throw e;
  } finally {
    await q(`SET time_zone = ${mysql.escape(tz)}`).catch(() => {});
    knex.client.releaseConnection(conn);
  }
  const size = fs.statSync(target).size;
  await prune();
  await audit.record(ctx || {}, 'platform.backup_created', { newValues: { name, size, tables, rows: rowsOut, ms: Date.now() - started } });
  return { name, size, tables, rows: rowsOut };
}

/** Keeps the newest `keep` backups. */
async function prune() {
  const { keep } = await settings();
  for (const b of list().slice(keep)) fs.rmSync(path.join(DIR, b.name), { force: true });
}

function remove(ctx, name) {
  fs.rmSync(fileOf(name));
  return audit.record(ctx, 'platform.backup_deleted', { newValues: { name: path.basename(name) } });
}

const openRead = (name) => fs.createReadStream(fileOf(name));

/** Reads a backup file back as a list of SQL statements (each ends with ';' at the end of a line). */
async function statements(file) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  if (!text.startsWith(HEADER)) throw new AppError('BACKUP_INVALID', 'This file is not a RemoteWay database backup.', 422);
  if (!/-- End of backup\n?$/.test(text)) throw new AppError('BACKUP_INVALID', 'The backup file is incomplete.', 422);
  const out = [];
  let cur = [];
  for (const line of text.split('\n')) {
    if (!cur.length && (line.startsWith('--') || !line.trim())) continue;
    cur.push(line);
    if (line.endsWith(';')) { out.push(cur.join('\n')); cur = []; }
  }
  return out;
}

/** Replaces the whole database with a backup. Takes a safety backup first. */
async function restore(ctx, name, password) {
  const file = fileOf(name);
  const user = await knex('users').where({ id: ctx.userId }).first();
  if (!user || !(await bcrypt.compare(String(password || ''), user.password_hash))) throw E.validation({ password: 'Current password is incorrect.' });
  const stmts = await statements(file);
  const safety = await create(ctx, { label: 'before-restore' });
  const conn = await knex.client.acquireConnection();
  const q = (sql) => new Promise((resolve, reject) => conn.query(sql, (e, rows) => (e ? reject(e) : resolve(rows))));
  const [{ tz }] = await q('SELECT @@session.time_zone AS tz');
  try {
    for (const s of stmts) await q(s);
  } finally {
    try { await q('SET FOREIGN_KEY_CHECKS=1'); await q(`SET time_zone = ${mysql.escape(tz)}`); } catch { /* connection may be gone */ }
    knex.client.releaseConnection(conn);
  }
  cache.clear();
  await audit.record(ctx, 'platform.backup_restored', { newValues: { name: path.basename(file), safety: safety.name, statements: stmts.length } });
  return { safety: safety.name, statements: stmts.length };
}

/** Adds an uploaded backup (e.g. from another server) to the list, after checking it. */
async function importFile(ctx, buffer) {
  if (!buffer?.length) throw E.validation({ file: 'Choose a backup file (.sql.gz).' });
  let text;
  try { text = zlib.gunzipSync(buffer).toString('utf8'); } catch { throw E.validation({ file: 'This is not a .sql.gz file.' }); }
  if (!text.startsWith(HEADER) || !/-- End of backup\n?$/.test(text)) throw E.validation({ file: 'This file is not a complete RemoteWay database backup.' });
  ensureDir();
  const name = `remoteway-db-${stamp()}-imported.sql.gz`;
  fs.writeFileSync(path.join(DIR, name), buffer, { mode: 0o600 });
  await audit.record(ctx, 'platform.backup_imported', { newValues: { name, size: buffer.length } });
  return name;
}

/** Called hourly: takes the daily automatic backup once the chosen hour has passed. */
async function autoBackup(now = new Date()) {
  const s = await settings();
  if (!s.enabled || now.getUTCHours() < s.hour) return null;
  const today = now.toISOString().slice(0, 10);
  if (list().some((b) => b.label === 'auto' && new Date(b.createdAt).toISOString().slice(0, 10) === today)) return null;
  return create({}, { label: 'auto' });
}

module.exports = { DIR, settings, saveSettings, list, create, remove, restore, importFile, openRead, autoBackup, statements };
