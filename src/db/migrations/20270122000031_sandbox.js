// Test companies (Super Admin → Test environment): marked so they are kept apart and can be deleted in one step.
exports.up = async (knex) => {
  await knex.schema.alterTable('organizations', (t) => {
    t.boolean('is_sandbox').notNullable().defaultTo(false);
    t.text('sandbox_meta').nullable(); // { domain, password_enc, plan, sample, created_by, note }
    t.index(['is_sandbox'], 'org_sandbox_idx');
  });
};
exports.down = async (knex) => {
  await knex.schema.alterTable('organizations', (t) => { t.dropIndex(['is_sandbox'], 'org_sandbox_idx'); t.dropColumn('is_sandbox'); t.dropColumn('sandbox_meta'); });
};
