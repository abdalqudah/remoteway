// Flexible SMTP: security mode, authentication mode, provider preset and Reply-To for company mailboxes
// (the platform email keeps its JSON in platform_settings.smtp and gains the same fields there),
// plus a diagnostic log of SMTP checks and failures (never passwords).
exports.up = async (knex) => {
  await knex.schema.alterTable('organization_mail', (t) => {
    t.string('provider', 20).notNullable().defaultTo('custom');
    t.string('security', 10).nullable(); // none | starttls | ssl
    t.string('auth_mode', 10).notNullable().defaultTo('password'); // password | none
    t.string('reply_to', 190).nullable();
  });
  // Existing mailboxes keep working exactly as before: 465 = SSL/TLS, 587 = STARTTLS, others = none.
  await knex('organization_mail').where({ port: 465 }).update({ security: 'ssl' });
  await knex('organization_mail').where({ port: 587 }).update({ security: 'starttls' });
  await knex('organization_mail').whereNull('security').update({ security: 'none' });
  await knex('organization_mail').where((q) => q.whereNull('username').orWhere('username', '')).update({ auth_mode: 'none' });
  await knex.schema.createTable('smtp_events', (t) => {
    t.increments('id');
    t.string('scope', 10).notNullable(); // platform | company
    t.integer('organization_id').unsigned().nullable().references('organizations.id').onDelete('CASCADE');
    t.string('action', 20).notNullable(); // test_connection | test_email | send
    t.string('provider', 20);
    t.string('host', 190);
    t.integer('port').unsigned();
    t.string('security', 10);
    t.string('auth_mode', 10);
    t.boolean('success').notNullable();
    t.string('error_code', 40).nullable();
    t.string('error_kind', 20).nullable();
    t.string('error_message', 500).nullable();
    t.integer('duration_ms').unsigned().nullable();
    t.integer('user_id').unsigned().nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['scope', 'organization_id', 'created_at'], 'smtp_ev_idx');
  });
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('smtp_events');
  await knex.schema.alterTable('organization_mail', (t) => { t.dropColumn('provider'); t.dropColumn('security'); t.dropColumn('auth_mode'); t.dropColumn('reply_to'); });
};
