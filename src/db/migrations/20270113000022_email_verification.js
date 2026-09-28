// Email verification: accounts prove they own their address. Accounts that existed before this
// release are treated as verified so nobody already using the platform is interrupted.
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('users', 'email_verified_at'))) {
    await knex.schema.alterTable('users', (t) => { t.datetime('email_verified_at').nullable(); });
    await knex('users').update({ email_verified_at: knex.raw('COALESCE(created_at, NOW())') });
  }
  await knex.schema.dropTableIfExists('email_verifications');
  await knex.schema.createTable('email_verifications', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('email', 190).notNullable();
    t.string('token_hash', 64).notNullable().unique();
    t.datetime('expires_at').notNullable();
    t.datetime('used_at').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['user_id', 'created_at']);
  });
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('email_verifications');
  if (await knex.schema.hasColumn('users', 'email_verified_at')) await knex.schema.alterTable('users', (t) => { t.dropColumn('email_verified_at'); });
};
