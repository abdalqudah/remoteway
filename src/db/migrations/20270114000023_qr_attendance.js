// QR attendance: display screens ("kiosks") show a code that changes every minute; employees scan it
// with their phone to clock in or out. Each attendance record remembers how it was recorded.
exports.up = async (knex) => {
  await knex.schema.dropTableIfExists('attendance_kiosks');
  await knex.schema.createTable('attendance_kiosks', (t) => {
    t.increments('id');
    t.integer('organization_id').unsigned().notNullable().references('organizations.id').onDelete('CASCADE');
    t.integer('location_id').unsigned().nullable().references('locations.id').onDelete('SET NULL');
    t.string('name', 120).notNullable();
    t.string('public_id', 16).notNullable().unique(); // appears in the scanned link
    t.text('secret_enc').notNullable(); // signs the per-minute codes
    t.text('display_token_enc').notNullable(); // opens the display screen
    t.string('display_token_hash', 64).notNullable().unique();
    t.boolean('same_network').notNullable().defaultTo(false);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.string('last_ip', 64);
    t.datetime('last_seen_at').nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['organization_id']);
  });
  const cols = [['clock_in_method', 'clock_out_method']];
  for (const [a, b] of cols) {
    if (!(await knex.schema.hasColumn('attendance', a))) {
      await knex.schema.alterTable('attendance', (t) => {
        t.string(a, 10).nullable();
        t.string(b, 10).nullable();
        t.integer('kiosk_id').unsigned().nullable().references('attendance_kiosks.id').onDelete('SET NULL');
      });
    }
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('attendance', 'clock_in_method')) {
    await knex.schema.alterTable('attendance', (t) => { t.dropForeign(['kiosk_id']); t.dropColumn('kiosk_id'); t.dropColumn('clock_in_method'); t.dropColumn('clock_out_method'); });
  }
  await knex.schema.dropTableIfExists('attendance_kiosks');
};
