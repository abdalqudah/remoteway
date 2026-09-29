// View locals, CSRF protection, flash messages and theme/locale for server-rendered pages.
const { translator, resolveLocale } = require('../core/i18n');
const { randomToken, safeEqual } = require('../core/tokens');
const { E } = require('../core/errors');
const fmt = require('../core/format');
const config = require('../config');
const ASSET_V = require('../../package.json').version;


// The site's public address. APP_URL wins when it is a real address; when it is missing or still
// "localhost" (a common set-up slip on cPanel), links use the address the browser actually opened.
const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(u || '');
function publicBase(req) {
  const configured = process.env.APP_URL ? config.appUrl.replace(/\/+$/, '') : '';
  if (configured && !(isLocalUrl(configured) && !/^(localhost|127\.|\[::1\])/i.test(req.hostname || ''))) return configured;
  // In production the site runs behind HTTPS even when the proxy does not say so: links (e.g. inside a
  // QR code) must not fall back to http, where the secure session cookie would be dropped.
  const proto = config.isProd || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https' ? 'https' : req.protocol;
  return `${proto}://${req.get('host')}`;
}

function locals(req, res, next) {
  const locale = resolveLocale(req);
  if (req.query.lang && config.locales.includes(req.query.lang)) {
    res.cookie('rw_lang', req.query.lang, { maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: true, secure: config.isProd });
  }
  const t = translator(locale);
  req.t = t;
  req.locale = locale;
  if (req.session && !req.session.csrf) req.session.csrf = randomToken(24);
  const theme = ['light', 'dark'].includes(req.cookies?.rw_theme) ? req.cookies.rw_theme : 'system';
  Object.assign(res.locals, {
    t,
    locale,
    // Editable site texts are { ar, en }: show the visitor's language, else the other one.
    L: (v) => (v && typeof v === 'object' ? (v[locale] || v[locale === 'ar' ? 'en' : 'ar'] || '') : (v || '')),
    // Layout classes of an editable website section (alignment, background media).
    secCls: (s) => {
      const d = (s && s.design) || {};
      const c = [];
      if (d.title_align && d.title_align !== 'default') c.push(`al-t-${d.title_align}`);
      if (d.text_align && d.text_align !== 'default') c.push(`al-x-${d.text_align}`);
      if (d.media && d.media_pos === 'background') c.push('has-bg');
      return c.join(' ');
    },
    dir: locale === 'ar' ? 'rtl' : 'ltr',
    theme,
    csrfToken: req.session?.csrf,
    currentUser: req.user || null,
    // Shows the "confirm your email" banner (only when the platform can send email).
    emailUnverified: Boolean(req.user && !req.apiToken && !require('../modules/auth/verify.service').isVerified(req.user) && require('../modules/auth/verify.service').required()), // eslint-disable-line global-require
    path: req.path,
    fullPath: req.originalUrl,
    query: req.query,
    flash: req.session?.flash || [],
    fmt: {
      date: (v, o) => fmt.formatDate(v, locale, o),
      money: (a, c) => fmt.formatMoney(a, c, locale),
      amount: (a, c) => fmt.formatAmount(a, c, locale),
      number: (n) => fmt.formatNumber(n, locale),
      mb: (mb) => fmt.formatBytesMb(mb, locale),
      dateInput: fmt.toDateInput,
    },
    appName: config.appName,
    arabicFont: config.arabicFontInstalled,
    assetV: ASSET_V,
    escapeHtml: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    cookiesOk: req.cookies?.rw_cookies_ok === '1',
    consent: ['yes', 'no'].includes(req.cookies?.rw_consent) ? req.cookies.rw_consent : '', // advertising pixels
    baseUrl: publicBase(req),
    icon: (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="/icons.svg?v=${ASSET_V}#i-${name}"></use></svg>`,
    brandIcon: (name, cls = '') => `<svg class="brand-icon ${cls}" aria-hidden="true"><use href="/icons.svg?v=${ASSET_V}#b-${String(name).replace(/[^a-z]/g, '')}"></use></svg>`,
    roleName: (r) => {
      if (!r) return '—';
      if (r.is_system === false || r.is_system === 0) return r.name;
      const k = r.key || r.role_key;
      const tr = k ? t(`roles.${k}`) : null;
      return tr && tr !== `roles.${k}` ? tr : (r.name || r.role_name || '—');
    },
    initials: (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase(),
    errors: {},
    old: {},
    formError: null,
    unreadNotifications: 0,
    openDialog: null,
  });
  if (req.session) req.session.flash = [];
  res.locals.langUrl = (lang) => {
    const url = new URL(req.originalUrl, 'http://x');
    url.searchParams.set('lang', lang);
    return url.pathname + url.search;
  };
  next();
}

function flash(req, type, message) {
  req.session.flash = [...(req.session.flash || []), { type, message }];
}

// Synchronizer-token CSRF check for every state-changing browser request.
// API requests authenticated with a Bearer token are exempt (no ambient credentials).
// Multipart bodies are only parsed by the upload routes below; their token is checked after parsing
// (verifyCsrfAfterUpload). Multipart sent anywhere else is refused so it can never skip the check.
const MULTIPART_ROUTES = [/^\/app\/documents(\/\d+\/versions)?\/?$/, /^\/app\/employees\/import\/?$/, /^\/api\/v1\/documents\/?$/, /^\/admin\/system\/update\/?$/,
  /^\/app\/recruitment\/candidates(\/\d+)?\/?$/, /^\/careers\/[a-z0-9-]+\/jobs\/[a-z0-9-]+\/apply\/?$/,
  /^\/app\/learning\/manage\/courses\/\d+\/lessons(\/\d+)?\/?$/, /^\/app\/settings\/branding\/logo\/?$/, /^\/me\/profile\/(photo|cv)\/?$/, /^\/admin\/backups\/import\/?$/, /^\/admin\/site\/media\/?$/];

function tokenValid(req, sent) {
  return Boolean(req.session?.csrf && sent && safeEqual(sent, req.session.csrf));
}

function csrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.apiToken) return next();
  // Payment gateways post back from their own servers/pages: no session, verified with the gateway instead.
  if (/^\/payments\/(return\/[a-f0-9]{48}|webhook\/[a-z]+)\/?$/.test(req.path) || /^\/webhooks\/crm\/whatsapp\/?$/.test(req.path)) return next();
  if (req.is('multipart/form-data')) {
    if (MULTIPART_ROUTES.some((r) => r.test(req.path))) {
      req.csrfDeferred = true;
      return next();
    }
    return next(E.csrf());
  }
  if (!tokenValid(req, req.body?._csrf || req.get('x-csrf-token'))) return next(E.csrf());
  return next();
}

function verifyCsrfAfterUpload(req, res, next) {
  if (!req.csrfDeferred || req.apiToken) return next();
  return tokenValid(req, req.body?._csrf || req.get('x-csrf-token')) ? next() : next(E.csrf());
}

module.exports = {
  publicBase, isLocalUrl, locals, flash, csrf, verifyCsrfAfterUpload };
