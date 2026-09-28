// Session store table used by connect-session-knex (web logins are kept in MySQL).
exports.up = async (knex) => {
  if (await knex.schema.hasTable('sessions')) return;
  await knex.schema.createTable('sessions', (t) => {
    t.string('sid', 255).primary();
    t.json('sess').notNullable();
    t.dateTime('expired').notNullable().index();
  });
};

exports.down = (knex) => knex.schema.dropTableIfExists('sessions');
