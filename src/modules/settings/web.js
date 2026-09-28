const express = require('express');
const { z, validate, optionalString, email } = require('../../core/validate');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const config = require('../../config');
const orgs = require('../organizations/organization.service');
const members = require('../organizations/members.service');
const auditLog = require('../organizations/audit.service');
const rbac = require('../rbac/rbac.service');
const authService = require('../auth/auth.service');
const ent = require('../billing/entitlements.service');
const mailer = require('../../core/mailer');

const router = express.Router();
const DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];

router.get('/', (req, res) => res.redirect(req.ctx.permissions.has('organization.manage') ? '/app/settings/company' : '/app/settings/account'));

// ---------- Company profile & work settings ----------
const companySchema = z.object({
  name: z.string().trim().min(2).max(150),
  country_code: z.string().length(2),
  industry: optionalString(80),
  company_size: optionalString(20),
  website: optionalString(255),
  phone: optionalString(40),
  address: optionalString(255),
  locale: z.enum(['en', 'ar']),
});
const workSchema = z.object({
  working_days: z.preprocess((v) => (Array.isArray(v) ? v : v ? [v] : []), z.array(z.enum(DAYS)).min(1, 'Choose at least one working day.')),
  work_start: z.string().regex(/^\d{2}:\d{2}$/),
  work_end: z.string().regex(/^\d{2}:\d{2}$/),
  employee_number_prefix: z.string().trim().min(1).max(10),
});

const renderCompany = async (req, res, extra = {}) => res.page('pages/settings/company', {
  title: req.t('settings.company'), section: 'company', countries: await orgs.listCountries(), settings: await orgs.getSettings(req.ctx.organizationId), days: DAYS, ...extra,
});
router.get('/company', can('organization.manage'), wrap((req, res) => renderCompany(req, res)));
router.post('/company', can('organization.manage'), form(async (req, res) => {
  const data = validate(companySchema, req.body);
  await orgs.updateProfile(req.ctx, {
    ...data, industry: data.industry ?? null, company_size: data.company_size ?? null, website: data.website ?? null, phone: data.phone ?? null, address: data.address ?? null,
  });
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/settings/company');
}, renderCompany));
router.post('/work', can('settings.manage'), form(async (req, res) => {
  const data = validate(workSchema, req.body);
  await orgs.updateSettings(req.ctx, data);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/settings/company#work');
}, renderCompany));

// ---------- Users & invitations ----------
const renderUsers = async (req, res, extra = {}) => {
  const [list, invitations, roles, usage] = await Promise.all([
    members.listMembers(req.ctx.organizationId), members.listInvitations(req.ctx.organizationId), rbac.listRoles(req.ctx.organizationId), ent.getUsage(req.ctx.organizationId),
  ]);
  const inviteLink = req.session.lastInviteLink;
  delete req.session.lastInviteLink;
  res.page('pages/settings/users', {
    title: req.t('settings.users'), section: 'users', members: list, invitations, roles: roles.filter((r) => r.key !== 'owner'), usage, inviteLink,
    emailEnabled: mailer.enabled(), ...extra,
  });
};
router.get('/users', can('users.view'), wrap((req, res) => renderUsers(req, res)));
router.post('/users/invite', can('users.manage'), form(async (req, res) => {
  const data = validate(z.object({ email: email(), role_id: z.coerce.number().int().positive() }), req.body);
  const { token } = await members.invite(req.ctx, { email: data.email, roleId: data.role_id });
  const link = `${config.appUrl}/invite/${token}`;
  let emailed = false;
  if (mailer.enabled()) {
    const role = await rbac.getRole(req.ctx.organizationId, data.role_id);
    emailed = await mailer.sendInvitation({ email: data.email, link, organizationName: req.organization.name, roleName: role.name, locale: req.locale, organizationId: req.ctx.organizationId })
      .catch((e) => { console.error('[mail] invitation failed:', e.message); return false; });
  }
  if (!emailed) req.session.lastInviteLink = link;
  flash(req, 'success', req.t(emailed ? 'settings.invite_emailed' : 'settings.invite_created', { email: data.email }));
  res.redirect('/app/settings/users');
}, (req, res, extra) => renderUsers(req, res, { ...extra, openDialog: 'invite' })));
router.post('/users/invitations/:id/revoke', can('users.manage'), wrap(async (req, res) => {
  await members.revokeInvitation(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('settings.invite_revoked'));
  res.redirect('/app/settings/users');
}));
router.post('/users/:id/role', can('users.manage'), form(async (req, res) => {
  await rbac.assignRole(req.ctx, Number(req.params.id), Number(req.body.role_id));
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/settings/users');
}, renderUsers));
router.post('/users/:id/status', can('users.manage'), form(async (req, res) => {
  await members.setMemberStatus(req.ctx, Number(req.params.id), req.body.status === 'active' ? 'active' : 'disabled');
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/settings/users');
}, renderUsers));

// ---------- Roles & permissions ----------
const renderRoles = async (req, res, extra = {}) => {
  const [roles, permissions] = await Promise.all([rbac.listRoles(req.ctx.organizationId), rbac.listPermissions()]);
  res.page('pages/settings/roles', {
    title: req.t('settings.roles'), section: 'roles', roles, permissions, customRoles: req.entitlements.features.has('custom_roles'), ...extra,
  });
};
router.get('/roles', can('roles.manage'), wrap((req, res) => renderRoles(req, res)));
router.post('/roles', can('roles.manage'), form(async (req, res) => {
  const data = validate(z.object({
    id: z.preprocess((v) => (v ? Number(v) : undefined), z.number().int().positive().optional()),
    name: z.string().trim().min(2).max(100),
    description: optionalString(255),
    permissions: z.preprocess((v) => (Array.isArray(v) ? v : v ? [v] : []), z.array(z.string())),
  }), req.body);
  await rbac.saveCustomRole(req.ctx, data);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/settings/roles');
}, (req, res, extra) => renderRoles(req, res, { ...extra, openDialog: 'role' })));
router.post('/roles/:id/delete', can('roles.manage'), form(async (req, res) => {
  await rbac.deleteCustomRole(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect('/app/settings/roles');
}, renderRoles));

// ---------- API tokens ----------
const renderApi = async (req, res, extra = {}) => {
  const newToken = req.session.newApiToken;
  delete req.session.newApiToken;
  return res.page('pages/settings/api', {
    title: req.t('settings.api'), section: 'api', tokens: await authService.listApiTokens(req.ctx.organizationId),
    apiEnabled: req.entitlements.features.has('api'), newToken, apiBase: `${config.appUrl}/api/v1`, ...extra,
  });
};
router.get('/api', can('api.manage'), wrap((req, res) => renderApi(req, res)));
router.post('/api', can('api.manage'), form(async (req, res) => {
  await ent.assertFeature(req.ctx.organizationId, 'api');
  const data = validate(z.object({ name: z.string().trim().min(2).max(100) }), req.body);
  const { token } = await authService.createApiToken(req.ctx, data.name);
  req.session.newApiToken = token;
  res.redirect('/app/settings/api');
}, renderApi));
router.post('/api/:id/revoke', can('api.manage'), wrap(async (req, res) => {
  await authService.revokeApiToken(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('settings.token_revoked'));
  res.redirect('/app/settings/api');
}));

// ---------- Audit log ----------
router.get('/audit', can('audit.view'), wrap(async (req, res) => {
  const result = await auditLog.list(req.ctx.organizationId, { page: Number(req.query.page) || 1, action: req.query.action });
  res.page('pages/settings/audit', { title: req.t('settings.audit'), section: 'audit', result });
}));

// ---------- My account ----------
const renderAccount = (req, res, extra = {}) => res.page('pages/settings/account', { title: req.t('settings.account'), section: 'account', ...extra });
router.get('/account', (req, res) => renderAccount(req, res));
router.post('/account/password', form(async (req, res) => {
  const data = validate(z.object({
    current_password: z.string().min(1), new_password: z.string().min(8, 'Password must be at least 8 characters.').max(128),
  }), req.body);
  await authService.changePassword(req.ctx, { currentPassword: data.current_password, newPassword: data.new_password });
  flash(req, 'success', req.t('settings.password_changed'));
  res.redirect('/app/settings/account');
}, renderAccount));
router.post('/account/locale', wrap(async (req, res) => {
  const locale = req.body.locale === 'ar' ? 'ar' : 'en';
  await require('../../db/knex')('users').where({ id: req.user.id }).update({ locale });
  res.cookie('rw_lang', locale, { maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: true, secure: config.isProd });
  res.redirect('/app/settings/account');
}));

module.exports = router;
