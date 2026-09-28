// Online payments of subscription invoices through Saudi payment gateways (Moyasar, Tap, HyperPay,
// PayTabs). One row per attempt; an invoice becomes paid only after the gateway confirms it server-side.
const TABLES = ['payments'];

exports.up = async (knex) => {
  // MySQL DDL is not transactional: clear leftovers of a previously interrupted run of this migration.
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
  await knex.schema.createTable('payments', (t) => {
    t.bigIncrements('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('invoice_id').unsigned().notNullable().references('invoices.id').onDelete('CASCADE');
    t.string('provider', 20).notNullable(); // moyasar | tap | hyperpay | paytabs
    t.string('method', 20).nullable(); // hyperpay: card | mada
    t.string('mode', 4).notNullable().defaultTo('test'); // test | live
    t.string('token', 64).notNullable(); // unguessable id used in return URLs
    t.string('provider_ref', 120).nullable();
    t.decimal('amount', 12, 2).notNullable();
    t.string('currency', 3).notNullable();
    t.enu('status', ['initiated', 'paid', 'failed', 'cancelled', 'expired']).notNullable().defaultTo('initiated');
    t.string('failure_reason', 255).nullable();
    t.string('note', 60).nullable(); // e.g. invoice_already_paid (needs a refund)
    t.json('raw'); // last gateway response (no card data is ever sent to us)
    t.datetime('paid_at').nullable();
    t.datetime('checked_at').nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['token'], 'pay_token_uq');
    t.index(['provider', 'provider_ref'], 'pay_provider_ref_idx');
    t.index(['invoice_id', 'status'], 'pay_invoice_idx');
    t.index(['status', 'created_at'], 'pay_status_idx');
  });
};

exports.down = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
};
