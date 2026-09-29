// Creates "RemoteWay Demo Company" with demo users for each role.
// For demos and local development only — refuses to run when NODE_ENV=production unless --force.
//   npm run seed:demo            (password: DEMO_PASSWORD or Demo@12345)
const knex = require('../src/db/knex');
const config = require('../src/config');
const { seedReference } = require('../src/db/seed-reference');
const sample = require('../src/db/sample-company');

const PASSWORD = process.env.DEMO_PASSWORD || 'Demo@12345';
const DOMAIN = 'demo.remoteway.local';

(async () => {
  try {
    if (config.isProd && !process.argv.includes('--force')) throw new Error('Refusing to seed demo data in production (use --force to override).');
    await knex.migrate.latest();
    await seedReference(knex);

    const existing = await knex('users').where({ email: `owner@${DOMAIN}` }).first();
    if (existing) {
      if (process.argv.includes('--talent')) {
        await sample.seedTalent(existing.last_organization_id || (await knex('organizations').orderBy('id').first('id')).id, { domain: DOMAIN, password: PASSWORD });
        await knex('users').where('email', 'like', '%remoteway.local').whereNull('email_verified_at').update({ email_verified_at: new Date() });
        console.log('Talent marketplace demo data added.');
        return;
      }
      console.log('Demo company already exists. Run `npm run migrate:fresh` first to rebuild it (or add --talent for marketplace data).');
      return;
    }
    const r = await sample.createSampleCompany({ name: 'RemoteWay Demo Company', domain: DOMAIN, password: PASSWORD, planKey: 'business', talent: true });
    await knex('users').where('email', 'like', '%remoteway.local').whereNull('email_verified_at').update({ email_verified_at: new Date() });
    console.log('\nRemoteWay Demo Company is ready.');
    console.log(`Password for all demo users: ${PASSWORD}\n`);
    for (const a of r.accounts) console.log(`  ${a.role.padEnd(20)} ${a.email}`);
    if (process.env.SUPER_ADMIN_EMAIL) console.log(`  ${'super admin'.padEnd(20)} ${process.env.SUPER_ADMIN_EMAIL} (from .env)`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
