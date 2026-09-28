const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const content = require('../src/modules/learning/content');
const enrollSvc = require('../src/modules/learning/enrollments.service');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

describe('Phase 6 — learning (pure)', () => {
  test('lesson text is escaped and lightly formatted', () => {
    const html = content.renderText('# Title\nHello **bold** <script>alert(1)</script>\n\n- one\n- two');
    assert.match(html, /<h3>Title<\/h3>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  });
  test('only YouTube and Vimeo links become embeds', () => {
    assert.equal(content.videoEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    assert.equal(content.videoEmbed('https://youtu.be/dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    assert.equal(content.videoEmbed('https://vimeo.com/76979871'), 'https://player.vimeo.com/video/76979871');
    assert.equal(content.videoEmbed('http://youtube.com/watch?v=dQw4w9WgXcQ'), null);
    assert.equal(content.videoEmbed('https://evil.example/embed/x'), null);
    assert.equal(content.videoEmbed('javascript:alert(1)'), null);
  });
  test('certificate expiry adds calendar months safely', () => {
    assert.equal(enrollSvc.addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(enrollSvc.addMonths('2024-02-29', 12), '2025-02-28');
  });
});

describe('Phase 6 — learning (integration)', () => {
  let C; let O; let owner; let other; let hrU; let hr; let mgrU; let mgr; let saraU; let sara; let noraU; let nora;
  let saraEmp; let noraEmp; let courseId; let lessons;

  before(async () => {
    await h.resetDatabase();
    C = await h.createCompany({ plan: 'business' });
    O = await h.createCompany({ plan: 'business' });
    owner = await h.login(C.email, C.password);
    other = await h.login(O.email, O.password);
    hrU = await h.addMember(C.organizationId, 'hr_manager'); hr = await h.login(hrU.email, hrU.password);
    mgrU = await h.addMember(C.organizationId, 'team_manager'); mgr = await h.login(mgrU.email, mgrU.password);
    saraU = await h.addMember(C.organizationId, 'employee'); sara = await h.login(saraU.email, saraU.password);
    noraU = await h.addMember(C.organizationId, 'employee'); nora = await h.login(noraU.email, noraU.password);
    const mgrEmp = (await h.createEmployee(owner, { first_name: 'Omar', email: mgrU.email })).body.data;
    saraEmp = (await h.createEmployee(owner, { first_name: 'Sara', email: saraU.email, manager_id: mgrEmp.id })).body.data;
    noraEmp = (await h.createEmployee(owner, { first_name: 'Nora', email: noraU.email })).body.data;
  });
  after(() => h.knex.destroy());

  const lessonForm = (s, url, fields, file) => {
    const req = s.agent.post(url).field('_csrf', s.csrf);
    for (const [k, v] of Object.entries(fields)) for (const one of [].concat(v)) req.field(k, String(one));
    return file ? req.attach('file', file, 'guide.pdf') : req;
  };

  test('learning is not part of the Starter plan', async () => {
    const S = await h.createCompany({ plan: 'starter' });
    const s = await h.login(S.email, S.password);
    assert.equal((await s.get('/app/learning')).status, 402);
  });

  test('HR builds a course with text, video, file and quiz lessons, then publishes it', async () => {
    assert.equal((await sara.form('/app/learning/manage/courses', { title: 'Nope' })).status, 403);
    const res = await hr.form('/app/learning/manage/courses', { title: 'Security basics', level: 'beginner', passing_score: 70, validity_months: 12, certificate_enabled: 'on', self_enroll: 'on', is_mandatory: 'on' });
    assert.equal(res.status, 302, res.text.slice(0, 300));
    courseId = Number(res.headers.location.split('/').pop());
    // Cannot publish an empty course.
    await hr.form(`/app/learning/manage/courses/${courseId}/status`, { status: 'published' });
    assert.equal((await h.knex('courses').where({ id: courseId }).first()).status, 'draft');
    const base = `/app/learning/manage/courses/${courseId}/lessons`;
    assert.equal((await lessonForm(hr, base, { kind: 'text', title: 'Intro', body: 'Hello' })).status, 302);
    assert.equal((await lessonForm(hr, base, { kind: 'video', title: 'Bad video', url: 'https://evil.example/v' })).status, 422);
    assert.equal((await lessonForm(hr, base, { kind: 'video', title: 'Video', url: 'https://youtu.be/dQw4w9WgXcQ' })).status, 302);
    assert.equal((await lessonForm(hr, base, { kind: 'file', title: 'Guide' }, PDF)).status, 302);
    const badQuiz = await lessonForm(hr, base, { kind: 'quiz', title: 'Quiz', q_text: ['Q1'], q_opt0: ['Only one'], q_opt1: [''], q_opt2: [''], q_opt3: [''], q_correct: ['0'] });
    assert.equal(badQuiz.status, 422);
    // Blank answer in the middle: the correct answer ("C") must still be graded as correct.
    const quiz = await lessonForm(hr, base, { kind: 'quiz', title: 'Quiz', q_text: ['Q1', 'Q2'], q_opt0: ['A', 'Yes'], q_opt1: ['', 'No'], q_opt2: ['C', ''], q_opt3: ['', ''], q_correct: ['2', '0'] });
    assert.equal(quiz.status, 302);
    lessons = await h.knex('course_lessons').where({ course_id: courseId }).orderBy('sort_order');
    assert.equal(lessons.length, 4);
    const qs = await h.knex('lesson_questions').where({ lesson_id: lessons[3].id }).orderBy('sort_order');
    assert.equal(qs[0].correct_index, 1); // ["A", "C"] → index 1
    await hr.form(`/app/learning/manage/courses/${courseId}/status`, { status: 'published' });
    assert.equal((await h.knex('courses').where({ id: courseId }).first()).status, 'published');
  });

  test('draft courses and other companies\' courses are invisible', async () => {
    const d = await hr.form('/app/learning/manage/courses', { title: 'Draft only' });
    const draftId = Number(d.headers.location.split('/').pop());
    assert.equal((await sara.get(`/app/learning/courses/${draftId}`)).status, 404);
    assert.equal((await other.get(`/app/learning/courses/${courseId}`)).status, 404);
    const catalog = await sara.api('get', '/api/v1/learning/courses');
    assert.deepEqual(catalog.body.data.map((c) => c.id), [courseId]);
  });

  test('lessons need an enrollment; files are only served to learners', async () => {
    const page = await nora.get(`/app/learning/courses/${courseId}/lessons/${lessons[0].id}`);
    assert.equal(page.status, 302);
    assert.equal((await nora.get(`/app/learning/courses/${courseId}/lessons/${lessons[2].id}/file`)).status, 409);
    assert.equal((await other.get(`/app/learning/courses/${courseId}/lessons/${lessons[2].id}/file`)).status, 404);
  });

  test('assignment: a manager can assign to reports only; HR to anyone', async () => {
    assert.equal((await nora.form(`/app/learning/courses/${courseId}/assign`, { employee_ids: saraEmp.id })).status, 403);
    const denied = await mgr.form(`/app/learning/courses/${courseId}/assign`, { employee_ids: noraEmp.id });
    assert.equal(denied.status, 422);
    assert.equal(await h.knex('enrollments').where({ employee_id: noraEmp.id }).first(), undefined);
    assert.equal((await mgr.form(`/app/learning/courses/${courseId}/assign`, { employee_ids: saraEmp.id, due_date: '2020-01-01' })).status, 302);
    const e = await h.knex('enrollments').where({ employee_id: saraEmp.id, course_id: courseId }).first();
    assert.equal(e.source, 'assigned');
    assert.ok(await h.knex('notifications').where({ user_id: saraU.userId, type: 'course_assigned' }).first());
    // Overdue shows in the manager's team report, not Nora's.
    const rep = await mgr.api('get', '/api/v1/learning/enrollments?overdue=1');
    assert.deepEqual(rep.body.data.map((r) => r.employee_id), [saraEmp.id]);
    assert.equal((await nora.get('/app/learning/reports')).status, 403);
  });

  test('progress, quiz scoring and certificate issue on completion', async () => {
    const base = `/app/learning/courses/${courseId}/lessons`;
    assert.equal((await sara.get(`${base}/${lessons[2].id}/file`)).status, 200);
    // A quiz lesson cannot be "marked complete".
    await sara.form(`${base}/${lessons[3].id}/complete`, {});
    assert.equal((await h.knex('lesson_progress').whereNotNull('completed_at')).length, 0);
    for (const l of lessons.slice(0, 3)) await sara.form(`${base}/${l.id}/complete`, {});
    let e = await h.knex('enrollments').where({ employee_id: saraEmp.id, course_id: courseId }).first();
    assert.equal(Number(e.progress), 75);
    assert.equal(e.status, 'in_progress');
    const qs = await h.knex('lesson_questions').where({ lesson_id: lessons[3].id }).orderBy('sort_order');
    // 1 of 2 correct = 50% < 70%: not passed.
    const fail = await sara.form(`${base}/${lessons[3].id}/quiz`, { [`q_${qs[0].id}`]: 1, [`q_${qs[1].id}`]: 1 });
    assert.equal(fail.status, 200);
    assert.match(fail.text, /70%/);
    e = await h.knex('enrollments').where({ id: e.id }).first();
    assert.equal(e.status, 'in_progress');
    assert.equal(await h.knex('certificates').where({ employee_id: saraEmp.id }).first(), undefined);
    // Unanswered questions are refused.
    assert.equal((await sara.form(`${base}/${lessons[3].id}/quiz`, { [`q_${qs[0].id}`]: 1 })).status, 422);
    // Pass.
    await sara.form(`${base}/${lessons[3].id}/quiz`, { [`q_${qs[0].id}`]: 1, [`q_${qs[1].id}`]: 0 });
    e = await h.knex('enrollments').where({ id: e.id }).first();
    assert.equal(e.status, 'completed');
    assert.equal(Number(e.progress), 100);
    assert.equal(Number(e.score), 100);
    const cert = await h.knex('certificates').where({ employee_id: saraEmp.id }).first();
    assert.ok(cert);
    assert.match(cert.code, /^RW-[0-9A-F]{10}$/);
    assert.ok(cert.expires_on);
    assert.ok(await h.knex('notifications').where({ user_id: saraU.userId, type: 'certificate_issued' }).first());
    const attempts = await h.knex('lesson_progress').where({ enrollment_id: e.id, lesson_id: lessons[3].id }).first();
    assert.equal(attempts.attempts, 2);
  });

  test('certificates: owner, manager and HR can view; public verification by code', async () => {
    const cert = await h.knex('certificates').where({ employee_id: saraEmp.id }).first();
    assert.equal((await sara.get(`/app/learning/certificates/${cert.id}`)).status, 200);
    assert.equal((await mgr.get(`/app/learning/certificates/${cert.id}`)).status, 200);
    assert.equal((await hr.get(`/app/learning/certificates/${cert.id}`)).status, 200);
    assert.equal((await nora.get(`/app/learning/certificates/${cert.id}`)).status, 404);
    assert.equal((await other.get(`/app/learning/certificates/${cert.id}`)).status, 404);
    const pub = await h.request(h.getApp()).get(`/verify/${cert.code}`);
    assert.equal(pub.status, 200);
    assert.match(pub.text, /Security basics/);
    assert.equal((await h.request(h.getApp()).get('/verify/RW-0000000000')).status, 404);
    await h.knex('certificates').where({ id: cert.id }).update({ expires_on: '2020-01-01' });
    const expired = await h.request(h.getApp()).get(`/verify/${cert.code}`);
    assert.match(expired.text, /Expired/);
  });

  test('retaking a completed course resets progress but keeps the certificate', async () => {
    await sara.form(`/app/learning/courses/${courseId}/restart`, {});
    const e = await h.knex('enrollments').where({ employee_id: saraEmp.id, course_id: courseId }).first();
    assert.equal(e.status, 'not_started');
    assert.equal(Number(e.progress), 0);
    assert.equal((await h.knex('certificates').where({ employee_id: saraEmp.id })).length, 1);
  });

  test('self-enrolment only for open courses; paths enroll in every course', async () => {
    assert.equal((await nora.form(`/app/learning/courses/${courseId}/enroll`, {})).status, 302);
    assert.ok(await h.knex('enrollments').where({ employee_id: noraEmp.id, course_id: courseId, source: 'self' }).first());
    const c2 = await hr.form('/app/learning/manage/courses', { title: 'Closed course', passing_score: 70 }); // self_enroll off
    const c2id = Number(c2.headers.location.split('/').pop());
    await lessonForm(hr, `/app/learning/manage/courses/${c2id}/lessons`, { kind: 'text', title: 'Only', body: 'x' });
    await hr.form(`/app/learning/manage/courses/${c2id}/status`, { status: 'published' });
    await nora.form(`/app/learning/courses/${c2id}/enroll`, {});
    assert.equal(await h.knex('enrollments').where({ employee_id: noraEmp.id, course_id: c2id }).first(), undefined);
    const p = await hr.form('/app/learning/paths', { title: 'Starter path', course_ids: [courseId, c2id], status: 'published' });
    const pathId = Number(p.headers.location.split('/').pop());
    assert.equal((await hr.form(`/app/learning/paths/${pathId}/assign`, { employee_ids: noraEmp.id })).status, 302);
    const mine = await h.knex('enrollments').where({ employee_id: noraEmp.id });
    assert.equal(mine.length, 2);
    assert.ok(mine.some((x) => x.course_id === c2id && x.source === 'path'));
    assert.ok(await h.knex('path_assignments').where({ path_id: pathId, employee_id: noraEmp.id }).first());
  });
});
