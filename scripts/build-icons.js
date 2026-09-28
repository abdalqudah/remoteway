// Builds public/icons.svg (a <symbol> sprite) from lucide-static outline icons.
// Run only when the icon set changes: `npm run build:icons` (needs devDependencies).
const fs = require('fs');
const path = require('path');

const ICONS = [
  'layout-dashboard', 'users', 'user', 'user-plus', 'user-check', 'user-x', 'building-2', 'map-pin',
  'briefcase', 'calendar-check', 'calendar-days', 'plane', 'wallet', 'target', 'graduation-cap',
  'list-checks', 'folder-kanban', 'file-text', 'shield-check', 'chart-column', 'life-buoy', 'plug',
  'sparkles', 'credit-card', 'settings', 'search', 'bell', 'log-out', 'chevron-down', 'chevron-right',
  'chevron-left', 'chevrons-up-down', 'plus', 'pencil', 'trash-2', 'x', 'check', 'circle-alert',
  'triangle-alert', 'info', 'lock', 'moon', 'sun', 'languages', 'menu', 'filter', 'arrow-up-down',
  'arrow-right', 'arrow-left', 'download', 'upload', 'mail', 'key-round', 'history', 'eye', 'ellipsis',
  'clock', 'circle-check', 'circle-x', 'rocket', 'layers', 'gauge', 'receipt', 'hard-drive', 'globe',
  'copy', 'external-link', 'panel-left', 'columns-3', 'user-cog', 'badge-check', 'package', 'zap',
  'phone', 'video', 'star', 'message-square', 'link', 'send', 'clipboard-list', 'user-round-plus',
  'mail-check', 'shield-alert', 'smartphone', 'database', 'bug', 'scale', 'cookie', 'archive-restore',
];

const dir = path.join(__dirname, '..', 'node_modules', 'lucide-static', 'icons');
const symbols = ICONS.map((name) => {
  const svg = fs.readFileSync(path.join(dir, `${name}.svg`), 'utf8');
  const inner = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
    .replace(/\s+/g, ' ').trim();
  return `<symbol id="i-${name}" viewBox="0 0 24 24">${inner}</symbol>`;
});

const out = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none"><!-- Lucide icons (ISC license) -->${symbols.join('')}</svg>\n`;
fs.writeFileSync(path.join(__dirname, '..', 'public', 'icons.svg'), out);
console.log(`Wrote ${ICONS.length} icons to public/icons.svg`);
