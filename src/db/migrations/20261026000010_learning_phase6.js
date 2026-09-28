// Phase 6 — Learning: courses with lessons (text, video, file, link, quiz), learning paths,
// enrollments with per-lesson progress, and certificates with public verification codes.
const TABLES = ['certificates', 'lesson_progress', 'enrollments', 'path_assignments', 'learning_path_courses', 'learning_paths',
  'lesson_questions', 'course_lessons', 'courses'];

exports.up = async (knex) => {
  // MySQL DDL is not transactional: clear leftovers of a previously interrupted run of this migration.
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);

  await knex.schema.createTable('courses', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('title', 200).notNullable();
    t.text('description');
    t.string('category', 60);
    t.enu('level', ['beginner', 'intermediate', 'advanced']).notNullable().defaultTo('beginner');
    t.enu('status', ['draft', 'published', 'archived']).notNullable().defaultTo('draft');
    t.boolean('is_mandatory').notNullable().defaultTo(false);
    t.boolean('self_enroll').notNullable().defaultTo(true);
    t.integer('passing_score').notNullable().defaultTo(70); // % needed on each quiz
    t.boolean('certificate_enabled').notNullable().defaultTo(true);
    t.integer('validity_months').nullable(); // certificate expiry (e.g. yearly compliance refreshers)
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('published_at').nullable();
    t.timestamps(true, true);
    t.index(['organization_id', 'status'], 'crs_org_status_idx');
  });

  await knex.schema.createTable('course_lessons', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('course_id').unsigned().notNullable().references('courses.id').onDelete('CASCADE');
    t.string('title', 200).notNullable();
    t.enu('kind', ['text', 'video', 'file', 'link', 'quiz']).notNullable().defaultTo('text');
    t.text('body', 'mediumtext');
    t.string('url', 500);
    t.string('file_storage_key', 255);
    t.string('file_name', 255);
    t.string('file_mime', 120);
    t.integer('file_size').unsigned();
    t.integer('duration_minutes').notNullable().defaultTo(5);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.index(['course_id'], 'cl_course_idx');
  });

  await knex.schema.createTable('lesson_questions', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('lesson_id').unsigned().notNullable().references('course_lessons.id').onDelete('CASCADE');
    t.string('question', 500).notNullable();
    t.json('options').notNullable();
    t.tinyint('correct_index').notNullable();
    t.integer('sort_order').notNullable().defaultTo(0);
    t.index(['lesson_id'], 'lq_lesson_idx');
  });

  await knex.schema.createTable('learning_paths', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('title', 200).notNullable();
    t.text('description');
    t.enu('status', ['draft', 'published', 'archived']).notNullable().defaultTo('draft');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['organization_id'], 'lp_org_idx');
  });

  await knex.schema.createTable('learning_path_courses', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('path_id').unsigned().notNullable().references('learning_paths.id').onDelete('CASCADE');
    t.integer('course_id').unsigned().notNullable().references('courses.id').onDelete('CASCADE');
    t.integer('sort_order').notNullable().defaultTo(0);
    t.unique(['path_id', 'course_id'], 'lpc_path_course_uq');
  });

  await knex.schema.createTable('path_assignments', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('path_id').unsigned().notNullable().references('learning_paths.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.date('due_date').nullable();
    t.integer('assigned_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['path_id', 'employee_id'], 'pa_path_emp_uq');
  });

  await knex.schema.createTable('enrollments', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('course_id').unsigned().notNullable().references('courses.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.enu('source', ['self', 'assigned', 'path']).notNullable().defaultTo('self');
    t.enu('status', ['not_started', 'in_progress', 'completed']).notNullable().defaultTo('not_started');
    t.decimal('progress', 5, 2).notNullable().defaultTo(0);
    t.date('due_date').nullable();
    t.integer('assigned_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('started_at').nullable();
    t.timestamp('completed_at').nullable();
    t.decimal('score', 5, 2).nullable(); // average quiz score
    t.timestamps(true, true);
    t.unique(['course_id', 'employee_id'], 'enr_course_emp_uq');
    t.index(['organization_id', 'employee_id'], 'enr_org_emp_idx');
    t.index(['organization_id', 'status'], 'enr_org_status_idx');
  });

  await knex.schema.createTable('lesson_progress', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('enrollment_id').unsigned().notNullable().references('enrollments.id').onDelete('CASCADE');
    t.integer('lesson_id').unsigned().notNullable().references('course_lessons.id').onDelete('CASCADE');
    t.timestamp('completed_at').nullable();
    t.decimal('score', 5, 2).nullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.unique(['enrollment_id', 'lesson_id'], 'lpr_enr_lesson_uq');
  });

  await knex.schema.createTable('certificates', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('enrollment_id').unsigned().nullable().references('enrollments.id').onDelete('SET NULL');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.integer('course_id').unsigned().notNullable().references('courses.id').onDelete('CASCADE');
    t.string('code', 24).notNullable().unique();
    t.string('employee_name', 170).notNullable();
    t.string('course_title', 200).notNullable();
    t.decimal('score', 5, 2).nullable();
    t.date('issued_on').notNullable();
    t.date('expires_on').nullable();
    t.timestamp('revoked_at').nullable();
    t.timestamps(true, true);
    t.index(['organization_id', 'employee_id'], 'cert_org_emp_idx');
  });
};

exports.down = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
};
