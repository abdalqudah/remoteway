// Platform-level (non-tenant) catalog: countries, permissions, features, plans, add-ons.
exports.up = async (knex) => {
  await knex.schema.createTable('country_policies', (t) => {
    t.string('country_code', 2).primary();
    t.string('name', 100).notNullable();
    t.string('name_ar', 100);
    t.string('currency', 3).notNullable();
    t.string('timezone', 64).notNullable();
    t.string('default_locale', 5).notNullable().defaultTo('en');
    t.string('date_format', 20).notNullable().defaultTo('YYYY-MM-DD');
    t.json('working_days').notNullable(); // e.g. ["sun","mon","tue","wed","thu"]
    t.decimal('vat_rate', 5, 2).notNullable().defaultTo(0);
    t.json('rules'); // country-specific payroll / compliance rules (consumed by the Country Policy Engine)
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('permissions', (t) => {
    t.increments('id');
    t.string('key', 80).notNullable().unique();
    t.string('module', 40).notNullable();
    t.string('description', 255);
  });

  await knex.schema.createTable('features', (t) => {
    t.increments('id');
    t.string('key', 60).notNullable().unique();
    t.string('name', 100).notNullable();
    t.string('module', 40).notNullable();
    t.string('description', 255);
    // available = implemented; coming_soon = shown but disabled; integration_required = needs provider config
    t.enu('availability', ['available', 'coming_soon', 'integration_required']).notNullable().defaultTo('coming_soon');
    t.integer('sort_order').notNullable().defaultTo(0);
  });

  await knex.schema.createTable('plans', (t) => {
    t.increments('id');
    t.string('key', 40).notNullable().unique();
    t.string('name', 80).notNullable();
    t.string('tagline', 255);
    t.string('tagline_ar', 255);
    t.string('currency', 3).notNullable().defaultTo('SAR');
    t.decimal('price_monthly', 12, 2); // null = custom pricing (contact sales)
    t.decimal('price_yearly', 12, 2);
    t.integer('trial_days').notNullable().defaultTo(14);
    t.boolean('is_public').notNullable().defaultTo(true);
    t.boolean('is_custom').notNullable().defaultTo(false);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('plan_features', (t) => {
    t.integer('plan_id').unsigned().notNullable().references('plans.id').onDelete('CASCADE');
    t.integer('feature_id').unsigned().notNullable().references('features.id').onDelete('CASCADE');
    t.primary(['plan_id', 'feature_id']);
  });

  // Usage limits per plan. limit_value NULL = unlimited.
  await knex.schema.createTable('plan_limits', (t) => {
    t.integer('plan_id').unsigned().notNullable().references('plans.id').onDelete('CASCADE');
    t.string('limit_key', 40).notNullable();
    t.bigInteger('limit_value').nullable();
    t.primary(['plan_id', 'limit_key']);
  });

  await knex.schema.createTable('addons', (t) => {
    t.increments('id');
    t.string('key', 60).notNullable().unique();
    t.string('name', 100).notNullable();
    t.string('description', 255);
    t.string('currency', 3).notNullable().defaultTo('SAR');
    t.decimal('price_monthly', 12, 2);
    t.integer('feature_id').unsigned().nullable().references('features.id').onDelete('SET NULL');
    t.string('limit_key', 40).nullable();
    t.bigInteger('limit_increment').nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
  });
};

exports.down = async (knex) => {
  for (const table of ['addons', 'plan_limits', 'plan_features', 'plans', 'features', 'permissions', 'country_policies']) {
    await knex.schema.dropTableIfExists(table);
  }
};
