const knex = require('../../db/knex');
const employees = require('../workforce/employee.service');
const ent = require('../billing/entitlements.service');

// Global search (Ctrl/⌘+K). Only searches modules that exist and the user may see.
async function search(ctx, term) {
  const q = String(term || '').trim();
  if (q.length < 2) return { employees: [], departments: [], jobs: [], candidates: [] };
  const results = { employees: [], departments: [], jobs: [], candidates: [] };
  if (ctx.permissions.has('employees.view') || ctx.permissions.has('team.view')) {
    const { data } = await employees.list(ctx, { q, per_page: 6, status: 'current' });
    results.employees = data.map((e) => ({ id: e.id, title: e.full_name, subtitle: [e.job_title, e.department_name].filter(Boolean).join(' · '), href: `/app/employees/${e.id}` }));
  }
  if (ctx.permissions.has('employees.view')) {
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
    const rows = await knex('departments').where({ organization_id: ctx.organizationId }).where('name', 'like', like).limit(4);
    results.departments = rows.map((d) => ({ id: d.id, title: d.name, href: `/app/employees?department_id=${d.id}` }));
  }
  if (ctx.permissions.has('recruitment.view') && (await ent.hasFeature(ctx.organizationId, 'recruitment'))) {
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
    const [jobs, candidates] = await Promise.all([
      knex('jobs').where({ organization_id: ctx.organizationId }).where('title', 'like', like).orderBy('id', 'desc').limit(4),
      knex('candidates').where({ organization_id: ctx.organizationId })
        .where((w) => w.whereRaw("CONCAT(first_name, ' ', last_name) LIKE ?", [like]).orWhere('email', 'like', like)).orderBy('id', 'desc').limit(5),
    ]);
    results.jobs = jobs.map((j) => ({ id: j.id, title: j.title, href: `/app/recruitment/jobs/${j.id}` }));
    results.candidates = candidates.map((c) => ({ id: c.id, title: `${c.first_name} ${c.last_name}`, subtitle: c.current_title || c.email, href: `/app/recruitment/candidates/${c.id}` }));
  }
  return results;
}

module.exports = { search };
