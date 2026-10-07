// Sales documents: quotations with line items, files to send (company profile…), a log of every send
// (email or WhatsApp link) and share links for invoices.
exports.up = async (knex) => {
  await knex.schema.createTable('quotes', (t) => {
    t.increments('id');
    t.string('number', 40).notNullable().unique();
    t.string('token', 64).notNullable().unique(); // the customer's link
    t.integer('contact_id').unsigned().nullable().references('crm_contacts.id').onDelete('SET NULL');
    t.string('customer_name', 150).notNullable();
    t.string('customer_company', 150);
    t.string('customer_email', 190);
    t.string('customer_phone', 40);
    t.string('customer_vat', 40);
    t.string('customer_address', 255);
    t.string('locale', 5).notNullable().defaultTo('ar');
    t.string('currency', 3).notNullable().defaultTo('SAR');
    t.date('issue_date').notNullable();
    t.date('valid_until').notNullable();
    t.decimal('subtotal', 12, 2).notNullable().defaultTo(0);
    t.decimal('discount', 12, 2).notNullable().defaultTo(0);
    t.decimal('tax_rate', 5, 2).notNullable().defaultTo(15);
    t.decimal('tax', 12, 2).notNullable().defaultTo(0);
    t.decimal('total', 12, 2).notNullable().defaultTo(0);
    t.text('notes');
    t.text('terms');
    t.enu('status', ['draft', 'sent', 'accepted', 'declined']).notNullable().defaultTo('draft');
    t.timestamp('sent_at').nullable();
    t.timestamp('first_viewed_at').nullable();
    t.timestamp('last_viewed_at').nullable();
    t.integer('view_count').unsigned().notNullable().defaultTo(0);
    t.timestamp('responded_at').nullable();
    t.string('response_name', 150);
    t.string('response_note', 500);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['status', 'issue_date']);
  });
  await knex.schema.createTable('quote_items', (t) => {
    t.increments('id');
    t.integer('quote_id').unsigned().notNullable().references('quotes.id').onDelete('CASCADE');
    t.string('description', 500).notNullable();
    t.decimal('quantity', 10, 2).notNullable().defaultTo(1);
    t.decimal('unit_price', 12, 2).notNullable().defaultTo(0);
    t.decimal('amount', 12, 2).notNullable().defaultTo(0);
    t.integer('sort').notNullable().defaultTo(0);
  });
  await knex.schema.createTable('sales_files', (t) => {
    t.increments('id');
    t.string('title', 150).notNullable();
    t.string('description', 500);
    t.string('storage_key', 200).notNullable();
    t.string('filename', 200).notNullable();
    t.string('mime', 100).notNullable();
    t.integer('size').unsigned().notNullable();
    t.string('token', 64).notNullable().unique();
    t.integer('open_count').unsigned().notNullable().defaultTo(0);
    t.timestamp('last_opened_at').nullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });
  await knex.schema.createTable('document_sends', (t) => {
    t.increments('id');
    t.string('doc_type', 20).notNullable(); // quote | invoice | file
    t.integer('doc_id').unsigned().notNullable();
    t.string('channel', 20).notNullable(); // email | whatsapp
    t.string('recipient', 190).notNullable();
    t.integer('contact_id').unsigned().nullable().references('crm_contacts.id').onDelete('SET NULL');
    t.string('status', 20).notNullable(); // sent | failed | opened (WhatsApp opened with the text ready)
    t.string('error', 500);
    t.string('subject', 200);
    t.text('body');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['doc_type', 'doc_id']);
  });
  await knex.schema.alterTable('invoices', (t) => {
    t.string('share_token', 64).nullable().unique();
    t.integer('view_count').unsigned().notNullable().defaultTo(0);
    t.timestamp('last_viewed_at').nullable();
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('invoices', (t) => { t.dropColumn('share_token'); t.dropColumn('view_count'); t.dropColumn('last_viewed_at'); });
  await knex.schema.dropTableIfExists('document_sends');
  await knex.schema.dropTableIfExists('sales_files');
  await knex.schema.dropTableIfExists('quote_items');
  await knex.schema.dropTableIfExists('quotes');
};
