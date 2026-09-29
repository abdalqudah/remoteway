// Hosting often runs MySQL 5.7 or an old MariaDB: keep SQL to what they support.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));

test('no SQL that MySQL 5.7 / MariaDB < 10.2 reject (CTEs, window functions, LATERAL)', () => {
  const bad = [];
  for (const f of files(path.join(__dirname, '..', 'src'))) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return; // comments may mention them
      if (/\bWITH\s+RECURSIVE\b|\bOVER\s*\(\s*(PARTITION|ORDER)\b|\bLATERAL\b|\bJSON_TABLE\s*\(|\.withRecursive\(|\.with\(/i.test(line)) bad.push(`${path.relative(process.cwd(), f)}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});
