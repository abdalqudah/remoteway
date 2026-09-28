// Phase 9 — Enterprise: single sign-on (OIDC), multi-step approval workflows for leave,
// saved & scheduled reports, and the client success portal (support tickets with SLA).
const TABLES = ['ticket_messages', 'support_tickets', 'report_schedules', 'saved_reports', 'leave_request_steps', 'approval_workflows', 'user_identities', 'sso_connections'];

exports.up = async (knex) => {
  // MySQL DDL is not transactional: clear leftovers of a previously interrupted run of this migration.
  if (await knex.schema.hasColumn('leave_requests', 'workflow_id')) {
    const [fk] = await knex.raw("SELECT CONSTRAINT_NAME AS n FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leave_requests' AND CONSTRAINT_NAME = 'lr_workflow_fk'");
    if (fk.length) await knex.schema.alterTable('leave_requests', (t) => { t.dropForeign('workflow_id', 'lr_workflow_fk'); });
    await knex.schema.alterTable('leave_requests', (t) => { t.dropColumn('workflow_id'); });
  }
  if (await knex.schema.hasColumn('leave_requests', 'current_step')) await knex.schema.alterTable('leave_requests', (t) => { t.dropColumn('current_step'); });
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);

  // ---------- SSO ----------
  await knex.schema.createTable('sso_connections', (t) => {
    t.integer('organization_id').unsigned().primary().references('organizations.id').onDelete('CASCADE');
    t.string('protocol', 10).notNullable().defaultTo('oidc');
    t.string('issuer', 255).notNullable();
    t.string('client_id', 255).notNullable();
    t.text('client_secret_enc');
    t.json('domains'); // allowed email domains, lower case
    t.boolean('enabled').notNullable().defaultTo(false);
    t.boolean('enforce').notNullable().defaultTo(false); // password sign-in blocked for members (owners keep a break-glass password)
    t.boolean('jit').notNullable().defaultTo(false); // create accounts on first sign-in
    t.string('default_role', 40).notNullable().defaultTo('employee');
    t.datetime('verified_at').nullable(); // set by a successful test sign-in; required before enforcing
    t.datetime('last_login_at').nullable();
    t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });
  await knex.schema.createTable('user_identities', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('issuer', 255).notNullable();
    t.string('subject', 255).notNullable();
    t.string('email', 190);
    t.datetime('last_login_at').nullable();
    t.timestamps(true, true);
    t.unique(['issuer', 'subject'], 'uid_iss_sub_uq');
  });

  // ---------- Approval workflows ----------
  await knex.schema.createTable('approval_workflows', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('entity', 20).notNullable().defaultTo('leave');
    t.string('name', 150).notNullable();
    t.json('leave_type_ids'); // empty = all types
    t.decimal('min_days', 6, 2).nullable(); // applies when the request is at least this long
    t.json('steps'); // [{ type: manager|department_head|role|user, ref }]
    t.integer('priority').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['organization_id', 'entity', 'is_active'], 'aw_org_entity_idx');
  });
  await knex.schema.alterTable('leave_requests', (t) => {
    t.integer('workflow_id').unsigned().nullable();
    t.integer('current_step').nullable();
    t.foreign('workflow_id', 'lr_workflow_fk').references('approval_workflows.id').onDelete('SET NULL');
  });
  await knex.schema.createTable('leave_request_steps', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('leave_request_id').unsigned().notNullable().references('leave_requests.id').onDelete('CASCADE');
    t.integer('step_no').notNullable();
    t.string('approver_type', 20).notNullable();
    t.string('approver_ref', 60);
    t.string('approver_label', 150);
    t.enu('status', ['waiting', 'pending', 'approved', 'rejected', 'skipped', 'cancelled']).notNullable().defaultTo('waiting');
    t.integer('decided_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('decided_at').nullable();
    t.string('note', 500);
    t.unique(['leave_request_id', 'step_no'], 'lrs_req_step_uq');
    t.index(['organization_id', 'status'], 'lrs_org_status_idx');
  });

  // ---------- Reports ----------
  await knex.schema.createTable('saved_reports', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('name', 150).notNullable();
    t.string('dataset', 30).notNullable();
    t.json('config'); // { columns, filters, group_by, sort }
    t.boolean('is_shared').notNullable().defaultTo(false); // visible to others who may see the dataset
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['organization_id', 'created_by'], 'sr_org_user_idx');
  });
  await knex.schema.createTable('report_schedules', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('report_id').unsigned().notNullable().references('saved_reports.id').onDelete('CASCADE');
    t.enu('frequency', ['daily', 'weekly', 'monthly']).notNullable();
    t.tinyint('weekday').nullable(); // 0 = Sunday
    t.tinyint('day_of_month').nullable();
    t.tinyint('hour').notNullable().defaultTo(8); // organization time zone
    t.json('recipients'); // user ids (organization members only)
    t.boolean('is_active').notNullable().defaultTo(true);
    t.datetime('next_run_at').notNullable();
    t.datetime('last_run_at').nullable();
    t.string('last_status', 255);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['is_active', 'next_run_at'], 'rs_due_idx');
  });

  // ---------- Client success portal ----------
  await knex.schema.createTable('support_tickets', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.string('subject', 200).notNullable();
    t.enu('category', ['technical', 'billing', 'account', 'data', 'feature_request', 'other']).notNullable().defaultTo('technical');
    t.enu('priority', ['low', 'normal', 'high', 'urgent']).notNullable().defaultTo('normal');
    t.enu('status', ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed']).notNullable().defaultTo('open');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('assigned_to').unsigned().nullable().references('users.id').onDelete('SET NULL'); // platform staff
    t.integer('sla_hours').notNullable();
    t.datetime('first_response_due').notNullable();
    t.datetime('first_response_at').nullable();
    t.datetime('resolved_at').nullable();
    t.datetime('last_activity_at').notNullable();
    t.tinyint('satisfaction').nullable(); // 1-5 after resolution
    t.timestamps(true, true);
    t.index(['organization_id', 'status'], 'st_org_status_idx');
    t.index(['status', 'first_response_due'], 'st_status_due_idx');
  });
  await knex.schema.createTable('ticket_messages', (t) => {
    t.increments('id');
    t.integer('ticket_id').unsigned().notNullable().references('support_tickets.id').onDelete('CASCADE');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.boolean('is_staff').notNullable().defaultTo(false);
    t.boolean('is_internal').notNullable().defaultTo(false); // staff-only note, never shown to the company
    t.text('body').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['ticket_id', 'id'], 'tm_ticket_idx');
  });
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('leave_requests', 'workflow_id')) {
    await knex.schema.alterTable('leave_requests', (t) => { t.dropForeign('workflow_id', 'lr_workflow_fk'); });
    await knex.schema.alterTable('leave_requests', (t) => { t.dropColumn('workflow_id'); t.dropColumn('current_step'); });
  }
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
};
