// npm run migrate            -> apply pending migrations + reference data (+ super admin from .env)
// npm run migrate -- --fresh -> DROP everything and rebuild (development only)
const knex = require('../src/db/knex');
const config = require('../src/config');
const { seedReference, ensureSuperAdmin } = require('../src/db/seed-reference');

(async () => {
  try {
    if (process.argv.includes('--fresh')) {
      if (config.isProd) throw new Error('Refusing to run --fresh in production.');
      await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
      const [tables] = await knex.raw('SHOW TABLES');
      for (const row of tables) await knex.schema.dropTableIfExists(Object.values(row)[0]);
      await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
      console.log('Dropped all tables.');
    }
    const [, applied] = await knex.migrate.latest();
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database schema is up to date.');
    await seedReference(knex, { log: console.log });
    console.log('Reference data (countries, permissions, roles, features, plans, add-ons) is in place.');
    const adminId = await ensureSuperAdmin(knex, {
      email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD, name: process.env.SUPER_ADMIN_NAME,
    }, config.bcryptRounds);
    if (adminId) console.log(`Super admin ready: ${process.env.SUPER_ADMIN_EMAIL}`);
    else console.log('No SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD set; skipped super admin.');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
