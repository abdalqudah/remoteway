// Branding routes: public logo/theme files, the company's Settings → Branding page, and the locals
// that tell layouts which identity to show.
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { singleFile } = require('../../middleware/upload');
const branding = require('./branding.service');
const ent = require('../billing/entitlements.service');

// ---------- Public files (logos appear on printouts, emails and sign-in pages) ----------
const files = express.Router();
files.get('/:orgId/theme/:hex.css', (req, res, next) => {
  if (!/^[0-9a-f]{6}$/.test(req.params.hex)) return next();
  res.type('text/css').set('Cache-Control', 'public, max-age=31536000, immutable').send(branding.themeCss(`#${req.params.hex.toUpperCase()}`));
  return undefined;
});
files.get('/:orgId/:kind/:sha', wrap(async (req, res, next) => {
  const a = await branding.asset(Number(req.params.orgId), req.params.kind, req.params.sha);
  if (!a) return next();
  res.set({ 'Content-Type': a.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
  return res.send(a.data);
}));

// ---------- Locals ----------
/** Inside /app: the company's brand (logo everywhere it is theirs; the full identity with white label). */
const appLocals = wrap(async (req, res, next) => {
  res.locals.brand = await branding.forOrg(req.organization.id, req.organization.name);
  next();
});
/** Outside /app: a white-label company's own domain shows its identity on sign-in pages. */
const hostLocals = async (req, res, next) => {
  try {
    const orgId = await branding.orgIdForHost(req.hostname);
    if (orgId) {
      const org = await require('../../db/knex')('organizations').where({ id: orgId }).first('name'); // eslint-disable-line global-require
      res.locals.brand = await branding.forOrg(orgId, org && org.name);
      res.locals.hostBrand = true;
    }
  } catch { /* the platform identity is always a safe fallback */ }
  next();
};

// ---------- Settings → Branding ----------
const settings = express.Router();
settings.use((req, res, next) => { res.locals.section = 'branding'; next(); });
const render = async (req, res, extra = {}) => res.page('pages/settings/branding', {
  title: req.t('branding.title'), saved: await branding.settings(req.ctx.organizationId), hasWhiteLabel: await ent.hasFeature(req.ctx.organizationId, 'white_label'),
  platformHost: branding.PLATFORM_HOST, ...extra,
});
settings.get('/', can('organization.manage'), wrap((req, res) => render(req, res)));
settings.post('/logo', can('organization.manage'), ...singleFile('file'), form(async (req, res) => {
  await branding.uploadLogo(req.ctx, String(req.body.kind || 'logo'), req.file);
  flash(req, 'success', req.t('branding.logo_saved'));
  res.redirect('/app/settings/branding');
}, render));
settings.post('/logo/remove', can('organization.manage'), form(async (req, res) => {
  await branding.removeLogo(req.ctx, String(req.body.kind || 'logo'));
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/settings/branding');
}, render));
settings.post('/white-label', can('organization.manage'), form(async (req, res) => {
  await branding.saveWhiteLabel(req.ctx, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/settings/branding#white-label');
}, render));

module.exports = { files, settings, appLocals, hostLocals };
