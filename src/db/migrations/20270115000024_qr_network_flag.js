// QR attendance: remember when a scan came from a network other than the screen's (shown to managers).
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('attendance', 'qr_off_network'))) {
    await knex.schema.alterTable('attendance', (t) => { t.boolean('qr_off_network').notNullable().defaultTo(false); });
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('attendance', 'qr_off_network')) await knex.schema.alterTable('attendance', (t) => { t.dropColumn('qr_off_network'); });
};
