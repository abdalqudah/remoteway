// npm run build -> dist/ and dist.zip: a clean, production-only copy ready to upload to cPanel (Orange Host),
// or to install from Super Admin → System update.
// Contains no node_modules (cPanel "Run NPM Install" creates them), no tests, no dev tools, no .env.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const zipPath = path.join(root, 'remoteway-dist.zip');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

const copy = (rel) => fs.cpSync(path.join(root, rel), path.join(dist, rel), { recursive: true });
['app.js', 'knexfile.js', 'package-lock.json', '.env.example', 'README.md', 'src', 'public', 'docs',
  'scripts/migrate.js', 'scripts/seed-demo.js', 'scripts/doctor.js', 'scripts/run-jobs.js'].filter((f) => fs.existsSync(path.join(root, f))).forEach(copy);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
delete pkg.devDependencies;
pkg.scripts = Object.fromEntries(['start', 'migrate', 'seed:demo', 'doctor', 'jobs'].filter((k) => pkg.scripts[k]).map((k) => [k, pkg.scripts[k]]));
fs.writeFileSync(path.join(dist, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

let commit = null;
try { commit = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a git checkout */ }
fs.writeFileSync(path.join(dist, 'build.json'), `${JSON.stringify({ name: pkg.name, version: pkg.version, commit, builtAt: new Date().toISOString() }, null, 2)}\n`);

// Zip with explicit permissions: files 0644, folders 0755 (readable by the web server on shared hosting).
const zip = new AdmZip();
let files = 0;
(function add(dir, rel) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      zip.addFile(`${name}/`, Buffer.alloc(0), '', 0o755);
      add(full, name);
    } else {
      zip.addFile(name, fs.readFileSync(full), '', 0o644);
      files += 1;
    }
  }
}(dist, ''));
zip.writeZip(zipPath);
console.log(`dist/ ready (${files} files) and ${path.basename(zipPath)} (v${pkg.version}${commit ? ` · ${commit}` : ''}).`);
console.log('Upload it in Super Admin → System update, or extract it into the app folder and click "Run NPM Install" and "Restart".');
