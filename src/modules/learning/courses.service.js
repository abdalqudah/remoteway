// Courses, lessons (text, video, file, link, quiz) and learning paths.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const storage = require('../../core/storage');
const { E, AppError } = require('../../core/errors');
const ent = require('../billing/entitlements.service');
const documents = require('../documents/document.service');
const { videoEmbed, isHttpsUrl } = require('./content');

const LEVELS = ['beginner', 'intermediate', 'advanced'];
const KINDS = ['text', 'video', 'file', 'link', 'quiz'];
const FILE_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'webp', 'txt'];
const parseJson = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const canManage = (ctx) => ctx.permissions.has('learning.manage');

async function assertManage(ctx) {
  if (!canManage(ctx)) throw E.forbidden('learning.manage');
  await ent.assertFeature(ctx.organizationId, 'learning');
  await ent.assertCanWrite(ctx.organizationId);
}

// ---------- Courses ----------
async function listCourses(ctx, { status, q, category, forCatalog = false } = {}) {
  const query = knex('courses as c').where('c.organization_id', ctx.organizationId)
    .select('c.*',
      knex('course_lessons').count('*').where('course_id', knex.ref('c.id')).as('lesson_count'),
      knex('course_lessons').sum('duration_minutes').where('course_id', knex.ref('c.id')).as('minutes'),
      knex('enrollments').count('*').where('course_id', knex.ref('c.id')).as('enrolled'),
      knex('enrollments').count('*').where('course_id', knex.ref('c.id')).where('status', 'completed').as('completed'))
    .orderBy('c.is_mandatory', 'desc').orderBy('c.title');
  if (forCatalog || !canManage(ctx)) query.where('c.status', 'published');
  else if (['draft', 'published', 'archived'].includes(status)) query.where('c.status', status);
  else query.whereNot('c.status', 'archived');
  if (q) query.where((w) => w.where('c.title', 'like', `%${String(q).replace(/[%_]/g, '\\$&')}%`).orWhere('c.category', 'like', `%${String(q).replace(/[%_]/g, '\\$&')}%`));
  if (category) query.where('c.category', category);
  const rows = await query;
  return rows.map((c) => ({ ...c, lesson_count: Number(c.lesson_count), minutes: Number(c.minutes || 0), enrolled: Number(c.enrolled), completed: Number(c.completed) }));
}

async function categories(organizationId) {
  return (await knex('courses').where({ organization_id: organizationId }).whereNotNull('category').distinct('category').orderBy('category')).map((r) => r.category);
}

async function getCourse(ctx, id, { withQuestions = false } = {}) {
  const course = await knex('courses').where({ id, organization_id: ctx.organizationId }).first();
  if (!course) throw E.notFound('Course');
  if (course.status !== 'published' && !canManage(ctx)) {
    // Enrolled learners keep access to a course that was archived later.
    const mine = await knex('enrollments as e').join('employees as p', 'p.id', 'e.employee_id').where({ 'e.course_id': id, 'p.user_id': ctx.userId }).first('e.id');
    if (!mine || course.status === 'draft') throw E.notFound('Course');
  }
  course.lessons = await knex('course_lessons').where({ course_id: id }).orderBy(['sort_order', 'id']);
  course.minutes = course.lessons.reduce((s, l) => s + Number(l.duration_minutes || 0), 0);
  if (withQuestions) {
    const qs = await knex('lesson_questions').whereIn('lesson_id', course.lessons.map((l) => l.id)).orderBy(['lesson_id', 'sort_order']);
    for (const l of course.lessons) l.questions = qs.filter((q) => q.lesson_id === l.id).map((q) => ({ ...q, options: parseJson(q.options, []) }));
  }
  return course;
}

async function saveCourse(ctx, id, input) {
  await assertManage(ctx);
  const errors = {};
  const title = String(input.title || '').trim();
  if (!title) errors.title = 'Title is required.';
  const passing = Number(input.passing_score ?? 70);
  if (Number.isNaN(passing) || passing < 0 || passing > 100) errors.passing_score = 'Enter a percentage between 0 and 100.';
  const validity = input.validity_months === '' || input.validity_months === undefined ? null : Number(input.validity_months);
  if (validity !== null && (!Number.isInteger(validity) || validity < 1 || validity > 120)) errors.validity_months = 'Enter a number of months between 1 and 120.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const row = {
    title: title.slice(0, 200), description: input.description ? String(input.description).slice(0, 5000) : null,
    category: input.category ? String(input.category).trim().slice(0, 60) : null, level: LEVELS.includes(input.level) ? input.level : 'beginner',
    is_mandatory: input.is_mandatory === 'on' || input.is_mandatory === true, self_enroll: input.self_enroll === 'on' || input.self_enroll === true,
    passing_score: Math.round(passing), certificate_enabled: input.certificate_enabled === 'on' || input.certificate_enabled === true, validity_months: validity,
  };
  if (id) {
    const n = await knex('courses').where({ id, organization_id: ctx.organizationId }).update(row);
    if (!n) throw E.notFound('Course');
    await audit.record(ctx, 'course.updated', { entityType: 'course', entityId: id, newValues: { name: title } });
    return Number(id);
  }
  const [newId] = await knex('courses').insert({ ...row, organization_id: ctx.organizationId, status: 'draft', created_by: ctx.userId });
  await audit.record(ctx, 'course.created', { entityType: 'course', entityId: newId, newValues: { name: title } });
  return newId;
}

async function setCourseStatus(ctx, id, status) {
  await assertManage(ctx);
  if (!['draft', 'published', 'archived'].includes(status)) throw E.validation({ status: 'Invalid status.' });
  const course = await knex('courses').where({ id, organization_id: ctx.organizationId }).first();
  if (!course) throw E.notFound('Course');
  if (status === 'published') {
    const [{ n }] = await knex('course_lessons').where({ course_id: id }).count({ n: '*' });
    if (!Number(n)) throw new AppError('COURSE_EMPTY', 'Add at least one lesson before publishing.', 409);
    const emptyQuiz = await knex('course_lessons as l').where({ 'l.course_id': id, 'l.kind': 'quiz' })
      .whereNotExists(function sub() { this.select('*').from('lesson_questions as q').whereRaw('q.lesson_id = l.id'); }).first('l.id');
    if (emptyQuiz) throw new AppError('QUIZ_EMPTY', 'Every quiz needs at least one question.', 409);
  }
  await knex('courses').where({ id }).update({ status, published_at: status === 'published' ? (course.published_at || new Date()) : course.published_at });
  await audit.record(ctx, `course.${status}`, { entityType: 'course', entityId: id, newValues: { name: course.title } });
}

// ---------- Lessons ----------
function parseQuestions(input) {
  const arr = (k) => [].concat(input[k] ?? []);
  const questions = arr('q_text').map((text, i) => {
    const raw = [0, 1, 2, 3].map((j) => String(arr(`q_opt${j}`)[i] ?? '').trim());
    const chosen = Number(arr('q_correct')[i] ?? 0);
    // Blank answers are dropped; the correct answer keeps pointing at the same text (-1 if it was blank).
    const options = raw.filter(Boolean);
    const correct = raw[chosen] ? raw.slice(0, chosen).filter(Boolean).length : -1;
    return { question: String(text || '').trim(), options, correct };
  }).filter((q) => q.question);
  return questions;
}

async function saveLesson(ctx, courseId, lessonId, input, file) {
  await assertManage(ctx);
  const course = await knex('courses').where({ id: courseId, organization_id: ctx.organizationId }).first();
  if (!course) throw E.notFound('Course');
  const existing = lessonId ? await knex('course_lessons').where({ id: lessonId, course_id: courseId }).first() : null;
  if (lessonId && !existing) throw E.notFound('Lesson');
  const errors = {};
  const title = String(input.title || '').trim();
  if (!title) errors.title = 'Title is required.';
  const kind = existing ? existing.kind : (KINDS.includes(input.kind) ? input.kind : 'text');
  const duration = Math.max(1, Math.min(600, Number(input.duration_minutes) || 5));
  const row = { title: title.slice(0, 200), duration_minutes: duration, body: input.body ? String(input.body).slice(0, 60000) : null, url: null };
  if (kind === 'video') {
    if (!videoEmbed(input.url)) errors.url = 'Use a YouTube or Vimeo link.';
    row.url = String(input.url || '').trim().slice(0, 500);
  }
  if (kind === 'link') {
    if (!isHttpsUrl(input.url)) errors.url = 'Enter a secure link (https://…).';
    row.url = String(input.url || '').trim().slice(0, 500);
  }
  let stored = null;
  if (kind === 'file' && file) {
    const f = documents.checkFile(file);
    if (!FILE_EXT.includes(f.ext)) errors.file = 'This file type is not allowed (PDF, images, Word, Excel, TXT, CSV).';
    else stored = f;
  }
  if (kind === 'file' && !file && !existing?.file_storage_key) errors.file = 'Choose a file to upload.';
  let questions = [];
  if (kind === 'quiz') {
    questions = parseQuestions(input);
    if (!questions.length) errors.questions = 'Add at least one question.';
    else if (questions.some((q) => q.options.length < 2 || q.correct < 0 || q.correct >= q.options.length || !q.options[q.correct])) errors.questions = 'Each question needs at least two answers and a correct answer.';
  }
  if (Object.keys(errors).length) throw E.validation(errors);
  if (stored) {
    await documents.assertStorage(ctx.organizationId, file.size);
    const key = storage.newKey(ctx.organizationId, 'learning');
    await storage.put(key, file.buffer);
    Object.assign(row, { file_storage_key: key, file_name: stored.name, file_mime: stored.mime, file_size: file.size });
  }
  const id = await knex.transaction(async (trx) => {
    let lid = lessonId ? Number(lessonId) : null;
    if (lid) await trx('course_lessons').where({ id: lid }).update(row);
    else {
      const [{ n }] = await trx('course_lessons').where({ course_id: courseId }).count({ n: '*' });
      [lid] = await trx('course_lessons').insert({ ...row, organization_id: ctx.organizationId, course_id: courseId, kind, sort_order: Number(n) });
    }
    if (kind === 'quiz') {
      await trx('lesson_questions').where({ lesson_id: lid }).del();
      await trx('lesson_questions').insert(questions.map((q, i) => ({
        organization_id: ctx.organizationId, lesson_id: lid, question: q.question.slice(0, 500), options: JSON.stringify(q.options.map((o) => o.slice(0, 300))), correct_index: q.correct, sort_order: i,
      })));
    }
    return lid;
  });
  if (stored && existing?.file_storage_key) await storage.remove(existing.file_storage_key);
  return id;
}

async function moveLesson(ctx, courseId, lessonId, direction) {
  await assertManage(ctx);
  const lessons = await knex('course_lessons').where({ course_id: courseId, organization_id: ctx.organizationId }).orderBy(['sort_order', 'id']);
  const i = lessons.findIndex((l) => l.id === Number(lessonId));
  if (i === -1) throw E.notFound('Lesson');
  const j = direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= lessons.length) return;
  [lessons[i], lessons[j]] = [lessons[j], lessons[i]];
  await knex.transaction(async (trx) => {
    for (const [k, l] of lessons.entries()) await trx('course_lessons').where({ id: l.id }).update({ sort_order: k });
  });
}

async function deleteLesson(ctx, courseId, lessonId) {
  await assertManage(ctx);
  const lesson = await knex('course_lessons').where({ id: lessonId, course_id: courseId, organization_id: ctx.organizationId }).first();
  if (!lesson) throw E.notFound('Lesson');
  await knex('course_lessons').where({ id: lessonId }).del();
  if (lesson.file_storage_key) await storage.remove(lesson.file_storage_key);
}

// ---------- Paths ----------
async function listPaths(ctx) {
  const q = knex('learning_paths').where({ organization_id: ctx.organizationId }).orderBy('title');
  if (!canManage(ctx)) q.where('status', 'published');
  else q.whereNot('status', 'archived');
  const paths = await q;
  const links = paths.length ? await knex('learning_path_courses as pc').join('courses as c', 'c.id', 'pc.course_id').whereIn('pc.path_id', paths.map((p) => p.id))
    .select('pc.path_id', 'pc.sort_order', 'c.id', 'c.title', 'c.status').orderBy(['pc.path_id', 'pc.sort_order']) : [];
  return paths.map((p) => ({ ...p, courses: links.filter((l) => l.path_id === p.id) }));
}

async function getPath(ctx, id) {
  const path = (await listPaths(ctx)).find((p) => p.id === Number(id));
  if (!path) throw E.notFound('Learning path');
  return path;
}

async function savePath(ctx, id, input) {
  await assertManage(ctx);
  const title = String(input.title || '').trim();
  if (!title) throw E.validation({ title: 'Title is required.' });
  const ids = [...new Set([].concat(input.course_ids ?? []).map(Number).filter(Boolean))];
  const valid = ids.length ? (await knex('courses').where({ organization_id: ctx.organizationId }).whereIn('id', ids).select('id')).map((c) => c.id) : [];
  const courseIds = ids.filter((c) => valid.includes(c));
  if (!courseIds.length) throw E.validation({ course_ids: 'Choose at least one course.' });
  const row = { title: title.slice(0, 200), description: input.description ? String(input.description).slice(0, 5000) : null, status: input.status === 'published' ? 'published' : 'draft' };
  return knex.transaction(async (trx) => {
    let pid = id ? Number(id) : null;
    if (pid) {
      const n = await trx('learning_paths').where({ id: pid, organization_id: ctx.organizationId }).update(row);
      if (!n) throw E.notFound('Learning path');
      await trx('learning_path_courses').where({ path_id: pid }).del();
    } else {
      [pid] = await trx('learning_paths').insert({ ...row, organization_id: ctx.organizationId, created_by: ctx.userId });
    }
    await trx('learning_path_courses').insert(courseIds.map((c, i) => ({ organization_id: ctx.organizationId, path_id: pid, course_id: c, sort_order: i })));
    await audit.record(ctx, id ? 'learning_path.updated' : 'learning_path.created', { entityType: 'learning_path', entityId: pid, newValues: { name: title, courses: courseIds.length } }, trx);
    return pid;
  });
}

module.exports = {
  LEVELS, KINDS, canManage, listCourses, categories, getCourse, saveCourse, setCourseStatus, saveLesson, moveLesson, deleteLesson,
  listPaths, getPath, savePath, parseJson,
};
