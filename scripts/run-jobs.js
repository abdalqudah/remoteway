// Processes queued jobs (webhooks, emails, SMS, chat) once and exits.
// Optional on shared hosting — the app already runs jobs every 15 seconds while it is awake.
// Add a cPanel cron job to also cover quiet hours:   */5 * * * *   cd ~/remoteway && node scripts/run-jobs.js
require('dotenv').config();
const knex = require('../src/db/knex');
const jobs = require('../src/modules/integrations/handlers');

(async () => {
  try {
    await require('../src/modules/reports/reports.service').dispatchDue(); // due scheduled reports
    let total = { done: 0, retry: 0, dead: 0 };
    for (let i = 0; i < 20; i += 1) {
      const r = await jobs.runDue({ limit: 50 });
      if (r.skipped) break;
      total = { done: total.done + r.done, retry: total.retry + r.retry, dead: total.dead + r.dead };
      if (r.done + r.retry + r.dead === 0) break;
    }
    console.log(`[jobs] done=${total.done} retry=${total.retry} dead=${total.dead}`);
  } catch (err) {
    console.error('[jobs] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
