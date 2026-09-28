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
};

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
}

async function start() {
  const config = require('./config');
  const knex = require('./db/knex');
  const { createApp } = require('./app');
  const { seedReference, ensureSuperAdmin } = require('./db/seed-reference');

  await knex.raw('select 1'); // fail fast with a clear code if the database is unreachable
  if (config.autoMigrate) {
    const [, applied] = await knex.migrate.latest();
    if (applied.length) console.log(`[db] applied migrations: ${applied.join(', ')}`);
    await seedReference(knex);
    await ensureSuperAdmin(knex, {
      email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD, name: process.env.SUPER_ADMIN_NAME,
    }, config.bcryptRounds);
  }
  const app = createApp();
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
