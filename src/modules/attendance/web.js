const express = require('express');
const { wrap, form, flash, back } = require('../../routes/helpers');
const { can, feature } = require('../../middleware/context');
const attendance = require('./attendance.service');
const employees = require('../workforce/employee.service');

const router = express.Router();
router.use(feature('attendance'));

// HR / managers see the daily sheet; everyone else goes to their own timesheet.
router.get('/', wrap(async (req, res) => {
  const { ctx } = req;
  if (!ctx.permissions.has('attendance.view')) {
    const self = await employees.linkedEmployeeId(ctx);
    if (!self) return res.page('pages/attendance/none', { title: req.t('nav.attendance') });
    return res.redirect(`/app/attendance/employees/${self}`);
  }
  const [sheet, today] = await Promise.all([attendance.daily(ctx, req.query.date), attendance.today(ctx)]);
  return res.page('pages/attendance/daily', { title: req.t('nav.attendance'), sheet, today });
}));

router.get('/employees/:id', wrap(async (req, res) => {
  const employee = await employees.get(req.ctx, Number(req.params.id));
  const sheet = await attendance.timesheet(req.ctx, employee.id, req.query.month);
  res.page('pages/attendance/timesheet', { title: `${req.t('nav.attendance')} · ${employee.full_name}`, employee, sheet, today: await attendance.today(req.ctx) });
}));

router.post('/clock', form(async (req, res) => {
  const done = await attendance.clock(req.ctx, String(req.body.action || ''), req.ip);
  flash(req, 'success', req.t(`attendance.done_${done}`));
  back(req, res, '/app');
}, async (req, res, extra) => {
  flash(req, 'error', extra.formError.message);
  back(req, res, '/app');
}));

router.post('/manual', can('attendance.manage'), form(async (req, res) => {
  await attendance.saveManual(req.ctx, Number(req.body.employee_id), req.body);
  flash(req, 'success', req.t('common.saved'));
  back(req, res, '/app/attendance');
}, async (req, res, extra) => {
  flash(req, 'error', Object.values(extra.errors || {})[0] || extra.formError.message);
  back(req, res, '/app/attendance');
}));

// ---------- QR attendance: office screens ----------
const kiosks = require('./kiosk.service');
const orgs = require('../organizations/organization.service');
const knex = require('../../db/knex');
const renderQr = async (req, res, extra = {}) => {
  const [list, locations, settings] = await Promise.all([kiosks.list(req.ctx.organizationId), knex('locations').where({ organization_id: req.ctx.organizationId }).orderBy('name'), orgs.getSettings(req.ctx.organizationId)]);
  res.page('pages/attendance/qr', { title: req.t('qr.title'), list, locations, qrRequired: Boolean(settings.attendance_qr_required), ...extra });
};
router.get('/qr', can('attendance.manage'), wrap((req, res) => renderQr(req, res)));
router.post('/qr', can('attendance.manage'), form(async (req, res) => {
  await kiosks.create(req.ctx, req.body);
  flash(req, 'success', req.t('qr.created'));
  res.redirect('/app/attendance/qr');
}, renderQr));
router.post('/qr/settings', can('attendance.manage'), wrap(async (req, res) => {
  await orgs.updateSettings(req.ctx, { attendance_qr_required: req.body.qr_required === '1' });
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/attendance/qr');
}));
router.get('/qr/:id/open', can('attendance.manage'), wrap(async (req, res) => res.redirect(kiosks.displayUrl(await kiosks.get(req.ctx, Number(req.params.id))))));
router.post('/qr/:id', can('attendance.manage'), wrap(async (req, res) => {
  await kiosks.update(req.ctx, Number(req.params.id), { same_network: req.body.same_network === '1', is_active: req.body.is_active === '1' });
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/attendance/qr');
}));
router.post('/qr/:id/regenerate', can('attendance.manage'), wrap(async (req, res) => {
  await kiosks.regenerate(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('qr.regenerated'));
  res.redirect('/app/attendance/qr');
}));
router.post('/qr/:id/delete', can('attendance.manage'), wrap(async (req, res) => {
  await kiosks.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('qr.deleted'));
  res.redirect('/app/attendance/qr');
}));

module.exports = router;
