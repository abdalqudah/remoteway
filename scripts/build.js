// npm run build -> dist/ : a clean, production-only copy ready to upload to cPanel (Orange Host).
// Contains no node_modules (cPanel "Run NPM Install" creates them), no tests, no dev tools, no .env.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

const copy = (rel) => fs.cpSync(path.join(root, rel), path.join(dist, rel), { recursive: true });
['app.js', 'knexfile.js', 'package-lock.json', '.env.example', 'README.md', 'src', 'public', 'docs',
  'scripts/migrate.js', 'scripts/seed-demo.js'].forEach(copy);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
delete pkg.devDependencies;
pkg.scripts = { start: pkg.scripts.start, migrate: pkg.scripts.migrate, 'seed:demo': pkg.scripts['seed:demo'] };
fs.writeFileSync(path.join(dist, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

let files = 0;
const count = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => (d.isDirectory() ? count(path.join(dir, d.name)) : files++));
count(dist);
console.log(`dist/ ready (${files} files). Upload its contents to your app root, then "Run NPM Install" and "Restart".`);
