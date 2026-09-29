// A password set by a company admin is temporary: the person chooses their own at first sign-in.
exports.up = (knex) => knex.schema.alterTable('users', (t) => { t.boolean('must_change_password').notNullable().defaultTo(false); });
exports.down = (knex) => knex.schema.alterTable('users', (t) => { t.dropColumn('must_change_password'); });
