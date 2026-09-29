// Public side of QR attendance: the office display screen and the page a phone opens after scanning.
const express = require('express');
const { wrap } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const kiosks = require('./kiosk.service');
const attendance = require('./attendance.service');
const orgs = require('../organizations/organization.service');
const knex = require('../../db/knex');

const TICKET_MS = 3 * 60_000; // time to sign in after scanning

// ---------- Display screen (opened on the office tablet / TV with its secret link) ----------
const display = express.Router();
display.get('/:token', wrap(async (req, res, next) => {
  const k = await kiosks.byDisplayToken(req.params.token);
  if (!k) return next();
  const org = await orgs.get(k.organization_id);
  const brandInfo = await require('../branding/branding.service').forOrg(org.id, org.name); // eslint-disable-line global-require
  res.set('Cache-Control', 'no-store');
  return res.page('pages/attendance/kiosk-display', { layout: 'kiosk', title: `${org.name} · ${k.name}`, org, kiosk: k, orgLogo: brandInfo.logoUrl, token: req.params.token, qr: await kiosks.currentQr(k, req.ip, res.locals.baseUrl) });
}));
display.get('/:token/qr', wrap(async (req, res) => {
  const k = await kiosks.byDisplayToken(req.params.token);
  if (!k) return res.status(404).json({ success: false });
  res.set('Cache-Control', 'no-store');
  const q = await kiosks.currentQr(k, req.ip, res.locals.baseUrl);
  return res.json({ success: true, data: { svg: q.svg, expiresIn: q.expiresIn, step: q.stepSeconds } });
}));

// ---------- Scan ----------
const scan = express.Router();
const renderScan = async (req, res, extra = {}) => {
  const t = req.session.qrTicket;
  const k = t && await knex('attendance_kiosks').where({ id: t.kioskId }).first();
  const org = k && await orgs.get(k.organization_id);
  let today = null;
  if (k && req.user) today = await attendance.today({ organizationId: k.organization_id, userId: req.user.id });
  res.page('pages/attendance/scan', { layout: 'auth', title: req.t('qr.scan_title'), kiosk: k, org, today, ...extra });
};
const failScan = (req, res, e) => {
  res.status(e.status || 400);
  const tr = req.t(`errors.${e.code}`);
  return res.page('pages/attendance/scan', { layout: 'auth', title: req.t('qr.scan_title'), failed: tr !== `errors.${e.code}` ? tr : e.message });
};

scan.get('/:pub/:code', wrap(async (req, res) => {
  let k;
  try {
    k = await kiosks.checkScan(req.params.pub, req.params.code, req.ip);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return failScan(req, res, e);
  }
  // The scan is valid now; the person has a few minutes to sign in if needed.
  // The ticket is tied to the screen's current secret (a "new screen link" cancels open tickets) and
  // remembers whether the phone was on the screen's network.
  req.session.qrTicket = { kioskId: k.id, pub: k.public_id, at: Date.now(), sv: kiosks.secretVersion(k), off: Boolean(k.last_ip && String(req.ip) !== k.last_ip) };
  if (!req.user) {
    req.session.returnTo = `/q/${k.public_id}`;
    return req.session.save(() => res.redirect('/login'));
  }
  return req.session.save(() => res.redirect(`/q/${k.public_id}`));
}));

const ticketFor = (req, pub) => {
  const t = req.session.qrTicket;
  return t && t.pub === pub && Date.now() - t.at < TICKET_MS ? t : null;
};

scan.get('/:pub', wrap(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (!ticketFor(req, req.params.pub)) return failScan(req, res, new AppError('QR_EXPIRED', 'This code has expired. Scan the code currently on the screen.', 410));
  return renderScan(req, res);
}));

scan.post('/:pub', wrap(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  try {
    const t = ticketFor(req, req.params.pub);
    if (!t) throw new AppError('QR_EXPIRED', 'This code has expired. Scan the code currently on the screen.', 410);
    const k = await knex('attendance_kiosks').where({ id: t.kioskId, is_active: true }).first();
    if (!k || kiosks.secretVersion(k) !== t.sv) throw new AppError('QR_INVALID', 'This QR code is not valid. Scan the code on the office screen.', 404);
    if (!(await orgs.isMember(req.user.id, k.organization_id))) throw new AppError('QR_NOT_MEMBER', 'Your account does not belong to this company.', 403);
    const action = req.body.action === 'out' ? 'out' : 'in';
    const ctx = { organizationId: k.organization_id, userId: req.user.id, ip: req.ip };
    const done = await attendance.clock(ctx, action, req.ip, { method: 'qr', kioskId: k.id, offNetwork: t.off });
    delete req.session.qrTicket;
    req.session.organizationId = k.organization_id;
    return res.page('pages/attendance/scan', { layout: 'auth', title: req.t('qr.scan_title'), kiosk: k, org: await orgs.get(k.organization_id), today: await attendance.today(ctx), done, finished: true });
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    if ([403, 404, 410].includes(e.status)) return failScan(req, res, e);
    const tr = req.t(`errors.${e.code}`);
    res.status(e.status);
    return renderScan(req, res, { formError: { code: e.code, message: tr !== `errors.${e.code}` ? tr : e.message } });
  }
}));

module.exports = { display, scan };
