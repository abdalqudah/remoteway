// Phase 3 — Talent: recruitment (jobs, candidates, applications, interviews, assessments) and onboarding.
const TABLES = ['onboarding_tasks', 'onboarding_plans', 'onboarding_template_items', 'onboarding_templates',
  'assessments', 'interviews', 'application_events', 'applications', 'candidates', 'jobs'];

exports.up = async (knex) => {
  // MySQL DDL is not transactional: clear leftovers of a previously interrupted run of this migration.
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);

  await knex.schema.createTable('jobs', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('title', 150).notNullable();
    t.string('slug', 80).notNullable();
    t.integer('department_id').unsigned().nullable().references('departments.id').onDelete('SET NULL');
    t.integer('location_id').unsigned().nullable().references('locations.id').onDelete('SET NULL');
    t.enu('work_mode', ['remote', 'hybrid', 'onsite']).notNullable().defaultTo('onsite');
    t.enu('employment_type', ['full_time', 'part_time', 'contract', 'intern', 'freelance']).notNullable().defaultTo('full_time');
    t.decimal('salary_min', 12, 2).nullable();
    t.decimal('salary_max', 12, 2).nullable();
    t.string('salary_currency', 3).nullable();
    t.boolean('show_salary').notNullable().defaultTo(false);
    t.integer('experience_years').nullable();
    t.json('skills');
    t.text('description');
    t.text('requirements');
    t.integer('openings').notNullable().defaultTo(1);
    t.enu('status', ['draft', 'open', 'closed']).notNullable().defaultTo('draft');
    t.integer('hiring_manager_user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('published_at').nullable();
    t.timestamp('closed_at').nullable();
    t.timestamps(true, true);
    t.unique(['organization_id', 'slug'], 'job_org_slug_uq');
    t.index(['organization_id', 'status'], 'job_org_status_idx');
  });

  await knex.schema.createTable('candidates', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('first_name', 80).notNullable();
    t.string('last_name', 80).notNullable();
    t.string('email', 190).notNullable();
    t.string('phone', 40);
    t.string('city', 100);
    t.string('current_title', 150);
    t.integer('experience_years').nullable();
    t.json('skills');
    t.string('linkedin_url', 255);
    t.enu('source', ['manual', 'careers', 'referral', 'linkedin', 'agency', 'other']).notNullable().defaultTo('manual');
    t.string('cv_storage_key', 255);
    t.string('cv_name', 255);
    t.string('cv_mime', 100);
    t.bigInteger('cv_size').nullable();
    t.boolean('consent').notNullable().defaultTo(false);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['organization_id', 'email'], 'cand_org_email_uq');
  });

  await knex.schema.createTable('applications', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('job_id').unsigned().notNullable().references('jobs.id').onDelete('CASCADE');
    t.integer('candidate_id').unsigned().notNullable().references('candidates.id').onDelete('CASCADE');
    t.enu('stage', ['applied', 'screening', 'shortlisted', 'interview', 'assessment', 'offer', 'hired', 'rejected']).notNullable().defaultTo('applied');
    t.timestamp('stage_changed_at').notNullable().defaultTo(knex.fn.now());
    t.string('rejection_reason', 255);
    t.integer('rating').nullable();
    t.text('cover_note');
    t.integer('hired_employee_id').unsigned().nullable().references('employees.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['organization_id', 'job_id', 'candidate_id'], 'app_org_job_cand_uq');
    t.index(['organization_id', 'stage'], 'app_org_stage_idx');
  });

  await knex.schema.createTable('application_events', (t) => {
    t.bigIncrements('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('application_id').unsigned().notNullable().references('applications.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.string('type', 40).notNullable(); // stage, note, interview, assessment, rating, hired
    t.json('data');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['organization_id', 'application_id'], 'appev_org_app_idx');
  });

  await knex.schema.createTable('interviews', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('application_id').unsigned().notNullable().references('applications.id').onDelete('CASCADE');
    t.dateTime('scheduled_at').notNullable();
    t.integer('duration_minutes').notNullable().defaultTo(45);
    t.enu('mode', ['video', 'onsite', 'phone']).notNullable().defaultTo('video');
    t.string('location', 255);
    t.integer('interviewer_user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.enu('status', ['scheduled', 'completed', 'cancelled']).notNullable().defaultTo('scheduled');
    t.enu('recommendation', ['strong_yes', 'yes', 'no', 'strong_no']).nullable();
    t.integer('rating').nullable();
    t.text('feedback');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['organization_id', 'scheduled_at'], 'int_org_sched_idx');
    t.index(['organization_id', 'interviewer_user_id'], 'int_org_interviewer_idx');
  });

  await knex.schema.createTable('assessments', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('application_id').unsigned().notNullable().references('applications.id').onDelete('CASCADE');
    t.string('title', 150).notNullable();
    t.decimal('score', 7, 2).nullable();
    t.decimal('max_score', 7, 2).nullable();
    t.string('notes', 1000);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('onboarding_templates', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('name', 120).notNullable();
    t.boolean('is_default').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('onboarding_template_items', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('template_id').unsigned().notNullable().references('onboarding_templates.id').onDelete('CASCADE');
    t.string('title', 200).notNullable();
    t.enu('category', ['contract', 'documents', 'bank', 'policies', 'equipment', 'accounts', 'training', 'manager', 'other']).notNullable().defaultTo('other');
    t.enu('assignee', ['hr', 'manager', 'employee']).notNullable().defaultTo('hr');
    t.integer('due_offset_days').notNullable().defaultTo(0); // relative to the start date (negative = before day one)
    t.integer('sort_order').notNullable().defaultTo(0);
  });

  await knex.schema.createTable('onboarding_plans', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.integer('template_id').unsigned().nullable().references('onboarding_templates.id').onDelete('SET NULL');
    t.date('start_date').notNullable();
    t.enu('status', ['active', 'completed', 'cancelled']).notNullable().defaultTo('active');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('completed_at').nullable();
    t.timestamps(true, true);
    t.index(['organization_id', 'status'], 'onbp_org_status_idx');
  });

  await knex.schema.createTable('onboarding_tasks', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('plan_id').unsigned().notNullable().references('onboarding_plans.id').onDelete('CASCADE');
    t.string('title', 200).notNullable();
    t.enu('category', ['contract', 'documents', 'bank', 'policies', 'equipment', 'accounts', 'training', 'manager', 'other']).notNullable().defaultTo('other');
    t.enu('assignee', ['hr', 'manager', 'employee']).notNullable().defaultTo('hr');
    t.integer('assignee_user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.date('due_date').nullable();
    t.timestamp('completed_at').nullable();
    t.integer('completed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('sort_order').notNullable().defaultTo(0);
    t.index(['organization_id', 'plan_id'], 'onbt_org_plan_idx');
    t.index(['organization_id', 'assignee_user_id'], 'onbt_org_user_idx');
  });
};

exports.down = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
};
