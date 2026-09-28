// Company branding. Every company can upload its logo: it appears on the company's own printouts and
// exports (payslips, certificates, reports, careers page) while RemoteWay stays the platform identity.
// White label (plan feature `white_label`) goes further: the company's name, logo and colour replace
// RemoteWay across the app, emails and printouts, optionally on the company's own domain.
// Logos are stored in the database, so they survive redeploys and are part of every backup.
const crypto = require('crypto');
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const config = require('../../config');
const { E } = require('../../core/errors');
const ent = require('../billing/entitlements.service');

const KINDS = ['logo', 'logo_dark'];
const MAX_BYTES = 1024 * 1024;
const PLATFORM_HOST = (() => { try { return new URL(config.appUrl).hostname.toLowerCase(); } catch { return 'localhost'; } })();

function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null; // SVG is refused on purpose: it can carry scripts
}

const row = (organizationId) => cache.remember(`brand:${organizationId}`, async () => (await knex('organization_branding').where({ organization_id: organizationId })
  .first('logo_sha', 'logo_dark_sha', 'white_label', 'brand_name', 'brand_color', 'custom_domain', 'email_sender_name')) || null, 60_000);
const invalidate = (organizationId) => { cache.forgetPrefix(`brand:${organizationId}`); cache.forgetPrefix('brand-host:'); };

// ---------- Colour ----------
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbToHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const mix = (hex, target, t) => { const a = hexToRgb(hex); const b = hexToRgb(target); return rgbToHex(a.map((v, i) => v + (b[i] - v) * t)); };
/** The colour moved towards black (or white) until it reads as text on `bg` (WCAG AA, 4.5:1). */
function readableOn(hex, bg, towards) {
  for (let t = 0; t <= 1.0001; t += 0.05) { const c = mix(hex, towards, t); if (contrast(c, bg) >= 4.5) return c; }
  return towards.toUpperCase();
}

/** Theme overrides for the white-label colour, for light and dark mode (served as a stylesheet: CSP allows only 'self'). */
function themeCss(color) {
  const [r, g, b] = hexToRgb(color);
  const ink = contrast(color, '#000000') >= contrast(color, '#FFFFFF') ? '#000000' : '#FFFFFF';
  const deepLight = readableOn(color, '#FFFFFF', '#000000');
  const deepDark = readableOn(color, '#121212', '#FFFFFF');
  const light = `--rw-green: ${color}; --rw-green-deep: ${deepLight}; --accent-ink: ${ink}; --accent-soft: rgba(${r}, ${g}, ${b}, .12); --accent-soft-2: rgba(${r}, ${g}, ${b}, .22); --focus: 0 0 0 3px rgba(${r}, ${g}, ${b}, .45); --success: ${deepLight};`;
  // On dark surfaces a dark brand colour is lifted until it stands out (3:1 for bars, buttons, focus rings).
  let accentDark = color;
  for (let t = 0; t <= 1.0001 && contrast(accentDark, '#121212') < 3; t += 0.05) accentDark = mix(color, '#FFFFFF', t);
  const inkDark = contrast(accentDark, '#000000') >= contrast(accentDark, '#FFFFFF') ? '#000000' : '#FFFFFF';
  const dark = `--rw-green: ${accentDark}; --accent-ink: ${inkDark}; --rw-green-deep: ${deepDark}; --accent-soft: rgba(${r}, ${g}, ${b}, .14); --accent-soft-2: rgba(${r}, ${g}, ${b}, .26);`;
  return `/* white label */\n:root { ${light} }\n:root[data-theme="dark"] { ${dark} }\n@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark} } }\n`;
}

// ---------- Resolved brand (what layouts, printouts and emails use) ----------
async function forOrg(organizationId, orgName) {
  const r = await row(organizationId);
  const e = await ent.getEntitlements(organizationId);
  const whiteLabel = Boolean(r && r.white_label && e.features.has('white_label'));
  const logoUrl = r && r.logo_sha ? `/org-brand/${organizationId}/logo/${r.logo_sha}` : null;
  const logoDarkUrl = r && r.logo_dark_sha ? `/org-brand/${organizationId}/logo_dark/${r.logo_dark_sha}` : logoUrl;
  const color = whiteLabel && r.brand_color ? r.brand_color : null;
  return {
    organizationId, logoUrl, logoDarkUrl, whiteLabel,
    appName: whiteLabel ? (r.brand_name || orgName || 'RemoteWay') : 'RemoteWay',
    color, themeUrl: color ? `/org-brand/${organizationId}/theme/${color.slice(1).toLowerCase()}.css` : null,
    customDomain: whiteLabel ? r.custom_domain || null : null,
    emailSenderName: whiteLabel ? (r.email_sender_name || r.brand_name || orgName) : null,
  };
}

/** Brand for emails about one company (absolute logo URL), or null when RemoteWay's own look applies. */
async function forEmail(organizationId) {
  if (!organizationId) return null;
  const org = await knex('organizations').where({ id: organizationId }).first('name');
  if (!org) return null;
  const b = await forOrg(organizationId, org.name);
  if (!b.whiteLabel) return null;
  const base = b.customDomain ? `https://${b.customDomain}` : config.appUrl.replace(/\/+$/, '');
  return { name: b.appName, color: b.color, logoUrl: b.logoUrl ? `${base}${b.logoUrl}` : null, senderName: b.emailSenderName, base };
}

/** Company whose white-label domain this is (null for the platform's own host). */
function orgIdForHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  if (!h || h === PLATFORM_HOST || h === 'localhost' || /^[\d.]+$/.test(h)) return Promise.resolve(null);
  return cache.remember(`brand-host:${h}`, async () => {
    const r = await knex('organization_branding as b').join('organizations as o', 'o.id', 'b.organization_id')
      .where({ 'b.custom_domain': h, 'b.white_label': true, 'o.status': 'active' }).first('b.organization_id');
    if (!r) return 0;
    const e = await ent.getEntitlements(r.organization_id);
    return e.features.has('white_label') ? r.organization_id : 0;
  }, 60_000).then((id) => id || null);
}

// ---------- Changes ----------
async function uploadLogo(ctx, kind, file) {
  if (!KINDS.includes(kind)) throw E.validation({ kind: 'Choose which logo to replace.' });
  if (!file || !file.buffer || !file.buffer.length) throw E.validation({ file: 'Choose an image to upload.' });
  if (file.buffer.length > MAX_BYTES) throw E.validation({ file: 'The logo must be 1 MB or smaller.' });
  const mime = sniff(file.buffer);
  if (!mime) throw E.validation({ file: 'Upload a PNG, JPG or WebP image.' });
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex').slice(0, 16);
  const values = { [kind]: file.buffer, [`${kind}_mime`]: mime, [`${kind}_sha`]: sha, updated_by: ctx.userId, updated_at: new Date() };
  await knex('organization_branding').insert({ organization_id: ctx.organizationId, ...values }).onConflict('organization_id').merge(values);
  invalidate(ctx.organizationId);
  await audit.record(ctx, 'branding.logo_updated', { entityType: 'organization', entityId: ctx.organizationId, newValues: { kind, size: file.buffer.length } });
}

async function removeLogo(ctx, kind) {
  if (!KINDS.includes(kind)) throw E.validation({ kind: 'Choose which logo to remove.' });
  await knex('organization_branding').where({ organization_id: ctx.organizationId }).update({ [kind]: null, [`${kind}_mime`]: null, [`${kind}_sha`]: null, updated_by: ctx.userId, updated_at: new Date() });
  invalidate(ctx.organizationId);
  await audit.record(ctx, 'branding.logo_removed', { entityType: 'organization', entityId: ctx.organizationId, newValues: { kind } });
}

async function saveWhiteLabel(ctx, body) {
  const enabled = body.white_label === 'on' || body.white_label === true;
  const errors = {};
  const name = String(body.brand_name || '').trim().slice(0, 80);
  const color = String(body.brand_color || '').trim().toUpperCase();
  const domain = String(body.custom_domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const sender = String(body.email_sender_name || '').trim().slice(0, 80);
  if (enabled) await ent.assertFeature(ctx.organizationId, 'white_label');
  if (enabled && name.length < 2) errors.brand_name = 'Enter the name to show instead of RemoteWay.';
  if (color && !/^#[0-9A-F]{6}$/.test(color)) errors.brand_color = 'Use a colour like #1A73E8.';
  if (domain) {
    if (!/^(?=.{4,190}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) errors.custom_domain = 'Enter a domain like hr.yourcompany.com.';
    else if (domain === PLATFORM_HOST || domain.endsWith(`.${PLATFORM_HOST}`) && PLATFORM_HOST !== 'localhost') errors.custom_domain = 'Use a domain your company owns.';
    else if (await knex('organization_branding').where({ custom_domain: domain }).whereNot({ organization_id: ctx.organizationId }).first()) errors.custom_domain = 'This domain is used by another company.';
  }
  if (Object.keys(errors).length) throw E.validation(errors);
  const values = {
    white_label: enabled, brand_name: name || null, brand_color: color || null, custom_domain: domain || null, email_sender_name: sender || null,
    updated_by: ctx.userId, updated_at: new Date(),
  };
  await knex('organization_branding').insert({ organization_id: ctx.organizationId, ...values }).onConflict('organization_id').merge(values);
  invalidate(ctx.organizationId);
  await audit.record(ctx, 'branding.white_label_updated', { entityType: 'organization', entityId: ctx.organizationId, newValues: { enabled, brand_name: name, brand_color: color, custom_domain: domain } });
}

async function asset(organizationId, kind, sha) {
  if (!KINDS.includes(kind) || !/^[a-f0-9]{16}$/.test(sha)) return null;
  const r = await knex('organization_branding').where({ organization_id: organizationId, [`${kind}_sha`]: sha }).first(kind, `${kind}_mime`);
  return r && r[kind] ? { data: r[kind], mime: r[`${kind}_mime`] } : null;
}

async function settings(organizationId) {
  return (await row(organizationId)) || {};
}

module.exports = { KINDS, forOrg, forEmail, orgIdForHost, uploadLogo, removeLogo, saveWhiteLabel, asset, settings, themeCss, contrast, invalidate, PLATFORM_HOST };
