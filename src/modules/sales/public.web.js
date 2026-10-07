// The customer's links: /quote/<token> a quotation (view, print, accept or decline), /invoice/<token> an
// invoice, /file/<token> a file (company profile…). No account needed; the link itself is the key.
const express = require('express');
const { wrap, form } = require('../../routes/helpers');
const { translator } = require('../../core/i18n');
const fmt = require('../../core/format');
const storage = require('../../core/storage');
const sales = require('./sales.service');
const response = require('./quote-response.service');
const { someFiles } = require('../../middleware/upload');

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
  res.page('pages/sales/quote-public', {
    layout: 'document', title: `${res.locals.t('sales.quotation')} ${q.number}`, q, state: sales.quoteState(q), p: await sales.profile(),
    events: await response.events(q.id), reasons: response.DECLINE_REASONS, tab: ['accept', 'negotiate', 'decline'].includes(req.query.tab) ? req.query.tab : extra.tab || 'accept', ...extra,
  });
};
router.get('/quote/:token', wrap((req, res) => renderQuote(req, res)));
const back = (req, hash = '') => `/quote/${encodeURIComponent(req.params.token)}${hash}`;
router.post('/quote/:token/accept', someFiles(['stamp', 'signed_file']), form(async (req, res) => {
  await response.accept(req.params.token, req.body, req.filesByName || {}, { ip: req.ip, base: res.locals.baseUrl });
  res.redirect(back(req));
}, (req, res, extra) => renderQuote(req, res, { ...extra, tab: 'accept' })));
router.post('/quote/:token/decline', form(async (req, res) => {
  await response.decline(req.params.token, req.body);
  res.redirect(back(req));
}, (req, res, extra) => renderQuote(req, res, { ...extra, tab: 'decline' })));
router.post('/quote/:token/negotiate', form(async (req, res) => {
  await response.negotiate(req.params.token, req.body);
  require('../../routes/helpers').flash(req, 'success', res.locals.t('sales.negotiation_sent')); // eslint-disable-line global-require
  res.redirect(back(req, '#conversation'));
}, (req, res, extra) => renderQuote(req, res, { ...extra, tab: 'negotiate' })));
router.post('/quote/:token/email-copy', form(async (req, res) => {
  await response.emailCopy(req.params.token, req.body.email, res.locals.baseUrl);
  require('../../routes/helpers').flash(req, 'success', res.locals.t('sales.copy_sent', { email: String(req.body.email || '') })); // eslint-disable-line global-require
  res.redirect(back(req));
}, renderQuote));
/** The signature, stamp and signed document of an accepted quotation (the link is the key). */
router.get('/quote/:token/:part(signature|stamp|signed-file)', wrap(async (req, res) => {
  noIndex(res);
  const q = await sales.quoteByToken(req.params.token, { count: false });
  const key = { signature: q.signature_key, stamp: q.stamp_key, 'signed-file': q.signed_file_key }[req.params.part];
  if (!key || q.status !== 'accepted') return res.status(404).end();
  const mime = req.params.part === 'signed-file' ? q.signed_file_mime : req.params.part === 'signature' ? 'image/png' : (/-jpg-/.test(key) ? 'image/jpeg' : 'image/png');
  res.set('Content-Type', mime);
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=300');
  if (req.params.part === 'signed-file') res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(q.signed_file_name || 'signed.pdf')}`);
  return storage.createReadStream(key).on('error', () => res.status(404).end()).pipe(res);
}));

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
  if (f.body_html) { // a document written in the editor: a printable page with the letterhead, in its language
    asLocale(req, res, /[\u0600-\u06FF]/.test(f.body_html) ? 'ar' : 'en');
    return res.page('pages/sales/document-public', { layout: 'document', title: f.title, f, p: await sales.profile() });
  }
  const inline = ['application/pdf', 'image/png', 'image/jpeg'].includes(f.mime) && req.query.download !== '1';
  res.set('Content-Type', f.mime);
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  // No `sandbox` here: Chrome will not show a PDF in a sandboxed page, and these files come only from the
  // RemoteWay team (type checked on upload).
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=300');
  return storage.createReadStream(f.storage_key).on('error', () => res.status(404).end()).pipe(res);
}));

module.exports = router;
