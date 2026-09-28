// Platform team roles, admin-granted extra features, and company branding (logo + white label).
// Logos are stored in the database (not on disk) so they survive redeploys and move with backups.
const TABLES = ['organization_branding'];

exports.up = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
  if (!(await knex.schema.hasColumn('users', 'platform_role'))) {
    await knex.schema.alterTable('users', (t) => { t.string('platform_role', 20).nullable(); }); // owner | admin | finance | support
  }
  await knex('users').where({ is_super_admin: true }).whereNull('platform_role').update({ platform_role: 'owner' });
  if (!(await knex.schema.hasColumn('subscriptions', 'custom_features'))) {
    await knex.schema.alterTable('subscriptions', (t) => { t.json('custom_features').nullable(); }); // feature keys granted on top of the plan
  }
  await knex.schema.createTable('organization_branding', (t) => {
    t.integer('organization_id').unsigned().primary().references('organizations.id').onDelete('CASCADE');
    t.specificType('logo', 'MEDIUMBLOB').nullable();
    t.string('logo_mime', 40).nullable();
    t.string('logo_sha', 16).nullable();
    t.specificType('logo_dark', 'MEDIUMBLOB').nullable();
    t.string('logo_dark_mime', 40).nullable();
    t.string('logo_dark_sha', 16).nullable();
    t.boolean('white_label').notNullable().defaultTo(false);
    t.string('brand_name', 80).nullable();
    t.string('brand_color', 7).nullable();
    t.string('custom_domain', 190).nullable();
    t.string('email_sender_name', 80).nullable();
    t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['custom_domain'], 'ob_domain_uq');
  });

  // New feature: White label, part of Enterprise and sold as an add-on.
  await knex('features').insert({ key: 'white_label', name: 'White Label', module: 'branding', availability: 'available', sort_order: 31 }).onConflict('key').ignore();
  const wl = await knex('features').where({ key: 'white_label' }).first('id');
  const enterprise = await knex('plans').where({ key: 'enterprise' }).first('id');
  if (wl && enterprise) await knex('plan_features').insert({ plan_id: enterprise.id, feature_id: wl.id }).onConflict().ignore();
  if (wl && !(await knex('addons').where({ key: 'white_label' }).first())) {
    await knex('addons').insert({ key: 'white_label', name: 'White Label', price_monthly: 999, feature_id: wl.id, sort_order: 20 });
  }
};

exports.down = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
};
