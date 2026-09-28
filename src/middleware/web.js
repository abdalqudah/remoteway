// View locals, CSRF protection, flash messages and theme/locale for server-rendered pages.
const { translator, resolveLocale } = require('../core/i18n');
const { randomToken, safeEqual } = require('../core/tokens');
const { E } = require('../core/errors');
const fmt = require('../core/format');
const config = require('../config');

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
    dir: locale === 'ar' ? 'rtl' : 'ltr',
    theme,
    csrfToken: req.session?.csrf,
    currentUser: req.user || null,
    path: req.path,
    fullPath: req.originalUrl,
    query: req.query,
    flash: req.session?.flash || [],
    fmt: {
      date: (v, o) => fmt.formatDate(v, locale, o),
      money: (a, c) => fmt.formatMoney(a, c, locale),
      number: (n) => fmt.formatNumber(n, locale),
      mb: (mb) => fmt.formatBytesMb(mb, locale),
      dateInput: fmt.toDateInput,
    },
    appName: config.appName,
    arabicFont: config.arabicFontInstalled,
    icon: (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="/icons.svg#i-${name}"></use></svg>`,
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
function csrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.apiToken) return next();
  const sent = req.body?._csrf || req.get('x-csrf-token');
  if (!req.session?.csrf || !sent || !safeEqual(sent, req.session.csrf)) return next(E.csrf());
  return next();
}

module.exports = { locals, flash, csrf };
