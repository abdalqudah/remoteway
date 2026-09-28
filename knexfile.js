// Used by the knex CLI (npx knex migrate:latest). The app itself uses src/db/knex.js.
const config = require('./src/config');
const path = require('path');

module.exports = {
  client: 'mysql2',
  connection: { ...config.db, charset: 'utf8mb4', timezone: 'Z' },
  migrations: { directory: path.join(__dirname, 'src', 'db', 'migrations'), tableName: 'knex_migrations' },
};
