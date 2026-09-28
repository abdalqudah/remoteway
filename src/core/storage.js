// Private file storage. Files never live under /public and are only served through
// permission-checked routes. The local-disk driver keeps files OUTSIDE the app folder
// (default: ../remoteway-storage) so redeploying the app never deletes uploaded files.
// A cloud object-storage driver (S3-compatible) can implement the same interface later.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(process.env.STORAGE_PATH || path.join(__dirname, '..', '..', '..', 'remoteway-storage'));

function resolveKey(key) {
  if (!/^[a-z0-9/_-]+$/i.test(key) || key.includes('..')) throw new Error('Invalid storage key');
  const full = path.resolve(ROOT, key);
  if (!full.startsWith(ROOT + path.sep)) throw new Error('Invalid storage key');
  return full;
}

const localDisk = {
  root: ROOT,
  newKey(organizationId, folder) {
    return `org-${Number(organizationId)}/${folder}/${crypto.randomUUID().replace(/-/g, '')}`;
  },
  async put(key, buffer) {
    const full = resolveKey(key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(full, buffer, { mode: 0o600 });
  },
  async read(key) {
    return fs.promises.readFile(resolveKey(key));
  },
  createReadStream(key) {
    return fs.createReadStream(resolveKey(key));
  },
  async exists(key) {
    try {
      await fs.promises.access(resolveKey(key));
      return true;
    } catch {
      return false;
    }
  },
  async remove(key) {
    await fs.promises.rm(resolveKey(key), { force: true });
  },
};

module.exports = localDisk;
