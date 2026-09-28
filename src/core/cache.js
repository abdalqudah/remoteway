// Small in-process TTL cache for entitlements, permissions and settings.
// Each Node process has its own cache; TTL bounds staleness across processes.
const config = require('../config');

const store = new Map();

function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

function set(key, value, ttl = config.cacheTtlMs) {
  store.set(key, { value, expires: Date.now() + ttl });
  return value;
}

async function remember(key, fn, ttl) {
  const cached = get(key);
  if (cached !== undefined) return cached;
  return set(key, await fn(), ttl);
}

function forgetPrefix(prefix) {
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
}

function clear() {
  store.clear();
}

module.exports = { get, set, remember, forgetPrefix, clear };
