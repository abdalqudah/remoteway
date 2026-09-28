// Who may do what in Performance.
//  • Admin (HR): performance.manage + org-wide employee access → cycles, competencies, company/department goals, every review.
//  • Managers: act on their reporting line (goals for reports, manager reviews assigned to them).
//  • Everyone: their own goals, self reviews and feedback.
const employees = require('../workforce/employee.service');

const isAdmin = (ctx) => ctx.permissions.has('performance.manage') && ctx.permissions.has('employees.view');

/** Employee ids this user can see performance data for (null = everyone). */
async function scopeIds(ctx) {
  if (isAdmin(ctx) || (ctx.permissions.has('performance.view') && ctx.permissions.has('employees.view'))) return null;
  return employees.visibleIds(ctx);
}

/** Employee ids this user manages (not including themselves). */
async function managedIds(ctx) {
  const self = await employees.linkedEmployeeId(ctx);
  if (!self || !ctx.permissions.has('team.view')) return [];
  return employees.reportIds(ctx.organizationId, self);
}

module.exports = { isAdmin, scopeIds, managedIds };
