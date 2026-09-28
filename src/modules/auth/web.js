const express = require('express');
const rateLimit = require('express-rate-limit');
const { z, validate, email, password, optionalString } = require('../../core/validate');
const { wrap, form, flash } = require('../../routes/helpers');
const { requireAuth, touchLastOrganization } = require('../../middleware/context');
const config = require('../../config');
const authService = require('./auth.service');
const orgs = require('../organizations/organization.service');
const members = require('../organizations/members.service');
const subscriptions = require('../billing/subscription.service');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: config.isTest ? 1000 : 20, standardHeaders: true, legacyHeaders: false,
  handler: (req, res, next) => next(require('../../core/errors').E.rateLimited()),
});

function signIn(req, user, organizationId) {
  return new Promise((resolve, reject) => {
    const returnTo = req.session.returnTo;
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      if (organizationId) req.session.organizationId = organizationId;
      req.session.returnTo = returnTo;
      return req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

// ---------- Login ----------
const renderLogin = (req, res, extra = {}) => res.page('pages/auth/login', { layout: 'auth', title: req.t('auth.login_title'), ...extra });

router.get('/login', (req, res) => (req.user ? res.redirect('/app') : renderLogin(req, res)));

router.post('/login', loginLimiter, form(async (req, res) => {
  const data = validate(z.object({ email: email(), password: z.string().min(1, 'Password is required.') }), req.body);
  const user = await authService.authenticate(data, { ip: req.ip, userAgent: req.get('user-agent') });
  await signIn(req, user, user.last_organization_id);
  const to = req.session.returnTo && req.session.returnTo.startsWith('/') && !req.session.returnTo.startsWith('//') ? req.session.returnTo : null;
  delete req.session.returnTo;
  if (to) return res.redirect(to);
  const list = await orgs.listForUser(user.id);
  if (!list.length && user.is_super_admin) return res.redirect('/admin');
  // Individuals (talent profiles without a company) go to their own dashboard
  if (!list.length && await require('../../db/knex')('talent_profiles').where({ user_id: user.id }).first('id')) return res.redirect('/me'); // eslint-disable-line global-require
  return res.redirect('/app');
}, (req, res, extra) => {
  if (extra.formError?.code === 'INVALID_CREDENTIALS') res.status(401);
  return renderLogin(req, res, extra);
}));

router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('rw.sid');
    return res.redirect('/login');
  });
});

// ---------- Sign up (company onboarding wizard: account → company → plan) ----------
const signupSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name.').max(120),
  email: email(),
  password: password(),
  company_name: z.string().trim().min(2, 'Enter your company name.').max(150),
  country_code: z.string().length(2, 'Choose a country.'),
  industry: optionalString(80),
  company_size: optionalString(20),
  website: optionalString(255),
  phone: optionalString(40),
  plan: z.string().min(1, 'Choose a plan.'),
  terms: z.literal('on', { message: 'You must accept the terms to continue.' }),
});

async function renderSignup(req, res, extra = {}) {
  const [plans, countries] = await Promise.all([subscriptions.listPublicPlans(), orgs.listCountries()]);
  return res.page('pages/auth/signup', {
    layout: 'auth', wide: true, title: req.t('auth.signup_title'), plans, countries,
    selectedPlan: extra.old?.plan || req.query.plan || 'business', ...extra,
  });
}

router.get('/signup', wrap(async (req, res) => (req.user ? res.redirect('/organizations/new') : renderSignup(req, res))));

router.post('/signup', loginLimiter, form(async (req, res) => {
  const d = validate(signupSchema, req.body);
  const { userId, organizationId } = await orgs.registerCompany({
    account: { name: d.name, email: d.email, password: d.password, locale: req.locale },
    company: {
      name: d.company_name, country_code: d.country_code, industry: d.industry, company_size: d.company_size, website: d.website, phone: d.phone, locale: req.locale,
    },
    planKey: d.plan,
  }, { ip: req.ip, userAgent: req.get('user-agent') });
  await signIn(req, { id: userId }, organizationId);
  return res.redirect('/app/onboarding');
}, (req, res, extra) => renderSignup(req, res, extra)));

// ---------- Additional organization for an existing user ----------
const newOrgSchema = signupSchema.pick({ company_name: true, country_code: true, industry: true, company_size: true, website: true, phone: true, plan: true });

async function renderNewOrg(req, res, extra = {}) {
  const [plans, countries] = await Promise.all([subscriptions.listPublicPlans(), orgs.listCountries()]);
  return res.page('pages/auth/new-organization', {
    layout: 'auth', wide: true, title: req.t('auth.new_org_title'), plans, countries, selectedPlan: extra.old?.plan || 'business', ...extra,
  });
}

router.get('/organizations/new', requireAuth, wrap(renderNewOrg));
router.post('/organizations/new', requireAuth, form(async (req, res) => {
  const d = validate(newOrgSchema, req.body);
  const organizationId = await orgs.createAdditionalOrganization(req.user.id, {
    company: { name: d.company_name, country_code: d.country_code, industry: d.industry, company_size: d.company_size, website: d.website, phone: d.phone, locale: req.locale },
    planKey: d.plan,
  }, { ip: req.ip, userAgent: req.get('user-agent') });
  req.session.organizationId = organizationId;
  return res.redirect('/app/onboarding');
}, renderNewOrg));

// ---------- Organization switcher ----------
router.post('/organizations/switch', requireAuth, wrap(async (req, res) => {
  const id = Number(req.body.organization_id);
  if (!(await orgs.isMember(req.user.id, id))) {
    flash(req, 'error', req.t('errors.PERMISSION_DENIED'));
    return res.redirect('/app');
  }
  req.session.organizationId = id;
  await touchLastOrganization(req.user.id, id);
  return res.redirect('/app');
}));

// ---------- Invitations ----------
async function renderInvite(req, res, extra = {}) {
  const invitation = await members.findInvitation(req.params.token);
  if (!invitation) res.status(404);
  return res.page('pages/auth/invite', { layout: 'auth', title: req.t('auth.invite_title'), invitation, ...extra });
}

router.get('/invite/:token', wrap(renderInvite));
router.post('/invite/:token', loginLimiter, form(async (req, res) => {
  const ctx = { ip: req.ip, userAgent: req.get('user-agent') };
  let result;
  if (req.user) {
    result = await members.acceptInvitation(req.params.token, { userId: req.user.id }, ctx);
    req.session.organizationId = result.organizationId;
  } else {
    const d = validate(z.object({ name: z.string().trim().min(2, 'Enter your full name.').max(120), password: password() }), req.body);
    result = await members.acceptInvitation(req.params.token, { account: { name: d.name, password: d.password, locale: req.locale } }, ctx);
    await signIn(req, { id: result.userId }, result.organizationId);
  }
  flash(req, 'success', req.t('auth.invite_accepted'));
  return res.redirect('/app');
}, renderInvite));

module.exports = router;
module.exports.signIn = signIn;
