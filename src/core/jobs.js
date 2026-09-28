// Database-backed job queue. Works on shared hosting: jobs are picked up by a timer inside the
// running app and, optionally, by a cron job (`npm run jobs`) — both are safe to run together
// because each job is claimed with a conditional UPDATE before it runs.
const os = require('os');
const knex = require('../db/knex');

const TABLE = 'background_jobs'; // not `jobs`: that table holds recruitment job postings
const handlers = new Map();
const WORKER = `${os.hostname()}:${process.pid}`.slice(0, 64);
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200, 86400]; // 1m, 5m, 30m, 2h, 12h, 24h

class PermanentError extends Error {} // a failure that retrying cannot fix (e.g. 4xx from a provider)

function register(type, handler) { handlers.set(type, handler); }

async function enqueue(trx, { organizationId = null, type, payload = {}, runAt = new Date(), maxAttempts = 6 }) {
  const [id] = await (trx || knex)(TABLE).insert({ organization_id: organizationId, type, payload: JSON.stringify(payload), status: 'pending', run_at: runAt, max_attempts: maxAttempts });
  return id;
}

const nextRun = (attempts) => new Date(Date.now() + (BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)] * 1000));

async function runOne(job) {
  const claimed = await knex(TABLE).where({ id: job.id, status: 'pending' }).update({ status: 'running', locked_at: new Date(), locked_by: WORKER, attempts: job.attempts + 1 });
  if (!claimed) return null; // another worker took it
  const handler = handlers.get(job.type);
  const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
  const attempts = job.attempts + 1;
  try {
    if (!handler) throw new PermanentError(`No handler for job type ${job.type}`);
    await handler(payload, { job: { ...job, attempts }, final: attempts >= job.max_attempts });
    await knex(TABLE).where({ id: job.id }).update({ status: 'done', finished_at: new Date(), last_error: null, locked_at: null });
    return 'done';
  } catch (err) {
    const permanent = err instanceof PermanentError;
    const dead = permanent || attempts >= job.max_attempts;
    await knex(TABLE).where({ id: job.id }).update({
      status: dead ? 'dead' : 'pending', run_at: dead ? job.run_at : nextRun(attempts), locked_at: null,
      last_error: String(err.message || err).slice(0, 1000), finished_at: dead ? new Date() : null,
    });
    return dead ? 'dead' : 'retry';
  }
}

let running = false;
/** Processes due jobs. Returns counts. */
async function runDue({ limit = 25 } = {}) {
  if (running) return { skipped: true };
  running = true;
  const stats = { done: 0, retry: 0, dead: 0 };
  try {
    // Recover jobs left "running" by a process that died.
    await knex(TABLE).where('status', 'running').where('locked_at', '<', new Date(Date.now() - 10 * 60_000)).update({ status: 'pending', locked_at: null });
    const due = await knex(TABLE).where('status', 'pending').where('run_at', '<=', new Date()).orderBy('run_at').limit(limit);
    for (const job of due) {
      const r = await runOne(job);
      if (r) stats[r] += 1;
    }
  } finally {
    running = false;
  }
  return stats;
}

let timer = null;
function startWorker(intervalMs = 15_000) {
  if (timer) return;
  timer = setInterval(() => { runDue().catch((e) => console.error('[jobs]', e.message)); }, intervalMs);
  timer.unref();
}
function stopWorker() { if (timer) clearInterval(timer); timer = null; }

async function stats() {
  const rows = await knex(TABLE).groupBy('status').select('status').count({ n: '*' });
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  const [{ oldest }] = await knex(TABLE).where('status', 'pending').min({ oldest: 'run_at' });
  return { by, oldestPending: oldest };
}

/** Removes finished jobs older than N days. */
async function prune(days = 30) {
  return knex(TABLE).whereIn('status', ['done', 'dead']).where('updated_at', '<', new Date(Date.now() - days * 86_400_000)).del();
}

module.exports = { register, enqueue, runDue, runOne, startWorker, stopWorker, stats, prune, PermanentError, BACKOFF_SECONDS };
