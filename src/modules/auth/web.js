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
const security = require('./security.service');
const privacy = require('./privacy.service');

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

router.get('/login', (req, res) => (req.user ? res.redirect('/app') : renderLogin(req, res, { restored: req.query.restored === '1' })));

router.post('/login', loginLimiter, form(async (req, res) => {
  const data = validate(z.object({ email: email(), password: z.string().min(1, 'Password is required.') }), req.body);
  const user = await authService.authenticate(data, { ip: req.ip, userAgent: req.get('user-agent') });
  if (security.hasTwoFactor(user)) {
    // Password was right; the session is only created after the second factor.
    req.session.pending2fa = { userId: user.id, at: Date.now() };
    return req.session.save(() => res.redirect('/login/2fa'));
  }
  await signIn(req, user, user.last_organization_id);
  return finishLogin(req, res, user);
}, (req, res, extra) => {
  if (extra.formError?.code === 'INVALID_CREDENTIALS') res.status(401);
  return renderLogin(req, res, extra);
}));

async function finishLogin(req, res, user) {
  const to = req.session.returnTo && req.session.returnTo.startsWith('/') && !req.session.returnTo.startsWith('//') ? req.session.returnTo : null;
  delete req.session.returnTo;
  if (to) return res.redirect(to);
  const list = await orgs.listForUser(user.id);
  if (!list.length && user.is_super_admin) return res.redirect('/admin');
  // Individuals (talent profiles without a company) go to their own dashboard
  if (!list.length && await require('../../db/knex')('talent_profiles').where({ user_id: user.id }).first('id')) return res.redirect('/me'); // eslint-disable-line global-require
  return res.redirect('/app');
}

// ---------- Second factor at sign-in ----------
const pending = (req) => (req.session.pending2fa && Date.now() - req.session.pending2fa.at < 10 * 60_000 ? req.session.pending2fa : null);
const render2fa = (req, res, extra = {}) => res.page('pages/auth/two-factor', { layout: 'auth', title: req.t('auth.twofa_title'), ...extra });
router.get('/login/2fa', (req, res) => (pending(req) ? render2fa(req, res) : res.redirect('/login')));
router.post('/login/2fa', loginLimiter, form(async (req, res) => {
  const p = pending(req);
  if (!p) return res.redirect('/login');
  await security.verifyLogin(p.userId, req.body.code);
  const user = await authService.findUser(p.userId);
  delete req.session.pending2fa;
  await signIn(req, user, user.last_organization_id);
  return finishLogin(req, res, user);
}, render2fa));

// ---------- Forgot / reset password ----------
const renderForgot = (req, res, extra = {}) => res.page('pages/auth/forgot', { layout: 'auth', title: req.t('auth.forgot_title'), sent: false, ...extra });
router.get('/forgot', (req, res) => renderForgot(req, res));
router.post('/forgot', loginLimiter, form(async (req, res) => {
  await security.requestReset(req.body.email, { ip: req.ip, locale: req.locale });
  return renderForgot(req, res, { sent: true });
}, renderForgot));
const renderReset = async (req, res, extra = {}) => {
  const valid = Boolean(await security.findReset(req.params.token));
  res.set('Referrer-Policy', 'no-referrer');
  return res.page('pages/auth/reset', { layout: 'auth', title: req.t('auth.reset_title'), valid, token: req.params.token, ...extra });
};
router.get('/reset/:token', wrap((req, res) => renderReset(req, res)));
router.post('/reset/:token', loginLimiter, form(async (req, res) => {
  await security.resetPassword(req.params.token, req.body.password, req.body.password_confirm, { ip: req.ip });
  flash(req, 'success', req.t('auth.reset_done'));
  return res.redirect('/login');
}, renderReset));

// ---------- Security settings (every signed-in user) ----------
router.get('/security/export', requireAuth, wrap(async (req, res) => {
  const data = await privacy.exportData(req.user.id);
  await require('../../core/audit').record({ userId: req.user.id, ip: req.ip }, 'account.data_exported', { entityType: 'user', entityId: req.user.id }); // eslint-disable-line global-require
  res.set({ 'Content-Disposition': `attachment; filename="remoteway-my-data-${new Date().toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
  res.type('application/json').send(JSON.stringify(data, null, 2));
}));
router.post('/security/delete', requireAuth, loginLimiter, form(async (req, res) => {
  await privacy.deleteAccount(req.user.id, { password: req.body.password, confirm: req.body.confirm, ip: req.ip });
  req.session.destroy(() => {});
  res.clearCookie('rw.sid');
  return res.redirect('/?deleted=1');
}, (req, res, extra) => renderSecurity(req, res, { ...extra, deleteOpen: true })));
const renderSecurity = async (req, res, extra = {}) => {
  const user = await authService.findUser(req.user.id);
  const setup = req.session.twofaSetup ? await security.setupData(user, req.session.twofaSetup) : null;
  res.page('pages/auth/security', { layout: 'auth', wide: true, title: req.t('auth.security_title'), on: security.hasTwoFactor(user), setup, owned: await privacy.ownedCompanies(user.id), required: req.query.required === '1', back: req.session.securityBack || '/app', ...extra });
};
router.get('/security', requireAuth, wrap(async (req, res) => {
  const ref = String(req.get('referer') || '');
  if (/\/(app|admin|me)(\/|$)/.test(ref)) req.session.securityBack = new URL(ref).pathname;
  return renderSecurity(req, res);
}));
router.post('/security/2fa/start', requireAuth, wrap(async (req, res) => {
  req.session.twofaSetup = security.generateSecret();
  req.session.save(() => res.redirect('/security#setup'));
}));
router.post('/security/2fa/enable', requireAuth, loginLimiter, form(async (req, res) => {
  if (!req.session.twofaSetup) return res.redirect('/security');
  const user = await authService.findUser(req.user.id);
  const codes = await security.enable(user, req.session.twofaSetup, req.body.code);
  delete req.session.twofaSetup;
  return renderSecurity(req, res, { recoveryCodes: codes });
}, renderSecurity));
router.post('/security/2fa/disable', requireAuth, loginLimiter, form(async (req, res) => {
  const user = await authService.findUser(req.user.id);
  if (user.is_super_admin && await security.requireAdmin2fa()) throw require('../../core/errors').E.conflict('TWO_FACTOR_REQUIRED', 'Two-factor authentication is required for the platform team.'); // eslint-disable-line global-require
  await security.disable(user, req.body.password);
  flash(req, 'success', req.t('auth.twofa_disabled'));
  return res.redirect('/security');
}, renderSecurity));

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
