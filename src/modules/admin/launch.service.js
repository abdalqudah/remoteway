// Launch readiness: live checks of the things that must be right before real customers arrive.
// Each check returns ok | warn | fail with a short fix; nothing here changes anything.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const knex = require('../../db/knex');
const config = require('../../config');
const mailer = require('../../core/mailer');
const storage = require('../../core/storage');
const backups = require('./backup.service');
const security = require('../auth/security.service');
const legal = require('../site/legal.service');
const payments = require('../payments/payments.service');
const ai = require('../ai/ai.service');

const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
const inside = (p) => path.resolve(p).startsWith(APP_ROOT + path.sep);
const writable = (dir) => { try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } };
const WEAK = new Set(['changeme', 'secret', 'change-me', 'please-change-me', 'test-secret-test-secret-test-secret']);
const DEFAULT_PASSWORDS = ['Admin@12345', 'Demo@12345', 'Password#123', 'admin', 'password'];

const c = (group, key, status, vars = {}) => ({ group, key, status, vars });

async function run(user) {
  const out = [];
  // ---------- Server ----------
  out.push(c('server', 'node_env', config.isProd ? 'ok' : 'fail', { env: config.env }));
  const https = /^https:\/\//.test(process.env.APP_URL || '');
  out.push(c('server', 'app_url', https ? 'ok' : 'fail', { url: process.env.APP_URL || '—' }));
  const sess = process.env.SESSION_SECRET || '';
  out.push(c('server', 'session_secret', sess.length >= 32 && !WEAK.has(sess) ? 'ok' : 'fail'));
  const appKey = process.env.APP_KEY || '';
  out.push(c('server', 'app_key', appKey.length >= 32 ? 'ok' : 'warn'));
  const major = Number(process.versions.node.split('.')[0]);
  out.push(c('server', 'node_version', major >= 20 ? 'ok' : 'fail', { v: process.version }));
  out.push(c('server', 'storage', writable(storage.root) && !inside(storage.root) ? 'ok' : 'fail', { dir: storage.root }));
  const [engines] = await knex.raw("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND ENGINE <> 'InnoDB'");
  out.push(c('server', 'innodb', Number(engines[0].n) === 0 ? 'ok' : 'fail', { n: Number(engines[0].n) }));

  // ---------- Security ----------
  out.push(c('security', 'my_2fa', security.hasTwoFactor(user) ? 'ok' : 'warn'));
  out.push(c('security', 'team_2fa', (await security.requireAdmin2fa()) ? 'ok' : 'warn'));
  const team = await knex('users').where({ is_super_admin: true, status: 'active' }).select('id', 'email', 'password_hash');
  const weak = [];
  for (const u of team) {
    for (const p of DEFAULT_PASSWORDS) { if (await bcrypt.compare(p, u.password_hash)) { weak.push(u.email); break; } }
  }
  out.push(c('security', 'default_passwords', weak.length ? 'fail' : 'ok', { emails: weak.join(', ') }));
  const demo = await knex('users').where('email', 'like', '%demo.remoteway.local').count({ n: '*' }).first();
  out.push(c('security', 'demo_data', Number(demo.n) ? 'warn' : 'ok', { n: Number(demo.n) }));

  // ---------- Operations ----------
  out.push(c('ops', 'email', mailer.currentConfig() ? 'ok' : 'fail'));
  const bs = await backups.settings();
  const last = backups.list()[0];
  const fresh = last && Date.now() - new Date(last.createdAt) < 26 * 3600_000;
  out.push(c('ops', 'backup_recent', fresh ? 'ok' : last ? 'warn' : 'fail', { when: last ? new Date(last.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '—' }));
  out.push(c('ops', 'backup_schedule', bs.enabled && writable(backups.DIR) && !inside(backups.DIR) ? 'ok' : 'fail', { dir: backups.DIR }));
  const errs = await knex('app_errors').where('created_at', '>=', new Date(Date.now() - 86400_000)).count({ n: '*' }).first();
  out.push(c('ops', 'errors', Number(errs.n) === 0 ? 'ok' : 'warn', { n: Number(errs.n) }));
  const dead = await knex('background_jobs').where({ status: 'dead' }).where('updated_at', '>=', new Date(Date.now() - 7 * 86400_000)).count({ n: '*' }).first().catch(() => ({ n: 0 }));
  out.push(c('ops', 'jobs', Number(dead.n) === 0 ? 'ok' : 'warn', { n: Number(dead.n) }));

  // ---------- Business ----------
  const pay = await payments.rawConfig();
  const gateways = Object.keys(pay.providers || {}).filter((k) => pay.providers[k]?.enabled);
  out.push(c('business', 'payments', gateways.length && pay.mode === 'live' ? 'ok' : gateways.length ? 'warn' : 'fail', { mode: pay.mode, list: gateways.join(', ') || '—' }));
  const d = await legal.details();
  out.push(c('business', 'legal', d.company !== 'RemoteWay' && d.email ? 'ok' : 'warn'));
  const plans = await knex('plans').where({ is_public: true }).count({ n: '*' }).first().catch(() => ({ n: 1 }));
  out.push(c('business', 'plans', Number(plans.n) ? 'ok' : 'fail', { n: Number(plans.n) }));
  const aiCfg = await ai.rawConfig();
  out.push(c('business', 'ai', aiCfg && aiCfg.enabled && aiCfg.api_key_enc ? 'ok' : 'warn'));

  const score = { ok: out.filter((x) => x.status === 'ok').length, warn: out.filter((x) => x.status === 'warn').length, fail: out.filter((x) => x.status === 'fail').length };
  return { checks: out, score, ready: score.fail === 0 };
}

module.exports = { run };
