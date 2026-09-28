// Public SSO sign-in (/sso) and Settings → Single sign-on (/app/settings/sso).
const express = require('express');
const rateLimit = require('express-rate-limit');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { signIn } = require('../auth/web');
const rbac = require('../rbac/rbac.service');
const sso = require('./sso.service');

// ---------- Public sign-in ----------
const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
// The provider is on another origin: a form POST may not redirect there (CSP form-action 'self'),
// so we answer with a short page that moves on by itself (Refresh header) with a link as fallback.
function goToProvider(req, res, url) {
  res.set('Refresh', `0; url=${url}`);
  res.set('Cache-Control', 'no-store');
  return res.page('pages/auth/sso-redirect', { layout: 'auth', title: req.t('sso.redirecting'), url });
}
const renderStart = (req, res, extra = {}) => res.page('pages/auth/sso', { layout: 'auth', title: req.t('sso.sign_in'), ...extra });

router.get('/', (req, res) => renderStart(req, res));
router.post('/', limiter, form(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const organizationId = await sso.forEmail(email);
  if (!organizationId) throw new AppError('SSO_NOT_FOUND', 'Single sign-on is not set up for this email domain. Sign in with your password.', 404);
  const { url, pending } = await sso.start(organizationId, { loginHint: email });
  req.session.sso = pending;
  req.session.save(() => goToProvider(req, res, url));
}, renderStart));

router.get('/callback', limiter, wrap(async (req, res) => {
  const pending = req.session.sso;
  delete req.session.sso;
  try {
    const result = await sso.complete(pending, req.query);
    if (result.test) {
      flash(req, 'success', req.t('sso.test_ok'));
      return res.redirect('/app/settings/sso');
    }
    await signIn(req, result.user, result.organizationId);
    // This session only opens the company whose identity provider signed it in.
    req.session.ssoOrg = result.organizationId;
    return req.session.save(() => res.redirect('/app'));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    if (pending && pending.test && req.user) {
      flash(req, 'error', `${req.t('sso.test_failed')} ${e.message}`);
      return res.redirect('/app/settings/sso');
    }
    const tr = req.t(`errors.${e.code}`);
    res.status(e.status);
    return renderStart(req, res, { formError: { code: e.code, message: tr !== `errors.${e.code}` ? tr : e.message } });
  }
}));

// ---------- Settings → Single sign-on ----------
const settings = express.Router();
settings.use((req, res, next) => { res.locals.section = 'sso'; next(); });
settings.use(can('sso.manage'));
const renderSettings = async (req, res, extra = {}) => {
  const [conn, roles, stats] = await Promise.all([sso.get(req.ctx.organizationId), rbac.listRoles(req.ctx.organizationId), sso.stats(req.ctx.organizationId)]);
  res.page('pages/settings/sso', {
    title: req.t('sso.title'), conn, roles: roles.filter((r) => r.key !== 'owner'), stats, redirectUri: sso.redirectUri(), inPlan: req.entitlements.features.has('sso'), ...extra,
  });
};
settings.get('/', wrap((req, res) => renderSettings(req, res)));
settings.post('/', form(async (req, res) => {
  await sso.save(req.ctx, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/settings/sso');
}, renderSettings));
settings.post('/test', form(async (req, res) => {
  const { url, pending } = await sso.start(req.ctx.organizationId, { test: req.ctx.userId, loginHint: req.user.email });
  req.session.sso = pending;
  req.session.save(() => goToProvider(req, res, url));
}, renderSettings));
settings.post('/delete', wrap(async (req, res) => {
  await sso.remove(req.ctx);
  flash(req, 'success', req.t('sso.removed'));
  res.redirect('/app/settings/sso');
}));

module.exports = { router, settings };
