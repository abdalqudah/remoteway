// Server error log: unexpected (500) errors are kept in the database so the team can see them
// from the admin panel without shell access to the host's log files.
const knex = require('../../db/knex');

const cut = (v, n) => (v == null ? null : String(v).slice(0, n));
// Secrets never go into the log, even when an error message quotes them.
const scrub = (s) => (s == null ? s : String(s).replace(/(password|token|secret|apikey|api_key|authorization)(["'=:\s]+)[^\s"'&,}]+/gi, '$1$2[hidden]'));

async function record(err, req = {}) {
  try {
    await knex('app_errors').insert({
      method: cut(req.method, 10), path: cut(scrub((req.originalUrl || '').split('?')[0]), 500), status: 500,
      code: cut(err?.code, 60), message: cut(scrub(err?.message || String(err)), 1000), stack: cut(scrub(err?.stack), 8000),
      user_id: req.user?.id || null, organization_id: req.ctx?.organizationId || null, ip: cut(req.ip, 64),
    });
  } catch { /* never let logging break the error page */ }
}

async function list({ q, days = 30, limit = 200 } = {}) {
  const query = knex('app_errors as e').leftJoin('users as u', 'u.id', 'e.user_id')
    .where('e.created_at', '>=', new Date(Date.now() - days * 86400_000))
    .select('e.*', 'u.email as user_email').orderBy('e.id', 'desc').limit(limit);
  if (q) query.where((w) => w.where('e.message', 'like', `%${q}%`).orWhere('e.path', 'like', `%${q}%`));
  return query;
}

/** The same failure repeating is one problem: grouped by message and path. */
async function groups(days = 7) {
  return knex('app_errors').where('created_at', '>=', new Date(Date.now() - days * 86400_000))
    .select('message', 'path').count({ n: '*' }).max({ last: 'created_at' })
    .groupBy('message', 'path').orderBy('n', 'desc').limit(20);
}

async function counts() {
  const since = (h) => knex('app_errors').where('created_at', '>=', new Date(Date.now() - h * 3600_000)).count({ n: '*' }).first().then((r) => Number(r.n));
  return { day: await since(24), week: await since(24 * 7) };
}

const clear = () => knex('app_errors').del();
const prune = (days = 90) => knex('app_errors').where('created_at', '<', new Date(Date.now() - days * 86400_000)).del();

module.exports = { record, list, groups, counts, clear, prune };
