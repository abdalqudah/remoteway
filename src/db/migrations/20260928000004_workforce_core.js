// Minimal workforce entities needed by Phase 1 (seat limits, dashboard, org structure).
exports.up = async (knex) => {
  await knex.schema.createTable('locations', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('name', 120).notNullable();
    t.string('country_code', 2);
    t.string('city', 100);
    t.string('timezone', 64);
    t.boolean('is_remote').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.unique(['organization_id', 'name']);
  });

  await knex.schema.createTable('departments', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('name', 120).notNullable();
    t.string('code', 20);
    t.integer('parent_id').unsigned().nullable().references('departments.id').onDelete('SET NULL');
    t.integer('head_employee_id').unsigned().nullable();
    t.timestamps(true, true);
    t.unique(['organization_id', 'name']);
  });

  await knex.schema.createTable('employees', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('employee_number', 30).notNullable();
    t.string('first_name', 80).notNullable();
    t.string('last_name', 80).notNullable();
    t.string('email', 190);
    t.string('phone', 40);
    t.string('job_title', 120);
    t.integer('department_id').unsigned().nullable().references('departments.id').onDelete('SET NULL');
    t.integer('location_id').unsigned().nullable().references('locations.id').onDelete('SET NULL');
    t.integer('manager_id').unsigned().nullable().references('employees.id').onDelete('SET NULL');
    t.enu('employment_type', ['full_time', 'part_time', 'contract', 'intern', 'freelance']).notNullable().defaultTo('full_time');
    t.enu('work_mode', ['remote', 'hybrid', 'onsite']).notNullable().defaultTo('onsite');
    t.enu('status', ['active', 'probation', 'on_leave', 'terminated']).notNullable().defaultTo('active');
    t.date('joining_date');
    t.date('termination_date');
    t.string('nationality', 2);
    t.decimal('base_salary', 12, 2);
    t.string('salary_currency', 3);
    t.timestamps(true, true);
    t.unique(['organization_id', 'employee_number']);
    t.unique(['organization_id', 'email']);
    t.index(['organization_id', 'status']);
  });

  await knex.schema.alterTable('departments', (t) => {
    t.foreign('head_employee_id').references('employees.id').onDelete('SET NULL');
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('departments', (t) => t.dropForeign('head_employee_id'));
  await knex.schema.dropTableIfExists('employees');
  await knex.schema.dropTableIfExists('departments');
  await knex.schema.dropTableIfExists('locations');
};
