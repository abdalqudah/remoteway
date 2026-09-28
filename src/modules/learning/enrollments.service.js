// Enrollments: self-enrolment and assignments, lesson progress, quizzes, completion and certificates.
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const storage = require('../../core/storage');
const { E, AppError } = require('../../core/errors');
const { todayIn, isDateStr, addDays } = require('../../core/workdays');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');
const employees = require('../workforce/employee.service');
const notifications = require('../notifications/notification.service');
const { canManage, parseJson } = require('./courses.service');

const dstr = (v) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);

/** Employee ids this user may assign training to and follow (null = everyone). */
async function scopeIds(ctx) {
  if (canManage(ctx)) return null;
  const self = await employees.linkedEmployeeId(ctx);
  if (!self || !ctx.permissions.has('team.view')) return [];
  return employees.reportIds(ctx.organizationId, self);
}

async function me(ctx) {
  const id = await employees.linkedEmployeeId(ctx);
  if (!id) throw new AppError('EMPLOYEE_RECORD_REQUIRED', 'Your account is not linked to an employee record.', 409);
  return id;
}

function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

// ---------- Enrolling ----------
async function enrollSelf(ctx, courseId) {
  await ent.assertFeature(ctx.organizationId, 'learning');
  await ent.assertCanWrite(ctx.organizationId);
  const employeeId = await me(ctx);
  const course = await knex('courses').where({ id: courseId, organization_id: ctx.organizationId, status: 'published' }).first();
  if (!course) throw E.notFound('Course');
  if (!course.self_enroll) throw new AppError('ENROLL_BY_ASSIGNMENT', 'This course is assigned by your company.', 409);
  const existing = await knex('enrollments').where({ course_id: courseId, employee_id: employeeId }).first('id');
  if (existing) return existing.id;
  const [id] = await knex('enrollments').insert({ organization_id: ctx.organizationId, course_id: courseId, employee_id: employeeId, source: 'self' });
  return id;
}

/** Resolves target employees from explicit ids and/or departments, limited to what the assigner may manage. */
async function targets(ctx, input) {
  const scope = await scopeIds(ctx);
  if (scope !== null && !scope.length) throw E.forbidden('learning.manage');
  const ids = [].concat(input.employee_ids ?? []).map(Number).filter(Boolean);
  const depts = [].concat(input.department_ids ?? []).map(Number).filter(Boolean);
  const q = knex('employees').where({ organization_id: ctx.organizationId }).whereNot('status', 'terminated').select('id', 'user_id', 'first_name', 'last_name');
  q.where((w) => { if (ids.length) w.orWhereIn('id', ids); if (depts.length) w.orWhereIn('department_id', depts); if (input.everyone === 'on') w.orWhereNotNull('id'); });
  if (!ids.length && !depts.length && input.everyone !== 'on') throw E.validation({ employee_ids: 'Choose who should take it.' });
  let rows = await q;
  if (scope !== null) rows = rows.filter((r) => scope.includes(r.id));
  if (!rows.length) throw E.validation({ employee_ids: 'Choose who should take it.' });
  return rows;
}

async function assignCourse(ctx, courseId, input, { trx: outer, source = 'assigned', people } = {}) {
  await ent.assertFeature(ctx.organizationId, 'learning');
  await ent.assertCanWrite(ctx.organizationId);
  const course = await knex('courses').where({ id: courseId, organization_id: ctx.organizationId, status: 'published' }).first();
  if (!course) throw E.validation({ course_id: 'Choose a published course.' });
  const due = input.due_date && isDateStr(input.due_date) ? input.due_date : null;
  const list = people || (await targets(ctx, input));
  let created = 0;
  const run = async (trx) => {
    for (const p of list) {
      const existing = await trx('enrollments').where({ course_id: courseId, employee_id: p.id }).first();
      if (existing) {
        // Re-assigning sets the due date (and upgrades a self-enrolment to an assignment).
        if (existing.status !== 'completed') await trx('enrollments').where({ id: existing.id }).update({ due_date: due || existing.due_date, source: existing.source === 'self' ? source : existing.source, assigned_by: ctx.userId });
        continue;
      }
      await trx('enrollments').insert({ organization_id: ctx.organizationId, course_id: courseId, employee_id: p.id, source, due_date: due, assigned_by: ctx.userId });
      created += 1;
      if (source === 'assigned' && p.user_id && p.user_id !== ctx.userId) {
        await notifications.notify(ctx.organizationId, [p.user_id], 'course_assigned', { title: course.title }, `/app/learning/courses/${courseId}`, trx);
      }
    }
  };
  if (outer) await run(outer); else await knex.transaction(run);
  await audit.record(ctx, 'course.assigned', { entityType: 'course', entityId: courseId, newValues: { name: course.title, people: list.length } });
  return created;
}

async function assignPath(ctx, pathId, input) {
  const path = await knex('learning_paths').where({ id: pathId, organization_id: ctx.organizationId, status: 'published' }).first();
  if (!path) throw E.validation({ path_id: 'Choose a published learning path.' });
  const people = await targets(ctx, input);
  const courses = await knex('learning_path_courses as pc').join('courses as c', 'c.id', 'pc.course_id').where({ 'pc.path_id': pathId, 'c.status': 'published' }).orderBy('pc.sort_order').select('c.id');
  const due = input.due_date && isDateStr(input.due_date) ? input.due_date : null;
  await knex.transaction(async (trx) => {
    for (const p of people) {
      await trx('path_assignments').insert({ organization_id: ctx.organizationId, path_id: pathId, employee_id: p.id, due_date: due, assigned_by: ctx.userId })
        .onConflict(['path_id', 'employee_id']).merge({ due_date: due, updated_at: new Date() });
      if (p.user_id && p.user_id !== ctx.userId) await notifications.notify(ctx.organizationId, [p.user_id], 'path_assigned', { title: path.title }, `/app/learning/paths/${pathId}`, trx);
    }
    for (const c of courses) await assignCourse(ctx, c.id, { due_date: due }, { trx, source: 'path', people });
  });
  return people.length;
}

// ---------- Learning ----------
/** The learner's enrollment in a course, with lesson progress; managers may view someone else's by employee id. */
async function enrollmentFor(ctx, courseId, employeeId = null) {
  const target = employeeId || (await employees.linkedEmployeeId(ctx));
  if (!target) return null;
  if (employeeId) {
    const scope = await scopeIds(ctx);
    const self = await employees.linkedEmployeeId(ctx);
    if (employeeId !== self && scope !== null && !scope.includes(employeeId)) throw E.notFound('Enrollment');
  }
  const e = await knex('enrollments').where({ organization_id: ctx.organizationId, course_id: courseId, employee_id: target }).first();
  if (!e) return null;
  e.lessons = await knex('lesson_progress').where({ enrollment_id: e.id });
  e.progress = Number(e.progress);
  return e;
}

async function recompute(trx, enrollmentId, ctx) {
  const e = await trx('enrollments').where({ id: enrollmentId }).first();
  const course = await trx('courses').where({ id: e.course_id }).first();
  const lessons = await trx('course_lessons').where({ course_id: e.course_id }).select('id', 'kind');
  const done = await trx('lesson_progress').where({ enrollment_id: enrollmentId }).whereNotNull('completed_at');
  const doneIds = new Set(done.map((d) => d.lesson_id));
  const completedCount = lessons.filter((l) => doneIds.has(l.id)).length;
  const progress = lessons.length ? Math.round((completedCount / lessons.length) * 10000) / 100 : 0;
  const quizScores = done.filter((d) => d.score !== null && lessons.some((l) => l.id === d.lesson_id && l.kind === 'quiz')).map((d) => Number(d.score));
  const score = quizScores.length ? Math.round((quizScores.reduce((a, b) => a + b, 0) / quizScores.length) * 100) / 100 : null;
  const finished = lessons.length > 0 && completedCount === lessons.length;
  const patch = { progress, score, status: finished ? 'completed' : (completedCount || e.started_at ? 'in_progress' : 'not_started') };
  if (!e.started_at) patch.started_at = new Date();
  let certificate = null;
  if (finished && e.status !== 'completed') {
    patch.completed_at = new Date();
    if (course.certificate_enabled) {
      const org = await orgs.get(e.organization_id);
      const person = await trx('employees').where({ id: e.employee_id }).first('first_name', 'last_name', 'user_id');
      const today = todayIn(org.timezone);
      const code = `RW-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      const [certId] = await trx('certificates').insert({
        organization_id: e.organization_id, enrollment_id: e.id, employee_id: e.employee_id, course_id: e.course_id, code,
        employee_name: `${person.first_name} ${person.last_name}`, course_title: course.title, score, issued_on: today,
        expires_on: course.validity_months ? addMonths(today, course.validity_months) : null,
      });
      certificate = certId;
      if (person.user_id) await notifications.notify(e.organization_id, [person.user_id], 'certificate_issued', { title: course.title }, `/app/learning/certificates/${certId}`, trx);
    }
    await audit.record(ctx, 'course.completed', { entityType: 'course', entityId: course.id, newValues: { name: course.title, score } }, trx);
  }
  await trx('enrollments').where({ id: enrollmentId }).update(patch);
  return { progress, finished, certificate };
}

async function loadLesson(ctx, courseId, lessonId) {
  const lesson = await knex('course_lessons').where({ id: lessonId, course_id: courseId, organization_id: ctx.organizationId }).first();
  if (!lesson) throw E.notFound('Lesson');
  const enrollment = await enrollmentFor(ctx, courseId);
  if (!enrollment && !canManage(ctx)) throw new AppError('NOT_ENROLLED', 'Enrol in the course to open its lessons.', 409);
  return { lesson, enrollment };
}

async function completeLesson(ctx, courseId, lessonId) {
  await ent.assertCanWrite(ctx.organizationId);
  const { lesson, enrollment } = await loadLesson(ctx, courseId, lessonId);
  if (!enrollment) throw new AppError('NOT_ENROLLED', 'Enrol in the course to open its lessons.', 409);
  if (lesson.kind === 'quiz') throw new AppError('QUIZ_REQUIRED', 'Pass the quiz to complete this lesson.', 409);
  return knex.transaction(async (trx) => {
    await trx('lesson_progress').insert({ organization_id: ctx.organizationId, enrollment_id: enrollment.id, lesson_id: lesson.id, completed_at: new Date() })
      .onConflict(['enrollment_id', 'lesson_id']).merge({ completed_at: knex.raw('COALESCE(completed_at, NOW())'), updated_at: new Date() });
    return recompute(trx, enrollment.id, ctx);
  });
}

/** Scores a quiz. Passing (course passing score) completes the lesson; the best score is kept. */
async function submitQuiz(ctx, courseId, lessonId, answers) {
  await ent.assertCanWrite(ctx.organizationId);
  const { lesson, enrollment } = await loadLesson(ctx, courseId, lessonId);
  if (!enrollment) throw new AppError('NOT_ENROLLED', 'Enrol in the course to open its lessons.', 409);
  if (lesson.kind !== 'quiz') throw E.notFound('Quiz');
  const course = await knex('courses').where({ id: courseId }).first('passing_score');
  const questions = await knex('lesson_questions').where({ lesson_id: lessonId }).orderBy('sort_order');
  if (!questions.length) throw E.notFound('Quiz');
  const results = questions.map((q) => {
    const given = answers[`q_${q.id}`];
    return { id: q.id, given: given === undefined || given === '' ? null : Number(given), correct: q.correct_index, ok: given !== undefined && given !== '' && Number(given) === q.correct_index };
  });
  if (results.some((r) => r.given === null)) throw E.validation({ answers: 'Answer every question.' });
  const score = Math.round((results.filter((r) => r.ok).length / results.length) * 10000) / 100;
  const passed = score >= course.passing_score;
  const outcome = await knex.transaction(async (trx) => {
    const prev = await trx('lesson_progress').where({ enrollment_id: enrollment.id, lesson_id: lessonId }).first();
    const best = prev && prev.score !== null ? Math.max(Number(prev.score), score) : score;
    const row = { score: best, attempts: (prev?.attempts || 0) + 1, completed_at: prev?.completed_at || (passed ? new Date() : null), updated_at: new Date() };
    if (prev) await trx('lesson_progress').where({ id: prev.id }).update(row);
    else await trx('lesson_progress').insert({ ...row, organization_id: ctx.organizationId, enrollment_id: enrollment.id, lesson_id: lessonId });
    return recompute(trx, enrollment.id, ctx);
  });
  return { score, passed, passing: course.passing_score, results, ...outcome };
}

/** Starts a completed course again (e.g. to renew an expiring certificate). Past certificates are kept. */
async function restart(ctx, courseId) {
  const enrollment = await enrollmentFor(ctx, courseId);
  if (!enrollment) throw E.notFound('Enrollment');
  if (enrollment.status !== 'completed') return;
  await knex.transaction(async (trx) => {
    await trx('lesson_progress').where({ enrollment_id: enrollment.id }).del();
    await trx('enrollments').where({ id: enrollment.id }).update({ status: 'not_started', progress: 0, score: null, started_at: null, completed_at: null });
  });
}

async function openLessonFile(ctx, courseId, lessonId) {
  const { lesson } = await loadLesson(ctx, courseId, lessonId);
  if (lesson.kind !== 'file' || !lesson.file_storage_key || !(await storage.exists(lesson.file_storage_key))) throw E.notFound('File');
  return { stream: storage.createReadStream(lesson.file_storage_key), name: lesson.file_name, mime: lesson.file_mime, inline: lesson.file_mime === 'application/pdf' || /^image\//.test(lesson.file_mime) };
}

// ---------- Views ----------
function enrollmentBase(organizationId) {
  return knex('enrollments as e').join('courses as c', 'c.id', 'e.course_id').join('employees as p', 'p.id', 'e.employee_id')
    .leftJoin('departments as d', 'd.id', 'p.department_id')
    .where('e.organization_id', organizationId)
    .select('e.*', 'c.title as course_title', 'c.is_mandatory', 'c.category', 'c.level', 'p.first_name', 'p.last_name', 'p.job_title', 'd.name as department_name',
      knex('course_lessons').count('*').where('course_id', knex.ref('c.id')).as('lesson_count'),
      knex('course_lessons').sum('duration_minutes').where('course_id', knex.ref('c.id')).as('minutes'));
}

async function myLearning(ctx) {
  const self = await employees.linkedEmployeeId(ctx);
  if (!self) return { enrollments: [], certificates: [], paths: [] };
  const [enrollments, certificates, paths] = await Promise.all([
    enrollmentBase(ctx.organizationId).where('e.employee_id', self).orderByRaw("FIELD(e.status, 'in_progress', 'not_started', 'completed')").orderBy('e.due_date'),
    knex('certificates').where({ organization_id: ctx.organizationId, employee_id: self }).whereNull('revoked_at').orderBy('issued_on', 'desc'),
    pathProgress(ctx, self),
  ]);
  return { enrollments: enrollments.map(normalize), certificates, paths };
}

const normalize = (e) => ({ ...e, progress: Number(e.progress), lesson_count: Number(e.lesson_count), minutes: Number(e.minutes || 0) });

async function pathProgress(ctx, employeeId) {
  const assigned = await knex('path_assignments as a').join('learning_paths as p', 'p.id', 'a.path_id').where({ 'a.organization_id': ctx.organizationId, 'a.employee_id': employeeId })
    .select('a.*', 'p.title');
  for (const a of assigned) {
    const courses = await knex('learning_path_courses as pc').join('courses as c', 'c.id', 'pc.course_id').leftJoin('enrollments as e', function j() { this.on('e.course_id', 'c.id').andOn('e.employee_id', knex.raw('?', [employeeId])); })
      .where('pc.path_id', a.path_id).orderBy('pc.sort_order').select('c.id', 'c.title', 'e.status', 'e.progress');
    a.courses = courses;
    a.done = courses.filter((c) => c.status === 'completed').length;
    a.progress = courses.length ? Math.round((a.done / courses.length) * 100) : 0;
  }
  return assigned;
}

async function report(ctx, { course_id: courseId, department_id: departmentId, status, overdue } = {}) {
  const scope = await scopeIds(ctx);
  if (scope !== null && !scope.length) throw E.forbidden('learning.manage');
  const q = enrollmentBase(ctx.organizationId).orderBy('p.first_name').orderBy('c.title').limit(1000);
  if (scope !== null) q.whereIn('e.employee_id', scope);
  if (courseId) q.where('e.course_id', Number(courseId));
  if (departmentId) q.where('p.department_id', Number(departmentId));
  if (['not_started', 'in_progress', 'completed'].includes(status)) q.where('e.status', status);
  const org = await orgs.get(ctx.organizationId);
  const today = todayIn(org.timezone);
  if (overdue === '1') q.whereNot('e.status', 'completed').whereNotNull('e.due_date').where('e.due_date', '<', today);
  return (await q).map((e) => ({ ...normalize(e), overdue: e.status !== 'completed' && e.due_date && dstr(e.due_date) < today }));
}

async function summary(ctx) {
  const scope = await scopeIds(ctx);
  const org = await orgs.get(ctx.organizationId);
  const today = todayIn(org.timezone);
  const base = () => { const q = knex('enrollments').where({ organization_id: ctx.organizationId }); if (scope !== null) q.whereIn('employee_id', scope.length ? scope : [-1]); return q; };
  const [[{ total }], [{ completed }], [{ overdue }], [{ expiring }]] = await Promise.all([
    base().count({ total: '*' }), base().where('status', 'completed').count({ completed: '*' }),
    base().whereNot('status', 'completed').whereNotNull('due_date').where('due_date', '<', today).count({ overdue: '*' }),
    knex('certificates').where({ organization_id: ctx.organizationId }).whereNull('revoked_at').whereNotNull('expires_on').whereBetween('expires_on', [today, addDays(today, 30)])
      .modify((q) => { if (scope !== null) q.whereIn('employee_id', scope.length ? scope : [-1]); }).count({ expiring: '*' }),
  ]);
  return { total: Number(total), completed: Number(completed), overdue: Number(overdue), expiring: Number(expiring), rate: Number(total) ? Math.round((Number(completed) / Number(total)) * 100) : 0 };
}

async function myDue(ctx) {
  const self = await employees.linkedEmployeeId(ctx);
  if (!self) return [];
  return enrollmentBase(ctx.organizationId).where('e.employee_id', self).whereNot('e.status', 'completed').whereNot('e.source', 'self').orderBy('e.due_date').limit(5);
}

// ---------- Certificates ----------
async function getCertificate(ctx, id) {
  const cert = await knex('certificates').where({ id, organization_id: ctx.organizationId }).first();
  if (!cert) throw E.notFound('Certificate');
  const self = await employees.linkedEmployeeId(ctx);
  const scope = await scopeIds(ctx);
  if (cert.employee_id !== self && scope !== null && !scope.includes(cert.employee_id)) throw E.notFound('Certificate');
  return cert;
}

/** Public verification by code (shows only the name, course and dates). */
async function verify(code) {
  const cert = await knex('certificates as c').join('organizations as o', 'o.id', 'c.organization_id')
    .where('c.code', String(code || '').toUpperCase().slice(0, 24)).first('c.code', 'c.employee_name', 'c.course_title', 'c.issued_on', 'c.expires_on', 'c.revoked_at', 'o.name as organization_name', 'o.timezone');
  if (!cert) return null;
  const today = todayIn(cert.timezone);
  cert.state = cert.revoked_at ? 'revoked' : cert.expires_on && dstr(cert.expires_on) < today ? 'expired' : 'valid';
  return cert;
}

/** One employee's enrollments, if the viewer is that employee, their manager, or runs learning. Null otherwise. */
async function forEmployee(ctx, employeeId) {
  const self = await employees.linkedEmployeeId(ctx);
  const scope = await scopeIds(ctx);
  if (employeeId !== self && scope !== null && !scope.includes(employeeId)) return null;
  const org = await orgs.get(ctx.organizationId);
  const today = todayIn(org.timezone);
  const rows = await enrollmentBase(ctx.organizationId).where('e.employee_id', employeeId).orderByRaw("FIELD(e.status, 'in_progress', 'not_started', 'completed')");
  return rows.map((e) => ({ ...normalize(e), overdue: e.status !== 'completed' && e.due_date && dstr(e.due_date) < today }));
}

async function certificatesForEmployee(ctx, employeeId) {
  return knex('certificates').where({ organization_id: ctx.organizationId, employee_id: employeeId }).whereNull('revoked_at').orderBy('issued_on', 'desc');
}

module.exports = {
  scopeIds, enrollSelf, assignCourse, assignPath, enrollmentFor, completeLesson, submitQuiz, restart, openLessonFile, loadLesson,
  myLearning, pathProgress, report, summary, myDue, getCertificate, verify, certificatesForEmployee, forEmployee, addMonths, parseJson,
};
