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
const verify = require('./verify.service');
const portal = require('../organizations/portal.service');
const rbac = require('../rbac/rbac.service');
const { E } = require('../../core/errors');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: config.isTest ? 1000 : 20, standardHeaders: true, legacyHeaders: false,
  handler: (req, res, next) => next(require('../../core/errors').E.rateLimited()),
});

function signIn(req, user, organizationId) {
  return new Promise((resolve, reject) => {
    const returnTo = req.session.returnTo;
    const qrTicket = req.session.qrTicket; // a QR attendance scan made just before signing in
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      if (organizationId) req.session.organizationId = organizationId;
      req.session.returnTo = returnTo;
      if (qrTicket) req.session.qrTicket = qrTicket;
      return req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

// ---------- Login ----------
const renderLogin = (req, res, extra = {}) => res.page('pages/auth/login', { layout: 'auth', title: req.t('auth.login_title'), ...extra });

router.get('/login', (req, res) => (req.user ? res.redirect('/app') : renderLogin(req, res, { restored: req.query.restored === '1' })));

router.post('/login', loginLimiter, form(async (req, res) => {
  const data = validate(z.object({ email: email(), password: z.string().min(1, 'Password is required.') }), req.body);
  // Signing in from a company page (remoteway.net/<link>): the account must belong to that company.
  const fromPortal = req.body.portal ? await portal.bySlug(req.body.portal) : null;
  const user = await authService.authenticate(data, { ip: req.ip, userAgent: req.get('user-agent') });
  let orgId = user.last_organization_id;
  if (fromPortal) {
    if (!(await orgs.isMember(user.id, fromPortal.id))) throw E.conflict('PORTAL_NOT_MEMBER', `This account is not a member of ${fromPortal.name}.`);
    orgId = fromPortal.id;
    const e = portal.entry(req.body.as);
    const perms = await rbac.getUserPermissions(orgId, user.id);
    req.session.returnTo = !e.permission || perms.has(e.permission) ? e.path : '/app';
  }
  if (security.hasTwoFactor(user)) {
    // Password was right; the session is only created after the second factor.
    req.session.pending2fa = { userId: user.id, at: Date.now(), orgId };
    return req.session.save(() => res.redirect('/login/2fa'));
  }
  await signIn(req, user, orgId);
  return finishLogin(req, res, user);
}, async (req, res, extra) => {
  if (extra.formError?.code === 'INVALID_CREDENTIALS') res.status(401);
  const fromPortal = req.body.portal ? await portal.bySlug(req.body.portal) : null;
  if (fromPortal) return require('../organizations/portal.web').renderPortal(req, res, fromPortal, extra); // eslint-disable-line global-require
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
  await signIn(req, user, p.orgId || user.last_organization_id);
  return finishLogin(req, res, user);
}, render2fa));

// ---------- Forgot / reset password ----------
const renderForgot = (req, res, extra = {}) => res.page('pages/auth/forgot', { layout: 'auth', title: req.t('auth.forgot_title'), sent: false, ...extra });
router.get('/forgot', (req, res) => renderForgot(req, res));
router.post('/forgot', loginLimiter, form(async (req, res) => {
  if (!security.canEmail()) return renderForgot(req, res, { noEmail: true });
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

// ---------- Email verification ----------
router.get('/verify-email/:token', wrap(async (req, res) => {
  try {
    const user = await verify.confirm(req.params.token);
    flash(req, 'success', req.t('verify.done'));
    if (req.user && req.user.id === user.id) return res.redirect(req.session.organizationId ? '/app' : '/me');
    return res.redirect('/login');
  } catch (e) {
    if (e.code !== 'VERIFY_INVALID') throw e;
    res.status(404);
    return res.page('pages/auth/verify', { layout: 'auth', title: req.t('verify.title'), invalid: true, sent: false });
  }
}));
router.get('/verify-email', requireAuth, (req, res) => {
  if (verify.isVerified(req.user)) return res.redirect('/app');
  return res.page('pages/auth/verify', { layout: 'auth', title: req.t('verify.title'), invalid: false, sent: req.query.sent === '1' });
});
router.post('/verify-email/resend', requireAuth, wrap(async (req, res) => {
  try {
    await verify.send(req.user, { locale: req.locale });
    flash(req, 'success', req.t('verify.resent', { email: req.user.email }));
  } catch (e) {
    if (e.status !== 429) throw e;
    flash(req, 'error', req.t('verify.too_many'));
  }
  const back = String(req.get('referer') || '');
  let path = '/verify-email';
  try { const p = new URL(back, 'http://x').pathname; if (/^\/(app|me|verify-email)(\/[\w\-/]*)?$/.test(p)) path = p; } catch { /* keep default */ }
  return res.redirect(path);
}));

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
  res.page('pages/auth/security', { layout: 'auth', wide: true, title: req.t('auth.security_title'), on: security.hasTwoFactor(user), setup, owned: await privacy.ownedCompanies(user.id), required: req.query.required === '1', back: req.session.securityBack || '/app', googleLinked: Boolean(user.google_sub), ...extra });
};
router.get('/security', requireAuth, wrap(async (req, res) => {
  let back = '';
  try { back = new URL(String(req.get('referer') || ''), 'http://x').pathname; } catch { /* ignore */ }
  if (/^\/(app|admin|me)(\/[\w\-/]*)?$/.test(back)) req.session.securityBack = back;
  return renderSecurity(req, res);
}));
router.post('/security/password', requireAuth, loginLimiter, form(async (req, res) => {
  const data = validate(z.object({
    current_password: z.string().min(1, 'Enter your current password.'),
    new_password: password(),
    new_password_confirm: z.string(),
  }).refine((d) => d.new_password === d.new_password_confirm, { path: ['new_password_confirm'], message: 'The passwords do not match.' })
    .refine((d) => !['Admin@12345', 'Demo@12345', 'Password#123'].includes(d.new_password), { path: ['new_password'], message: 'Choose a password that is not a known default.' }), req.body);
  await authService.changePassword({ userId: req.user.id, ip: req.ip, sessionId: req.sessionID }, { currentPassword: data.current_password, newPassword: data.new_password });
  flash(req, 'success', req.t('settings.password_changed'));
  return res.redirect('/security');
}, (req, res, extra) => renderSecurity(req, res, { ...extra, passwordErrors: extra.errors })));
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
  await verify.send(await authService.findUser(userId), { locale: req.locale }).catch(() => {});
  require('../site/seo.service').markConversion(res, 'signup'); // eslint-disable-line global-require
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

// ---------- First sign-in with a temporary password: choose your own ----------
const renderNewPassword = (req, res, extra = {}) => res.page('pages/auth/new-password', { layout: 'auth', title: req.t('empacc.choose_title'), ...extra });
router.get('/security/new-password', requireAuth, (req, res) => (req.user.must_change_password ? renderNewPassword(req, res) : res.redirect('/app')));
router.post('/security/new-password', requireAuth, loginLimiter, form(async (req, res) => {
  if (!req.user.must_change_password) return res.redirect('/app');
  const d = validate(z.object({ new_password: password(), new_password_confirm: z.string() }), req.body);
  if (d.new_password !== d.new_password_confirm) throw E.validation({ new_password_confirm: 'The two passwords do not match.' });
  const user = await authService.findUser(req.user.id);
  if (await require('bcryptjs').compare(d.new_password, user.password_hash)) throw E.validation({ new_password: 'Choose a new password, not the temporary one.' }); // eslint-disable-line global-require
  await require('../../db/knex')('users').where({ id: user.id }).update({ password_hash: await authService.hashPassword(d.new_password), password_changed_at: new Date(), must_change_password: false }); // eslint-disable-line global-require
  await security.endSessions(user.id, req.sessionID);
  await require('../../core/audit').record({ userId: user.id, ip: req.ip }, 'auth.password_changed', { entityType: 'user', entityId: user.id, newValues: { first_sign_in: true } }); // eslint-disable-line global-require
  flash(req, 'success', req.t('empacc.chosen'));
  return finishLogin(req, res, user);
}, renderNewPassword));

// ---------- Sign in with Google ----------
const google = require('./google.service');
router.get('/auth/google', loginLimiter, wrap(async (req, res) => {
  if (req.user) return res.redirect('/app');
  try {
    const { url, pending: p } = await google.start({ intent: req.query.intent, next: req.query.next, portal: req.query.portal, as: req.query.as });
    req.session.google = p;
    return req.session.save(() => res.redirect(url));
  } catch (e) {
    if (!(e instanceof require('../../core/errors').AppError) && !/provider|HTTP|JSON|Timed out|ENOTFOUND|EAI_AGAIN/.test(e.message)) throw e; // eslint-disable-line global-require
    flash(req, 'error', req.t('google.unavailable'));
    return res.redirect('/login');
  }
}));
router.get('/auth/google/callback', loginLimiter, wrap(async (req, res) => {
  const p = req.session.google;
  delete req.session.google;
  try {
    const g = await google.verify(p, req.query);
    const { user, created } = await google.resolve(g, { locale: req.locale, ip: req.ip });
    let orgId = user.last_organization_id;
    const fromPortal = p.portal ? await portal.bySlug(p.portal) : null;
    if (fromPortal) {
      if (!(await orgs.isMember(user.id, fromPortal.id))) throw E.conflict('PORTAL_NOT_MEMBER', `This account is not a member of ${fromPortal.name}.`);
      orgId = fromPortal.id;
      const e = portal.entry(p.as);
      const perms = await rbac.getUserPermissions(orgId, user.id);
      req.session.returnTo = !e.permission || perms.has(e.permission) ? e.path : '/app';
    } else if (p.next) req.session.returnTo = p.next;
    if (created) require('../site/seo.service').markConversion(res, 'join'); // eslint-disable-line global-require
    if (security.hasTwoFactor(user)) {
      req.session.pending2fa = { userId: user.id, at: Date.now(), orgId };
      return req.session.save(() => res.redirect('/login/2fa'));
    }
    await signIn(req, user, orgId);
    if (created) return res.redirect(req.session.returnTo && req.session.returnTo.startsWith('/jobs/') ? req.session.returnTo : '/me/profile');
    return finishLogin(req, res, user);
  } catch (e) {
    if (!(e instanceof require('../../core/errors').AppError)) throw e; // eslint-disable-line global-require
    const tr = req.t(`errors.${e.code}`);
    res.status(e.status >= 500 ? 502 : e.status);
    return renderLogin(req, res, { formError: { code: e.code, message: tr !== `errors.${e.code}` ? tr : e.message } });
  }
}));
router.post('/security/google/unlink', requireAuth, wrap(async (req, res) => {
  await google.unlink({ userId: req.user.id, ip: req.ip }, req.user.id);
  flash(req, 'success', req.t('google.unlinked'));
  res.redirect('/security');
}));

module.exports = router;
module.exports.signIn = signIn;
