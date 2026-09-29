// Copy of a company's data to its own database (white label): connection, choices, schedule and run log.
exports.up = async (knex) => {
  await knex.schema.createTable('organization_data_sync', (t) => {
    t.integer('organization_id').unsigned().primary().references('organizations.id').onDelete('CASCADE');
    t.string('driver', 10).notNullable().defaultTo('mysql'); // mysql | postgres
    t.string('host', 190).notNullable();
    t.integer('port').unsigned().notNullable();
    t.string('database_name', 64).notNullable();
    t.string('username', 64).notNullable();
    t.text('password_enc').nullable();
    t.boolean('ssl').notNullable().defaultTo(true);
    t.string('table_prefix', 16).notNullable().defaultTo('rw_');
    t.json('datasets');
    t.string('frequency', 10).notNullable().defaultTo('daily'); // manual | hourly | daily
    t.boolean('enabled').notNullable().defaultTo(true);
    t.datetime('next_run_at').nullable();
    t.datetime('running_since').nullable();
    t.datetime('last_run_at').nullable();
    t.string('last_status', 10).nullable(); // ok | failed
    t.text('last_error').nullable();
    t.datetime('verified_at').nullable();
    t.integer('updated_by').unsigned().nullable();
    t.timestamps(true, true);
    t.index(['enabled', 'next_run_at'], 'ods_due_idx');
  });
  await knex.schema.createTable('data_sync_runs', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('trigger', 10).notNullable(); // manual | schedule
    t.string('status', 10).notNullable(); // running | ok | failed
    t.json('counts');
    t.text('error').nullable();
    t.integer('duration_ms').unsigned().nullable();
    t.integer('started_by').unsigned().nullable();
    t.datetime('started_at').notNullable();
    t.datetime('finished_at').nullable();
    t.index(['organization_id', 'started_at'], 'dsr_org_idx');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('data_sync_runs');
  await knex.schema.dropTableIfExists('organization_data_sync');
};
