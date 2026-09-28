// Phase 4 — Payroll: pay components, employee pay profiles, payroll runs, payslips and their lines.
// Money columns use 3 decimals so KWD/BHD/OMR/JOD (3 minor digits) are exact; other currencies round to 2.
const TABLES = ['payslip_lines', 'payslips', 'payroll_adjustments', 'payroll_runs', 'employee_pay_components', 'employee_pay_profiles', 'pay_components'];

exports.up = async (knex) => {
  // MySQL DDL is not transactional: clear leftovers of a previously interrupted run of this migration.
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);

  await knex.schema.alterTable('employees', (t) => {
    t.decimal('base_salary', 14, 3).alter();
  });

  await knex.schema.createTable('pay_components', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('code', 30).notNullable();
    t.string('name', 100).notNullable();
    t.string('name_ar', 100);
    t.enu('kind', ['earning', 'deduction']).notNullable();
    t.enu('calc', ['fixed', 'percent_basic']).notNullable().defaultTo('fixed');
    t.decimal('default_value', 14, 3).nullable(); // amount, or percent of basic
    t.boolean('in_gosi_base').notNullable().defaultTo(false); // e.g. housing allowance counts towards GOSI wage
    t.boolean('prorate').notNullable().defaultTo(true); // scaled for partial months (loan deductions usually are not)
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.unique(['organization_id', 'code'], 'pc_org_code_uq');
  });

  await knex.schema.createTable('employee_pay_profiles', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.enu('payment_method', ['bank', 'cash']).notNullable().defaultTo('bank');
    t.string('bank_name', 100);
    t.string('iban', 34);
    t.string('account_name', 150);
    t.boolean('gosi_registered').notNullable().defaultTo(true);
    t.string('gosi_number', 30);
    t.timestamps(true, true);
    t.unique(['employee_id'], 'epp_emp_uq');
    t.index(['organization_id'], 'epp_org_idx');
  });

  await knex.schema.createTable('employee_pay_components', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.integer('component_id').unsigned().notNullable().references('pay_components.id').onDelete('CASCADE');
    t.decimal('value', 14, 3).notNullable(); // amount, or percent of basic (per the component's calc)
    t.timestamps(true, true);
    t.unique(['employee_id', 'component_id'], 'epc_emp_comp_uq');
    t.index(['organization_id'], 'epc_org_idx');
  });

  await knex.schema.createTable('payroll_runs', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('period', 7).notNullable(); // YYYY-MM
    t.date('period_start').notNullable();
    t.date('period_end').notNullable();
    t.enu('status', ['draft', 'review', 'approved', 'paid', 'cancelled']).notNullable().defaultTo('draft');
    t.string('currency', 3).notNullable();
    t.integer('employee_count').notNullable().defaultTo(0);
    t.decimal('total_gross', 16, 3).notNullable().defaultTo(0);
    t.decimal('total_deductions', 16, 3).notNullable().defaultTo(0);
    t.decimal('total_net', 16, 3).notNullable().defaultTo(0);
    t.decimal('total_employer', 16, 3).notNullable().defaultTo(0);
    t.json('warnings');
    t.string('notes', 1000);
    t.date('payment_date');
    t.timestamp('calculated_at').nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('submitted_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('submitted_at').nullable();
    t.integer('approved_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('approved_at').nullable();
    t.integer('paid_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('paid_at').nullable();
    t.timestamps(true, true);
    t.index(['organization_id', 'period'], 'pr_org_period_idx');
    t.index(['organization_id', 'status'], 'pr_org_status_idx');
  });

  await knex.schema.createTable('payroll_adjustments', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('run_id').unsigned().notNullable().references('payroll_runs.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    t.enu('kind', ['earning', 'deduction']).notNullable();
    t.string('name', 120).notNullable();
    t.decimal('amount', 14, 3).notNullable();
    t.string('note', 500);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['organization_id', 'run_id'], 'padj_org_run_idx');
  });

  await knex.schema.createTable('payslips', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('run_id').unsigned().notNullable().references('payroll_runs.id').onDelete('CASCADE');
    t.integer('employee_id').unsigned().notNullable().references('employees.id').onDelete('CASCADE');
    // Snapshot of the employee at calculation time, so approved payslips never change afterwards.
    t.string('employee_number', 30);
    t.string('employee_name', 170).notNullable();
    t.string('job_title', 120);
    t.string('department_name', 120);
    t.string('nationality', 2);
    t.string('payment_method', 10);
    t.string('bank_name', 100);
    t.string('iban', 34);
    t.decimal('paid_days', 6, 2).notNullable();
    t.decimal('period_days', 6, 2).notNullable();
    t.decimal('unpaid_leave_days', 6, 2).notNullable().defaultTo(0);
    t.decimal('basic', 14, 3).notNullable().defaultTo(0);
    t.decimal('gross', 14, 3).notNullable().defaultTo(0);
    t.decimal('total_deductions', 14, 3).notNullable().defaultTo(0);
    t.decimal('net', 14, 3).notNullable().defaultTo(0);
    t.decimal('employer_cost', 14, 3).notNullable().defaultTo(0);
    t.decimal('gosi_base', 14, 3).notNullable().defaultTo(0);
    t.json('warnings');
    t.timestamps(true, true);
    t.unique(['run_id', 'employee_id'], 'ps_run_emp_uq');
    t.index(['organization_id', 'employee_id'], 'ps_org_emp_idx');
  });

  await knex.schema.createTable('payslip_lines', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('payslip_id').unsigned().notNullable().references('payslips.id').onDelete('CASCADE');
    t.enu('kind', ['earning', 'deduction', 'employer']).notNullable();
    t.enu('source', ['basic', 'component', 'statutory', 'leave', 'adjustment']).notNullable();
    t.string('code', 30).notNullable();
    t.string('name', 120).notNullable();
    t.string('name_ar', 120);
    t.decimal('amount', 14, 3).notNullable();
    t.string('note', 255);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.index(['payslip_id'], 'psl_slip_idx');
  });
};

exports.down = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
};
