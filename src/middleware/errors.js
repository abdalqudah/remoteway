const { AppError } = require('../core/errors');
const config = require('../config');

function notFound(req, res, next) {
  next(new AppError('NOT_FOUND', 'Page not found.', 404));
}

function errorHandler(err, req, res, next) {
  const known = err instanceof AppError;
  const status = known ? err.status : 500;
  if (!known) console.error(`[error] ${req.method} ${req.originalUrl}`, err);

  const code = known ? err.code : 'INTERNAL_ERROR';
  const message = known ? err.message : 'Something went wrong. Please try again.';

  if (req.originalUrl.startsWith('/api/')) {
    return res.status(status).json({ success: false, error: { code, message, ...(err.details ? { details: err.details } : {}) } });
  }

  // Browser: a few errors are better handled by redirecting.
  if (code === 'UNAUTHENTICATED') return res.redirect('/login');
  if (code === 'CSRF_TOKEN_INVALID' && req.session) {
    req.session.flash = [{ type: 'error', message: req.t ? req.t('errors.CSRF_TOKEN_INVALID') : message }];
    return res.redirect(req.get('referer') || '/');
  }
  const t = res.locals.t || ((k) => k);
  const translated = t(`errors.${code}`);
  res.status(status);
  let layout = 'public';
  if (req.ctx?.organizationId && res.locals.organization) layout = 'app';
  else if (req.originalUrl.startsWith('/admin') && req.user?.is_super_admin) layout = 'admin';
  const data = {
    layout,
    title: status === 404 ? t('errors.not_found_title') : status === 403 ? t('errors.forbidden_title') : t('errors.generic_title'),
    status,
    code,
    message: translated !== `errors.${code}` ? translated : message,
    stack: !config.isProd && !known ? err.stack : null,
  };
  if (!res.page || !res.locals.t) return res.type('text').send(`${status} ${message}`);
  return res.render('pages/error', data, (e1, body) => {
    if (e1) return res.type('text').send(`${status} ${message}`);
    return res.render(`layouts/${layout}`, { ...data, body }, (e2, html) => (e2 ? res.type('text').send(`${status} ${message}`) : res.send(html)));
  });
}

module.exports = { notFound, errorHandler };
