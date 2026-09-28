// Phase 2 — Workforce: leave, attendance, documents, tasks & projects, notifications.
// Every table is tenant-scoped with organization_id first in its indexes.
const TABLES = ['notifications', 'task_comments', 'tasks', 'projects', 'document_versions', 'documents', 'attendance', 'leave_requests', 'leave_balances', 'leave_types'];

exports.up = async (knex) => {
  // MySQL DDL is not transactional: clear leftovers of a previously interrupted run of this migration.
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);

  // ---------- Leave ----------
  await knex.schema.createTable('leave_types', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('key', 40).notNullable();
    t.string('name', 100).notNullable();
    t.string('name_ar', 100);
    t.decimal('days_per_year', 6, 2).notNullable().defaultTo(0);
    t.boolean('has_balance').notNullable().defaultTo(true); // false = unlimited / not tracked (e.g. unpaid)
    t.boolean('is_paid').notNullable().defaultTo(true);
    t.boolean('requires_document').notNullable().defaultTo(false);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.string('color', 7).notNullable().defaultTo('#1ACC6C');
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.unique(['organization_id', 'key'], 'lt_org_key_uq');
  });

  await knex.schema.createTable('leave_balances', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.integer('leave_type_id').unsigned().notNullable().references('leave_types.id').onDelete('CASCADE');
    t.integer('year').notNullable();
    t.decimal('entitled_days', 6, 2).notNullable().defaultTo(0);
    t.decimal('adjustment_days', 6, 2).notNullable().defaultTo(0);
    t.decimal('used_days', 6, 2).notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.unique(['organization_id', 'employee_id', 'leave_type_id', 'year'], 'lb_org_emp_type_year_uq');
  });

  await knex.schema.createTable('leave_requests', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.integer('leave_type_id').unsigned().notNullable().references('leave_types.id');
    t.date('start_date').notNullable();
    t.date('end_date').notNullable();
    t.decimal('days', 6, 2).notNullable();
    t.string('reason', 1000);
    t.enu('status', ['pending', 'approved', 'rejected', 'cancelled']).notNullable().defaultTo('pending');
    t.integer('requested_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('decided_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('decided_at').nullable();
    t.string('decision_note', 500);
    t.timestamps(true, true);
    t.index(['organization_id', 'status'], 'lr_org_status_idx');
    t.index(['organization_id', 'employee_id', 'start_date'], 'lr_org_emp_start_idx');
  });

  // ---------- Attendance ----------
  await knex.schema.createTable('attendance', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.date('work_date').notNullable();
    t.dateTime('clock_in').nullable();
    t.dateTime('clock_out').nullable();
    t.dateTime('break_started_at').nullable();
    t.integer('break_minutes').notNullable().defaultTo(0);
    t.integer('worked_minutes').notNullable().defaultTo(0);
    t.integer('late_minutes').notNullable().defaultTo(0);
    t.integer('overtime_minutes').notNullable().defaultTo(0);
    t.enu('source', ['web', 'manual', 'api', 'import']).notNullable().defaultTo('web');
    t.string('note', 500);
    t.string('ip', 64);
    t.integer('edited_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['organization_id', 'employee_id', 'work_date'], 'att_org_emp_date_uq');
    t.index(['organization_id', 'work_date'], 'att_org_date_idx');
  });

  // ---------- Documents ----------
  await knex.schema.createTable('documents', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().nullable().references('employees.id').onDelete('CASCADE'); // null = company document / policy
    t.enu('category', ['contract', 'id', 'passport', 'iqama', 'certificate', 'policy', 'payslip', 'other']).notNullable().defaultTo('other');
    t.string('title', 190).notNullable();
    t.date('issue_date').nullable();
    t.date('expires_at').nullable();
    t.boolean('visible_to_employee').notNullable().defaultTo(true);
    t.integer('current_version').notNullable().defaultTo(1);
    t.integer('uploaded_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['organization_id', 'employee_id'], 'doc_org_emp_idx');
    t.index(['organization_id', 'expires_at'], 'doc_org_exp_idx');
  });

  await knex.schema.createTable('document_versions', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('document_id').unsigned().notNullable().references('documents.id').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.string('storage_key', 255).notNullable(); // path inside private storage, never public
    t.string('original_name', 255).notNullable();
    t.string('mime_type', 100).notNullable();
    t.bigInteger('size_bytes').notNullable();
    t.string('sha256', 64).notNullable();
    t.integer('uploaded_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['document_id', 'version'], 'docv_doc_ver_uq');
  });

  // ---------- Projects & tasks ----------
  await knex.schema.createTable('projects', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('name', 150).notNullable();
    t.string('description', 2000);
    t.enu('status', ['active', 'on_hold', 'completed', 'archived']).notNullable().defaultTo('active');
    t.integer('owner_user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.date('due_date').nullable();
    t.timestamps(true, true);
    t.index(['organization_id', 'status'], 'prj_org_status_idx');
  });

  await knex.schema.createTable('tasks', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('project_id').unsigned().nullable().references('projects.id').onDelete('SET NULL');
    t.string('title', 200).notNullable();
    t.text('description');
    t.integer('assignee_user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.enu('priority', ['low', 'medium', 'high', 'urgent']).notNullable().defaultTo('medium');
    t.enu('status', ['todo', 'in_progress', 'review', 'done']).notNullable().defaultTo('todo');
    t.date('due_date').nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('completed_at').nullable();
    t.timestamps(true, true);
    t.index(['organization_id', 'status'], 'task_org_status_idx');
    t.index(['organization_id', 'assignee_user_id'], 'task_org_assignee_idx');
  });

  await knex.schema.createTable('task_comments', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('task_id').unsigned().notNullable().references('tasks.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.text('body').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // ---------- Notifications ----------
  await knex.schema.createTable('notifications', (t) => {
    t.bigIncrements('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('type', 60).notNullable();
    t.json('data'); // variables for the translated message
    t.string('link', 255);
    t.timestamp('read_at').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['organization_id', 'user_id', 'read_at'], 'notif_org_user_read_idx');
  });
};

exports.down = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
};
