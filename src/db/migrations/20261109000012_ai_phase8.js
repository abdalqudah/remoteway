// Phase 8 — AI layer: per-organization governance switches, a metered request log (tokens, cost,
// latency, status) and saved insights (candidate match, document summary, analytics answers).
// The provider, model and API key are platform settings (platform_settings key 'ai', key encrypted).
const TABLES = ['ai_insights', 'ai_requests', 'ai_settings'];

exports.up = async (knex) => {
  // MySQL DDL is not transactional: clear leftovers of a previously interrupted run of this migration.
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);

  await knex.schema.createTable('ai_settings', (t) => {
    t.integer('organization_id').unsigned().primary().references('organizations.id').onDelete('CASCADE');
    t.boolean('enabled').notNullable().defaultTo(false);
    t.json('features'); // enabled AI areas: recruitment, documents, performance, learning, analytics
    t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('ai_requests', (t) => {
    t.bigIncrements('id');
    t.integer('organization_id').unsigned().nullable().references('organizations.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('feature', 20).notNullable();
    t.string('action', 40).notNullable();
    t.string('provider', 20);
    t.string('model', 120);
    t.string('entity_type', 30);
    t.integer('entity_id').unsigned().nullable();
    t.integer('tokens_in').notNullable().defaultTo(0);
    t.integer('tokens_out').notNullable().defaultTo(0);
    t.decimal('cost_usd', 12, 6).nullable();
    t.integer('latency_ms').nullable();
    t.enu('status', ['ok', 'error', 'invalid']).notNullable();
    t.string('error', 500);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['organization_id', 'created_at'], 'air_org_created_idx');
  });

  await knex.schema.createTable('ai_insights', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('action', 40).notNullable();
    t.string('entity_type', 30).notNullable();
    t.integer('entity_id').unsigned().notNullable();
    t.string('locale', 5).notNullable();
    t.json('output');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['organization_id', 'entity_type', 'entity_id', 'action'], 'aii_entity_idx');
  });

  // New plan feature: AI for Learning, added to every plan that already includes AI Performance.
  await knex('features').insert({ key: 'ai_learning', name: 'AI Learning', module: 'ai', availability: 'available', sort_order: 30 })
    .onConflict('key').ignore();
  const learning = await knex('features').where({ key: 'ai_learning' }).first('id');
  const perf = await knex('features').where({ key: 'ai_performance' }).first('id');
  if (learning && perf) {
    const planIds = (await knex('plan_features').where({ feature_id: perf.id }).select('plan_id')).map((r) => r.plan_id);
    for (const planId of planIds) await knex('plan_features').insert({ plan_id: planId, feature_id: learning.id }).onConflict().ignore();
  }
};

exports.down = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
};
