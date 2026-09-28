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

module.exports = router;
