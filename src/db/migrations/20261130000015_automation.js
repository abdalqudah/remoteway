// Advanced Automation: "when … if … then …" rules and a run log (one row per rule and occurrence,
// so a rule never acts twice on the same event or date).
const TABLES = ['automation_runs', 'automation_rules'];

exports.up = async (knex) => {
  // MySQL DDL is not transactional: clear leftovers of a previously interrupted run of this migration.
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
  await knex.schema.createTable('automation_rules', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('name', 150).notNullable();
    t.string('trigger', 40).notNullable(); // event name (employee.created …) or schedule key (document_expiring …)
    t.json('trigger_options'); // { days, category }
    t.json('conditions'); // { department_ids, employment_types, nationality, leave_type_ids, min_days }
    t.json('actions'); // [{ type: notify|create_task|assign_course|post_chat, ... }]
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('last_run_at').nullable();
    t.integer('run_count').notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.index(['organization_id', 'is_active', 'trigger'], 'ar_org_active_trigger_idx');
  });
  await knex.schema.createTable('automation_runs', (t) => {
    t.bigIncrements('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('rule_id').unsigned().notNullable().references('automation_rules.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().nullable().references('employees.id').onDelete('SET NULL');
    t.string('dedupe_key', 120).notNullable();
    t.enu('status', ['running', 'done', 'skipped', 'failed']).notNullable().defaultTo('running');
    t.json('detail'); // what each action did
    t.string('error', 500);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['rule_id', 'dedupe_key'], 'arun_rule_key_uq');
    t.index(['organization_id', 'id'], 'arun_org_idx');
  });
};

exports.down = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
};
