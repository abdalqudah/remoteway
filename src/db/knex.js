const knexFactory = require('knex');
const config = require('../config');

const knex = knexFactory({
  client: 'mysql2',
  connection: {
    // DB_SOCKET (e.g. /var/lib/mysql/mysql.sock) connects through the local socket, like PHP does on cPanel.
    ...(process.env.DB_SOCKET ? { socketPath: process.env.DB_SOCKET } : { host: config.db.host, port: config.db.port }),
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: false,
    decimalNumbers: true,
    supportBigNumbers: true,
  },
  pool: { min: 0, max: Number(process.env.DB_POOL_MAX || 10) },
  migrations: { directory: require('path').join(__dirname, 'migrations'), tableName: 'knex_migrations' },
});

module.exports = knex;
