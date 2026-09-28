// Talent & Jobs Marketplace: professional profiles for individuals, company saves/shortlists and
// invitations, and jobs a company chooses to publish on the RemoteWay jobs board. Applications from
// the marketplace go into the company's existing recruitment pipeline (candidates + applications).
const TABLES = ['talent_invitations', 'talent_saved', 'talent_skills', 'talent_profiles'];

exports.up = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
  await knex.schema.createTable('talent_profiles', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('slug', 70).notNullable();
    t.string('headline', 150);
    t.string('specialization', 80);
    t.text('bio');
    t.string('country_code', 2);
    t.string('city', 100);
    t.integer('years_experience').nullable(); // stated by the person; otherwise computed from experience
    t.integer('computed_years').nullable();
    t.specificType('photo', 'MEDIUMBLOB').nullable();
    t.string('photo_mime', 40);
    t.string('photo_sha', 16);
    t.string('cv_storage_key', 255);
    t.string('cv_name', 255);
    t.string('cv_mime', 100);
    t.bigInteger('cv_size').nullable();
    t.string('linkedin_url', 255);
    t.string('portfolio_url', 255);
    t.string('phone', 40);
    t.enu('visibility', ['public', 'companies', 'private']).notNullable().defaultTo('companies');
    t.boolean('open_to_work').notNullable().defaultTo(true);
    t.boolean('show_contact').notNullable().defaultTo(false);
    t.json('education');
    t.json('experience');
    t.json('certifications');
    t.json('projects');
    t.json('languages');
    t.json('skills');
    t.json('preferences'); // { titles, job_types, work_modes, locations, salary_min, salary_currency, available_from }
    t.integer('completion').notNullable().defaultTo(0);
    t.json('ai_analysis');
    t.timestamp('analyzed_at').nullable();
    t.timestamps(true, true);
    t.unique(['user_id'], 'tp_user_uq');
    t.unique(['slug'], 'tp_slug_uq');
    t.index(['visibility', 'open_to_work'], 'tp_visibility_idx');
    t.index(['specialization'], 'tp_spec_idx');
  });
  await knex.schema.createTable('talent_skills', (t) => {
    t.integer('profile_id').unsigned().notNullable().references('talent_profiles.id').onDelete('CASCADE');
    t.string('skill', 60).notNullable(); // normalised (lower case)
    t.primary(['profile_id', 'skill']);
    t.index(['skill'], 'ts_skill_idx');
  });
  await knex.schema.createTable('talent_saved', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('profile_id').unsigned().notNullable().references('talent_profiles.id').onDelete('CASCADE');
    t.enu('list', ['saved', 'shortlist']).notNullable().defaultTo('saved');
    t.integer('job_id').unsigned().nullable().references('jobs.id').onDelete('SET NULL');
    t.string('note', 500);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['organization_id', 'profile_id'], 'tsv_org_profile_uq');
  });
  await knex.schema.createTable('talent_invitations', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('profile_id').unsigned().notNullable().references('talent_profiles.id').onDelete('CASCADE');
    t.integer('job_id').unsigned().nullable().references('jobs.id').onDelete('SET NULL');
    t.text('message');
    t.enu('status', ['sent', 'applied', 'declined']).notNullable().defaultTo('sent');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('responded_at').nullable();
    t.index(['profile_id', 'status'], 'tinv_profile_idx');
    t.index(['organization_id', 'created_at'], 'tinv_org_idx');
  });

  if (!(await knex.schema.hasColumn('jobs', 'marketplace'))) {
    await knex.schema.alterTable('jobs', (t) => {
      t.boolean('marketplace').notNullable().defaultTo(false); // listed on the RemoteWay jobs board
      t.timestamp('marketplace_at').nullable();
      t.index(['marketplace', 'status'], 'job_market_idx');
    });
  }
  if (!(await knex.schema.hasColumn('candidates', 'user_id'))) {
    await knex.schema.alterTable('candidates', (t) => {
      t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL'); // applied with a RemoteWay profile
      t.index(['organization_id', 'user_id'], 'cand_org_user_idx');
    });
  }
  await knex.raw("ALTER TABLE candidates MODIFY source ENUM('manual', 'careers', 'referral', 'linkedin', 'agency', 'other', 'remoteway') NOT NULL DEFAULT 'manual'");

  // New plan feature: the talent marketplace, for every plan that includes recruitment.
  await knex('features').insert({ key: 'talent_marketplace', name: 'Talent Marketplace', module: 'talent', availability: 'available', sort_order: 32 }).onConflict('key').ignore();
  const tm = await knex('features').where({ key: 'talent_marketplace' }).first('id');
  const rec = await knex('features').where({ key: 'recruitment' }).first('id');
  if (tm && rec) {
    const planIds = (await knex('plan_features').where({ feature_id: rec.id }).select('plan_id')).map((r) => r.plan_id);
    for (const planId of planIds) await knex('plan_features').insert({ plan_id: planId, feature_id: tm.id }).onConflict().ignore();
  }
};

exports.down = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
};
