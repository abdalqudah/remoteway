const knex = require('../../db/knex');

async function list(organizationId, { page = 1, perPage = 30, action } = {}) {
  const q = knex('audit_logs as a').leftJoin('users as u', 'u.id', 'a.user_id');
  if (organizationId !== null) q.where('a.organization_id', organizationId);
  if (action) q.where('a.action', 'like', `${String(action).replace(/[%_]/g, '\\$&')}%`);
  const [{ total }] = await q.clone().count({ total: '*' });
  const rows = await q.select('a.*', 'u.name as user_name', 'u.email as user_email').orderBy('a.id', 'desc')
    .limit(perPage).offset((Math.max(1, page) - 1) * perPage);
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  return {
    data: rows.map((r) => ({ ...r, old_values: parse(r.old_values), new_values: parse(r.new_values) })),
    meta: { total: Number(total), page: Math.max(1, page), pages: Math.max(1, Math.ceil(Number(total) / perPage)) },
  };
}

module.exports = { list };
