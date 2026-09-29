// QR attendance. A display screen ("kiosk") at the office shows a QR code that changes every 10 seconds.
// The code is an HMAC of the current 10-second step with the screen's own secret, so it cannot be guessed
// or reused later. Any number of people can scan the same code at the same time; a scan is accepted for
// the current step and the two before it (up to 30 seconds), so a slow phone camera still gets through.
// Optionally the phone must be on the same network as the screen (same public IP, e.g. office Wi-Fi),
// so a photo of the code sent to someone at home does not work.
const crypto = require('crypto');
const QRCode = require('qrcode');
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const { sha256 } = require('../../core/tokens');
const { E, AppError } = require('../../core/errors');
const ent = require('../billing/entitlements.service');

const STEP_MS = 10_000;
const GRACE_STEPS = 2; // earlier codes still accepted (slow cameras / networks)
const stepOf = (now = Date.now()) => Math.floor(now / STEP_MS);
const base = (b) => (b || config.appUrl).replace(/\/+$/, ''); // b: the address the screen was opened on

function codeFor(secret, publicId, step) {
  return crypto.createHmac('sha256', secret).update(`${publicId}:${step}`).digest('hex').slice(0, 12);
}

async function list(organizationId) {
  return knex('attendance_kiosks as k').leftJoin('locations as l', 'l.id', 'k.location_id').where('k.organization_id', organizationId)
    .select('k.id', 'k.name', 'k.public_id', 'k.same_network', 'k.is_active', 'k.last_seen_at', 'k.last_ip', 'k.location_id', 'l.name as location_name')
    .orderBy('k.id');
}

async function create(ctx, { name, location_id: locationId, same_network: sameNetwork }) {
  await ent.assertFeature(ctx.organizationId, 'attendance');
  await ent.assertCanWrite(ctx.organizationId);
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) throw E.validation({ name: 'Give the screen a name, e.g. Main entrance.' });
  const loc = locationId ? await knex('locations').where({ id: Number(locationId), organization_id: ctx.organizationId }).first('id') : null;
  if (locationId && !loc) throw E.validation({ location_id: 'Choose a location.' });
  const token = crypto.randomBytes(24).toString('hex');
  const [id] = await knex('attendance_kiosks').insert({
    organization_id: ctx.organizationId, location_id: loc ? loc.id : null, name: clean,
    public_id: crypto.randomBytes(8).toString('hex').slice(0, 12), secret_enc: secrets.encrypt(crypto.randomBytes(32).toString('hex')),
    display_token_enc: secrets.encrypt(token), display_token_hash: sha256(token), same_network: Boolean(sameNetwork), created_by: ctx.userId,
  });
  await audit.record(ctx, 'attendance.kiosk_created', { entityType: 'attendance_kiosk', entityId: id, newValues: { name: clean } });
  return id;
}

async function get(ctx, id) {
  const k = await knex('attendance_kiosks').where({ id: Number(id), organization_id: ctx.organizationId }).first();
  if (!k) throw E.notFound('Screen');
  return k;
}

async function update(ctx, id, { same_network: sameNetwork, is_active: isActive }) {
  await get(ctx, id);
  await knex('attendance_kiosks').where({ id }).update({ same_network: Boolean(sameNetwork), is_active: Boolean(isActive), updated_at: new Date() });
  await audit.record(ctx, 'attendance.kiosk_updated', { entityType: 'attendance_kiosk', entityId: id, newValues: { same_network: Boolean(sameNetwork), is_active: Boolean(isActive) } });
}

/** New display link and new code secret (e.g. the old screen link leaked). */
async function regenerate(ctx, id) {
  await get(ctx, id);
  const token = crypto.randomBytes(24).toString('hex');
  await knex('attendance_kiosks').where({ id }).update({
    display_token_enc: secrets.encrypt(token), display_token_hash: sha256(token), secret_enc: secrets.encrypt(crypto.randomBytes(32).toString('hex')), updated_at: new Date(),
  });
  await audit.record(ctx, 'attendance.kiosk_regenerated', { entityType: 'attendance_kiosk', entityId: id });
}

async function remove(ctx, id) {
  await get(ctx, id);
  await knex('attendance_kiosks').where({ id }).del();
  await audit.record(ctx, 'attendance.kiosk_deleted', { entityType: 'attendance_kiosk', entityId: id });
}

const displayUrl = (k, b) => `${base(b)}/kiosk/${secrets.decrypt(k.display_token_enc)}`;

/** The screen, from its secret display link. */
async function byDisplayToken(token) {
  const k = await knex('attendance_kiosks').where({ display_token_hash: sha256(String(token || '')) }).first();
  return k && k.is_active ? k : null;
}

// ---------- Same network ----------
/** "::ffff:1.2.3.4" → "1.2.3.4"; IPv6 → its /64 network (every device on a Wi-Fi gets its own IPv6 address). */
function networkOf(ip) {
  const s = String(ip || '').trim().toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
  if (!s) return '';
  if (!s.includes(':')) return s;
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = s.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((x) => parseInt(x || '0', 16).toString(16)).join(':')}::/64`;
}
const RECENT_MS = 30 * 60_000;
function recentNetworks(k, now = Date.now()) {
  let list = [];
  try { list = JSON.parse(k.recent_ips || '[]'); } catch { list = []; }
  const nets = list.filter((x) => x && now - x.at < RECENT_MS).map((x) => x.net);
  if (k.last_ip) nets.push(networkOf(k.last_ip));
  return [...new Set(nets.filter(Boolean))];
}
/** True when the phone is on one of the networks the screen was seen from in the last 30 minutes. */
const sameNetwork = (k, ip) => Boolean(ip) && recentNetworks(k).includes(networkOf(ip));

/** Current QR (SVG) for a screen; also records that the screen is online and from which network. */
async function currentQr(k, ip, b) {
  const step = stepOf();
  const secret = secrets.decrypt(k.secret_enc);
  const url = `${base(b)}/q/${k.public_id}/${step}.${codeFor(secret, k.public_id, step)}`;
  const now = Date.now();
  let list = [];
  try { list = JSON.parse(k.recent_ips || '[]'); } catch { list = []; }
  const net = networkOf(ip);
  if (net) list = [{ net, at: now }, ...list.filter((x) => x && x.net !== net && now - x.at < RECENT_MS)].slice(0, 6);
  await knex('attendance_kiosks').where({ id: k.id }).update({ last_seen_at: new Date(), last_ip: ip ? String(ip).slice(0, 64) : null, recent_ips: JSON.stringify(list) });
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { svg, url, expiresIn: Math.ceil(((step + 1) * STEP_MS - Date.now()) / 1000), stepSeconds: STEP_MS / 1000 };
}

/**
 * Checks a scanned code. Returns the screen, or throws with a message for the person holding the phone.
 */
async function checkScan(publicId, raw, ip, now = Date.now()) {
  const k = await knex('attendance_kiosks').where({ public_id: String(publicId || '') }).first();
  if (!k || !k.is_active) throw new AppError('QR_INVALID', 'This QR code is not valid. Scan the code on the office screen.', 404);
  const [s, code] = String(raw || '').split('.');
  const step = Number(s);
  const current = stepOf(now);
  if (!Number.isInteger(step) || step > current || current - step > GRACE_STEPS) throw new AppError('QR_EXPIRED', 'This code has expired. Scan the code currently on the screen.', 410);
  const expected = codeFor(secrets.decrypt(k.secret_enc), k.public_id, step);
  if (!code || code.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected))) {
    throw new AppError('QR_INVALID', 'This QR code is not valid. Scan the code on the office screen.', 404);
  }
  if (k.same_network && !sameNetwork(k, ip)) {
    throw new AppError('QR_NETWORK', 'Connect your phone to the office network (Wi-Fi) and scan again.', 403);
  }
  return k;
}

/** Changes whenever the screen's code secret is regenerated. */
const secretVersion = (k) => sha256(String(k.secret_enc)).slice(0, 16);

module.exports = { networkOf, sameNetwork, secretVersion, STEP_MS, GRACE_STEPS, stepOf, codeFor, list, create, get, update, regenerate, remove, displayUrl, byDisplayToken, currentQr, checkScan };
