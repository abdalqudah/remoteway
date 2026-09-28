// Professional profiles for individuals (the talent side of the marketplace). A profile belongs to a
// RemoteWay user, so the existing sign-in, sessions and password reset work unchanged; the same person
// can also be a member of company workspaces.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const storage = require('../../core/storage');
const config = require('../../config');
const { E } = require('../../core/errors');
const { z, validate, email, password, optionalString } = require('../../core/validate');
const documents = require('../documents/document.service');

const VISIBILITY = ['public', 'companies', 'private'];
const JOB_TYPES = ['full_time', 'part_time', 'contract', 'freelance', 'intern'];
const WORK_MODES = ['remote', 'hybrid', 'onsite'];
const LANG_LEVELS = ['basic', 'conversational', 'professional', 'fluent', 'native'];
const SECTIONS = ['experience', 'education', 'certifications', 'projects', 'languages'];
const CV_EXT = ['pdf', 'doc', 'docx'];
const PHOTO_MAX = 2 * 1024 * 1024;

const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const url = (v) => {
  const s = str(v, 255);
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try { const u = new URL(withScheme); return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null; } catch { return null; }
};
const ym = (v) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || '')) ? String(v) : null);
const year = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1950 && n <= 2100 ? n : null; };
const normSkill = (s) => str(s, 60).toLowerCase().replace(/\s+/g, ' ');
const skillsList = (v) => [...new Map(arr(v).flatMap((x) => String(x).split(/[,،\n]/)).map((s) => str(s, 60)).filter(Boolean).map((s) => [normSkill(s), s])).values()].slice(0, 40);

function hydrate(p) {
  if (!p) return null;
  const out = { ...p };
  for (const k of [...SECTIONS, 'skills']) out[k] = parse(p[k], []) || [];
  out.preferences = parse(p.preferences, {}) || {};
  out.ai_analysis = parse(p.ai_analysis, null);
  out.years = p.years_experience != null ? p.years_experience : p.computed_years;
  out.photoUrl = p.photo_sha ? `/talent-media/${p.id}/photo/${p.photo_sha}` : null;
  delete out.photo;
  return out;
}

/** Years covered by experience entries (overlaps counted once). */
function computeYears(experience, now = new Date()) {
  const toIdx = (s) => { const [y, m] = s.split('-').map(Number); return y * 12 + (m - 1); };
  const nowIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const ranges = experience.filter((e) => e.start).map((e) => [toIdx(e.start), e.current || !e.end ? nowIdx : toIdx(e.end)]).filter(([a, b]) => b >= a).sort((a, b) => a[0] - b[0]);
  let months = 0; let cur = null;
  for (const [a, b] of ranges) {
    if (!cur || a > cur[1]) { if (cur) months += cur[1] - cur[0] + 1; cur = [a, b]; } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) months += cur[1] - cur[0] + 1;
  return ranges.length ? Math.floor(months / 12) : null;
}

/** Profile completion and what is still missing (drives the dashboard meter). */
function completion(p) {
  const checks = [
    ['photo', Boolean(p.photo_sha)], ['headline', Boolean(p.headline)], ['specialization', Boolean(p.specialization)],
    ['bio', String(p.bio || '').length >= 80], ['location', Boolean(p.city || p.country_code)], ['skills', (p.skills || []).length >= 3],
    ['experience', (p.experience || []).length > 0], ['education', (p.education || []).length > 0], ['languages', (p.languages || []).length > 0],
    ['cv', Boolean(p.cv_storage_key)], ['links', Boolean(p.linkedin_url || p.portfolio_url)], ['preferences', (p.preferences?.work_modes || []).length > 0 || (p.preferences?.titles || []).length > 0],
    ['certifications', (p.certifications || []).length > 0], ['projects', (p.projects || []).length > 0],
  ];
  const weights = { photo: 8, headline: 10, specialization: 8, bio: 8, location: 5, skills: 12, experience: 12, education: 8, languages: 5, cv: 10, links: 4, preferences: 5, certifications: 3, projects: 2 };
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const got = checks.filter(([, ok]) => ok).reduce((a, [k]) => a + weights[k], 0);
  return { percent: Math.round((got / total) * 100), missing: checks.filter(([, ok]) => !ok).map(([k]) => k) };
}

async function uniqueSlug(name, exceptId) {
  const base = String(name || 'profile').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'profile';
  for (let i = 0; i < 20; i += 1) {
    const slug = i === 0 ? base : `${base}-${crypto.randomBytes(2).toString('hex')}`;
    const q = knex('talent_profiles').where({ slug });
    if (exceptId) q.whereNot('id', exceptId);
    if (!(await q.first('id'))) return slug;
  }
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

async function refresh(profileId, trx = knex) {
  const row = hydrate(await trx('talent_profiles').where({ id: profileId }).first());
  const c = completion(row);
  const computed = computeYears(row.experience);
  await trx('talent_profiles').where({ id: profileId }).update({ completion: c.percent, computed_years: computed, updated_at: new Date() });
  if (row.completion < 80 && c.percent >= 80) await require('../crm/crm.service').track('profile_completed', { userId: row.user_id, completion: c.percent }); // eslint-disable-line global-require
}

// ---------- Accounts ----------
const signupSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name.').max(120), email: email(), password: password(),
  terms: z.literal('on', { message: 'You must accept the terms to continue.' }),
});

/** Individual sign-up: a normal RemoteWay user with a profile and no company. */
async function signup(input, { ip } = {}) {
  const d = validate(signupSchema, input);
  if (await knex('users').where({ email: d.email }).first('id')) throw E.conflict('EMAIL_TAKEN', 'An account with this email already exists. Sign in instead.');
  const user = await knex.transaction(async (trx) => {
    const [userId] = await trx('users').insert({ name: d.name, email: d.email, password_hash: await bcrypt.hash(d.password, config.bcryptRounds) });
    await trx('talent_profiles').insert({ user_id: userId, slug: await uniqueSlug(d.name), skills: '[]', education: '[]', experience: '[]', certifications: '[]', projects: '[]', languages: '[]', preferences: '{}' });
    await audit.record({ organizationId: null, userId, ip }, 'talent.signup', { entityType: 'user', entityId: userId }, trx);
    return trx('users').where({ id: userId }).first();
  });
  await require('../crm/crm.service').track('individual_signup', { userId: user.id }); // eslint-disable-line global-require
  return user;
}

/** An existing user (e.g. a company member) starts a profile. */
async function ensure(user) {
  const existing = await knex('talent_profiles').where({ user_id: user.id }).first('id');
  if (existing) return existing.id;
  // Created on first visit to /me (e.g. an employee): hidden until the person chooses to show it.
  const [id] = await knex('talent_profiles').insert({ user_id: user.id, visibility: 'private', slug: await uniqueSlug(user.name), skills: '[]', education: '[]', experience: '[]', certifications: '[]', projects: '[]', languages: '[]', preferences: '{}' });
  return id;
}

async function forUser(userId) {
  return hydrate(await knex('talent_profiles as p').join('users as u', 'u.id', 'p.user_id').where('p.user_id', userId).first('p.*', 'u.name', 'u.email'));
}

async function byId(id) {
  return hydrate(await knex('talent_profiles as p').join('users as u', 'u.id', 'p.user_id').where('p.id', id).where('u.status', 'active').first('p.*', 'u.name', 'u.email'));
}

/**
 * Who may see a profile: public → everyone; companies → signed-in members of a company with the
 * marketplace; private → only companies the person applied to, or the person.
 */
async function canView(p, viewer = {}) {
  if (!p) return false;
  if (viewer.userId && viewer.userId === p.user_id) return true;
  if (p.visibility === 'public') return true;
  if (p.visibility === 'companies') return Boolean(viewer.companyAccess);
  if (viewer.organizationId) return Boolean(await knex('candidates').where({ organization_id: viewer.organizationId, user_id: p.user_id }).first('id'));
  return false;
}

async function bySlug(slug, viewer) {
  const p = hydrate(await knex('talent_profiles as p').join('users as u', 'u.id', 'p.user_id').where('p.slug', String(slug)).where('u.status', 'active').first('p.*', 'u.name', 'u.email'));
  return (await canView(p, viewer)) ? p : null;
}

/** Contact details are shown only when the person allows it, or to a company they applied to. */
async function contactFor(p, viewer = {}) {
  if (p.show_contact || (viewer.userId && viewer.userId === p.user_id)) return { email: p.email, phone: p.phone };
  if (viewer.organizationId && await knex('candidates').where({ organization_id: viewer.organizationId, user_id: p.user_id }).first('id')) return { email: p.email, phone: p.phone };
  return null;
}

// ---------- Editing ----------
const basicsSchema = z.object({
  headline: optionalString(150), specialization: optionalString(80), bio: optionalString(3000),
  country_code: z.preprocess((v) => (v ? String(v).toUpperCase() : undefined), z.string().regex(/^[A-Z]{2}$/, 'Choose a country.').optional()),
  city: optionalString(100), phone: optionalString(40),
  years_experience: z.preprocess((v) => (v === '' || v == null ? null : v), z.coerce.number().int().min(0).max(60).nullable()),
});

async function saveBasics(user, input) {
  const id = await ensure(user);
  const d = validate(basicsSchema, input);
  const linkedin = url(input.linkedin_url); const portfolio = url(input.portfolio_url);
  if (input.linkedin_url && !linkedin) throw E.validation({ linkedin_url: 'Enter a valid link.' });
  if (input.portfolio_url && !portfolio) throw E.validation({ portfolio_url: 'Enter a valid link.' });
  await knex('talent_profiles').where({ id }).update({
    headline: d.headline ?? null, specialization: d.specialization ?? null, bio: d.bio ?? null, country_code: d.country_code ?? null, city: d.city ?? null,
    phone: d.phone ?? null, years_experience: d.years_experience, linkedin_url: linkedin, portfolio_url: portfolio,
  });
  await refresh(id);
}

async function saveSkills(user, input) {
  const id = await ensure(user);
  const list = skillsList(input.skills);
  await knex.transaction(async (trx) => {
    await trx('talent_profiles').where({ id }).update({ skills: JSON.stringify(list) });
    await trx('talent_skills').where({ profile_id: id }).del();
    if (list.length) await trx('talent_skills').insert([...new Set(list.map(normSkill))].map((skill) => ({ profile_id: id, skill })));
  });
  await refresh(id);
}

/** Repeating sections arrive as parallel arrays (one entry per row). Empty rows are dropped. */
function rows(input, fields) {
  const cols = Object.fromEntries(fields.map((f) => [f, arr(input[f])]));
  const n = Math.max(0, ...Object.values(cols).map((c) => c.length));
  return Array.from({ length: n }, (_, i) => Object.fromEntries(fields.map((f) => [f, cols[f][i]])));
}

function readSection(section, input) {
  switch (section) {
    case 'experience': return rows(input, ['exp_title', 'exp_company', 'exp_start', 'exp_end', 'exp_current', 'exp_description']).map((r) => ({
      title: str(r.exp_title, 120), company: str(r.exp_company, 120), start: ym(r.exp_start), end: ym(r.exp_end),
      current: !ym(r.exp_end), description: str(r.exp_description, 1500), // no end month = current role
    })).filter((r) => r.title || r.company);
    case 'education': return rows(input, ['edu_degree', 'edu_field', 'edu_school', 'edu_start', 'edu_end']).map((r) => ({
      degree: str(r.edu_degree, 120), field: str(r.edu_field, 120), school: str(r.edu_school, 150), start: year(r.edu_start), end: year(r.edu_end),
    })).filter((r) => r.school || r.degree);
    case 'certifications': return rows(input, ['cert_name', 'cert_issuer', 'cert_year', 'cert_url']).map((r) => ({
      name: str(r.cert_name, 150), issuer: str(r.cert_issuer, 120), year: year(r.cert_year), url: url(r.cert_url),
    })).filter((r) => r.name);
    case 'projects': return rows(input, ['proj_name', 'proj_url', 'proj_description']).map((r) => ({
      name: str(r.proj_name, 150), url: url(r.proj_url), description: str(r.proj_description, 1000),
    })).filter((r) => r.name);
    case 'languages': return rows(input, ['lang_name', 'lang_level']).map((r) => ({
      name: str(r.lang_name, 60), level: LANG_LEVELS.includes(r.lang_level) ? r.lang_level : 'professional',
    })).filter((r) => r.name);
    default: throw E.notFound('Section');
  }
}

async function saveSection(user, section, input) {
  if (!SECTIONS.includes(section)) throw E.notFound('Section');
  const id = await ensure(user);
  const list = readSection(section, input).slice(0, 30);
  if (section === 'experience') {
    for (const [i, e] of list.entries()) {
      if (e.start && e.end && !e.current && e.end < e.start) throw E.validation({ [`exp_end_${i}`]: 'The end date is before the start date.', exp_end: 'The end date is before the start date.' });
    }
  }
  await knex('talent_profiles').where({ id }).update({ [section]: JSON.stringify(list) });
  await refresh(id);
}

async function savePreferences(user, input) {
  const id = await ensure(user);
  const prefs = {
    titles: skillsList(input.pref_titles).slice(0, 10),
    job_types: arr(input.pref_job_types).filter((v) => JOB_TYPES.includes(v)),
    work_modes: arr(input.pref_work_modes).filter((v) => WORK_MODES.includes(v)),
    locations: skillsList(input.pref_locations).slice(0, 10),
    salary_min: Number(input.pref_salary_min) > 0 ? Math.round(Number(input.pref_salary_min)) : null,
    salary_currency: /^[A-Z]{3}$/.test(String(input.pref_salary_currency || '')) ? input.pref_salary_currency : 'SAR',
    available_from: /^\d{4}-\d{2}-\d{2}$/.test(String(input.pref_available_from || '')) ? input.pref_available_from : null,
  };
  await knex('talent_profiles').where({ id }).update({
    preferences: JSON.stringify(prefs),
    visibility: VISIBILITY.includes(input.visibility) ? input.visibility : 'companies',
    open_to_work: input.open_to_work === 'on', show_contact: input.show_contact === 'on',
  });
  await refresh(id);
}

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function uploadPhoto(user, file) {
  const id = await ensure(user);
  if (!file || !file.buffer?.length) throw E.validation({ file: 'Choose an image to upload.' });
  if (file.buffer.length > PHOTO_MAX) throw E.validation({ file: 'The photo must be 2 MB or smaller.' });
  const mime = sniffImage(file.buffer);
  if (!mime) throw E.validation({ file: 'Upload a PNG, JPG or WebP image.' });
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex').slice(0, 16);
  await knex('talent_profiles').where({ id }).update({ photo: file.buffer, photo_mime: mime, photo_sha: sha });
  await refresh(id);
}

async function removePhoto(user) {
  const id = await ensure(user);
  await knex('talent_profiles').where({ id }).update({ photo: null, photo_mime: null, photo_sha: null });
  await refresh(id);
}

async function uploadCv(user, file) {
  const id = await ensure(user);
  if (!file) throw E.validation({ file: 'Attach your CV (PDF or Word).' });
  const f = documents.checkFile(file);
  if (!CV_EXT.includes(f.ext)) throw E.validation({ file: 'CVs must be PDF or Word documents.' });
  if (file.size > 5 * 1024 * 1024) throw E.validation({ file: 'The CV must be 5 MB or smaller.' });
  const key = `talent/u-${Number(user.id)}/cv/${crypto.randomUUID().replace(/-/g, '')}`;
  await storage.put(key, file.buffer);
  const old = await knex('talent_profiles').where({ id }).first('cv_storage_key');
  await knex('talent_profiles').where({ id }).update({ cv_storage_key: key, cv_name: f.name, cv_mime: f.mime, cv_size: file.size });
  if (old?.cv_storage_key) await storage.remove(old.cv_storage_key).catch(() => {});
  await refresh(id);
}

async function removeCv(user) {
  const id = await ensure(user);
  const old = await knex('talent_profiles').where({ id }).first('cv_storage_key');
  await knex('talent_profiles').where({ id }).update({ cv_storage_key: null, cv_name: null, cv_mime: null, cv_size: null });
  if (old?.cv_storage_key) await storage.remove(old.cv_storage_key).catch(() => {});
  await refresh(id);
}

async function photo(profileId, sha) {
  if (!/^[a-f0-9]{16}$/.test(String(sha))) return null;
  const r = await knex('talent_profiles as p').join('users as u', 'u.id', 'p.user_id').where({ 'p.id': profileId, 'p.photo_sha': sha }).first('p.photo', 'p.photo_mime');
  return r && r.photo ? { data: r.photo, mime: r.photo_mime } : null;
}

// ---------- Listing (Discover talent) ----------
const CARD_FIELDS = ['p.id', 'p.user_id', 'p.slug', 'p.headline', 'p.specialization', 'p.city', 'p.country_code', 'p.years_experience', 'p.computed_years', 'p.photo_sha', 'p.skills', 'p.open_to_work', 'p.visibility', 'p.completion', 'p.preferences', 'p.languages', 'u.name'];

/**
 * @param filters { q, specialization, skills[], min_years, max_years, country, city, work_mode, job_type, language, open_to_work }
 * @param viewer  { companyAccess } — companies also see "companies-only" profiles
 */
function searchQuery(filters = {}, viewer = {}) {
  const q = knex('talent_profiles as p').join('users as u', 'u.id', 'p.user_id').where('u.status', 'active')
    .whereIn('p.visibility', viewer.companyAccess ? ['public', 'companies'] : ['public']).where('p.completion', '>=', 20);
  const text = str(filters.q, 100);
  if (text) q.where((w) => w.where('p.headline', 'like', `%${text}%`).orWhere('p.specialization', 'like', `%${text}%`).orWhere('u.name', 'like', `%${text}%`).orWhere('p.bio', 'like', `%${text}%`)
    .orWhereExists(function sk() { this.select('*').from('talent_skills as s').whereRaw('s.profile_id = p.id').where('s.skill', 'like', `%${text.toLowerCase()}%`); }));
  if (filters.specialization) q.where('p.specialization', 'like', `%${str(filters.specialization, 80)}%`);
  for (const skill of skillsList(filters.skills).slice(0, 8)) {
    q.whereExists(function sk() { this.select('*').from('talent_skills as s').whereRaw('s.profile_id = p.id').where('s.skill', normSkill(skill)); });
  }
  const yearsExpr = knex.raw('COALESCE(p.years_experience, p.computed_years, 0)');
  if (Number(filters.min_years) > 0) q.where(yearsExpr, '>=', Number(filters.min_years));
  if (Number(filters.max_years) > 0) q.where(yearsExpr, '<=', Number(filters.max_years));
  if (/^[A-Za-z]{2}$/.test(String(filters.country || ''))) q.where('p.country_code', String(filters.country).toUpperCase());
  if (filters.city) q.where('p.city', 'like', `%${str(filters.city, 100)}%`);
  if (WORK_MODES.includes(filters.work_mode)) q.whereRaw('JSON_CONTAINS(p.preferences, ?, \'$.work_modes\')', [JSON.stringify(filters.work_mode)]);
  if (JOB_TYPES.includes(filters.job_type)) q.whereRaw('JSON_CONTAINS(p.preferences, ?, \'$.job_types\')', [JSON.stringify(filters.job_type)]);
  if (filters.language) q.where('p.languages', 'like', `%${str(filters.language, 40).replace(/[%_"]/g, '')}%`);
  if (filters.open_to_work) q.where('p.open_to_work', true);
  return q;
}

async function search(filters = {}, viewer = {}, { page = 1, perPage = 24 } = {}) {
  const base = searchQuery(filters, viewer);
  const [{ n }] = await base.clone().count({ n: 'p.id' });
  const rowsOut = await base.select(CARD_FIELDS).orderBy([{ column: 'p.open_to_work', order: 'desc' }, { column: 'p.completion', order: 'desc' }, { column: 'p.updated_at', order: 'desc' }])
    .limit(perPage).offset((Math.max(1, page) - 1) * perPage);
  return { total: Number(n), page, perPage, items: rowsOut.map(hydrate) };
}

async function featured(limit = 12) {
  const list = await knex('talent_profiles as p').join('users as u', 'u.id', 'p.user_id').where('u.status', 'active').where('p.visibility', 'public')
    .where('p.open_to_work', true).where('p.completion', '>=', 50).whereNotNull('p.headline')
    .select(CARD_FIELDS).orderBy([{ column: 'p.photo_sha', order: 'desc' }, { column: 'p.updated_at', order: 'desc' }]).limit(limit);
  return list.map(hydrate);
}

async function specializations() {
  return knex('talent_profiles').whereNot('visibility', 'private').whereNotNull('specialization').groupBy('specialization')
    .select('specialization').count({ n: '*' }).orderBy('n', 'desc').limit(30);
}

async function saveAnalysis(profileId, output) {
  await knex('talent_profiles').where({ id: profileId }).update({ ai_analysis: JSON.stringify(output), analyzed_at: new Date() });
}

module.exports = {
  VISIBILITY, JOB_TYPES, WORK_MODES, LANG_LEVELS, SECTIONS, hydrate, completion, computeYears, signup, ensure, forUser, byId, bySlug, canView, contactFor,
  saveBasics, saveSkills, saveSection, savePreferences, uploadPhoto, removePhoto, uploadCv, removeCv, photo, search, searchQuery, featured, specializations,
  saveAnalysis, normSkill, skillsList,
};
