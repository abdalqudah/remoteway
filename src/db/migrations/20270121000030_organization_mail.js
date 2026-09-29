// Each company's own mailbox (SMTP): emails to its people come from the company's address.
exports.up = async (knex) => {
  await knex.schema.createTable('organization_mail', (t) => {
    t.integer('organization_id').unsigned().primary().references('organizations.id').onDelete('CASCADE');
    t.string('host', 190).notNullable();
    t.integer('port').unsigned().notNullable().defaultTo(465);
    t.string('username', 190).nullable();
    t.text('password_enc').nullable();
    t.string('from_email', 190).notNullable();
    t.string('from_name', 120).nullable();
    t.boolean('enabled').notNullable().defaultTo(false); // only after a successful test message
    t.datetime('verified_at').nullable();
    t.text('last_error').nullable();
    t.datetime('last_error_at').nullable();
    t.integer('updated_by').unsigned().nullable();
    t.timestamps(true, true);
  });
};
exports.down = (knex) => knex.schema.dropTableIfExists('organization_mail');
