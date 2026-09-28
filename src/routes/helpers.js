const { AppError } = require('../core/errors');
const { flash } = require('../middleware/web');
const { translateMessage } = require('../core/i18n');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Runs a form action. Expected business errors (validation, limits, conflicts) re-render the
 * form with messages; anything else goes to the error handler.
 */
const form = (action, rerender) => wrap(async (req, res, next) => {
  try {
    await action(req, res, next);
  } catch (err) {
    if (err instanceof AppError && [402, 409, 422, 404, 429, 502].includes(err.status) && rerender) {
      const translated = req.t(`errors.${err.code}`);
      res.status(err.status);
      return rerender(req, res, {
        errors: err.details && err.code === 'VALIDATION_FAILED'
          ? Object.fromEntries(Object.entries(err.details).map(([k, v]) => [k, translateMessage(req.locale, v)])) : {},
        formError: { code: err.code, message: translated !== `errors.${err.code}` ? translated : err.message, details: err.details },
        old: req.body,
      });
    }
    throw err;
  }
});

function back(req, res, fallback) {
  const ref = req.get('referer');
  res.redirect(ref && new URL(ref, 'http://x').host === req.get('host') ? ref : fallback);
}

module.exports = { wrap, form, flash, back };
