// Compliance: policy acknowledgements (who read which version of a company policy) and a daily
// compliance-score history. Rules live in organization_settings (key "compliance").
const TABLES = ['compliance_snapshots', 'policy_acknowledgements'];

exports.up = async (knex) => {
  // MySQL DDL is not transactional: clear leftovers of a previously interrupted run of this migration.
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
  if (await knex.schema.hasColumn('documents', 'requires_ack')) await knex.schema.alterTable('documents', (t) => { t.dropColumn('requires_ack'); });

  await knex.schema.alterTable('documents', (t) => {
    t.boolean('requires_ack').notNullable().defaultTo(false); // company policy every employee must acknowledge
  });
  await knex.schema.createTable('policy_acknowledgements', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('document_id').unsigned().notNullable().references('documents.id').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('ip', 64);
    t.timestamp('acknowledged_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['document_id', 'version', 'employee_id'], 'pa_doc_ver_emp_uq');
    t.index(['organization_id', 'employee_id'], 'pa_org_emp_idx');
  });
  await knex.schema.createTable('compliance_snapshots', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.date('day').notNullable();
    t.decimal('score', 5, 1).notNullable();
    t.integer('issues').notNullable().defaultTo(0);
    t.integer('warnings').notNullable().defaultTo(0);
    t.unique(['organization_id', 'day'], 'cs_org_day_uq');
  });
};

exports.down = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
  if (await knex.schema.hasColumn('documents', 'requires_ack')) await knex.schema.alterTable('documents', (t) => { t.dropColumn('requires_ack'); });
};
