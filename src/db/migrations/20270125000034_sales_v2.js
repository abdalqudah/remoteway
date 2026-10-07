// Email log, services catalog, signed acceptance / negotiation on quotations, document templates, and a
// clean-up of phone numbers saved with a 0 after the country code (+966 05…).
exports.up = async (knex) => {
  await knex.schema.createTable('email_log', (t) => {
    t.bigIncrements('id');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.string('kind', 40).notNullable().defaultTo('other'); // password_reset, invitation, quote…
    t.string('to_addr', 255).notNullable();
    t.string('subject', 255);
    t.integer('organization_id').unsigned().nullable().references('organizations.id').onDelete('SET NULL');
    t.string('via', 20).notNullable(); // platform | company | none
    t.string('status', 20).notNullable(); // sent | failed | not_sent
    t.string('reason', 60); // why it was not sent: email_not_configured, company_mailbox_required…
    t.string('error', 500);
    t.string('response', 500); // what the mail server answered
    t.string('message_id', 255);
    t.integer('duration_ms').unsigned();
    t.index(['created_at']);
    t.index(['to_addr']);
  });
  await knex.schema.createTable('sales_services', (t) => {
    t.increments('id');
    t.string('name_ar', 200).notNullable();
    t.string('name_en', 200);
    t.string('description_ar', 1000);
    t.string('description_en', 1000);
    t.string('unit_ar', 60);
    t.string('unit_en', 60);
    t.decimal('price', 12, 2).notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    t.integer('sort').notNullable().defaultTo(0);
    t.timestamps(true, true);
  });
  await knex.schema.alterTable('quote_items', (t) => {
    t.integer('service_id').unsigned().nullable().references('sales_services.id').onDelete('SET NULL');
  });
  await knex.schema.alterTable('quotes', (t) => {
    t.string('status', 20).notNullable().defaultTo('draft').alter(); // + negotiating
    t.integer('revision').unsigned().notNullable().defaultTo(1);
    t.string('signer_title', 120);
    t.string('signature_key', 200);
    t.string('stamp_key', 200);
    t.string('signed_file_key', 200);
    t.string('signed_file_mime', 100);
    t.string('signed_file_name', 200);
    t.string('decline_reason', 40);
    t.string('response_ip', 64);
  });
  await knex.schema.createTable('quote_events', (t) => {
    t.increments('id');
    t.integer('quote_id').unsigned().notNullable().references('quotes.id').onDelete('CASCADE');
    t.string('type', 30).notNullable(); // negotiation | reply | revised | accepted | declined
    t.string('by', 10).notNullable(); // customer | team
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('name', 150);
    t.decimal('amount', 12, 2).nullable();
    t.text('message');
    t.integer('revision').unsigned();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['quote_id']);
  });
  await knex.schema.createTable('document_templates', (t) => {
    t.increments('id');
    t.string('name', 150).notNullable();
    t.string('kind', 10).notNullable(); // docx | html
    t.string('storage_key', 200);
    t.string('filename', 200);
    t.text('body_html', 'longtext');
    t.text('fields'); // JSON list of placeholders found in the template
    t.boolean('active').notNullable().defaultTo(true);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });
  await knex.schema.alterTable('sales_files', (t) => {
    t.string('storage_key', 200).nullable().alter();
    t.text('body_html', 'longtext');
    t.text('values_json');
    t.integer('template_id').unsigned().nullable().references('document_templates.id').onDelete('SET NULL');
    t.integer('contact_id').unsigned().nullable().references('crm_contacts.id').onDelete('SET NULL');
  });
  // Phones saved as +966 05… (the 0 kept after the country code): WhatsApp says the number does not exist.
  const { normalizePhone } = require('../../modules/integrations/messaging.service'); // eslint-disable-line global-require
  const rows = await knex('crm_contacts').whereNotNull('phone').select('id', 'phone');
  for (const r of rows) {
    const n = normalizePhone(`+${r.phone}`);
    if (n && n !== r.phone && !(await knex('crm_contacts').where({ phone: n }).whereNot({ id: r.id }).first('id'))) {
      await knex('crm_contacts').where({ id: r.id }).update({ phone: n });
    }
  }
};

exports.down = async (knex) => {
  await knex.schema.alterTable('sales_files', (t) => { t.dropForeign('template_id'); t.dropForeign('contact_id'); t.dropColumn('body_html'); t.dropColumn('values_json'); t.dropColumn('template_id'); t.dropColumn('contact_id'); });
  await knex.schema.dropTableIfExists('document_templates');
  await knex.schema.dropTableIfExists('quote_events');
  await knex.schema.alterTable('quotes', (t) => { for (const c of ['revision', 'signer_title', 'signature_key', 'stamp_key', 'signed_file_key', 'signed_file_mime', 'signed_file_name', 'decline_reason', 'response_ip']) t.dropColumn(c); });
  await knex.schema.alterTable('quote_items', (t) => { t.dropForeign('service_id'); t.dropColumn('service_id'); });
  await knex.schema.dropTableIfExists('sales_services');
  await knex.schema.dropTableIfExists('email_log');
};
