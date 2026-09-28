// Media library for the editable website: uploaded images and videos, and YouTube/Vimeo links.
exports.up = async (knex) => {
  await knex.schema.dropTableIfExists('site_media');
  await knex.schema.createTable('site_media', (t) => {
    t.increments('id');
    t.enu('kind', ['image', 'video', 'embed']).notNullable();
    t.string('name', 150).notNullable();
    t.string('mime', 60);
    t.integer('size').unsigned();
    t.string('storage_key', 255);
    t.string('sha', 16);
    t.string('embed_url', 255);
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
};
exports.down = (knex) => knex.schema.dropTableIfExists('site_media');
