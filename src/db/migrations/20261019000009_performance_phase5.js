// Phase 5 — Performance: goals (OKRs) with key results and check-ins, competencies, review cycles, reviews, feedback.
const TABLES = ['feedback', 'review_items', 'reviews', 'review_cycles', 'goal_checkins', 'goal_key_results', 'goals', 'competencies'];

exports.up = async (knex) => {
  // MySQL DDL is not transactional: clear leftovers of a previously interrupted run of this migration.
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);

  await knex.schema.createTable('competencies', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('name', 120).notNullable();
    t.string('name_ar', 120);
    t.string('description', 500);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.index(['organization_id'], 'comp_org_idx');
  });

  await knex.schema.createTable('review_cycles', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('name', 150).notNullable();
    t.enu('kind', ['annual', 'semi_annual', 'quarterly', 'probation', 'other']).notNullable().defaultTo('annual');
    t.date('period_start').notNullable();
    t.date('period_end').notNullable();
    t.date('self_due').nullable();
    t.date('manager_due').nullable();
    t.enu('status', ['draft', 'active', 'closed']).notNullable().defaultTo('draft');
    t.boolean('include_self').notNullable().defaultTo(true);
    t.integer('goals_weight').notNullable().defaultTo(50); // % of the final score; competencies get the rest
    t.json('competency_ids');
    t.json('department_ids'); // empty = everyone
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('launched_at').nullable();
    t.timestamp('closed_at').nullable();
    t.timestamps(true, true);
    t.index(['organization_id', 'status'], 'rc_org_status_idx');
  });

  await knex.schema.createTable('goals', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.enu('scope', ['company', 'department', 'individual']).notNullable().defaultTo('individual');
    t.integer('employee_id').unsigned().nullable().references('employees.id').onDelete('CASCADE');
    t.integer('department_id').unsigned().nullable().references('departments.id').onDelete('SET NULL');
    t.integer('parent_id').unsigned().nullable().references('goals.id').onDelete('SET NULL');
    t.string('title', 200).notNullable();
    t.text('description');
    t.date('start_date').nullable();
    t.date('due_date').nullable();
    t.enu('status', ['active', 'done', 'cancelled']).notNullable().defaultTo('active');
    t.enu('health', ['on_track', 'at_risk', 'off_track']).notNullable().defaultTo('on_track');
    t.decimal('progress', 5, 2).notNullable().defaultTo(0);
    t.integer('weight').notNullable().defaultTo(1);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['organization_id', 'scope'], 'goal_org_scope_idx');
    t.index(['organization_id', 'employee_id'], 'goal_org_emp_idx');
  });

  await knex.schema.createTable('goal_key_results', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('goal_id').unsigned().notNullable().references('goals.id').onDelete('CASCADE');
    t.string('title', 200).notNullable();
    t.decimal('start_value', 16, 2).notNullable().defaultTo(0);
    t.decimal('target_value', 16, 2).notNullable().defaultTo(100);
    t.decimal('current_value', 16, 2).notNullable().defaultTo(0);
    t.string('unit', 20);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.index(['goal_id'], 'gkr_goal_idx');
  });

  await knex.schema.createTable('goal_checkins', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('goal_id').unsigned().notNullable().references('goals.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.decimal('progress', 5, 2).notNullable();
    t.enu('health', ['on_track', 'at_risk', 'off_track']).notNullable();
    t.json('values'); // { keyResultId: value } at the time of the check-in
    t.string('note', 2000);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['goal_id'], 'gci_goal_idx');
  });

  await knex.schema.createTable('reviews', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('cycle_id').unsigned().notNullable().references('review_cycles.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.integer('reviewer_user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.enu('status', ['self_review', 'manager_review', 'completed']).notNullable();
    t.text('self_summary');
    t.timestamp('self_submitted_at').nullable();
    t.text('manager_summary');
    t.text('strengths');
    t.text('improvements');
    t.timestamp('manager_submitted_at').nullable();
    t.decimal('goals_score', 4, 2).nullable();
    t.decimal('competency_score', 4, 2).nullable();
    t.decimal('final_score', 4, 2).nullable();
    t.tinyint('final_rating').nullable();
    t.timestamp('acknowledged_at').nullable();
    t.text('employee_comment');
    t.timestamps(true, true);
    t.unique(['cycle_id', 'employee_id'], 'rev_cycle_emp_uq');
    t.index(['organization_id', 'reviewer_user_id'], 'rev_org_reviewer_idx');
  });

  await knex.schema.createTable('review_items', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('review_id').unsigned().notNullable().references('reviews.id').onDelete('CASCADE');
    t.enu('item_type', ['competency', 'goal']).notNullable();
    t.integer('competency_id').unsigned().nullable().references('competencies.id').onDelete('SET NULL');
    t.integer('goal_id').unsigned().nullable().references('goals.id').onDelete('SET NULL');
    t.string('title', 200).notNullable();
    t.string('title_ar', 200);
    t.tinyint('self_rating').nullable();
    t.string('self_comment', 2000);
    t.tinyint('manager_rating').nullable();
    t.string('manager_comment', 2000);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.index(['review_id'], 'ri_review_idx');
  });

  await knex.schema.createTable('feedback', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('from_user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.enu('kind', ['praise', 'suggestion']).notNullable().defaultTo('praise');
    t.enu('visibility', ['private', 'public']).notNullable().defaultTo('private');
    t.string('body', 2000).notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['organization_id', 'employee_id'], 'fb_org_emp_idx');
    t.index(['organization_id', 'visibility'], 'fb_org_vis_idx');
  });
};

exports.down = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
};
