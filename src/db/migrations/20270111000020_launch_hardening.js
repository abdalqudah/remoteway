// Launch hardening: password reset tokens, two-factor authentication (TOTP), and an error log the
// platform team can read in Super Admin (production errors otherwise only reach the host's logs).
const TABLES = ['app_errors', 'password_resets'];

exports.up = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
  await knex.schema.createTable('password_resets', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('token_hash', 64).notNullable().unique(); // SHA-256 of the emailed token; the token itself is never stored
    t.datetime('expires_at').notNullable();
    t.datetime('used_at').nullable();
    t.string('ip', 64);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['user_id', 'created_at'], 'pr_user_idx');
  });
  await knex.schema.createTable('app_errors', (t) => {
    t.bigIncrements('id');
    t.string('method', 10);
    t.string('path', 500);
    t.integer('status').notNullable().defaultTo(500);
    t.string('code', 60);
    t.string('message', 1000);
    t.text('stack');
    t.integer('user_id').unsigned().nullable();
    t.integer('organization_id').unsigned().nullable();
    t.string('ip', 64);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['created_at'], 'appe_created_idx');
  });
  const cols = [
    ['two_factor_secret_enc', (t) => t.string('two_factor_secret_enc', 500).nullable()],
    ['two_factor_enabled_at', (t) => t.datetime('two_factor_enabled_at').nullable()],
    ['two_factor_recovery', (t) => t.json('two_factor_recovery').nullable()], // SHA-256 of one-time recovery codes
    ['two_factor_last_step', (t) => t.bigInteger('two_factor_last_step').nullable()], // a code is accepted once
    ['password_changed_at', (t) => t.datetime('password_changed_at').nullable()],
    ['deleted_at', (t) => t.datetime('deleted_at').nullable()],
  ];
  for (const [name, def] of cols) {
    if (!(await knex.schema.hasColumn('users', name))) await knex.schema.alterTable('users', def);
  }
};

exports.down = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
};
