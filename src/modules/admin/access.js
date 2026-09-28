// Platform team roles. Every super admin has one; what each role may open and change is decided here.
//   owner   — everything, including the platform team and system updates
//   admin   — runs the platform (companies, plans, settings) but cannot manage the team or update the system
//   finance — companies' subscriptions, invoices and payments
//   support — reads companies and answers support tickets
//   sales   — the internal CRM (contacts, pipeline, messages) and reads companies
const ROLES = ['owner', 'admin', 'sales', 'finance', 'support'];
const ALL = ROLES;
const SECTIONS = {
  overview: ALL,
  organizations: ALL,
  plans: ['owner', 'admin'],
  invoices: ['owner', 'admin', 'finance'],
  payments: ['owner', 'admin', 'finance'],
  audit: ['owner', 'admin'],
  email: ['owner', 'admin'],
  support: ['owner', 'admin', 'support'],
  ai: ['owner', 'admin'],
  jobs: ['owner', 'admin'],
  system: ['owner'],
  team: ['owner'],
  crm: ['owner', 'admin', 'sales', 'support'],
  backups: ['owner'],
  errors: ['owner', 'admin'],
  launch: ['owner', 'admin'],
  legal: ['owner', 'admin'],
};
// Changing things (POST) in these sections needs a narrower role than reading them.
const WRITE = {
  organizations: ['owner', 'admin', 'finance'],
  payments: ['owner', 'admin'], // gateway keys; finance can still see payments
};

const roleOf = (user) => (user && user.is_super_admin ? (ROLES.includes(user.platform_role) ? user.platform_role : 'owner') : null);

function can(user, section, write = false) {
  const role = roleOf(user);
  if (!role) return false;
  const list = (write && WRITE[section]) || SECTIONS[section];
  return Boolean(list && list.includes(role));
}

module.exports = { ROLES, SECTIONS, roleOf, can };
