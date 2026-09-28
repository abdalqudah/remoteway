exports.up = async (knex) => {
  await knex.schema.createTable('subscriptions', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().unique().references('organizations.id').onDelete('CASCADE');
    t.integer('plan_id').unsigned().notNullable().references('plans.id');
    t.enu('status', ['trial', 'active', 'past_due', 'suspended', 'cancelled']).notNullable();
    t.enu('billing_cycle', ['monthly', 'yearly']).notNullable().defaultTo('monthly');
    t.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('trial_ends_at').nullable();
    t.timestamp('current_period_start').nullable();
    t.timestamp('current_period_end').nullable();
    t.timestamp('grace_ends_at').nullable();
    t.timestamp('cancelled_at').nullable();
    // Enterprise / negotiated overrides; NULL means "use plan limit".
    t.json('custom_limits');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('subscription_addons', (t) => {
    t.increments('id');
    t.integer('subscription_id').unsigned().notNullable().references('subscriptions.id').onDelete('CASCADE');
    t.integer('addon_id').unsigned().notNullable().references('addons.id');
    t.integer('quantity').unsigned().notNullable().defaultTo(1);
    t.timestamps(true, true);
    t.unique(['subscription_id', 'addon_id']);
  });

  await knex.schema.createTable('usage_records', (t) => {
    t.bigIncrements('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('metric', 40).notNullable();
    t.string('period', 7).notNullable(); // YYYY-MM
    t.bigInteger('quantity').notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.unique(['organization_id', 'metric', 'period']);
  });

  await knex.schema.createTable('invoices', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('subscription_id').unsigned().nullable().references('subscriptions.id').onDelete('SET NULL');
    t.string('number', 40).notNullable().unique();
    t.date('issue_date').notNullable();
    t.date('due_date').notNullable();
    t.date('period_start');
    t.date('period_end');
    t.string('currency', 3).notNullable();
    t.decimal('subtotal', 12, 2).notNullable();
    t.decimal('tax_rate', 5, 2).notNullable().defaultTo(0);
    t.decimal('tax', 12, 2).notNullable().defaultTo(0);
    t.decimal('total', 12, 2).notNullable();
    t.enu('status', ['draft', 'issued', 'paid', 'void']).notNullable().defaultTo('issued');
    t.timestamp('paid_at').nullable();
    t.string('payment_reference', 120);
    t.timestamps(true, true);
    t.index(['organization_id', 'issue_date']);
  });

  await knex.schema.createTable('invoice_items', (t) => {
    t.increments('id');
    t.integer('invoice_id').unsigned().notNullable().references('invoices.id').onDelete('CASCADE');
    t.string('description', 255).notNullable();
    t.integer('quantity').unsigned().notNullable().defaultTo(1);
    t.decimal('unit_price', 12, 2).notNullable();
    t.decimal('amount', 12, 2).notNullable();
  });
};

exports.down = async (knex) => {
  for (const table of ['invoice_items', 'invoices', 'usage_records', 'subscription_addons', 'subscriptions']) {
    await knex.schema.dropTableIfExists(table);
  }
};
