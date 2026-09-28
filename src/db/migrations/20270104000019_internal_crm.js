// RemoteWay's own internal CRM (Super Admin → CRM): the people the RemoteWay team works with —
// registered users, individuals, applicants and leads — with a customisable pipeline, a full
// communication timeline, follow-ups and message templates. It is NOT a feature offered to companies.
const TABLES = ['crm_templates', 'crm_followups', 'crm_activities', 'crm_contacts', 'crm_stages'];

const STAGES = [
  ['new_lead', 'New lead', 'عميل محتمل جديد', '#64748B'],
  ['contacted', 'Contacted', 'تم التواصل', '#2563EB'],
  ['interested', 'Interested', 'مهتم', '#7C3AED'],
  ['registered', 'Registered', 'مسجّل', '#0891B2'],
  ['follow_up', 'Follow up', 'متابعة', '#D97706'],
  ['expected_to_subscribe', 'Expected to subscribe', 'متوقع الاشتراك', '#CA8A04'],
  ['subscribed', 'Subscribed successfully', 'اشترك بنجاح', '#13AA54'],
  ['not_interested', 'Not interested', 'غير مهتم', '#DC2626'],
  ['inactive', 'Inactive', 'غير نشط', '#6B7280'],
];

exports.up = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
  await knex.schema.createTable('crm_stages', (t) => {
    t.increments('id');
    t.string('key', 40).notNullable().unique();
    t.string('name', 80).notNullable();
    t.string('name_ar', 80);
    t.string('color', 7).notNullable().defaultTo('#64748B');
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('is_system').notNullable().defaultTo(false); // used by platform events; can be renamed, not deleted
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamps(true, true);
  });
  await knex('crm_stages').insert(STAGES.map(([key, name, nameAr, color], i) => ({ key, name, name_ar: nameAr, color, sort_order: i, is_system: true })));

  await knex.schema.createTable('crm_contacts', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL'); // platform account, when registered
    t.integer('organization_id').unsigned().nullable().references('organizations.id').onDelete('SET NULL');
    t.enu('kind', ['lead', 'company_owner', 'company_user', 'individual', 'applicant', 'contact']).notNullable().defaultTo('lead');
    t.string('name', 150).notNullable();
    t.string('email', 190);
    t.string('phone', 30); // international digits
    t.string('company_name', 150);
    t.string('job_title', 150);
    t.string('country_code', 2);
    t.string('city', 100);
    t.string('source', 30).notNullable().defaultTo('manual');
    t.integer('stage_id').unsigned().notNullable().references('crm_stages.id');
    t.timestamp('stage_changed_at').nullable();
    t.integer('owner_user_id').unsigned().nullable().references('users.id').onDelete('SET NULL'); // responsible team member
    t.timestamp('last_contact_at').nullable();
    t.integer('last_contact_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('last_inbound_at').nullable();
    t.datetime('next_follow_up_at').nullable();
    t.timestamp('registered_at').nullable();
    t.timestamp('subscribed_at').nullable();
    t.text('notes');
    t.json('tags');
    t.string('locale', 5).defaultTo('ar');
    t.boolean('opt_out_email').notNullable().defaultTo(false);
    t.boolean('opt_out_sms').notNullable().defaultTo(false);
    t.boolean('opt_out_whatsapp').notNullable().defaultTo(false);
    t.json('ai_summary');
    t.timestamp('ai_summary_at').nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['user_id'], 'crmc_user_uq');
    t.unique(['email'], 'crmc_email_uq');
    t.index(['stage_id'], 'crmc_stage_idx');
    t.index(['owner_user_id'], 'crmc_owner_idx');
    t.index(['phone'], 'crmc_phone_idx');
    t.index(['next_follow_up_at'], 'crmc_follow_idx');
    t.index(['created_at'], 'crmc_created_idx');
  });

  await knex.schema.createTable('crm_activities', (t) => {
    t.bigIncrements('id');
    t.integer('contact_id').unsigned().notNullable().references('crm_contacts.id').onDelete('CASCADE');
    // note, call, meeting, email, sms, whatsapp, stage_change, registration, profile_completed, applied,
    // subscription_started, subscription_paid, follow_up, follow_up_done, assigned, system
    t.string('type', 30).notNullable();
    t.enu('direction', ['in', 'out']).nullable();
    t.string('channel', 20).nullable(); // email | sms | whatsapp | phone | meeting | platform
    t.string('subject', 200);
    t.text('body');
    t.string('status', 20).nullable(); // sent | failed | received | delivered | read
    t.json('meta');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL'); // team member (null = system)
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['contact_id', 'created_at'], 'crma_contact_idx');
    t.index(['type', 'created_at'], 'crma_type_idx');
    t.index(['user_id', 'created_at'], 'crma_user_idx');
  });

  await knex.schema.createTable('crm_followups', (t) => {
    t.increments('id');
    t.integer('contact_id').unsigned().notNullable().references('crm_contacts.id').onDelete('CASCADE');
    t.integer('assigned_to').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.datetime('due_at').notNullable(); // DATETIME: TIMESTAMP stops at 2038
    t.text('note');
    t.enu('status', ['open', 'done', 'cancelled']).notNullable().defaultTo('open');
    t.boolean('remind').notNullable().defaultTo(true);
    t.timestamp('reminded_at').nullable();
    t.timestamp('completed_at').nullable();
    t.integer('completed_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['status', 'due_at'], 'crmf_status_idx');
    t.index(['assigned_to', 'status'], 'crmf_assignee_idx');
  });

  await knex.schema.createTable('crm_templates', (t) => {
    t.increments('id');
    t.enu('channel', ['email', 'sms', 'whatsapp']).notNullable();
    t.string('name', 120).notNullable();
    t.string('subject', 200);
    t.text('body').notNullable();
    t.string('wa_template', 120); // approved WhatsApp template name (for messages outside the 24-hour window)
    t.string('wa_language', 10);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });
};

exports.down = async (knex) => {
  for (const table of TABLES) await knex.schema.dropTableIfExists(table);
};
