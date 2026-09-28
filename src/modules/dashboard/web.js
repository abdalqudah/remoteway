const express = require('express');
const knex = require('../../db/knex');
const { wrap } = require('../../routes/helpers');
const dashboard = require('./dashboard.service');
const employees = require('../workforce/employee.service');
const ent = require('../billing/entitlements.service');
const attendance = require('../attendance/attendance.service');
const leave = require('../leave/leave.service');
const documents = require('../documents/document.service');
const tasks = require('../tasks/task.service');
const recruitment = require('../recruitment/recruitment.service');
const onboarding = require('../onboarding/onboarding.service');
const payroll = require('../payroll/payroll.service');
const perfReviews = require('../performance/reviews.service');
const learning = require('../learning/enrollments.service');
const { todayIn } = require('../../core/workdays');

const router = express.Router();

/** Live "today" figures. Only modules in the plan are queried; others stay null. */
async function todayData(req) {
  const { ctx } = req;
  const has = (f) => req.entitlements.features.has(f);
  const out = { attendance: null, onLeave: null, approvals: null, docs: null, myTasks: null, recruitment: null, onboardingTasks: [], interviews: [], payroll: null, reviews: { mine: [], toWrite: [] }, training: [] };
  if (has('attendance')) out.attendance = await attendance.todaySummary(ctx.organizationId);
  if (has('leave')) {
    out.onLeave = (await leave.onLeaveOn(ctx.organizationId, todayIn(req.organization.timezone))).length;
    out.approvals = (await leave.pendingApprovals(ctx)).length;
  }
  if (has('documents') && (ctx.permissions.has('documents.view') || ctx.permissions.has('documents.manage'))) out.docs = await documents.expirySummary(ctx.organizationId);
  if (has('tasks')) out.myTasks = await tasks.myOpenCount(ctx);
  if (has('recruitment') && ctx.permissions.has('recruitment.view')) out.recruitment = await recruitment.summary(ctx.organizationId);
  if (has('recruitment')) out.interviews = (await recruitment.listInterviews(ctx, { mine: true })).slice(0, 5);
  if (has('onboarding')) out.onboardingTasks = await onboarding.myOpenTasks(ctx);
  if (has('performance')) out.reviews = await perfReviews.myQueue(ctx);
  if (has('learning')) out.training = await learning.myDue(ctx);
  if (has('payroll') && ctx.permissions.has('payroll.view')) out.payroll = await payroll.summary(ctx.organizationId);
  // eslint-disable-next-line global-require
  if (has('compliance')) out.policies = await require('../compliance/compliance.service').pendingPolicies(ctx);
  return out;
}

router.get('/', wrap(async (req, res) => {
  const { ctx } = req;
  const has = (f) => req.entitlements.features.has(f);
  const me = await employees.forUser(ctx.organizationId, ctx.userId);
  const today = await todayData(req);
  const clock = has('attendance') && me ? await attendance.today(ctx) : null;

  if (!ctx.permissions.has('employees.view')) {
    let team = null;
    if (ctx.permissions.has('team.view') && me) team = await employees.list(ctx, { status: 'current', per_page: 8, sort: 'name' });
    const [balances, myRequests, myTaskList] = await Promise.all([
      has('leave') && me ? leave.balancesFor(ctx.organizationId, me.id) : [],
      has('leave') && me ? leave.myRequests(ctx) : [],
      has('tasks') ? tasks.list(ctx, { mine: true }) : [],
    ]);
    return res.page('pages/dashboard/personal', {
      title: req.t('nav.dashboard'), me, team, today, clock, balances, myRequests: myRequests.slice(0, 5), myTaskList: myTaskList.slice(0, 6),
    });
  }
  const [data, activity, availability] = await Promise.all([
    dashboard.companyDashboard(ctx.organizationId),
    ctx.permissions.has('audit.view') ? dashboard.recentActivity(ctx.organizationId) : [],
    ent.featureAvailability(),
  ]);
  // Action center items that depend on the viewer (approvals) or on live data.
  const actions = [...data.actions];
  if (today.approvals) actions.unshift({ key: 'pending_leave', count: today.approvals, href: '/app/leave?tab=approvals', tone: 'warning' });
  if (today.docs?.expired) actions.push({ key: 'documents_expired', count: today.docs.expired, href: '/app/documents?expiry=expired', tone: 'danger' });
  if (today.docs?.expiring) actions.push({ key: 'documents_expiring', count: today.docs.expiring, href: '/app/documents?expiry=expiring', tone: 'warning' });
  const [{ n: openTasks }] = has('tasks') ? await knex('tasks').where({ organization_id: ctx.organizationId }).whereNot('status', 'done').count({ n: '*' }) : [{ n: null }];
  return res.page('pages/dashboard/company', {
    title: req.t('nav.dashboard'), data: { ...data, actions }, activity, availability, me, today, clock, openTasks: openTasks === null ? null : Number(openTasks),
  });
}));

module.exports = router;
