const express = require('express');
const { requireAuth, requireSuperAdmin, resolveTenant } = require('../middleware/context');
const { MODULES } = require('./modules');

const router = express.Router();

router.use((req, res, next) => {
  res.locals.MODULES = MODULES;
  next();
});
// Editable landing page content (header, sections, footer), cached for a minute.
const siteContent = require('../modules/site/content.service');
const siteMedia = require('../modules/site/media.service');
const seo = require('../modules/site/seo.service');
const google = require('../modules/auth/google.service');
router.use((req, res, next) => {
  Promise.all([siteContent.get(), siteMedia.map(), seo.get(), seo.marketing(), google.enabled().catch(() => false)]).then(([c, m, s, mk, g]) => {
    res.locals.googleOn = g;
    res.locals.site = c; res.locals.siteMedia = m; res.locals.seo = s; res.locals.marketing = mk;
    res.locals.pixelsOn = seo.hasPixels(mk);
    seo.cspFrom(mk); // keeps the script policy in step when another process changed the pixels
    // A conversion (sign-up, demo request) is reported once, on the next public page.
    const pixelEvent = req.cookies && seo.EVENTS.includes(req.cookies.rw_px_ev) ? req.cookies.rw_px_ev : '';
    if (pixelEvent && req.method === 'GET') res.clearCookie('rw_px_ev');
    res.locals.pixelPending = Boolean(pixelEvent);
    // Search tags, structured data and pixels for public pages (never on a company's own white-label domain).
    res.locals.seoHead = (page = {}) => (res.locals.hostBrand ? null : seo.head({
      seo: s, mkt: mk, base: res.locals.baseUrl, locale: req.locale, path: req.path, site: c, siteMedia: m, assetV: res.locals.assetV,
      consent: req.cookies && req.cookies.rw_consent, pixelEvent: res.locals.pixelEventNow || pixelEvent, fallbackDescription: req.t('site.meta_description'), ...page,
    }));
    next();
  }, next);
});
// Website images and videos (range requests work, so videos can be skipped through).
router.get('/site-media/:id/:sha', require('./helpers').wrap(async (req, res, next) => {
  const f = await siteMedia.file(req.params.id, req.params.sha);
  if (!f) return next();
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000, immutable' });
  return res.sendFile(f.path, { headers: { 'Content-Type': f.mime } });
}));
router.use('/', require('../modules/site/web'));
router.use('/', require('../modules/auth/web'));
router.use('/sso', require('../modules/sso/web').router);
router.use('/', require('../modules/talent/public.web').router); // jobs board, discover talent, profiles, individual sign-up
router.use('/me', requireAuth, emailGate, require('../modules/talent/me.web')); // individual dashboard
router.use('/careers', require('../modules/recruitment/careers.web'));
router.use('/verify', require('../modules/learning/verify.web'));
router.use('/calendar', require('../modules/integrations/web').feedRouter);
router.use('/payments', require('../modules/payments/web'));
router.use('/', require('../modules/crm/public.web')); // demo requests + WhatsApp webhook (internal CRM)
router.use('/admin', requireAuth, requireSuperAdmin, require('../modules/admin/web'));
router.use('/app', requireAuth, emailGate, resolveTenant, require('./app'));
router.use('/kiosk', require('../modules/attendance/qr.web').display); // office screen showing the attendance QR
router.use('/q', require('../modules/attendance/qr.web').scan); // phone opens this after scanning
router.use('/', require('../modules/organizations/portal.web').router); // remoteway.net/<company link> — keep last

// After the grace period an account must confirm its email before using the app (API tokens excepted).
function emailGate(req, res, next) {
  if (req.apiToken || !require('../modules/auth/verify.service').mustVerifyNow(req.user)) return next(); // eslint-disable-line global-require
  if (req.originalUrl.startsWith('/api/')) return next(require('../core/errors').E.forbidden('email.verify')); // eslint-disable-line global-require
  return res.redirect('/verify-email');
}

module.exports = router;
