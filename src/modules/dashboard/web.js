const express = require('express');
const { wrap } = require('../../routes/helpers');
const dashboard = require('./dashboard.service');
const employees = require('../workforce/employee.service');
const ent = require('../billing/entitlements.service');

const router = express.Router();

router.get('/', wrap(async (req, res) => {
  const { ctx } = req;
  const isCompanyView = ctx.permissions.has('employees.view');
  const me = await employees.forUser(ctx.organizationId, ctx.userId);
  if (!isCompanyView) {
    // Self-service / manager dashboard
    let team = null;
    if (ctx.permissions.has('team.view') && me) {
      team = (await employees.list(ctx, { status: 'current', per_page: 8, sort: 'name' }));
    }
    return res.page('pages/dashboard/personal', { title: req.t('nav.dashboard'), me, team });
  }
  const [data, activity, availability] = await Promise.all([
    dashboard.companyDashboard(ctx.organizationId),
    ctx.permissions.has('audit.view') ? dashboard.recentActivity(ctx.organizationId) : [],
    ent.featureAvailability(),
  ]);
  return res.page('pages/dashboard/company', { title: req.t('nav.dashboard'), data, activity, availability, me });
}));

module.exports = router;
