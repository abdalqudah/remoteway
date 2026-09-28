// Phase 7 — Integrations: a database-backed job queue (table background_jobs; `jobs` holds job postings), encrypted platform settings (SMTP),
// signed outbound webhooks with a delivery log, SMS / chat providers, and calendar feed tokens.
const TABLES = ['calendar_tokens', 'integration_logs', 'integration_settings', 'webhook_deliveries', 'webhook_endpoints', 'background_jobs', 'platform_settings'];

exports.up = async (knex) => {
  // MySQL DDL is not transactional: clear leftovers of a previously interrupted run of this migration.
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);

  await knex.schema.createTable('platform_settings', (t) => {
    t.string('key', 80).primary();
    t.json('value');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('background_jobs', (t) => {
    t.bigIncrements('id');
    t.integer('organization_id').unsigned().nullable().references('organizations.id').onDelete('CASCADE');
    t.string('type', 40).notNullable();
    t.json('payload');
    t.enu('status', ['pending', 'running', 'done', 'failed', 'dead']).notNullable().defaultTo('pending');
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('max_attempts').notNullable().defaultTo(6);
    t.datetime('run_at').notNullable();
    t.datetime('locked_at').nullable();
    t.string('locked_by', 64);
    t.string('last_error', 1000);
    t.datetime('finished_at').nullable();
    t.timestamps(true, true);
    t.index(['status', 'run_at'], 'job_status_run_idx');
    t.index(['organization_id', 'type'], 'job_org_type_idx');
  });

  await knex.schema.createTable('webhook_endpoints', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('url', 500).notNullable();
    t.string('description', 200);
    t.text('secret_enc').notNullable();
    t.json('events').notNullable(); // ["*"] or a list of event names
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('failure_count').notNullable().defaultTo(0); // consecutive failed deliveries
    t.string('disabled_reason', 255);
    t.datetime('last_success_at').nullable();
    t.datetime('last_failure_at').nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['organization_id', 'is_active'], 'whe_org_active_idx');
  });

  await knex.schema.createTable('webhook_deliveries', (t) => {
    t.bigIncrements('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('endpoint_id').unsigned().notNullable().references('webhook_endpoints.id').onDelete('CASCADE');
    t.string('event', 60).notNullable();
    t.string('event_id', 40).notNullable();
    t.json('payload').notNullable();
    t.enu('status', ['pending', 'success', 'failed']).notNullable().defaultTo('pending');
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('response_status').nullable();
    t.string('response_body', 1000);
    t.string('error', 500);
    t.integer('duration_ms').nullable();
    t.datetime('next_retry_at').nullable();
    t.datetime('delivered_at').nullable();
    t.timestamps(true, true);
    t.index(['endpoint_id', 'id'], 'whd_endpoint_idx');
    t.index(['organization_id', 'created_at'], 'whd_org_created_idx');
  });

  await knex.schema.createTable('integration_settings', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('kind', 20).notNullable(); // sms | chat
    t.string('provider', 30).notNullable();
    t.text('config_enc'); // encrypted JSON (credentials)
    t.json('options'); // non-secret options: sender, events…
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['organization_id', 'kind'], 'is_org_kind_uq');
  });

  await knex.schema.createTable('integration_logs', (t) => {
    t.bigIncrements('id');
    t.integer('organization_id').unsigned().nullable().references('organizations.id').onDelete('CASCADE');
    t.string('channel', 20).notNullable(); // email | sms | chat
    t.string('target', 190);
    t.string('summary', 255);
    t.enu('status', ['sent', 'failed']).notNullable();
    t.string('error', 500);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['organization_id', 'channel', 'id'], 'il_org_channel_idx');
  });

  await knex.schema.createTable('calendar_tokens', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.enu('kind', ['personal', 'company_leave']).notNullable();
    t.string('token_hash', 64).notNullable().unique();
    t.string('token_hint', 8);
    t.text('token_enc'); // so the owner can see their feed URL again
    t.datetime('last_used_at').nullable();
    t.timestamps(true, true);
    t.unique(['organization_id', 'user_id', 'kind'], 'ct_org_user_kind_uq');
  });
};

exports.down = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
};
