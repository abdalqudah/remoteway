// Sign in with Google (the account's Google subject) and custom-domain verification for white-label companies.
exports.up = async (knex) => {
  await knex.schema.alterTable('users', (t) => {
    t.string('google_sub', 64).nullable();
    t.unique(['google_sub'], 'users_google_sub_uq');
  });
  await knex.schema.alterTable('organization_branding', (t) => {
    t.string('domain_status', 20).notNullable().defaultTo('none'); // none | pending (waiting for DNS) | verified (live) | suspended (stopped by the platform team)
    t.string('domain_token', 40).nullable(); // TXT record value proving ownership
    t.datetime('domain_checked_at').nullable();
    t.datetime('domain_verified_at').nullable();
    t.text('domain_check').nullable(); // last DNS check result (JSON)
    t.string('domain_hosting', 20).nullable(); // cPanel alias: added | failed | manual
    t.text('domain_hosting_note').nullable();
  });
  // Domains saved before this release were already live: keep them working.
  await knex('organization_branding').whereNotNull('custom_domain').update({ domain_status: 'verified', domain_verified_at: knex.fn.now() });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('organization_branding', (t) => {
    t.dropColumn('domain_status'); t.dropColumn('domain_token'); t.dropColumn('domain_checked_at'); t.dropColumn('domain_verified_at');
    t.dropColumn('domain_check'); t.dropColumn('domain_hosting'); t.dropColumn('domain_hosting_note');
  });
  await knex.schema.alterTable('users', (t) => { t.dropUnique(['google_sub'], 'users_google_sub_uq'); t.dropColumn('google_sub'); });
};
