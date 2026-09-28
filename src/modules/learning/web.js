const express = require('express');
const { wrap, form, flash, back } = require('../../routes/helpers');
const { can, feature } = require('../../middleware/context');
const { singleFile } = require('../../middleware/upload');
const { E } = require('../../core/errors');
const csv = require('../../core/csv');
const structure = require('../workforce/structure.service');
const employees = require('../workforce/employee.service');
const courses = require('./courses.service');
const enroll = require('./enrollments.service');
const { renderText, videoEmbed } = require('./content');

const router = express.Router();
router.use(feature('learning'));
router.use(async (req, res, next) => {
  res.locals.learnSection = req.path.split('/')[1] || 'my';
  try {
    const scope = await enroll.scopeIds(req.ctx);
    res.locals.canAssign = scope === null || scope.length > 0;
  } catch (err) { return next(err); }
  return next();
});

/** People the current user may assign training to. */
async function assignable(ctx) {
  const scope = await enroll.scopeIds(ctx);
  const all = await employees.options(ctx.organizationId);
  return scope === null ? all : all.filter((e) => scope.includes(e.id));
}

// ---------- My learning & catalog ----------
router.get('/', wrap(async (req, res) => {
  res.page('pages/learning/index', { title: req.t('nav.learning'), mine: await enroll.myLearning(req.ctx) });
}));
router.get('/catalog', wrap(async (req, res) => {
  const [rows, cats, mine] = await Promise.all([courses.listCourses(req.ctx, { ...req.query, forCatalog: true }), courses.categories(req.ctx.organizationId), enroll.myLearning(req.ctx)]);
  const byCourse = Object.fromEntries(mine.enrollments.map((e) => [e.course_id, e]));
  res.page('pages/learning/catalog', { title: req.t('learning.catalog'), rows, cats, byCourse });
}));

// ---------- Course page ----------
const renderCourse = async (req, res, extra = {}) => {
  const course = await courses.getCourse(req.ctx, Number(req.params.id));
  const [enrollment, people, departments] = await Promise.all([
    enroll.enrollmentFor(req.ctx, course.id),
    res.locals.canAssign ? assignable(req.ctx) : [], res.locals.canAssign ? structure.listDepartments(req.ctx.organizationId) : [],
  ]);
  res.page('pages/learning/course', { title: course.title, course, enrollment, people, departments, descriptionHtml: renderText(course.description), ...extra });
};
router.get('/courses/:id', wrap((req, res) => renderCourse(req, res)));
router.post('/courses/:id/enroll', form(async (req, res) => {
  await enroll.enrollSelf(req.ctx, Number(req.params.id));
  const course = await courses.getCourse(req.ctx, Number(req.params.id));
  res.redirect(course.lessons.length ? `/app/learning/courses/${course.id}/lessons/${course.lessons[0].id}` : `/app/learning/courses/${course.id}`);
}, async (req, res, extra) => { flash(req, 'error', extra.formError.message); res.redirect(`/app/learning/courses/${req.params.id}`); }));
router.post('/courses/:id/restart', form(async (req, res) => {
  await enroll.restart(req.ctx, Number(req.params.id));
  res.redirect(`/app/learning/courses/${req.params.id}`);
}, async (req, res, extra) => { flash(req, 'error', extra.formError.message); res.redirect(`/app/learning/courses/${req.params.id}`); }));
router.post('/courses/:id/assign', form(async (req, res) => {
  const n = await enroll.assignCourse(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('learning.assigned_msg', { n }));
  res.redirect(`/app/learning/courses/${req.params.id}`);
}, (req, res, extra) => renderCourse(req, res, { ...extra, openDialog: 'assign' })));

// ---------- Lesson player ----------
const renderLesson = async (req, res, extra = {}) => {
  const course = await courses.getCourse(req.ctx, Number(req.params.id), { withQuestions: true });
  const lesson = course.lessons.find((l) => l.id === Number(req.params.lid));
  if (!lesson) throw E.notFound('Lesson');
  const enrollment = await enroll.enrollmentFor(req.ctx, course.id);
  if (!enrollment && !courses.canManage(req.ctx)) return res.redirect(`/app/learning/courses/${course.id}`);
  const idx = course.lessons.indexOf(lesson);
  const done = new Set((enrollment?.lessons || []).filter((l) => l.completed_at).map((l) => l.lesson_id));
  const progress = (enrollment?.lessons || []).find((l) => l.lesson_id === lesson.id);
  return res.page('pages/learning/lesson', {
    title: lesson.title, course, lesson, enrollment, done, progress, prev: course.lessons[idx - 1], next: course.lessons[idx + 1],
    bodyHtml: renderText(lesson.body), embed: lesson.kind === 'video' ? videoEmbed(lesson.url) : null, ...extra,
  });
};
router.get('/courses/:id/lessons/:lid', wrap((req, res) => renderLesson(req, res)));
router.post('/courses/:id/lessons/:lid/complete', form(async (req, res) => {
  const out = await enroll.completeLesson(req.ctx, Number(req.params.id), Number(req.params.lid));
  if (out.finished) flash(req, 'success', req.t('learning.course_completed'));
  const course = await courses.getCourse(req.ctx, Number(req.params.id));
  const idx = course.lessons.findIndex((l) => l.id === Number(req.params.lid));
  const next = course.lessons[idx + 1];
  res.redirect(out.finished || !next ? `/app/learning/courses/${course.id}` : `/app/learning/courses/${course.id}/lessons/${next.id}`);
}, async (req, res, extra) => { flash(req, 'error', extra.formError.message); res.redirect(`/app/learning/courses/${req.params.id}/lessons/${req.params.lid}`); }));
router.post('/courses/:id/lessons/:lid/quiz', form(async (req, res) => {
  const result = await enroll.submitQuiz(req.ctx, Number(req.params.id), Number(req.params.lid), req.body);
  if (result.finished) flash(req, 'success', req.t('learning.course_completed'));
  return renderLesson(req, res, { quizResult: result });
}, renderLesson));
router.get('/courses/:id/lessons/:lid/file', wrap(async (req, res) => {
  const f = await enroll.openLessonFile(req.ctx, Number(req.params.id), Number(req.params.lid));
  const inline = req.query.inline === '1' && f.inline;
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
  f.stream.on('error', () => res.destroy());
  f.stream.pipe(res);
}));

// ---------- Paths ----------
router.get('/paths', wrap(async (req, res) => {
  const [paths, all] = await Promise.all([courses.listPaths(req.ctx), courses.canManage(req.ctx) ? courses.listCourses(req.ctx, {}) : []]);
  res.page('pages/learning/paths', { title: req.t('learning.paths'), paths, allCourses: all });
}));
const renderPath = async (req, res, extra = {}) => {
  const path = await courses.getPath(req.ctx, Number(req.params.id));
  const self = await employees.linkedEmployeeId(req.ctx);
  const [mine, people, departments, all] = await Promise.all([
    self ? enroll.pathProgress(req.ctx, self) : [], res.locals.canAssign ? assignable(req.ctx) : [], res.locals.canAssign ? structure.listDepartments(req.ctx.organizationId) : [],
    courses.canManage(req.ctx) ? courses.listCourses(req.ctx, {}) : [],
  ]);
  const myCourses = self ? await Promise.all(path.courses.map((c) => enroll.enrollmentFor(req.ctx, c.id))) : [];
  res.page('pages/learning/path', { title: path.title, path, assignment: mine.find((a) => a.path_id === path.id), myCourses, people, departments, allCourses: all, ...extra });
};
router.get('/paths/:id', wrap((req, res) => renderPath(req, res)));
router.post('/paths', can('learning.manage'), form(async (req, res) => {
  const id = await courses.savePath(req.ctx, null, req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/app/learning/paths/${id}`);
}, async (req, res, extra) => {
  const [paths, all] = await Promise.all([courses.listPaths(req.ctx), courses.listCourses(req.ctx, {})]);
  res.page('pages/learning/paths', { title: req.t('learning.paths'), paths, allCourses: all, ...extra, openDialog: 'path' });
}));
router.post('/paths/:id', can('learning.manage'), form(async (req, res) => {
  await courses.savePath(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect(`/app/learning/paths/${req.params.id}`);
}, (req, res, extra) => renderPath(req, res, { ...extra, openDialog: 'path' })));
router.post('/paths/:id/assign', form(async (req, res) => {
  const n = await enroll.assignPath(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('learning.path_assigned_msg', { n }));
  res.redirect(`/app/learning/paths/${req.params.id}`);
}, (req, res, extra) => renderPath(req, res, { ...extra, openDialog: 'assign' })));

// ---------- Manage courses ----------
router.get('/manage', can('learning.manage'), wrap(async (req, res) => {
  res.page('pages/learning/manage', { title: req.t('learning.manage_courses'), rows: await courses.listCourses(req.ctx, req.query), status: req.query.status || '' });
}));
const renderCourseForm = async (req, res, extra = {}) => {
  const course = req.params.id ? await courses.getCourse(req.ctx, Number(req.params.id), { withQuestions: true }) : null;
  res.page('pages/learning/course-form', { title: course ? course.title : req.t('learning.new_course'), course, cats: await courses.categories(req.ctx.organizationId), ...extra });
};
router.get('/manage/courses/new', can('learning.manage'), wrap((req, res) => renderCourseForm(req, res)));
router.post('/manage/courses', can('learning.manage'), form(async (req, res) => {
  const id = await courses.saveCourse(req.ctx, null, req.body);
  flash(req, 'success', req.t('learning.course_saved'));
  res.redirect(`/app/learning/manage/courses/${id}`);
}, renderCourseForm));
router.get('/manage/courses/:id', can('learning.manage'), wrap((req, res) => renderCourseForm(req, res)));
router.post('/manage/courses/:id', can('learning.manage'), form(async (req, res) => {
  await courses.saveCourse(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('learning.course_saved'));
  res.redirect(`/app/learning/manage/courses/${req.params.id}`);
}, renderCourseForm));
router.post('/manage/courses/:id/status', can('learning.manage'), form(async (req, res) => {
  await courses.setCourseStatus(req.ctx, Number(req.params.id), req.body.status);
  flash(req, 'success', req.t(`learning.course_${req.body.status}_msg`));
  back(req, res, `/app/learning/manage/courses/${req.params.id}`);
}, async (req, res, extra) => { flash(req, 'error', extra.formError.message); res.redirect(`/app/learning/manage/courses/${req.params.id}`); }));

const renderLessonForm = async (req, res, extra = {}) => {
  const course = await courses.getCourse(req.ctx, Number(req.params.id), { withQuestions: true });
  const lesson = req.params.lid ? course.lessons.find((l) => l.id === Number(req.params.lid)) : null;
  if (req.params.lid && !lesson) throw E.notFound('Lesson');
  const kind = lesson ? lesson.kind : (courses.KINDS.includes(req.query.kind || req.body?.kind) ? (req.query.kind || req.body.kind) : 'text');
  res.page('pages/learning/lesson-form', { title: lesson ? lesson.title : req.t('learning.new_lesson'), course, lesson, kind, ...extra });
};
router.get('/manage/courses/:id/lessons/new', can('learning.manage'), wrap((req, res) => renderLessonForm(req, res)));
router.get('/manage/courses/:id/lessons/:lid', can('learning.manage'), wrap((req, res) => renderLessonForm(req, res)));
router.post('/manage/courses/:id/lessons', can('learning.manage'), ...singleFile('file'), form(async (req, res) => {
  await courses.saveLesson(req.ctx, Number(req.params.id), null, req.body, req.file);
  flash(req, 'success', req.t('learning.lesson_saved'));
  res.redirect(`/app/learning/manage/courses/${req.params.id}#lessons`);
}, renderLessonForm));
router.post('/manage/courses/:id/lessons/:lid', can('learning.manage'), ...singleFile('file'), form(async (req, res) => {
  await courses.saveLesson(req.ctx, Number(req.params.id), Number(req.params.lid), req.body, req.file);
  flash(req, 'success', req.t('learning.lesson_saved'));
  res.redirect(`/app/learning/manage/courses/${req.params.id}#lessons`);
}, renderLessonForm));
router.post('/manage/courses/:id/lessons/:lid/move', can('learning.manage'), wrap(async (req, res) => {
  await courses.moveLesson(req.ctx, Number(req.params.id), Number(req.params.lid), req.body.direction);
  res.redirect(`/app/learning/manage/courses/${req.params.id}#lessons`);
}));
router.post('/manage/courses/:id/lessons/:lid/delete', can('learning.manage'), wrap(async (req, res) => {
  await courses.deleteLesson(req.ctx, Number(req.params.id), Number(req.params.lid));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(`/app/learning/manage/courses/${req.params.id}#lessons`);
}));

// ---------- Reports ----------
const needScope = (req, res, next) => (res.locals.canAssign ? next() : next(E.forbidden('learning.manage')));
router.get('/reports', needScope, wrap(async (req, res) => {
  const [rows, summary, all, departments] = await Promise.all([enroll.report(req.ctx, req.query), enroll.summary(req.ctx), courses.listCourses(req.ctx, {}), structure.listDepartments(req.ctx.organizationId)]);
  res.page('pages/learning/reports', { title: req.t('learning.reports'), rows, summary, allCourses: all, departments });
}));
router.get('/reports/export.csv', needScope, wrap(async (req, res) => {
  const rows = await enroll.report(req.ctx, req.query);
  const d = (v) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : '');
  csv.send(res, `training-${new Date().toISOString().slice(0, 10)}.csv`, ['Employee', 'Department', 'Course', 'Mandatory', 'Source', 'Status', 'Progress %', 'Score %', 'Due date', 'Completed', 'Overdue'],
    rows.map((r) => [`${r.first_name} ${r.last_name}`, r.department_name, r.course_title, r.is_mandatory ? 'yes' : 'no', r.source, r.status, r.progress, r.score === null ? '' : Number(r.score), d(r.due_date), d(r.completed_at), r.overdue ? 'yes' : 'no']));
}));

// ---------- Certificates ----------
router.get('/certificates/:id', wrap(async (req, res) => {
  const cert = await enroll.getCertificate(req.ctx, Number(req.params.id));
  res.page('pages/learning/certificate', { title: cert.course_title, cert, layout: req.query.print === '1' ? 'print' : 'app' });
}));

module.exports = router;
