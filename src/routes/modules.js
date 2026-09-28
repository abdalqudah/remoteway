// Navigation map for modules that are planned but not built yet. `phase` follows the roadmap.
// Built modules (employees, attendance, leave, documents, tasks) have their own links in the sidebar.
const MODULES = [
  { key: 'payway', icon: 'credit-card', feature: 'payway', phase: 7, status: 'integration', group: 'finance' },
  { key: 'analytics', icon: 'chart-column', feature: 'analytics', phase: 8, status: 'soon', group: 'insights' },
  { key: 'compliance', icon: 'shield-check', feature: 'compliance', phase: 9, status: 'soon', group: 'insights' },
];

module.exports = { MODULES };
