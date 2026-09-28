// Recruitment (ATS): jobs → candidates → applications moving through stages → hire.
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const storage = require('../../core/storage');
const { E, AppError } = require('../../core/errors');
const { z, validate, optionalString, optionalId, emptyToUndefined } = require('../../core/validate');
const { isDateStr, todayIn } = require('../../core/workdays');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');
const documents = require('../documents/document.service');
const employees = require('../workforce/employee.service');
const notifications = require('../notifications/notification.service');

const STAGES = ['applied', 'screening', 'shortlisted', 'interview', 'assessment', 'offer', 'hired', 'rejected'];
const PIPELINE = STAGES.filter((s) => s !== 'rejected');
const SOURCES = ['manual', 'careers', 'referral', 'linkedin', 'agency', 'other'];
const CV_EXT = ['pdf', 'doc', 'docx'];

const parseJson = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const skillsList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,،\n]/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 30).map((s) => s.slice(0, 60));
const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'job';

async function event(trx, ctx, applicationId, type, data = {}) {
  await trx('application_events').insert({ organization_id: ctx.organizationId, application_id: applicationId, user_id: ctx.userId || null, type, data: JSON.stringify(data) });
}

// ---------- Jobs ----------
const jobSchema = z.object({
  title: z.string().trim().min(2, 'Title is required.').max(150),
  department_id: optionalId(),
  location_id: optionalId(),
  work_mode: z.enum(['remote', 'hybrid', 'onsite']).default('onsite'),
  employment_type: z.enum(['full_time', 'part_time', 'contract', 'intern', 'freelance']).default('full_time'),
  salary_min: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(99_999_999).optional()),
  salary_max: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(99_999_999).optional()),
  show_salary: z.preprocess((v) => v === true || v === 'on' || v === 'true', z.boolean()),
  experience_years: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(50).optional()),
  skills: z.preprocess((v) => skillsList(v), z.array(z.string())),
  description: optionalString(20000),
  requirements: optionalString(20000),
  openings: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(500).default(1)),
  hiring_manager_user_id: optionalId(),
});

async function assertRefs(organizationId, data) {
  for (const [field, table] of [['department_id', 'departments'], ['location_id', 'locations']]) {
    if (data[field] && !(await knex(table).where({ id: data[field], organization_id: organizationId }).first('id'))) throw E.validation({ [field]: 'Not found.' });
  }
  if (data.hiring_manager_user_id && !(await knex('memberships').where({ organization_id: organizationId, user_id: data.hiring_manager_user_id, status: 'active' }).first('id'))) {
    throw E.validation({ hiring_manager_user_id: 'Choose a member of this workspace.' });
  }
  if (data.salary_min !== undefined && data.salary_max !== undefined && data.salary_max < data.salary_min) throw E.validation({ salary_max: 'Maximum must be above minimum.' });
}

async function uniqueSlug(organizationId, title, exceptId) {
  const base = slugify(title);
  for (let i = 0; i < 50; i += 1) {
    const slug = i ? `${base}-${i + 1}` : base;
    const q = knex('jobs').where({ organization_id: organizationId, slug });
    if (exceptId) q.whereNot('id', exceptId);
    if (!(await q.first('id'))) return slug;
  }
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

async function saveJob(ctx, id, input) {
  await ent.assertFeature(ctx.organizationId, 'recruitment');
  await ent.assertCanWrite(ctx.organizationId);
  const data = validate(jobSchema, input);
  await assertRefs(ctx.organizationId, data);
  const org = await orgs.get(ctx.organizationId);
  const row = {
    title: data.title, department_id: data.department_id ?? null, location_id: data.location_id ?? null, work_mode: data.work_mode,
    employment_type: data.employment_type, salary_min: data.salary_min ?? null, salary_max: data.salary_max ?? null, salary_currency: org.currency,
    show_salary: data.show_salary, experience_years: data.experience_years ?? null, skills: JSON.stringify(data.skills), description: data.description ?? null,
    requirements: data.requirements ?? null, openings: data.openings, hiring_manager_user_id: data.hiring_manager_user_id ?? null,
  };
  if (id) {
    const before = await knex('jobs').where({ id, organization_id: ctx.organizationId }).first();
    if (!before) throw E.notFound('Job');
    const d = audit.diff(before, row);
    await knex('jobs').where({ id }).update(row);
    if (d.changed) await audit.record(ctx, 'job.updated', { entityType: 'job', entityId: id, oldValues: d.oldValues, newValues: { ...d.newValues, name: data.title } });
    return Number(id);
  }
  const [newId] = await knex('jobs').insert({ ...row, organization_id: ctx.organizationId, slug: await uniqueSlug(ctx.organizationId, data.title), status: 'draft', created_by: ctx.userId });
  await audit.record(ctx, 'job.created', { entityType: 'job', entityId: newId, newValues: { name: data.title } });
  return newId;
}

/** draft → open (counts against the plan's active-jobs limit) → closed. */
async function setJobStatus(ctx, id, status) {
  if (!['draft', 'open', 'closed'].includes(status)) throw E.validation({ status: 'Invalid status.' });
  await ent.assertCanWrite(ctx.organizationId);
  await knex.transaction(async (trx) => {
    const job = await trx('jobs').where({ id, organization_id: ctx.organizationId }).forUpdate().first();
    if (!job) throw E.notFound('Job');
    if (job.status === status) return;
    if (status === 'open') {
      await ent.lockSubscription(ctx.organizationId, trx);
      await ent.assertWithinLimit(ctx.organizationId, 'active_jobs', 1, trx);
    }
    await trx('jobs').where({ id }).update({
      status, published_at: status === 'open' ? (job.published_at || new Date()) : job.published_at, closed_at: status === 'closed' ? new Date() : null,
    });
    await audit.record(ctx, `job.${status === 'open' ? 'published' : status}`, { entityType: 'job', entityId: id, oldValues: { status: job.status }, newValues: { status, name: job.title } }, trx);
  });
}

function jobBase(organizationId) {
  return knex('jobs as j').leftJoin('departments as d', 'd.id', 'j.department_id').leftJoin('locations as l', 'l.id', 'j.location_id')
    .leftJoin('users as u', 'u.id', 'j.hiring_manager_user_id').where('j.organization_id', organizationId)
    .select('j.*', 'd.name as department_name', 'l.name as location_name', 'u.name as hiring_manager_name');
}

async function listJobs(ctx, { status } = {}) {
  const q = jobBase(ctx.organizationId).orderByRaw("FIELD(j.status, 'open', 'draft', 'closed')").orderBy('j.id', 'desc');
  if (['draft', 'open', 'closed'].includes(status)) q.where('j.status', status);
  const jobs = await q;
  const counts = await knex('applications').where({ organization_id: ctx.organizationId }).groupBy('job_id', 'stage').select('job_id', 'stage').count({ n: '*' });
  return jobs.map((j) => {
    const by = Object.fromEntries(counts.filter((c) => c.job_id === j.id).map((c) => [c.stage, Number(c.n)]));
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    return { ...j, skills: parseJson(j.skills, []), stageCounts: by, total, active: total - (by.hired || 0) - (by.rejected || 0) };
  });
}

async function getJob(ctx, id) {
  const job = await jobBase(ctx.organizationId).where('j.id', id).first();
  if (!job) throw E.notFound('Job');
  job.skills = parseJson(job.skills, []);
  return job;
}

// ---------- Candidates ----------
const candidateSchema = z.object({
  first_name: z.string().trim().min(1, 'First name is required.').max(80),
  last_name: z.string().trim().min(1, 'Last name is required.').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(190),
  phone: optionalString(40),
  city: optionalString(100),
  current_title: optionalString(150),
  experience_years: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(60).optional()),
  skills: z.preprocess((v) => skillsList(v), z.array(z.string())),
  linkedin_url: z.preprocess(emptyToUndefined, z.string().trim().url('Enter a valid URL.').max(255).refine((u) => /^https?:\/\//i.test(u), 'Enter a valid URL.').optional()),
  source: z.enum(SOURCES).default('manual'),
});

function checkCv(file) {
  const f = documents.checkFile(file);
  if (!CV_EXT.includes(f.ext)) throw E.validation({ file: 'CVs must be PDF or Word documents.' });
  return f;
}

async function storeCv(organizationId, file) {
  const f = checkCv(file);
  await documents.assertStorage(organizationId, file.size);
  const key = storage.newKey(organizationId, 'cvs');
  await storage.put(key, file.buffer);
  return { cv_storage_key: key, cv_name: f.name, cv_mime: f.mime, cv_size: file.size };
}

async function saveCandidate(ctx, id, input, file) {
  await ent.assertFeature(ctx.organizationId, 'recruitment');
  await ent.assertCanWrite(ctx.organizationId);
  const data = validate(candidateSchema, input);
  const row = { ...data, skills: JSON.stringify(data.skills), phone: data.phone ?? null, city: data.city ?? null, current_title: data.current_title ?? null,
    experience_years: data.experience_years ?? null, linkedin_url: data.linkedin_url ?? null };
  const dup = knex('candidates').where({ organization_id: ctx.organizationId, email: data.email });
  if (id) dup.whereNot('id', id);
  if (await dup.first('id')) throw E.validation({ email: 'A candidate with this email already exists.' });
  const cv = file ? await storeCv(ctx.organizationId, file) : null;
  try {
    if (id) {
      const before = await knex('candidates').where({ id, organization_id: ctx.organizationId }).first();
      if (!before) throw E.notFound('Candidate');
      await knex('candidates').where({ id }).update({ ...row, ...(cv || {}) });
      if (cv && before.cv_storage_key) await storage.remove(before.cv_storage_key);
      const d = audit.diff(before, row);
      if (d.changed || cv) await audit.record(ctx, 'candidate.updated', { entityType: 'candidate', entityId: id, oldValues: d.oldValues, newValues: { ...d.newValues, cv: cv ? cv.cv_name : undefined } });
      return Number(id);
    }
    const [newId] = await knex('candidates').insert({ ...row, ...(cv || {}), organization_id: ctx.organizationId, created_by: ctx.userId, consent: true });
    await audit.record(ctx, 'candidate.created', { entityType: 'candidate', entityId: newId, newValues: { name: `${data.first_name} ${data.last_name}` } });
    return newId;
  } catch (err) {
    if (cv) await storage.remove(cv.cv_storage_key);
    throw err;
  }
}

async function listCandidates(ctx, { q, job_id: jobId, stage } = {}) {
  const query = knex('candidates as c').where('c.organization_id', ctx.organizationId)
    .select('c.*', knex('applications').count('*').where('candidate_id', knex.ref('c.id')).as('application_count'),
      knex('applications as a2').join('jobs as j2', 'j2.id', 'a2.job_id').select(knex.raw("GROUP_CONCAT(j2.title SEPARATOR ', ')")).where('a2.candidate_id', knex.ref('c.id')).as('job_titles'))
    .orderBy('c.id', 'desc').limit(300);
  if (q) {
    const like = `%${String(q).replace(/[%_]/g, '\\$&')}%`;
    query.where((w) => w.whereRaw("CONCAT(c.first_name, ' ', c.last_name) LIKE ?", [like]).orWhere('c.email', 'like', like).orWhere('c.current_title', 'like', like).orWhere('c.skills', 'like', like));
  }
  if (jobId || stage) {
    query.whereExists(function sub() {
      this.select('*').from('applications as a').whereRaw('a.candidate_id = c.id');
      if (jobId) this.where('a.job_id', Number(jobId));
      if (STAGES.includes(stage)) this.where('a.stage', stage);
    });
  }
  const rows = await query;
  return rows.map((r) => ({ ...r, skills: parseJson(r.skills, []), application_count: Number(r.application_count) }));
}

async function getCandidate(ctx, id) {
  const c = await knex('candidates').where({ id, organization_id: ctx.organizationId }).first();
  if (!c) throw E.notFound('Candidate');
  c.skills = parseJson(c.skills, []);
  c.applications = await knex('applications as a').join('jobs as j', 'j.id', 'a.job_id').where({ 'a.candidate_id': id, 'a.organization_id': ctx.organizationId })
    .select('a.*', 'j.title as job_title', 'j.status as job_status').orderBy('a.id', 'desc');
  return c;
}

async function openCv(ctx, candidateId) {
  const c = await knex('candidates').where({ id: candidateId, organization_id: ctx.organizationId }).first();
  if (!c || !c.cv_storage_key || !(await storage.exists(c.cv_storage_key))) throw E.notFound('CV');
  return { stream: storage.createReadStream(c.cv_storage_key), name: c.cv_name, mime: c.cv_mime, size: c.cv_size, inline: c.cv_mime === 'application/pdf' };
}

async function deleteCandidate(ctx, id) {
  const c = await knex('candidates').where({ id, organization_id: ctx.organizationId }).first();
  if (!c) throw E.notFound('Candidate');
  const hired = await knex('applications').where({ candidate_id: id, stage: 'hired' }).first('id');
  if (hired) throw new AppError('CANDIDATE_HIRED', 'Hired candidates are kept as part of the employee history.', 409);
  await knex('candidates').where({ id }).del();
  if (c.cv_storage_key) await storage.remove(c.cv_storage_key);
  await audit.record(ctx, 'candidate.deleted', { entityType: 'candidate', entityId: id, oldValues: { name: `${c.first_name} ${c.last_name}` } });
}

// ---------- Applications ----------
async function recruitersToNotify(organizationId, job, trx = knex) {
  const users = new Set(await notifications.usersWithPermission(organizationId, 'recruitment.manage', trx));
  if (job.hiring_manager_user_id) users.add(job.hiring_manager_user_id);
  return [...users];
}

async function addToJob(ctx, candidateId, jobId, { coverNote, source } = {}) {
  await ent.assertCanWrite(ctx.organizationId);
  return knex.transaction(async (trx) => {
    const c = await trx('candidates').where({ id: candidateId, organization_id: ctx.organizationId }).first();
    const job = await trx('jobs').where({ id: jobId, organization_id: ctx.organizationId }).first();
    if (!c) throw E.notFound('Candidate');
    if (!job) throw E.validation({ job_id: 'Choose a job.' });
    if (job.status === 'closed') throw new AppError('JOB_CLOSED', 'This job is closed.', 409);
    const existing = await trx('applications').where({ organization_id: ctx.organizationId, job_id: jobId, candidate_id: candidateId }).first('id');
    if (existing) throw new AppError('ALREADY_APPLIED', 'This candidate is already in this job pipeline.', 409);
    const [id] = await trx('applications').insert({ organization_id: ctx.organizationId, job_id: jobId, candidate_id: candidateId, cover_note: coverNote ? String(coverNote).slice(0, 5000) : null });
    await event(trx, ctx, id, 'stage', { to: 'applied', source: source || c.source });
    await audit.record(ctx, 'application.created', { entityType: 'application', entityId: id, newValues: { name: `${c.first_name} ${c.last_name}`, job: job.title } }, trx);
    await notifications.notify(ctx.organizationId, (await recruitersToNotify(ctx.organizationId, job, trx)).filter((u) => u !== ctx.userId), 'candidate_applied',
      { name: `${c.first_name} ${c.last_name}`, job: job.title }, `/app/recruitment/applications/${id}`, trx);
    return id;
  });
}

function appBase(organizationId) {
  return knex('applications as a').join('candidates as c', 'c.id', 'a.candidate_id').join('jobs as j', 'j.id', 'a.job_id')
    .where('a.organization_id', organizationId)
    .select('a.*', 'c.first_name', 'c.last_name', 'c.email', 'c.phone', 'c.current_title', 'c.experience_years', 'c.cv_name', 'c.source as candidate_source',
      'j.title as job_title', 'j.status as job_status', 'j.department_id', 'j.location_id', 'j.employment_type', 'j.work_mode', 'j.salary_currency');
}

async function pipeline(ctx, jobId) {
  const rows = await appBase(ctx.organizationId).where('a.job_id', jobId)
    .select(knex('interviews').count('*').where('application_id', knex.ref('a.id')).where('status', 'scheduled').as('upcoming_interviews'))
    .orderBy('a.stage_changed_at', 'desc');
  return rows.map((r) => ({ ...r, upcoming_interviews: Number(r.upcoming_interviews) }));
}

async function getApplication(ctx, id) {
  const app = await appBase(ctx.organizationId).where('a.id', id).first();
  if (!app) throw E.notFound('Application');
  const [events, interviews, assessments] = await Promise.all([
    knex('application_events as e').leftJoin('users as u', 'u.id', 'e.user_id').where({ 'e.application_id': id, 'e.organization_id': ctx.organizationId })
      .select('e.*', 'u.name as user_name').orderBy('e.id', 'desc'),
    knex('interviews as i').leftJoin('users as u', 'u.id', 'i.interviewer_user_id').where({ 'i.application_id': id, 'i.organization_id': ctx.organizationId })
      .select('i.*', 'u.name as interviewer_name').orderBy('i.scheduled_at'),
    knex('assessments as s').leftJoin('users as u', 'u.id', 's.created_by').where({ 's.application_id': id, 's.organization_id': ctx.organizationId })
      .select('s.*', 'u.name as created_by_name').orderBy('s.id'),
  ]);
  app.events = events.map((e) => ({ ...e, data: parseJson(e.data, {}) }));
  app.interviews = interviews;
  app.assessments = assessments;
  return app;
}

async function moveStage(ctx, id, stage, { reason } = {}) {
  if (!STAGES.includes(stage)) throw E.validation({ stage: 'Invalid stage.' });
  if (stage === 'hired') throw new AppError('USE_HIRE', 'Use "Hire" to create the employee record.', 409);
  await ent.assertCanWrite(ctx.organizationId);
  await knex.transaction(async (trx) => {
    const app = await trx('applications').where({ id, organization_id: ctx.organizationId }).forUpdate().first();
    if (!app) throw E.notFound('Application');
    if (app.stage === 'hired') throw new AppError('ALREADY_HIRED', 'This candidate has already been hired.', 409);
    if (app.stage === stage) return;
    await trx('applications').where({ id }).update({ stage, stage_changed_at: new Date(), rejection_reason: stage === 'rejected' ? (reason ? String(reason).slice(0, 255) : null) : null });
    await event(trx, ctx, id, 'stage', { from: app.stage, to: stage, reason: stage === 'rejected' ? reason || null : undefined });
    await audit.record(ctx, 'application.stage_changed', { entityType: 'application', entityId: id, oldValues: { stage: app.stage }, newValues: { stage } }, trx);
  });
}

async function addNote(ctx, id, text) {
  const body = String(text || '').trim();
  if (!body) throw E.validation({ note: 'Write a note.' });
  const app = await knex('applications').where({ id, organization_id: ctx.organizationId }).first('id');
  if (!app) throw E.notFound('Application');
  await event(knex, ctx, id, 'note', { text: body.slice(0, 5000) });
}

async function rate(ctx, id, rating) {
  const value = Number(rating);
  if (!Number.isInteger(value) || value < 1 || value > 5) throw E.validation({ rating: 'Choose 1 to 5.' });
  const n = await knex('applications').where({ id, organization_id: ctx.organizationId }).update({ rating: value });
  if (!n) throw E.notFound('Application');
  await event(knex, ctx, id, 'rating', { rating: value });
}

// ---------- Interviews & assessments ----------
const interviewSchema = z.object({
  scheduled_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Choose a date and time.'),
  duration_minutes: z.preprocess(emptyToUndefined, z.coerce.number().int().min(10).max(480).default(45)),
  mode: z.enum(['video', 'onsite', 'phone']).default('video'),
  location: optionalString(255),
  interviewer_user_id: optionalId(),
});

async function scheduleInterview(ctx, applicationId, input) {
  await ent.assertCanWrite(ctx.organizationId);
  const data = validate(interviewSchema, input);
  const app = await appBase(ctx.organizationId).where('a.id', applicationId).first();
  if (!app) throw E.notFound('Application');
  if (data.interviewer_user_id && !(await knex('memberships').where({ organization_id: ctx.organizationId, user_id: data.interviewer_user_id, status: 'active' }).first('id'))) {
    throw E.validation({ interviewer_user_id: 'Choose a member of this workspace.' });
  }
  const org = await orgs.get(ctx.organizationId);
  const { zonedToUtc } = require('../attendance/attendance.service');
  const at = zonedToUtc(data.scheduled_at.slice(0, 10), data.scheduled_at.slice(11, 16), org.timezone);
  return knex.transaction(async (trx) => {
    const [id] = await trx('interviews').insert({
      organization_id: ctx.organizationId, application_id: applicationId, scheduled_at: at, duration_minutes: data.duration_minutes, mode: data.mode,
      location: data.location ?? null, interviewer_user_id: data.interviewer_user_id ?? null, created_by: ctx.userId,
    });
    await event(trx, ctx, applicationId, 'interview', { at: at.toISOString(), mode: data.mode });
    if (app.stage === 'applied' || app.stage === 'screening' || app.stage === 'shortlisted') {
      await trx('applications').where({ id: applicationId }).update({ stage: 'interview', stage_changed_at: new Date() });
      await event(trx, ctx, applicationId, 'stage', { from: app.stage, to: 'interview' });
    }
    if (data.interviewer_user_id && data.interviewer_user_id !== ctx.userId) {
      await notifications.notify(ctx.organizationId, [data.interviewer_user_id], 'interview_assigned',
        { name: `${app.first_name} ${app.last_name}`, job: app.job_title }, `/app/recruitment/interviews/${id}`, trx);
    }
    return id;
  });
}

async function getInterview(ctx, id) {
  const iv = await knex('interviews as i').join('applications as a', 'a.id', 'i.application_id').join('candidates as c', 'c.id', 'a.candidate_id')
    .join('jobs as j', 'j.id', 'a.job_id').leftJoin('users as u', 'u.id', 'i.interviewer_user_id')
    .where({ 'i.id': id, 'i.organization_id': ctx.organizationId })
    .first('i.*', 'a.candidate_id', 'c.first_name', 'c.last_name', 'c.current_title', 'c.cv_name', 'j.title as job_title', 'u.name as interviewer_name');
  if (!iv) throw E.notFound('Interview');
  // Interviewers who are not recruiters can only open their own interviews.
  if (!ctx.permissions.has('recruitment.view') && iv.interviewer_user_id !== ctx.userId) throw E.notFound('Interview');
  return iv;
}

async function submitFeedback(ctx, id, input) {
  const iv = await getInterview(ctx, id);
  if (!ctx.permissions.has('recruitment.manage') && iv.interviewer_user_id !== ctx.userId) throw E.forbidden('recruitment.manage');
  const rec = ['strong_yes', 'yes', 'no', 'strong_no'].includes(input.recommendation) ? input.recommendation : null;
  const rating = Number(input.rating);
  const feedback = String(input.feedback || '').trim();
  if (!rec || !feedback) throw E.validation({ feedback: 'Add your recommendation and feedback.' });
  await knex.transaction(async (trx) => {
    await trx('interviews').where({ id }).update({ status: 'completed', recommendation: rec, rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null, feedback: feedback.slice(0, 10000) });
    await event(trx, ctx, iv.application_id, 'feedback', { interview_id: id, recommendation: rec });
    await audit.record(ctx, 'interview.feedback', { entityType: 'interview', entityId: id, newValues: { recommendation: rec } }, trx);
  });
}

async function cancelInterview(ctx, id) {
  const iv = await getInterview(ctx, id);
  if (!ctx.permissions.has('recruitment.manage')) throw E.forbidden('recruitment.manage');
  await knex('interviews').where({ id, organization_id: ctx.organizationId }).update({ status: 'cancelled' });
  await event(knex, ctx, iv.application_id, 'interview_cancelled', { interview_id: id });
}

async function listInterviews(ctx, { mine = false, upcoming = true } = {}) {
  const q = knex('interviews as i').join('applications as a', 'a.id', 'i.application_id').join('candidates as c', 'c.id', 'a.candidate_id')
    .join('jobs as j', 'j.id', 'a.job_id').leftJoin('users as u', 'u.id', 'i.interviewer_user_id').where('i.organization_id', ctx.organizationId)
    .select('i.*', 'c.first_name', 'c.last_name', 'j.title as job_title', 'u.name as interviewer_name');
  if (mine || !ctx.permissions.has('recruitment.view')) q.where('i.interviewer_user_id', ctx.userId);
  if (upcoming) q.where('i.status', 'scheduled').where('i.scheduled_at', '>=', new Date(Date.now() - 3 * 3600_000)).orderBy('i.scheduled_at');
  else q.orderBy('i.scheduled_at', 'desc');
  return q.limit(200);
}

async function addAssessment(ctx, applicationId, input) {
  const title = String(input.title || '').trim();
  if (!title) throw E.validation({ title: 'Title is required.' });
  const num = (v) => (v === '' || v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v));
  const app = await knex('applications').where({ id: applicationId, organization_id: ctx.organizationId }).first();
  if (!app) throw E.notFound('Application');
  await knex.transaction(async (trx) => {
    await trx('assessments').insert({
      organization_id: ctx.organizationId, application_id: applicationId, title: title.slice(0, 150), score: num(input.score), max_score: num(input.max_score),
      notes: input.notes ? String(input.notes).slice(0, 1000) : null, created_by: ctx.userId,
    });
    await event(trx, ctx, applicationId, 'assessment', { title, score: num(input.score), max_score: num(input.max_score) });
  });
}

// ---------- Hire ----------
/**
 * Creates the employee from the candidate (seat limit enforced by the employee service),
 * marks the application hired and optionally starts onboarding.
 */
async function hire(ctx, applicationId, input) {
  await ent.assertCanWrite(ctx.organizationId);
  if (!ctx.permissions.has('employees.create')) throw E.forbidden('employees.create');
  const app = await appBase(ctx.organizationId).where('a.id', applicationId).first();
  if (!app) throw E.notFound('Application');
  if (app.stage === 'hired') throw new AppError('ALREADY_HIRED', 'This candidate has already been hired.', 409);
  const org = await orgs.get(ctx.organizationId);
  const joining = isDateStr(input.joining_date) ? input.joining_date : todayIn(org.timezone);
  const employee = await employees.create(ctx, {
    first_name: app.first_name, last_name: app.last_name, email: app.email, phone: app.phone || undefined, job_title: input.job_title || app.job_title,
    department_id: app.department_id || undefined, location_id: app.location_id || undefined, manager_id: input.manager_id || undefined,
    employment_type: app.employment_type, work_mode: app.work_mode, status: 'probation', joining_date: joining, base_salary: input.base_salary,
  });
  await knex.transaction(async (trx) => {
    await trx('applications').where({ id: applicationId }).update({ stage: 'hired', stage_changed_at: new Date(), hired_employee_id: employee.id });
    await event(trx, ctx, applicationId, 'hired', { employee_id: employee.id, joining_date: joining });
    await audit.record(ctx, 'application.hired', { entityType: 'application', entityId: applicationId, newValues: { name: employee.full_name, employee_id: employee.id } }, trx);
    // Close the job automatically once all openings are filled.
    const job = await trx('jobs').where({ id: app.job_id }).first();
    const [{ hiredCount }] = await trx('applications').where({ job_id: app.job_id, stage: 'hired' }).count({ hiredCount: '*' });
    if (job.status === 'open' && Number(hiredCount) >= job.openings) await trx('jobs').where({ id: job.id }).update({ status: 'closed', closed_at: new Date() });
  });
  let planId = null;
  if (input.start_onboarding !== false && input.start_onboarding !== 'off' && (await ent.hasFeature(ctx.organizationId, 'onboarding'))) {
    const onboarding = require('../onboarding/onboarding.service');
    planId = await onboarding.startPlan(ctx, employee.id, { start_date: joining });
  }
  return { employeeId: employee.id, planId };
}

// ---------- Public careers page ----------
async function publicOrg(slug) {
  const org = await knex('organizations').where({ slug: String(slug), status: 'active' }).first('id', 'name', 'slug', 'locale', 'logo_url', 'currency', 'timezone');
  if (!org) return null;
  const settings = await orgs.getSettings(org.id);
  if (!settings.careers_enabled) return null;
  if (!(await ent.hasFeature(org.id, 'recruitment'))) return null;
  return { ...org, intro: settings.careers_intro || '' };
}

async function publicJobs(organizationId) {
  const rows = await jobBase(organizationId).where('j.status', 'open').orderBy('j.published_at', 'desc');
  return rows.map((j) => ({ ...j, skills: parseJson(j.skills, []) }));
}

async function publicJob(organizationId, slug) {
  const job = await jobBase(organizationId).where({ 'j.slug': String(slug), 'j.status': 'open' }).first();
  if (!job) return null;
  job.skills = parseJson(job.skills, []);
  return job;
}

const applySchema = z.object({
  first_name: z.string().trim().min(1, 'First name is required.').max(80),
  last_name: z.string().trim().min(1, 'Last name is required.').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(190),
  phone: optionalString(40),
  city: optionalString(100),
  linkedin_url: z.preprocess(emptyToUndefined, z.string().trim().url('Enter a valid URL.').max(255).refine((u) => /^https?:\/\//i.test(u), 'Enter a valid URL.').optional()),
  cover_note: optionalString(5000),
  consent: z.literal('on', { message: 'Please accept the privacy notice.' }),
});

/** A candidate applies from the public careers page. Re-applying updates their profile. */
async function publicApply(org, job, input, file) {
  const data = validate(applySchema, input);
  if (!file) throw E.validation({ file: 'Attach your CV (PDF or Word).' });
  const ctx = { organizationId: org.id, userId: null };
  const canWrite = (await ent.getEntitlements(org.id)).canWrite;
  if (!canWrite) throw new AppError('JOB_CLOSED', 'Applications are not accepted at the moment.', 409);
  const cv = await storeCv(org.id, file);
  try {
    let candidate = await knex('candidates').where({ organization_id: org.id, email: data.email }).first();
    const profile = { first_name: data.first_name, last_name: data.last_name, phone: data.phone ?? null, city: data.city ?? null, linkedin_url: data.linkedin_url ?? null, consent: true };
    if (candidate) {
      await knex('candidates').where({ id: candidate.id }).update({ ...profile, ...cv });
      if (candidate.cv_storage_key) await storage.remove(candidate.cv_storage_key);
    } else {
      const [id] = await knex('candidates').insert({ ...profile, ...cv, email: data.email, organization_id: org.id, source: 'careers', skills: JSON.stringify([]) });
      candidate = { id };
    }
    return await addToJob(ctx, candidate.id, job.id, { coverNote: data.cover_note, source: 'careers' });
  } catch (err) {
    if (err.code === 'ALREADY_APPLIED') return null; // idempotent for the applicant; CV already refreshed
    throw err;
  }
}

async function summary(organizationId) {
  const [[{ open }], [{ fresh }], [{ interviews }]] = await Promise.all([
    knex('jobs').where({ organization_id: organizationId, status: 'open' }).count({ open: '*' }),
    knex('applications').where({ organization_id: organizationId }).where('created_at', '>=', new Date(Date.now() - 7 * 86_400_000)).count({ fresh: '*' }),
    knex('interviews').where({ organization_id: organizationId, status: 'scheduled' }).where('scheduled_at', '>=', new Date()).count({ interviews: '*' }),
  ]);
  return { openJobs: Number(open), newApplications: Number(fresh), upcomingInterviews: Number(interviews) };
}

module.exports = {
  STAGES, PIPELINE, SOURCES, saveJob, setJobStatus, listJobs, getJob, saveCandidate, listCandidates, getCandidate, openCv, deleteCandidate,
  addToJob, pipeline, getApplication, moveStage, addNote, rate, scheduleInterview, getInterview, submitFeedback, cancelInterview, listInterviews,
  addAssessment, hire, publicOrg, publicJobs, publicJob, publicApply, summary,
};
