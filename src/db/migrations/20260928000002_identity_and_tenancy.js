exports.up = async (knex) => {
  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('name', 120).notNullable();
    t.string('email', 190).notNullable().unique();
    t.string('password_hash', 100).notNullable();
    t.string('locale', 5).notNullable().defaultTo('en');
    t.boolean('is_super_admin').notNullable().defaultTo(false);
    t.enu('status', ['active', 'disabled']).notNullable().defaultTo('active');
    t.integer('last_organization_id').unsigned().nullable();
    t.timestamp('last_login_at').nullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable('organizations', (t) => {
    t.increments('id');
    t.string('name', 150).notNullable();
    t.string('slug', 80).notNullable().unique();
    t.string('country_code', 2).notNullable().references('country_policies.country_code');
    t.string('industry', 80);
    t.string('company_size', 20);
    t.string('website', 255);
    t.string('phone', 40);
    t.string('address', 255);
    t.string('logo_url', 500);
    t.string('currency', 3).notNullable();
    t.string('timezone', 64).notNullable();
    t.string('locale', 5).notNullable().defaultTo('en');
    t.enu('status', ['active', 'suspended', 'closed']).notNullable().defaultTo('active');
    t.integer('owner_user_id').unsigned().notNullable().references('users.id');
    t.timestamp('onboarding_completed_at').nullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable('organization_settings', (t) => {
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('key', 80).notNullable();
    t.json('value');
    t.timestamps(true, true);
    t.primary(['organization_id', 'key']);
  });

  // System role templates have organization_id NULL; custom roles belong to one organization.
  await knex.schema.createTable('roles', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().nullable().references('organizations.id').onDelete('CASCADE');
    t.string('key', 60).notNullable();
    t.string('name', 100).notNullable();
    t.string('description', 255);
    t.boolean('is_system').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.unique(['organization_id', 'key']);
  });

  await knex.schema.createTable('role_permissions', (t) => {
    t.integer('role_id').unsigned().notNullable().references('roles.id').onDelete('CASCADE');
    t.integer('permission_id').unsigned().notNullable().references('permissions.id').onDelete('CASCADE');
    t.primary(['role_id', 'permission_id']);
  });

  // A user's membership in an organization.
  await knex.schema.createTable('memberships', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.enu('status', ['active', 'disabled']).notNullable().defaultTo('active');
    t.timestamps(true, true);
    t.unique(['organization_id', 'user_id']);
  });

  await knex.schema.createTable('user_roles', (t) => {
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.integer('role_id').unsigned().notNullable().references('roles.id').onDelete('CASCADE');
    t.primary(['organization_id', 'user_id', 'role_id']);
  });

  await knex.schema.createTable('invitations', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('email', 190).notNullable();
    t.integer('role_id').unsigned().notNullable().references('roles.id').onDelete('CASCADE');
    t.string('token_hash', 64).notNullable().unique();
    t.integer('invited_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('expires_at').notNullable();
    t.timestamp('accepted_at').nullable();
    t.timestamp('revoked_at').nullable();
    t.timestamps(true, true);
    t.index(['organization_id', 'email']);
  });

  await knex.schema.createTable('api_tokens', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('name', 100).notNullable();
    t.string('token_hash', 64).notNullable().unique();
    t.string('token_prefix', 12).notNullable();
    t.timestamp('last_used_at').nullable();
    t.timestamp('expires_at').nullable();
    t.timestamp('revoked_at').nullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id');
    t.integer('organization_id').unsigned().nullable().index();
    t.integer('user_id').unsigned().nullable();
    t.string('action', 80).notNullable();
    t.string('entity_type', 60).nullable();
    t.string('entity_id', 40).nullable();
    t.json('old_values');
    t.json('new_values');
    t.string('ip', 64);
    t.string('user_agent', 255);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['organization_id', 'created_at']);
    t.index(['entity_type', 'entity_id']);
  });
};

exports.down = async (knex) => {
  for (const table of ['audit_logs', 'api_tokens', 'invitations', 'user_roles', 'memberships', 'role_permissions', 'roles', 'organization_settings', 'organizations', 'users']) {
    await knex.schema.dropTableIfExists(table);
  }
};
