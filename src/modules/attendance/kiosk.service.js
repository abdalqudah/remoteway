// QR attendance. A display screen ("kiosk") at the office shows a QR code that changes every minute.
// The code is an HMAC of the current minute with the screen's own secret, so it cannot be guessed or
// reused later: a scan is accepted for the current minute and the one before it (up to two minutes).
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

const STEP_MS = 60_000;
const stepOf = (now = Date.now()) => Math.floor(now / STEP_MS);
const base = () => config.appUrl.replace(/\/+$/, '');

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

const displayUrl = (k) => `${base()}/kiosk/${secrets.decrypt(k.display_token_enc)}`;

/** The screen, from its secret display link. */
async function byDisplayToken(token) {
  const k = await knex('attendance_kiosks').where({ display_token_hash: sha256(String(token || '')) }).first();
  return k && k.is_active ? k : null;
}

/** Current QR (SVG) for a screen; also records that the screen is online and from which network. */
async function currentQr(k, ip) {
  const step = stepOf();
  const secret = secrets.decrypt(k.secret_enc);
  const url = `${base()}/q/${k.public_id}/${step}.${codeFor(secret, k.public_id, step)}`;
  await knex('attendance_kiosks').where({ id: k.id }).update({ last_seen_at: new Date(), last_ip: ip ? String(ip).slice(0, 64) : null });
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { svg, url, expiresIn: Math.ceil(((step + 1) * STEP_MS - Date.now()) / 1000) };
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
  if (!Number.isInteger(step) || step > current || current - step > 1) throw new AppError('QR_EXPIRED', 'This code has expired. Scan the code currently on the screen.', 410);
  const expected = codeFor(secrets.decrypt(k.secret_enc), k.public_id, step);
  if (!code || code.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected))) {
    throw new AppError('QR_INVALID', 'This QR code is not valid. Scan the code on the office screen.', 404);
  }
  if (k.same_network && (!ip || !k.last_ip || String(ip) !== k.last_ip)) {
    throw new AppError('QR_NETWORK', 'Connect your phone to the office network (Wi-Fi) and scan again.', 403);
  }
  return k;
}

/** Changes whenever the screen's code secret is regenerated. */
const secretVersion = (k) => sha256(String(k.secret_enc)).slice(0, 16);

module.exports = { secretVersion, STEP_MS, stepOf, codeFor, list, create, get, update, regenerate, remove, displayUrl, byDisplayToken, currentQr, checkScan };
