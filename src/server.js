const config = require('./config');
const knex = require('./db/knex');
const { createApp } = require('./app');
const { seedReference, ensureSuperAdmin } = require('./db/seed-reference');

async function start() {
  if (config.autoMigrate) {
    const [, applied] = await knex.migrate.latest();
    if (applied.length) console.log(`[db] applied migrations: ${applied.join(', ')}`);
    await seedReference(knex);
    await ensureSuperAdmin(knex, {
      email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD, name: process.env.SUPER_ADMIN_NAME,
    });
  }
  const app = createApp();
  // Phusion Passenger (cPanel "Setup Node.js App") passes a socket path via PORT; listen() accepts both.
  const server = app.listen(process.env.PORT || config.port, () => {
    console.log(`[remoteway] listening on ${process.env.PORT || config.port} (${config.env})`);
  });
  const shutdown = () => server.close(() => knex.destroy().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('[remoteway] failed to start', err);
  process.exit(1);
});
