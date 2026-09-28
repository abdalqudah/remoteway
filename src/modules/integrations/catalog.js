// Public event names (webhooks, chat) and the SMS / chat providers RemoteWay can talk to.
// Events are a curated subset of audit actions; salary-level data (compensation, pay components) is never sent.
const EVENT_GROUPS = [
  ['employees', ['employee.created', 'employee.updated', 'employee.terminated', 'employee.reactivated', 'employee.deleted']],
  ['leave', ['leave.requested', 'leave.approved', 'leave.rejected', 'leave.cancelled']],
  ['documents', ['document.uploaded', 'document.version_added', 'document.deleted']],
  ['tasks', ['task.created', 'task.status_changed']],
  ['recruitment', ['job.created', 'job.published', 'job.closed', 'application.created', 'application.stage_changed', 'application.hired']],
  ['onboarding', ['onboarding.started', 'onboarding.completed']],
  ['payroll', ['payroll.submitted', 'payroll.approved', 'payroll.paid']],
  ['performance', ['goal.created', 'review_cycle.launched', 'review_cycle.closed', 'review.completed']],
  ['learning', ['course.published', 'course.assigned', 'course.completed']],
];
const EVENTS = EVENT_GROUPS.flatMap(([, list]) => list);

// Notification types that can also go out by SMS (to the person's phone on their employee record).
const SMS_EVENTS = ['leave_approved', 'leave_rejected', 'leave_requested', 'payslip_available', 'interview_assigned', 'course_assigned',
  'review_self', 'review_manager', 'onboarding_started', 'payroll_submitted'];

// Only these hosts receive credentials. Sender names must be registered with the provider (CITC rules in KSA).
const SMS_PROVIDERS = {
  taqnyat: { name: 'Taqnyat', fields: ['token'], docs: 'https://dev.taqnyat.sa' },
  unifonic: { name: 'Unifonic', fields: ['app_sid'], docs: 'https://docs.unifonic.com' },
  msegat: { name: 'Msegat', fields: ['username', 'api_key'], docs: 'https://msegat.docs.apiary.io' },
};

const CHAT_PROVIDERS = {
  slack: { name: 'Slack', host: 'hooks.slack.com', docs: 'https://api.slack.com/messaging/webhooks' },
  google_chat: { name: 'Google Chat', host: 'chat.googleapis.com', docs: 'https://developers.google.com/workspace/chat/quickstart/webhooks' },
};

module.exports = { EVENT_GROUPS, EVENTS, SMS_EVENTS, SMS_PROVIDERS, CHAT_PROVIDERS };
