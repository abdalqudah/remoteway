const knex = require('../../db/knex');
const employees = require('../workforce/employee.service');

// Global search (Ctrl/⌘+K). Only searches modules that exist and the user may see.
async function search(ctx, term) {
  const q = String(term || '').trim();
  if (q.length < 2) return { employees: [], departments: [] };
  const results = { employees: [], departments: [] };
  if (ctx.permissions.has('employees.view') || ctx.permissions.has('team.view')) {
    const { data } = await employees.list(ctx, { q, per_page: 6, status: 'current' });
    results.employees = data.map((e) => ({ id: e.id, title: e.full_name, subtitle: [e.job_title, e.department_name].filter(Boolean).join(' · '), href: `/app/employees/${e.id}` }));
  }
  if (ctx.permissions.has('employees.view')) {
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
    const rows = await knex('departments').where({ organization_id: ctx.organizationId }).where('name', 'like', like).limit(4);
    results.departments = rows.map((d) => ({ id: d.id, title: d.name, href: `/app/employees?department_id=${d.id}` }));
  }
  return results;
}

module.exports = { search };
