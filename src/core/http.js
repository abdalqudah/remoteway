// Outbound HTTP for integrations (webhooks, SMS, chat) with SSRF protection:
// HTTPS only, and every resolved address is checked, so a hostname cannot point at the server's
// own network (127.0.0.1, 10.x, 192.168.x, cloud metadata 169.254.169.254, …). The check runs in the
// socket's DNS lookup itself, so a record cannot change between the check and the connection.
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const allowPrivate = () => process.env.INTEGRATIONS_ALLOW_PRIVATE === 'true'; // tests / on-premise only

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

class BlockedError extends Error {}

function validateUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { error: 'Enter a valid URL.' }; }
  if (u.protocol !== 'https:' && !(allowPrivate() && u.protocol === 'http:')) return { error: 'Use an https:// URL.' };
  if (u.username || u.password) return { error: 'Do not put credentials in the URL.' };
  if (net.isIP(u.hostname) && isPrivateIp(u.hostname) && !allowPrivate()) return { error: 'This address is not reachable from RemoteWay.' };
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname) && !allowPrivate()) return { error: 'This address is not reachable from RemoteWay.' };
  return { url: u };
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    if (!allowPrivate() && list.some((a) => isPrivateIp(a.address))) return callback(new BlockedError(`Blocked private address for ${hostname}`));
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

/**
 * @returns {Promise<{status:number, body:string, durationMs:number}>}  (never rejects on HTTP errors; rejects on network/blocked)
 */
function request(rawUrl, { method = 'POST', headers = {}, body = null, timeoutMs = 10_000, maxBytes = 65_536 } = {}) {
  const check = validateUrl(rawUrl);
  if (check.error) return Promise.reject(new BlockedError(check.error));
  const u = check.url;
  const lib = u.protocol === 'https:' ? https : http;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers: { 'user-agent': 'RemoteWay-Integrations/1.0', ...headers }, lookup: safeLookup, timeout: timeoutMs }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= maxBytes) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), durationMs: Date.now() - started }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${timeoutMs / 1000}s`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { request, validateUrl, isPrivateIp, BlockedError };
