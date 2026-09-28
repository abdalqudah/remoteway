const express = require('express');
const knex = require('../../db/knex');
const { z, validate, optionalString, emptyToUndefined } = require('../../core/validate');
const { wrap, form, flash } = require('../../routes/helpers');
const { LIMIT_KEYS } = require('../../db/catalog');
const admin = require('./admin.service');
const subscriptions = require('../billing/subscription.service');
const auditLog = require('../organizations/audit.service');
const bcrypt = require('bcryptjs');
const { E } = require('../../core/errors');
const { singleFile } = require('../../middleware/upload');
const updater = require('./updater.service');

const router = express.Router();

router.use((req, res, next) => {
  req.ctx = { userId: req.user.id, organizationId: null, permissions: new Set(), ip: req.ip, userAgent: req.get('user-agent') };
  res.locals.adminSection = req.path.split('/')[1] || 'overview';
  next();
});

router.get('/', wrap(async (req, res) => {
  res.page('pages/admin/overview', { layout: 'admin', title: req.t('admin.title'), stats: await admin.overview(), orgs: (await admin.listOrganizations()).slice(0, 8) });
}));

router.get('/organizations', wrap(async (req, res) => {
  res.page('pages/admin/organizations', { layout: 'admin', title: req.t('admin.organizations'), orgs: await admin.listOrganizations({ q: req.query.q }) });
}));

const renderOrg = async (req, res, extra = {}) => {
  const [org, plans] = await Promise.all([admin.getOrganization(Number(req.params.id)), knex('plans').orderBy('sort_order')]);
  res.page('pages/admin/organization', { layout: 'admin', title: org.name, org, plans, limitKeys: LIMIT_KEYS, ...extra });
};
router.get('/organizations/:id', wrap((req, res) => renderOrg(req, res)));
router.post('/organizations/:id/status', wrap(async (req, res) => {
  await admin.setOrganizationStatus(req.ctx, Number(req.params.id), req.body.status);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/admin/organizations/${req.params.id}`);
}));
const limitValue = z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional());
router.post('/organizations/:id/subscription', form(async (req, res) => {
  const data = validate(z.object({
    plan_id: z.coerce.number().int().positive(),
    status: z.enum(['trial', 'active', 'past_due', 'suspended', 'cancelled']),
    trial_ends_at: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
    custom: z.object(Object.fromEntries(LIMIT_KEYS.map((k) => [k, limitValue]))).partial().default({}),
    custom_unlimited: z.preprocess((v) => (Array.isArray(v) ? v : v ? [v] : []), z.array(z.enum(LIMIT_KEYS))),
  }), req.body);
  const custom = {};
  for (const k of LIMIT_KEYS) {
    if (data.custom_unlimited.includes(k)) custom[k] = null;
    else if (data.custom[k] !== undefined) custom[k] = data.custom[k];
  }
  await admin.updateSubscription(req.ctx, Number(req.params.id), {
    plan_id: data.plan_id, status: data.status, trial_ends_at: data.trial_ends_at ?? null, custom_limits: Object.keys(custom).length ? custom : null,
  });
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/admin/organizations/${req.params.id}`);
}, renderOrg));

// ---------- Plans ----------
const renderPlans = async (req, res, extra = {}) => res.page('pages/admin/plans', {
  layout: 'admin', title: req.t('admin.plans'), plans: await admin.listPlans(), features: await knex('features').orderBy('sort_order'), limitKeys: LIMIT_KEYS, ...extra,
});
router.get('/plans', wrap((req, res) => renderPlans(req, res)));
const money = z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(9_999_999).optional());
router.post('/plans/:id', form(async (req, res) => {
  const data = validate(z.object({
    name: z.string().trim().min(2).max(80),
    tagline: optionalString(255),
    tagline_ar: optionalString(255),
    price_monthly: money,
    price_yearly: money,
    trial_days: z.coerce.number().int().min(0).max(365),
    is_public: z.preprocess((v) => v === 'on', z.boolean()),
    is_active: z.preprocess((v) => v === 'on', z.boolean()),
    limits: z.object(Object.fromEntries(LIMIT_KEYS.map((k) => [k, limitValue]))).partial().default({}),
    feature_ids: z.preprocess((v) => (Array.isArray(v) ? v : v ? [v] : []), z.array(z.coerce.number().int().positive())),
  }), req.body);
  await admin.updatePlan(req.ctx, Number(req.params.id), data);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/admin/plans#plan-${req.params.id}`);
}, renderPlans));

// ---------- Invoices ----------
router.get('/invoices', wrap(async (req, res) => {
  res.page('pages/admin/invoices', { layout: 'admin', title: req.t('admin.invoices'), invoices: await admin.listInvoices(req.query.status) });
}));
router.post('/invoices/:id/paid', form(async (req, res) => {
  await subscriptions.markInvoicePaid(req.ctx, Number(req.params.id), String(req.body.reference || '').slice(0, 120));
  flash(req, 'success', req.t('admin.invoice_paid'));
  res.redirect('/admin/invoices');
}, async (req, res, extra) => {
  flash(req, 'error', extra.formError.message);
  res.redirect('/admin/invoices');
}));

// ---------- System update (no server access needed) ----------
const renderSystem = async (req, res, extra = {}) => {
  const [[{ v: dbVersion }]] = await knex.raw('SELECT VERSION() AS v');
  res.page('pages/admin/system', {
    layout: 'admin', title: req.t('admin.system'), current: updater.currentVersion(), backups: updater.listBackups(), log: updater.readLog(),
    dbVersion, workRoot: updater.WORK_ROOT, updated: req.query.updated, ...extra,
  });
};
router.get('/system', wrap((req, res) => renderSystem(req, res)));

async function confirmPassword(req) {
  if (!(await bcrypt.compare(String(req.body.password || ''), req.user.password_hash))) {
    throw E.validation({ password: 'Current password is incorrect.' });
  }
}

router.post('/system/update', ...singleFile('file', { big: true }), form(async (req, res) => {
  await confirmPassword(req);
  const result = await updater.apply({ ...req.ctx, userEmail: req.user.email }, req.file?.buffer, req.file?.originalname);
  res.redirect(`/admin/system?updated=${encodeURIComponent(result.to)}`);
}, renderSystem));

router.post('/system/restore', form(async (req, res) => {
  await confirmPassword(req);
  const result = await updater.restore({ ...req.ctx, userEmail: req.user.email }, req.body.backup);
  res.redirect(`/admin/system?updated=${encodeURIComponent(result.to)}`);
}, renderSystem));

// ---------- Platform audit log ----------
router.get('/audit', wrap(async (req, res) => {
  const result = await auditLog.list(null, { page: Number(req.query.page) || 1, action: req.query.action, perPage: 50 });
  res.page('pages/admin/audit', { layout: 'admin', title: req.t('admin.audit'), result });
}));

module.exports = router;
