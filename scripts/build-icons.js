// Builds public/icons.svg (a <symbol> sprite) from lucide-static outline icons.
// Run only when the icon set changes: `npm run build:icons` (needs devDependencies).
const fs = require('fs');
const path = require('path');

const ICONS = [
  'flask-conical', 'log-in', 'refresh-cw', 'bot', 'share-2', 'layout-dashboard', 'users', 'user', 'user-plus', 'user-check', 'user-x', 'building-2', 'map-pin',
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
  'chevron-up', 'eye-off', 'heart', 'handshake', 'building', 'house', 'home', 'award', 'trophy', 'medal', 'lightbulb', 'headset', 'circle-help', 'circle-play', 'play', 'monitor', 'laptop', 'tablet-smartphone', 'cloud', 'server', 'lock-keyhole', 'fingerprint', 'scan-line', 'qr-code', 'map', 'calendar', 'clock-3', 'timer', 'bell-ring', 'megaphone', 'message-circle', 'mail-open', 'inbox', 'chart-line', 'chart-pie', 'trending-up', 'percent', 'banknote', 'coins', 'receipt-text', 'file-check', 'file-signature', 'folder', 'book-open', 'notebook-pen', 'pen-tool', 'palette', 'image', 'camera', 'video-off', 'wifi', 'signal', 'flag', 'leaf', 'sun-medium', 'star-half', 'thumbs-up', 'smile', 'users-round', 'user-check-2', 'id-card', 'contact', 'briefcase-business', 'hand-coins', 'piggy-bank', 'scale-3d', 'store', 'truck', 'plane-takeoff', 'car', 'globe-2', 'languages', 'list-checks', 'list-todo', 'layout-grid', 'layout-list', 'puzzle', 'plug-zap', 'settings-2', 'sliders-horizontal',
];

const dir = path.join(__dirname, '..', 'node_modules', 'lucide-static', 'icons');
const symbols = ICONS.map((name) => {
  const svg = fs.readFileSync(path.join(dir, `${name}.svg`), 'utf8');
  const inner = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
    .replace(/\s+/g, ' ').trim();
  return `<symbol id="i-${name}" viewBox="0 0 24 24">${inner}</symbol>`;
});

// Brand marks for social links and "Sign in with Google" (Simple Icons, CC0), drawn filled.
const BRANDS = { x: 'siX', linkedin: 'siLinkedin', instagram: 'siInstagram', facebook: 'siFacebook', youtube: 'siYoutube', tiktok: 'siTiktok', snapchat: 'siSnapchat', whatsapp: 'siWhatsapp', telegram: 'siTelegram', threads: 'siThreads', google: 'siGoogle' };
const si = require('simple-icons'); // eslint-disable-line import/no-extraneous-dependencies
for (const [name, key] of Object.entries(BRANDS)) symbols.push(`<symbol id="b-${name}" viewBox="0 0 24 24"><path fill="currentColor" stroke="none" d="${si[key].path}"/></symbol>`);

const out = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none"><!-- Lucide icons (ISC license); brand marks from Simple Icons (CC0) -->${symbols.join('')}</svg>\n`;
fs.writeFileSync(path.join(__dirname, '..', 'public', 'icons.svg'), out);
console.log(`Wrote ${symbols.length} icons to public/icons.svg`);
