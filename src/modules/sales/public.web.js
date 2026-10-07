// The customer's links: /quote/<token> a quotation (view, print, accept or decline), /invoice/<token> an
// invoice, /file/<token> a file (company profile…). No account needed; the link itself is the key.
const express = require('express');
const { wrap, form } = require('../../routes/helpers');
const { translator } = require('../../core/i18n');
const fmt = require('../../core/format');
const storage = require('../../core/storage');
const sales = require('./sales.service');

const router = express.Router();

/** Shows the document in its own language unless the visitor picked one (?lang=). */
function asLocale(req, res, locale) {
  if (req.query.lang) return;
  Object.assign(res.locals, {
    locale, dir: locale === 'ar' ? 'rtl' : 'ltr', t: translator(locale),
    fmt: { ...res.locals.fmt, date: (v, o) => fmt.formatDate(v, locale, o), money: (a, c) => fmt.formatMoney(a, c, locale), number: (n) => fmt.formatNumber(n, locale) },
  });
}
const noIndex = (res) => { res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('Referrer-Policy', 'no-referrer'); };
// The RemoteWay team opening a link from the admin is not counted as the customer viewing it.
const isTeam = (req) => Boolean(req.user && req.user.is_super_admin);

const renderQuote = async (req, res, extra = {}) => {
  noIndex(res);
  const q = await sales.quoteByToken(req.params.token, { count: req.method === 'GET' && !isTeam(req) });
  asLocale(req, res, q.locale);
  res.page('pages/sales/quote-public', { layout: 'document', title: `${res.locals.t('sales.quotation')} ${q.number}`, q, state: sales.quoteState(q), p: await sales.profile(), ...extra });
};
router.get('/quote/:token', wrap((req, res) => renderQuote(req, res)));
router.post('/quote/:token/respond', form(async (req, res) => {
  await sales.respond(req.params.token, req.body);
  res.redirect(`/quote/${encodeURIComponent(req.params.token)}`);
}, renderQuote));

router.get('/invoice/:token', wrap(async (req, res) => {
  noIndex(res);
  const inv = await sales.invoiceByToken(req.params.token, { count: !isTeam(req) });
  const r = await sales.invoiceRecipient(inv.organization_id);
  asLocale(req, res, r.locale === 'en' ? 'en' : 'ar');
  res.page('pages/sales/invoice-public', { layout: 'document', title: `${res.locals.t('billing.invoice')} ${inv.number}`, inv, p: await sales.profile() });
}));

router.get('/file/:token', wrap(async (req, res) => {
  noIndex(res);
  const f = await sales.fileByToken(req.params.token);
  if (!isTeam(req)) await sales.countOpen(f);
  const inline = ['application/pdf', 'image/png', 'image/jpeg'].includes(f.mime) && req.query.download !== '1';
  res.set('Content-Type', f.mime);
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  // No `sandbox` here: Chrome will not show a PDF in a sandboxed page, and these files come only from the
  // RemoteWay team (type checked on upload).
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=300');
  storage.createReadStream(f.storage_key).on('error', () => res.status(404).end()).pipe(res);
}));

module.exports = router;
