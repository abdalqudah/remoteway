// Navigation map for modules that are planned but not built yet. `phase` follows the roadmap.
// Built modules (employees, attendance, leave, documents, tasks) have their own links in the sidebar.
const MODULES = [
  { key: 'recruitment', icon: 'briefcase', feature: 'recruitment', phase: 3, status: 'soon', group: 'talent' },
  { key: 'onboarding_module', icon: 'user-check', feature: 'onboarding', phase: 3, status: 'soon', group: 'talent' },
  { key: 'performance', icon: 'target', feature: 'performance', phase: 5, status: 'soon', group: 'talent' },
  { key: 'learning', icon: 'graduation-cap', feature: 'learning', phase: 6, status: 'soon', group: 'talent' },
  { key: 'payroll', icon: 'wallet', feature: 'payroll', phase: 4, status: 'soon', group: 'finance' },
  { key: 'payway', icon: 'credit-card', feature: 'payway', phase: 7, status: 'integration', group: 'finance' },
  { key: 'analytics', icon: 'chart-column', feature: 'analytics', phase: 8, status: 'soon', group: 'insights' },
  { key: 'compliance', icon: 'shield-check', feature: 'compliance', phase: 3, status: 'soon', group: 'insights' },
];

module.exports = { MODULES };
