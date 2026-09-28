const http = require('http');

const PORT = process.env.PORT || 3000;

// Human-readable hints for the most common hosting mistakes. Never includes passwords.
const HINTS = {
  ER_ACCESS_DENIED_ERROR: ['Database user or password is wrong, or the user is not added to the database.',
    'اسم مستخدم قاعدة البيانات أو كلمة المرور خطأ، أو المستخدم غير مضاف للقاعدة. من cPanel > MySQL Databases: غيّر كلمة مرور المستخدم وضعها في DB_PASSWORD، وأضف المستخدم للقاعدة بصلاحيات ALL PRIVILEGES.'],
  ER_BAD_DB_ERROR: ['Database does not exist.', 'قاعدة البيانات غير موجودة. تأكد أن DB_NAME مكتوب تماماً كما في cPanel.'],
  ECONNREFUSED: ['Cannot reach MySQL.', 'لا يمكن الوصول إلى MySQL. جرّب DB_HOST=127.0.0.1 أو أضف DB_SOCKET=/var/lib/mysql/mysql.sock'],
  ENOENT: ['MySQL socket not found.', 'ملف socket غير موجود. احذف متغير DB_SOCKET واستخدم DB_HOST=localhost'],
  MISSING_ENV: ['A required environment variable is missing.', 'متغير مطلوب غير موجود في إعدادات التطبيق.'],
  MODULE_NOT_FOUND: ['Dependencies are not installed.', 'الحزم غير مثبتة. اضغط Run NPM Install ثم RESTART.'],
  MYISAM_TABLES: ['Some tables use the MyISAM engine and the database already has data.',
    'بعض الجداول تستخدم محرك MyISAM والقاعدة فيها بيانات. من phpMyAdmin حوّل الجداول إلى InnoDB أو تواصل مع الدعم الفني.'],
  BOOT_LOCK_TIMEOUT: ['Another process is still starting the app.', 'عملية أخرى ما زالت تشغّل التطبيق. انتظر دقيقة ثم حدّث الصفحة.'],
  ER_TOO_LONG_KEY: ['Database engine is MyISAM.', 'محرك قاعدة البيانات MyISAM. اضغط RESTART، وإذا تكرر الخطأ احذف كل الجداول من phpMyAdmin ثم RESTART.'],
};

/**
 * A first run on a host that defaults to MyISAM leaves half-created MyISAM tables. If the database
 * holds no organizations yet (fresh install, nothing to lose), drop them so migrations rebuild as InnoDB.
 */
async function repairFreshMyIsamInstall(knex) {
  const [rows] = await knex.raw(
    "SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
  );
  if (!rows.some((r) => String(r.engine).toLowerCase() === 'myisam')) return;
  const hasOrgs = rows.some((r) => r.name === 'organizations')
    && Number((await knex('organizations').count({ n: '*' }))[0].n) > 0;
  if (hasOrgs) throw Object.assign(new Error('MyISAM tables with existing data'), { code: 'MYISAM_TABLES' });
  console.warn('[db] fresh install with MyISAM tables detected: rebuilding all tables as InnoDB');
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  for (const r of rows) await knex.schema.dropTableIfExists(r.name);
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
}

/**
 * Hosts like LiteSpeed may start several app processes at the same moment. A MySQL named lock
 * (held on one dedicated connection) makes them run migrations/seeding one at a time; the others
 * wait, then find nothing left to do. Because only the lock holder can be migrating, a leftover
 * knex migration lock (from a process killed mid-migration) is stale and safe to release.
 */
async function bootDatabase(knex, work) {
  await knex.transaction(async (trx) => {
    const [[{ got }]] = await trx.raw("SELECT GET_LOCK('remoteway_boot', 180) AS got");
    if (got !== 1) throw Object.assign(new Error('Timed out waiting for another process to finish starting'), { code: 'BOOT_LOCK_TIMEOUT' });
    try {
      if (await knex.schema.hasTable('knex_migrations_lock')) {
        const row = await knex('knex_migrations_lock').first();
        if (row && row.is_locked) {
          console.warn('[db] releasing a stale migration lock left by an interrupted start');
          await knex.migrate.forceFreeMigrationsLock();
        }
      }
      await work();
    } finally {
      await trx.raw("SELECT RELEASE_LOCK('remoteway_boot')");
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * If the app cannot start (bad DB credentials, missing variables, missing modules), serve a setup
 * page that explains the problem instead of letting the host show a bare 503.
 */
function serveSetupError(err) {
  const code = err.code || (/Missing required environment variable/.test(err.message) ? 'MISSING_ENV' : 'STARTUP_ERROR');
  const [en, ar] = HINTS[code] || ['The application could not start.', 'تعذّر تشغيل التطبيق. راجع ملف stderr.log.'];
  const detail = code === 'MISSING_ENV' ? err.message : code;
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RemoteWay — Setup</title><style>body{font-family:system-ui,Tahoma,sans-serif;background:#f7f7f7;color:#0a0a0a;margin:0;display:grid;place-items:center;min-height:100vh}
.c{background:#fff;border:1px solid #e2e2e2;border-radius:16px;padding:32px;max-width:560px;margin:16px}h1{font-size:20px;margin:0 0 12px}
.b{display:inline-block;background:#1acc6c;border-radius:999px;padding:4px 12px;font-weight:700;font-size:12px}code{background:#f2f2f2;padding:2px 6px;border-radius:6px}
p{line-height:1.7}.en{direction:ltr;text-align:left;color:#4a4a4a;font-size:14px;border-top:1px solid #e2e2e2;padding-top:12px;margin-top:16px}</style></head>
<body><div class="c"><span class="b">RemoteWay</span><h1>التطبيق يحتاج إعداد</h1><p>${escapeHtml(ar)}</p><p>رمز الخطأ: <code>${escapeHtml(detail)}</code></p>
<p>بعد التصحيح اضغط <b>RESTART</b> في صفحة Setup Node.js App.</p><div class="en">${escapeHtml(en)} Error: <code>${escapeHtml(detail)}</code>. Fix it, then click RESTART.</div></div></body></html>`;
  http.createServer((req, res) => {
    res.writeHead(503, { 'Content-Type': req.url === '/healthz' ? 'application/json' : 'text/html; charset=utf-8', 'Retry-After': '60' });
    res.end(req.url === '/healthz' ? JSON.stringify({ status: 'setup_error', code: detail }) : html);
  }).listen(PORT, () => console.error(`[remoteway] serving setup error page (${detail})`));
  // Exit after a minute so the host starts a fresh process: transient problems (a busy database,
  // a restart race) then fix themselves; configuration problems simply show this page again.
  setTimeout(() => process.exit(1), 60_000).unref();
}

async function start() {
  const config = require('./config');
  const knex = require('./db/knex');
  const { createApp } = require('./app');
  const { seedReference, ensureSuperAdmin } = require('./db/seed-reference');

  await knex.raw('select 1'); // fail fast with a clear code if the database is unreachable
  if (config.autoMigrate) {
    await bootDatabase(knex, async () => {
      await repairFreshMyIsamInstall(knex);
      const [, applied] = await knex.migrate.latest();
      if (applied.length) console.log(`[db] applied migrations: ${applied.join(', ')}`);
      await seedReference(knex);
      await ensureSuperAdmin(knex, {
        email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD, name: process.env.SUPER_ADMIN_NAME,
      }, config.bcryptRounds);
    });
  }
  const app = createApp();
  // Background work (webhooks, emails, SMS, chat) runs inside the app every 15 seconds.
  await require('./core/mailer').refresh();
  const jobs = require('./modules/integrations/handlers');
  jobs.startWorker();
  setInterval(() => jobs.prune(30).catch(() => {}), 24 * 3600_000).unref();
  // Scheduled reports: queue deliveries that are due (each is claimed once, even with several processes).
  const reports = require('./modules/reports/reports.service');
  setInterval(() => reports.dispatchDue().catch((e) => console.error('[reports]', e.message)), 60_000).unref();
  // Phusion Passenger / LiteSpeed (cPanel "Setup Node.js App") passes a socket path via PORT; listen() accepts both.
  const server = app.listen(PORT, () => console.log(`[remoteway] listening on ${PORT} (${config.env})`));
  const shutdown = () => server.close(() => knex.destroy().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('[remoteway] failed to start:', err.code || '', err.message);
  serveSetupError(err);
});
