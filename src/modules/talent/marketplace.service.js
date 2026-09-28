// The marketplace glue: the public RemoteWay jobs board (jobs a company chose to publish), applying
// with a profile (lands in the company's existing recruitment pipeline as a candidate + application),
// and the company side of talent: saved / shortlisted people and invitations to apply.
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const storage = require('../../core/storage');
const config = require('../../config');
const mailer = require('../../core/mailer');
const { E, AppError } = require('../../core/errors');
const ent = require('../billing/entitlements.service');
const recruitment = require('../recruitment/recruitment.service');
const documents = require('../documents/document.service');
const profiles = require('./profile.service');

const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const WORK_MODES = ['remote', 'hybrid', 'onsite'];
const TYPES = ['full_time', 'part_time', 'contract', 'intern', 'freelance'];

/** Jobs a company may show on the board: open, published to the marketplace, company active with the feature. */
function boardQuery() {
  return knex('jobs as j').join('organizations as o', 'o.id', 'j.organization_id').leftJoin('locations as l', 'l.id', 'j.location_id')
    .leftJoin('organization_branding as b', 'b.organization_id', 'o.id')
    .where({ 'j.marketplace': true, 'j.status': 'open', 'o.status': 'active' })
    .select('j.id', 'j.organization_id', 'j.title', 'j.slug', 'j.work_mode', 'j.employment_type', 'j.salary_min', 'j.salary_max', 'j.salary_currency', 'j.show_salary',
      'j.experience_years', 'j.skills', 'j.description', 'j.requirements', 'j.published_at', 'j.marketplace_at', 'j.openings',
      'o.name as org_name', 'o.slug as org_slug', 'o.currency as org_currency', 'b.logo_sha', 'l.name as location_name', 'l.city as location_city', 'l.country_code as location_country');
}

async function visibleOrgs(ids) {
  const out = new Set();
  for (const id of [...new Set(ids)]) {
    const e = await ent.getEntitlements(id);
    if (e.canWrite && e.features.has('talent_marketplace')) out.add(id);
  }
  return out;
}

const shapeJob = (j) => ({ ...j, skills: parse(j.skills, []) || [], logoUrl: j.logo_sha ? `/org-brand/${j.organization_id}/logo/${j.logo_sha}` : null });

async function listJobs(filters = {}, { page = 1, perPage = 20 } = {}) {
  const q = boardQuery();
  const text = str(filters.q, 100);
  if (text) q.where((w) => w.where('j.title', 'like', `%${text}%`).orWhere('j.skills', 'like', `%${text}%`).orWhere('o.name', 'like', `%${text}%`).orWhere('j.description', 'like', `%${text}%`));
  if (WORK_MODES.includes(filters.work_mode)) q.where('j.work_mode', filters.work_mode);
  if (TYPES.includes(filters.employment_type)) q.where('j.employment_type', filters.employment_type);
  if (filters.city) q.where('l.city', 'like', `%${str(filters.city, 100)}%`);
  if (Number(filters.max_years) >= 0 && filters.max_years !== undefined && filters.max_years !== '') q.where((w) => w.whereNull('j.experience_years').orWhere('j.experience_years', '<=', Number(filters.max_years)));
  const all = await q.orderBy('j.marketplace_at', 'desc').limit(1000);
  const ok = await visibleOrgs(all.map((j) => j.organization_id));
  const list = all.filter((j) => ok.has(j.organization_id));
  const start = (Math.max(1, page) - 1) * perPage;
  return { total: list.length, page, perPage, items: list.slice(start, start + perPage).map(shapeJob) };
}

async function latestJobs(limit = 12) {
  return (await listJobs({}, { perPage: limit })).items;
}

async function openJobsPool(limit = 400) {
  const all = await boardQuery().orderBy('j.marketplace_at', 'desc').limit(limit);
  const ok = await visibleOrgs(all.map((j) => j.organization_id));
  return all.filter((j) => ok.has(j.organization_id)).map(shapeJob);
}

async function getJob(orgSlug, jobSlug) {
  const j = await boardQuery().where({ 'o.slug': String(orgSlug), 'j.slug': String(jobSlug) }).first();
  if (!j || !(await visibleOrgs([j.organization_id])).has(j.organization_id)) return null;
  return shapeJob(j);
}

/** Publishing a job on the RemoteWay board (the recruiter's choice, per job). */
async function setMarketplace(ctx, jobId, on) {
  if (on) await ent.assertFeature(ctx.organizationId, 'talent_marketplace');
  const job = await knex('jobs').where({ id: jobId, organization_id: ctx.organizationId }).first();
  if (!job) throw E.notFound('Job');
  await knex('jobs').where({ id: job.id }).update({ marketplace: Boolean(on), marketplace_at: on ? (job.marketplace_at || new Date()) : null });
  await audit.record(ctx, on ? 'job.marketplace_published' : 'job.marketplace_removed', { entityType: 'job', entityId: job.id });
}

// ---------- Applying with a profile ----------
function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return { first_name: (parts[0] || 'Candidate').slice(0, 80), last_name: (parts.slice(1).join(' ') || '-').slice(0, 80) };
}

async function apply(user, job, { cover_note: coverNote } = {}) {
  const p = await profiles.forUser(user.id);
  if (!p) throw E.conflict('PROFILE_REQUIRED', 'Create your profile before applying.');
  if (p.completion < 40) throw E.conflict('PROFILE_INCOMPLETE', 'Complete at least 40% of your profile before applying.');
  const orgId = job.organization_id;
  const ctx = { organizationId: orgId, userId: null };
  const fields = {
    ...splitName(user.name), phone: p.phone || null, city: p.city || null, current_title: p.headline ? p.headline.slice(0, 150) : null,
    experience_years: p.years ?? null, skills: JSON.stringify((p.skills || []).slice(0, 30)), linkedin_url: p.linkedin_url || null, consent: true, user_id: user.id,
  };
  let candidate = await knex('candidates').where({ organization_id: orgId }).where((w) => w.where('user_id', user.id).orWhere('email', user.email)).first();
  // Email addresses are not verified, so a candidate the company already has is only taken over by this
  // account when it is already linked to it, or has no applications yet (nothing of anyone else's to see).
  let linked = candidate && candidate.user_id === user.id;
  if (candidate && !linked && !candidate.user_id) {
    const prior = await knex('applications').where({ candidate_id: candidate.id }).first('id');
    linked = !prior;
  }
  // The company gets its own copy of the CV (counted in its storage, removed with its data)
  let cv = {};
  if (p.cv_storage_key) {
    try {
      const buf = await storage.read(p.cv_storage_key);
      await documents.assertStorage(orgId, buf.length);
      const key = storage.newKey(orgId, 'cvs');
      await storage.put(key, buf);
      cv = { cv_storage_key: key, cv_name: p.cv_name, cv_mime: p.cv_mime, cv_size: p.cv_size };
    } catch (e) { if (e.status) throw e; }
  }
  if (candidate && linked) {
    await knex('candidates').where({ id: candidate.id }).update({ ...fields, ...cv });
    if (cv.cv_storage_key && candidate.cv_storage_key) await storage.remove(candidate.cv_storage_key).catch(() => {});
  } else if (candidate) {
    // Someone else's record: add the application without changing their details or linking the account.
    if (cv.cv_storage_key) await storage.remove(cv.cv_storage_key).catch(() => {});
  } else {
    const [id] = await knex('candidates').insert({ ...fields, ...cv, organization_id: orgId, email: user.email, source: 'remoteway' });
    candidate = { id };
  }
  const note = [str(coverNote, 4500), `RemoteWay profile: ${config.appUrl.replace(/\/+$/, '')}/talent/${p.slug}`].filter(Boolean).join('\n\n');
  const applicationId = await recruitment.addToJob(ctx, candidate.id, job.id, { coverNote: note, source: 'remoteway' });
  await knex('talent_invitations').where({ organization_id: orgId, profile_id: p.id, status: 'sent' }).where((w) => w.where('job_id', job.id).orWhereNull('job_id'))
    .update({ status: 'applied', responded_at: new Date() });
  await require('../crm/crm.service').track('applied', { userId: user.id, jobTitle: job.title, company: job.org_name }); // eslint-disable-line global-require
  await audit.record({ organizationId: null, userId: user.id }, 'talent.applied', { entityType: 'job', entityId: job.id, newValues: { organization_id: orgId } });
  return applicationId;
}

const PUBLIC_STAGE = { applied: 'submitted', screening: 'in_review', shortlisted: 'in_review', interview: 'interview', assessment: 'interview', offer: 'offer', hired: 'hired', rejected: 'closed' };

async function myApplications(userId) {
  const rows = await knex('applications as a').join('candidates as c', 'c.id', 'a.candidate_id').join('jobs as j', 'j.id', 'a.job_id').join('organizations as o', 'o.id', 'a.organization_id')
    .where('c.user_id', userId).orderBy('a.created_at', 'desc')
    .select('a.id', 'a.stage', 'a.created_at', 'a.stage_changed_at', 'j.title', 'j.slug', 'j.marketplace', 'j.status as job_status', 'o.name as org_name', 'o.slug as org_slug');
  return rows.map((r) => ({ ...r, public_stage: PUBLIC_STAGE[r.stage] || 'submitted' }));
}

async function appliedJobIds(userId) {
  return knex('applications as a').join('candidates as c', 'c.id', 'a.candidate_id').where('c.user_id', userId).pluck('a.job_id');
}

// ---------- Company: saved people and invitations ----------
async function assertCompany(ctx) {
  await ent.assertFeature(ctx.organizationId, 'talent_marketplace');
}

async function viewable(ctx, profileId) {
  const p = await profiles.byId(Number(profileId));
  if (!p || !(await profiles.canView(p, { organizationId: ctx.organizationId, companyAccess: true }))) throw E.notFound('Profile');
  return p;
}

async function save(ctx, profileId, { list = 'saved', note, job_id: jobId } = {}) {
  await assertCompany(ctx);
  const p = await viewable(ctx, profileId);
  const values = { list: list === 'shortlist' ? 'shortlist' : 'saved', note: note ? str(note, 500) : null, job_id: jobId ? Number(jobId) : null, created_by: ctx.userId, updated_at: new Date() };
  if (values.job_id && !(await knex('jobs').where({ id: values.job_id, organization_id: ctx.organizationId }).first('id'))) values.job_id = null;
  await knex('talent_saved').insert({ organization_id: ctx.organizationId, profile_id: p.id, ...values }).onConflict(['organization_id', 'profile_id']).merge(values);
  await audit.record(ctx, 'talent.saved', { entityType: 'talent_profile', entityId: p.id, newValues: { list: values.list } });
}

async function unsave(ctx, profileId) {
  await knex('talent_saved').where({ organization_id: ctx.organizationId, profile_id: Number(profileId) }).del();
}

async function savedList(ctx, list) {
  const q = knex('talent_saved as s').join('talent_profiles as p', 'p.id', 's.profile_id').join('users as u', 'u.id', 'p.user_id').leftJoin('jobs as j', 'j.id', 's.job_id')
    .where('s.organization_id', ctx.organizationId).where('u.status', 'active').whereNot('p.visibility', 'private')
    .select('p.*', 'u.name', 's.list', 's.note', 's.created_at as saved_at', 'j.title as job_title').orderBy('s.updated_at', 'desc');
  if (list) q.where('s.list', list);
  return (await q).map(profiles.hydrate);
}

async function savedMap(ctx) {
  return Object.fromEntries((await knex('talent_saved').where({ organization_id: ctx.organizationId }).select('profile_id', 'list')).map((r) => [r.profile_id, r.list]));
}

const INVITES_PER_DAY = 50;

async function invite(ctx, profileId, { job_id: jobId, message }) {
  await assertCompany(ctx);
  await ent.assertCanWrite(ctx.organizationId);
  const p = await viewable(ctx, profileId);
  if (!p.open_to_work) throw E.conflict('NOT_OPEN_TO_WORK', 'This person is not open to new opportunities right now.');
  const job = jobId ? await knex('jobs').where({ id: Number(jobId), organization_id: ctx.organizationId }).first() : null;
  if (jobId && (!job || job.status !== 'open')) throw E.validation({ job_id: 'Choose one of your open jobs.' });
  const [{ n }] = await knex('talent_invitations').where({ organization_id: ctx.organizationId }).where('created_at', '>=', new Date(Date.now() - 86_400_000)).count({ n: '*' });
  if (Number(n) >= INVITES_PER_DAY) throw new AppError('INVITE_LIMIT', `You can send up to ${INVITES_PER_DAY} invitations a day.`, 429);
  const dup = await knex('talent_invitations').where({ organization_id: ctx.organizationId, profile_id: p.id, status: 'sent' })
    .where((w) => (job ? w.where('job_id', job.id) : w.whereNull('job_id'))).first('id');
  if (dup) throw E.conflict('ALREADY_INVITED', 'You already invited this person.');
  const [id] = await knex('talent_invitations').insert({ organization_id: ctx.organizationId, profile_id: p.id, job_id: job ? job.id : null, message: message ? str(message, 2000) : null, created_by: ctx.userId });
  await audit.record(ctx, 'talent.invited', { entityType: 'talent_profile', entityId: p.id, newValues: { job: job ? job.title : null } });
  if (mailer.enabled()) {
    const org = await knex('organizations').where({ id: ctx.organizationId }).first('name');
    const u = await knex('users').where({ id: p.user_id }).first('email', 'locale');
    const ar = u.locale === 'ar';
    await mailer.send({
      to: u.email,
      subject: ar ? `دعوة من ${org.name} على RemoteWay` : `${org.name} invited you on RemoteWay`,
      html: mailer.layout({ locale: u.locale, title: ar ? `${org.name} مهتمة بملفك` : `${org.name} is interested in your profile`, body: `${job ? `${job.title}. ` : ''}${message ? str(message, 600) : ''}`, cta: ar ? 'عرض الدعوة' : 'View invitation', href: `${config.appUrl}/me` }),
    }).catch(() => {});
  }
  return id;
}

async function myInvitations(profileId) {
  return knex('talent_invitations as i').join('organizations as o', 'o.id', 'i.organization_id').leftJoin('jobs as j', 'j.id', 'i.job_id')
    .where('i.profile_id', profileId).orderBy('i.created_at', 'desc').limit(50)
    .select('i.*', 'o.name as org_name', 'o.slug as org_slug', 'j.title as job_title', 'j.slug as job_slug', 'j.marketplace', 'j.status as job_status');
}

async function declineInvitation(userId, id) {
  const p = await knex('talent_profiles').where({ user_id: userId }).first('id');
  const n = p ? await knex('talent_invitations').where({ id: Number(id), profile_id: p.id, status: 'sent' }).update({ status: 'declined', responded_at: new Date() }) : 0;
  if (!n) throw E.notFound('Invitation');
}

async function sentInvitations(ctx) {
  return knex('talent_invitations as i').join('talent_profiles as p', 'p.id', 'i.profile_id').join('users as u', 'u.id', 'p.user_id').leftJoin('jobs as j', 'j.id', 'i.job_id')
    .where('i.organization_id', ctx.organizationId).orderBy('i.created_at', 'desc').limit(100)
    .select('i.*', 'u.name', 'p.slug', 'p.headline', 'j.title as job_title');
}

module.exports = {
  listJobs, latestJobs, openJobsPool, getJob, setMarketplace, apply, myApplications, appliedJobIds, save, unsave, savedList, savedMap,
  invite, myInvitations, declineInvitation, sentInvitations, viewable, PUBLIC_STAGE, token: () => crypto.randomBytes(8).toString('hex'),
};
