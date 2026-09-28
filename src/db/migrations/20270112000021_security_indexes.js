// Per-account sign-in throttles look up recent failed attempts in the audit log.
exports.up = async (knex) => {
  const [rows] = await knex.raw("SHOW INDEX FROM audit_logs WHERE Key_name = 'audit_user_action_idx'");
  if (!rows.length) await knex.schema.alterTable('audit_logs', (t) => { t.index(['user_id', 'action', 'created_at'], 'audit_user_action_idx'); });
};
exports.down = async (knex) => {
  await knex.schema.alterTable('audit_logs', (t) => { t.dropIndex(['user_id', 'action', 'created_at'], 'audit_user_action_idx'); });
};
