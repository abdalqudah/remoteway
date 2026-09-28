// The AI tasks offered in the product. Each one gathers the minimum data the task needs (after the
// same access checks as the page it belongs to), asks for a JSON answer and validates it.
const knex = require('../../db/knex');
const { z } = require('../../core/validate');
const { E } = require('../../core/errors');
const ai = require('./ai.service');
const extract = require('./extract');
const metrics = require('./metrics');
const recruitment = require('../recruitment/recruitment.service');
const documents = require('../documents/document.service');
const reviews = require('../performance/reviews.service');
const goals = require('../performance/goals.service');

const text = (max) => z.string().trim().max(max);
const list = (max, len = 400) => z.array(z.string().trim().min(1).max(len)).max(max).default([]);
const parseJson = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const block = (title, value) => (value ? `## ${title}\n${value}\n` : '');

// ---------- Recruitment: job description draft ----------
const jobSchema = z.object({ description: text(6000).min(1), requirements: text(4000).default(''), skills: list(15, 60) });

async function jobDescription(ctx, input, locale) {
  const title = String(input.title || '').trim();
  if (title.length < 2) throw E.validation({ title: 'Enter the job title first.' });
  const dept = input.department_id ? await knex('departments').where({ id: Number(input.department_id), organization_id: ctx.organizationId }).first('name') : null;
  const org = await knex('organizations').where({ id: ctx.organizationId }).first('name', 'industry');
  const data = [
    block('Job title', ai.clip(title, 150)),
    block('Company industry', org.industry || ''),
    block('Department', dept ? dept.name : ''),
    block('Work mode', input.work_mode || ''),
    block('Employment type', input.employment_type || ''),
    block('Years of experience', input.experience_years || ''),
    block('Skills already listed', ai.clip(input.skills, 500)),
    block('Notes or current draft from the recruiter', ai.redact(ai.clip(input.description, 3000))),
  ].join('\n');
  return ai.run(ctx, {
    area: 'recruitment', action: 'job_description', locale, schema: jobSchema, maxTokens: 1800,
    instructions: 'Write a clear, inclusive job posting. Return {"description": "about the role and responsibilities, plain text with short paragraphs and \'- \' bullet lines", "requirements": "must-have and nice-to-have requirements as \'- \' bullet lines", "skills": ["up to 10 short skill names"]}. Do not invent salary, benefits or company facts that are not in the data. Avoid age, gender or nationality preferences.',
    data,
  });
}

// ---------- Recruitment: candidate ↔ job requirements match ----------
const MATCH = ['met', 'partial', 'not_evident'];
const matchSchema = z.object({
  summary: text(1500).min(1),
  requirements: z.array(z.object({ requirement: text(300).min(1), status: z.enum(MATCH), evidence: text(400).default('') })).max(15).default([]),
  strengths: list(6),
  gaps: list(6),
  questions: list(8),
});

async function candidateMatch(ctx, applicationId, locale) {
  const app = await recruitment.getApplication(ctx, applicationId);
  const job = await knex('jobs').where({ id: app.job_id, organization_id: ctx.organizationId }).first();
  const cand = await knex('candidates').where({ id: app.candidate_id, organization_id: ctx.organizationId }).first();
  await ai.assertUsable(ctx.organizationId, 'recruitment');
  const cfg = await ai.config();
  const cv = cand.cv_storage_key ? await extract.prepare(cfg.provider, { storageKey: cand.cv_storage_key, mime: cand.cv_mime, name: cand.cv_name, size: cand.cv_size }) : {};
  const data = [
    block('Job title', job.title),
    block('Job description', ai.clip(job.description, 5000)),
    block('Requirements', ai.clip(job.requirements, 4000)),
    block('Required skills', parseJson(job.skills, []).join(', ')),
    block('Minimum years of experience', job.experience_years != null ? String(job.experience_years) : ''),
    block('Candidate current title', cand.current_title || ''),
    block('Candidate years of experience', cand.experience_years != null ? String(cand.experience_years) : ''),
    block('Candidate skills', parseJson(cand.skills, []).join(', ')),
    block('Cover note', ai.redact(ai.clip(app.cover_note, 3000))),
    block('Assessments', app.assessments.map((s) => `${s.title}: ${s.score != null ? s.score : '—'}${s.max_score != null ? `/${s.max_score}` : ''}`).join('\n')),
    block('CV text', cv.text ? ai.redact(cv.text) : ''),
    cv.file ? 'The CV is attached as a file.\n' : '',
    !cv.text && !cv.file ? 'No readable CV is available; use the profile fields only.\n' : '',
  ].join('\n');
  const output = await ai.run(ctx, {
    area: 'recruitment', action: 'candidate_match', entityType: 'application', entityId: app.id, locale, schema: matchSchema, maxTokens: 2000,
    files: cv.file ? [cv.file] : [],
    instructions: `Compare the candidate's evidence with the job requirements. Return {"summary": "3-4 neutral sentences", "requirements": [{"requirement": "one requirement from the job", "status": "met|partial|not_evident", "evidence": "where it appears in the candidate data, or what is missing"}], "strengths": [], "gaps": [], "questions": ["interview questions that would verify the gaps"]}. Do not give an overall score, ranking or hire/reject recommendation. Ignore the candidate's name, photo, age, gender, nationality and other personal characteristics.`,
    data,
  });
  output.cv = cv.file ? 'attached' : cv.text ? 'text' : 'none';
  await ai.saveInsight(ctx, { action: 'candidate_match', entityType: 'application', entityId: app.id, locale, output });
  return output;
}

// ---------- Documents: summary and key dates ----------
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const docSchema = z.object({
  summary: text(1500).min(1),
  document_type: text(120).default(''),
  parties: list(6, 200),
  key_dates: z.array(z.object({ label: text(120).min(1), date: DATE })).max(10).default([]),
  issue_date: DATE.nullable().default(null),
  expiry_date: DATE.nullable().default(null),
  notes: list(6),
});

async function documentSummary(ctx, documentId, locale) {
  if (!ctx.permissions.has('documents.view') && !ctx.permissions.has('documents.manage')) throw E.forbidden('documents.view');
  const doc = await documents.get(ctx, documentId);
  const v = doc.versions[0];
  if (!v) throw E.notFound('Document');
  await ai.assertUsable(ctx.organizationId, 'documents');
  const cfg = await ai.config();
  const src = await extract.prepare(cfg.provider, { storageKey: v.storage_key, mime: v.mime_type, name: v.original_name, size: v.size_bytes });
  if (src.unsupported) throw E.validation({ file: 'The AI cannot read this file type. PDF, images, Word (.docx) and text files are supported.' });
  const output = await ai.run(ctx, {
    area: 'documents', action: 'document_summary', entityType: 'document', entityId: doc.id, locale, schema: docSchema, maxTokens: 1500,
    files: src.file ? [src.file] : [],
    instructions: 'Summarise this HR document for the HR team. Return {"summary": "3-5 sentences", "document_type": "e.g. employment contract, passport, residency permit, certificate, policy", "parties": ["organisations or roles involved"], "key_dates": [{"label": "what the date is", "date": "YYYY-MM-DD"}], "issue_date": "YYYY-MM-DD or null", "expiry_date": "YYYY-MM-DD or null", "notes": ["obligations, renewal or notice periods worth tracking"]}. Convert Hijri dates to Gregorian only when the conversion is certain; otherwise leave them out. Use null when a date is not stated. Do not copy ID, passport or account numbers.',
    data: [block('Document title', doc.title), block('Category', doc.category), src.text ? block('Document text', src.text) : 'The document is attached as a file.'].join('\n'),
  });
  output.version = v.version;
  await ai.saveInsight(ctx, { action: 'document_summary', entityType: 'document', entityId: doc.id, locale, output });
  return output;
}

// ---------- Performance: review summary draft ----------
const reviewSchema = z.object({ summary: text(5000).min(1), strengths: text(5000).default(''), improvements: text(5000).default('') });

async function reviewDraft(ctx, reviewId, input, locale) {
  const r = await reviews.getReview(ctx, reviewId);
  const mode = r.canSelf ? 'self' : r.canManage ? 'manager' : null;
  if (!mode) throw E.forbidden('performance.review');
  const prefix = mode === 'self' ? 'self' : 'manager';
  const lines = [];
  for (const it of r.items) {
    const rating = input[`${prefix}_rating_${it.id}`] || it[`${prefix}_rating`];
    const comment = input[`${prefix}_comment_${it.id}`] || it[`${prefix}_comment`];
    let line = `- [${it.item_type}] ${it.title}${it.weight ? ` (weight ${it.weight})` : ''}: rating ${rating || 'not set'}/5`;
    if (comment) line += `; comment: ${ai.redact(ai.clip(comment, 600))}`;
    if (it.goal_id) {
      try {
        const g = await goals.get(ctx, it.goal_id);
        line += `; goal progress ${Math.round(g.progress)}%, health ${g.health}`;
        const krs = g.key_results.map((k) => `${k.title} ${Math.round(k.progress)}%`).join(', ');
        if (krs) line += `; key results: ${krs}`;
        const notes = g.checkins.filter((c) => c.note && new Date(c.created_at) >= new Date(r.period_start)).slice(0, 5).map((c) => ai.clip(c.note, 200));
        if (notes.length) line += `; check-in notes: ${notes.map((x) => ai.redact(x)).join(' | ')}`;
      } catch { /* goal not visible to this user */ }
    }
    lines.push(line);
  }
  const fb = (await reviews.listFeedback(ctx, { employeeId: r.employee_id }))
    .filter((f) => new Date(f.created_at) >= new Date(r.period_start)).slice(0, 15)
    .map((f) => `- ${f.kind}: ${ai.redact(ai.clip(f.body, 400))}`);
  const data = [
    block('Review period', `${String(r.period_start).slice(0, 10)} to ${String(r.period_end).slice(0, 10)}`),
    block('Role', r.job_title || ''),
    block(mode === 'self' ? 'Self-assessment so far' : 'Manager assessment so far', lines.join('\n')),
    block('Feedback received in the period', fb.join('\n')),
    block('Current draft', ai.redact(ai.clip(input[`${prefix}_summary`], 3000))),
  ].join('\n');
  const who = mode === 'self' ? 'the employee writing their own self-review (first person)' : "the manager writing the employee's review (address the employee as \"you\")";
  return ai.run(ctx, {
    area: 'performance', action: `review_draft_${mode}`, entityType: 'review', entityId: r.id, locale, schema: reviewSchema, maxTokens: 1500,
    instructions: `Draft the written summary for ${who}, based only on the ratings, comments, goal progress and feedback in the data. Return {"summary": "one or two short paragraphs", "strengths": "${mode === 'manager' ? "'- ' bullet lines" : 'empty string'}", "improvements": "${mode === 'manager' ? "'- ' bullet lines with specific, constructive next steps" : 'empty string'}"}. Do not propose or change any rating, and do not mention pay, promotion or disciplinary action.`,
    data,
  });
}

// ---------- Learning: quiz questions from course content ----------
const quizSchema = z.object({
  questions: z.array(z.object({
    question: text(500).min(1), options: z.array(text(300).min(1)).length(4), correct_index: z.coerce.number().int().min(0).max(3),
  })).min(1).max(10),
});

async function quizQuestions(ctx, courseId, input, locale) {
  const course = await knex('courses').where({ id: courseId, organization_id: ctx.organizationId }).first();
  if (!course) throw E.notFound('Course');
  const lessons = await knex('course_lessons').where({ course_id: courseId, organization_id: ctx.organizationId }).whereIn('kind', ['text', 'video', 'link', 'file'])
    .orderBy('sort_order').select('title', 'kind', 'body');
  const content = lessons.map((l) => `### ${l.title}\n${ai.clip(l.body, 4000)}`).join('\n\n');
  const topic = String(input.topic || '').trim();
  if (!content.trim() && !topic && !String(input.body || '').trim()) throw E.validation({ topic: 'Add lesson content or a topic first.' });
  const count = Math.min(10, Math.max(3, Number(input.count) || 5));
  return ai.run(ctx, {
    area: 'learning', action: 'quiz_questions', entityType: 'course', entityId: course.id, locale, schema: quizSchema, maxTokens: 2500,
    instructions: `Write ${count} multiple-choice questions that check understanding of the course material. Return {"questions": [{"question": "...", "options": ["four", "distinct", "answer", "options"], "correct_index": 0}]}. Exactly one option is correct; vary the position of the correct answer. Base every question on the material provided${topic ? ' and the requested focus' : ''}.`,
    data: [block('Course', course.title), block('Course description', ai.clip(course.description, 2000)), block('Requested focus', ai.clip(topic, 300)),
      block('This lesson notes', ai.clip(input.body, 3000)), block('Course lessons', content)].join('\n'),
  });
}

// ---------- Analytics assistant ----------
const answerSchema = z.object({ answer: text(4000).min(1), highlights: list(6), caveats: list(4) });

async function ask(ctx, question, locale) {
  const q = String(question || '').trim();
  if (q.length < 3) throw E.validation({ question: 'Type a question.' });
  if (q.length > 500) throw E.validation({ question: 'Keep the question under 500 characters.' });
  const m = await metrics.collect(ctx);
  const output = await ai.run(ctx, {
    area: 'analytics', action: 'analytics_qa', locale, schema: answerSchema, maxTokens: 1200,
    instructions: 'Answer the question using only the company metrics in the data (JSON, computed from the company database). Quote numbers exactly as given; do not estimate or calculate new figures. If the metrics do not contain the answer, say which data is missing. Return {"answer": "a direct answer in 2-5 sentences", "highlights": ["short supporting facts from the metrics"], "caveats": ["limitations, e.g. areas you could not see"]}.',
    data: `${block('Question', ai.redact(q))}\n## Metrics (as of ${m.asOf}, currency ${m.currency})\n${JSON.stringify(m.areas)}`,
  });
  await knex('ai_insights').insert({
    organization_id: ctx.organizationId, action: 'analytics_qa', entity_type: 'user', entity_id: ctx.userId, locale,
    output: JSON.stringify({ question: q, ...output, areas: Object.keys(m.areas), asOf: m.asOf }), created_by: ctx.userId,
  });
  return output;
}

async function history(ctx, limit = 10) {
  const rows = await knex('ai_insights').where({ organization_id: ctx.organizationId, action: 'analytics_qa', entity_type: 'user', entity_id: ctx.userId })
    .orderBy('id', 'desc').limit(limit);
  return rows.map((r) => ({ id: r.id, created_at: r.created_at, ...(typeof r.output === 'string' ? JSON.parse(r.output) : r.output) }));
}

module.exports = { jobDescription, candidateMatch, documentSummary, reviewDraft, quizQuestions, ask, history, metrics, MATCH };
