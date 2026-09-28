// Review cycles: competencies library → cycle (draft) → launch (self + manager reviews) → close (results released).
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');
const { isDateStr } = require('../../core/workdays');
const ent = require('../billing/entitlements.service');
const orgs = require('../organizations/organization.service');
const employees = require('../workforce/employee.service');
const notifications = require('../notifications/notification.service');
const { isAdmin, scopeIds } = require('./access');

const KINDS = ['annual', 'semi_annual', 'quarterly', 'probation', 'other'];
const parseJson = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const dstr = (v) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);

const DEFAULT_COMPETENCIES = [
  ['Communication', 'التواصل', 'Shares information clearly and listens actively.'],
  ['Teamwork', 'العمل الجماعي', 'Works well with others and supports the team.'],
  ['Ownership', 'تحمّل المسؤولية', 'Takes initiative and follows through on commitments.'],
  ['Quality of work', 'جودة العمل', 'Delivers accurate, reliable and thorough work.'],
  ['Problem solving', 'حل المشكلات', 'Analyses issues and finds practical solutions.'],
  ['Customer focus', 'التركيز على العميل', 'Understands and serves internal and external customers.'],
];

/** Weighted score out of 5. Missing sections fall back to the other one; ratings are 1–5. */
function score(items, goalsWeight) {
  const avg = (type) => {
    const r = items.filter((i) => i.item_type === type && i.manager_rating).map((i) => Number(i.manager_rating));
    return r.length ? r.reduce((a, b) => a + b, 0) / r.length : null;
  };
  const goals = avg('goal'); const comps = avg('competency');
  let final = null;
  if (goals !== null && comps !== null) final = (goals * goalsWeight + comps * (100 - goalsWeight)) / 100;
  else final = goals ?? comps;
  const r2 = (n) => (n === null ? null : Math.round(n * 100) / 100);
  return { goals_score: r2(goals), competency_score: r2(comps), final_score: r2(final), final_rating: final === null ? null : Math.min(5, Math.max(1, Math.round(final))) };
}

// ---------- Competencies ----------
async function listCompetencies(organizationId, { activeOnly = false } = {}) {
  if (!(await knex('competencies').where({ organization_id: organizationId }).first('id'))) {
    await knex('competencies').insert(DEFAULT_COMPETENCIES.map(([name, nameAr, description], i) => ({ organization_id: organizationId, name, name_ar: nameAr, description, sort_order: i })));
  }
  const q = knex('competencies').where({ organization_id: organizationId }).orderBy(['sort_order', 'id']);
  if (activeOnly) q.where('is_active', true);
  return q;
}

async function saveCompetency(ctx, id, input) {
  if (!isAdmin(ctx)) throw E.forbidden('performance.manage');
  await ent.assertCanWrite(ctx.organizationId);
  const name = String(input.name || '').trim();
  if (!name) throw E.validation({ name: 'Name is required.' });
  const row = { name: name.slice(0, 120), name_ar: input.name_ar ? String(input.name_ar).trim().slice(0, 120) : null, description: input.description ? String(input.description).slice(0, 500) : null };
  if (id) {
    const n = await knex('competencies').where({ id, organization_id: ctx.organizationId }).update({ ...row, is_active: input.is_active === 'on' || input.is_active === true });
    if (!n) throw E.notFound('Competency');
    return Number(id);
  }
  const [{ n }] = await knex('competencies').where({ organization_id: ctx.organizationId }).count({ n: '*' });
  const [newId] = await knex('competencies').insert({ ...row, organization_id: ctx.organizationId, sort_order: Number(n) });
  return newId;
}

// ---------- Cycles ----------
async function saveCycle(ctx, id, input) {
  if (!isAdmin(ctx)) throw E.forbidden('performance.manage');
  await ent.assertFeature(ctx.organizationId, 'performance');
  await ent.assertCanWrite(ctx.organizationId);
  const errors = {};
  const name = String(input.name || '').trim();
  if (!name) errors.name = 'Name is required.';
  for (const f of ['period_start', 'period_end']) if (!isDateStr(input[f])) errors[f] = 'Use YYYY-MM-DD.';
  for (const f of ['self_due', 'manager_due']) if (input[f] && !isDateStr(input[f])) errors[f] = 'Use YYYY-MM-DD.';
  if (!errors.period_end && !errors.period_start && input.period_end < input.period_start) errors.period_end = 'End date must be on or after the start date.';
  const weight = Number(input.goals_weight);
  if (Number.isNaN(weight) || weight < 0 || weight > 100) errors.goals_weight = 'Enter a percentage between 0 and 100.';
  const comps = await listCompetencies(ctx.organizationId, { activeOnly: true });
  const competencyIds = [].concat(input.competency_ids ?? []).map(Number).filter((c) => comps.some((x) => x.id === c));
  const departmentIds = [].concat(input.department_ids ?? []).map(Number).filter(Boolean);
  if (weight < 100 && !competencyIds.length) errors.competency_ids = 'Choose at least one competency, or give goals 100%.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const row = {
    name: name.slice(0, 150), kind: KINDS.includes(input.kind) ? input.kind : 'annual', period_start: input.period_start, period_end: input.period_end,
    self_due: input.self_due || null, manager_due: input.manager_due || null, include_self: input.include_self === 'on' || input.include_self === true,
    goals_weight: Math.round(weight), competency_ids: JSON.stringify(competencyIds), department_ids: JSON.stringify(departmentIds),
  };
  if (id) {
    const cycle = await knex('review_cycles').where({ id, organization_id: ctx.organizationId }).first();
    if (!cycle) throw E.notFound('Review cycle');
    if (cycle.status !== 'draft') throw new AppError('CYCLE_LAUNCHED', 'A launched cycle can no longer be changed.', 409);
    await knex('review_cycles').where({ id }).update(row);
    return Number(id);
  }
  const [newId] = await knex('review_cycles').insert({ ...row, organization_id: ctx.organizationId, status: 'draft', created_by: ctx.userId });
  await audit.record(ctx, 'review_cycle.created', { entityType: 'review_cycle', entityId: newId, newValues: { name } });
  return newId;
}

async function participants(organizationId, cycle) {
  const depts = parseJson(cycle.department_ids, []);
  const q = knex('employees as e').leftJoin('employees as m', 'm.id', 'e.manager_id')
    .where('e.organization_id', organizationId).whereNot('e.status', 'terminated')
    .where((w) => w.whereNull('e.joining_date').orWhere('e.joining_date', '<=', dstr(cycle.period_end)))
    .select('e.id', 'e.first_name', 'e.last_name', 'e.user_id', 'm.user_id as manager_user_id');
  if (depts.length) q.whereIn('e.department_id', depts);
  return q;
}

async function launchCycle(ctx, id) {
  if (!isAdmin(ctx)) throw E.forbidden('performance.manage');
  await ent.assertCanWrite(ctx.organizationId);
  const cycle = await knex('review_cycles').where({ id, organization_id: ctx.organizationId }).first();
  if (!cycle) throw E.notFound('Review cycle');
  if (cycle.status !== 'draft') throw new AppError('CYCLE_LAUNCHED', 'This cycle was already launched.', 409);
  const people = await participants(ctx.organizationId, cycle);
  if (!people.length) throw new AppError('CYCLE_EMPTY', 'Nobody matches this cycle.', 409);
  const comps = await knex('competencies').where({ organization_id: ctx.organizationId }).whereIn('id', parseJson(cycle.competency_ids, []));
  const goals = await knex('goals').where({ organization_id: ctx.organizationId, scope: 'individual' }).whereNot('status', 'cancelled')
    .whereIn('employee_id', people.map((p) => p.id))
    .where((w) => w.whereNull('due_date').orWhere('due_date', '>=', dstr(cycle.period_start)))
    .where((w) => w.whereNull('start_date').orWhere('start_date', '<=', dstr(cycle.period_end)))
    .orderBy('id');
  const status = cycle.include_self ? 'self_review' : 'manager_review';
  const toNotify = [];
  await knex.transaction(async (trx) => {
    const locked = await trx('review_cycles').where({ id }).forUpdate().first();
    if (locked.status !== 'draft') throw new AppError('CYCLE_LAUNCHED', 'This cycle was already launched.', 409);
    for (const p of people) {
      const reviewer = p.manager_user_id || cycle.created_by || ctx.userId;
      const [reviewId] = await trx('reviews').insert({ organization_id: ctx.organizationId, cycle_id: id, employee_id: p.id, reviewer_user_id: reviewer, status });
      const items = [
        ...goals.filter((g) => g.employee_id === p.id).map((g) => ({ item_type: 'goal', goal_id: g.id, title: g.title })),
        ...comps.map((c) => ({ item_type: 'competency', competency_id: c.id, title: c.name, title_ar: c.name_ar })),
      ];
      if (items.length) await trx('review_items').insert(items.map((it, i) => ({ ...it, organization_id: ctx.organizationId, review_id: reviewId, sort_order: i })));
      if (status === 'self_review' && p.user_id) toNotify.push([p.user_id, 'review_self', reviewId]);
      if (status === 'manager_review' && reviewer) toNotify.push([reviewer, 'review_manager', reviewId]);
    }
    await trx('review_cycles').where({ id }).update({ status: 'active', launched_at: new Date() });
    await audit.record(ctx, 'review_cycle.launched', { entityType: 'review_cycle', entityId: id, newValues: { name: cycle.name, reviews: people.length } }, trx);
    for (const [userId, type, reviewId] of toNotify) {
      await notifications.notify(ctx.organizationId, [userId], type, { cycle: cycle.name }, `/app/performance/reviews/${reviewId}`, trx);
    }
  });
  return people.length;
}

async function closeCycle(ctx, id) {
  if (!isAdmin(ctx)) throw E.forbidden('performance.manage');
  const cycle = await knex('review_cycles').where({ id, organization_id: ctx.organizationId }).first();
  if (!cycle) throw E.notFound('Review cycle');
  if (cycle.status !== 'active') throw new AppError('CYCLE_NOT_ACTIVE', 'Only an active cycle can be closed.', 409);
  await knex.transaction(async (trx) => {
    await trx('review_cycles').where({ id }).update({ status: 'closed', closed_at: new Date() });
    const done = await trx('reviews as r').join('employees as e', 'e.id', 'r.employee_id').where({ 'r.cycle_id': id, 'r.status': 'completed' }).whereNotNull('e.user_id').select('r.id', 'e.user_id');
    for (const r of done) await notifications.notify(ctx.organizationId, [r.user_id], 'review_released', { cycle: cycle.name }, `/app/performance/reviews/${r.id}`, trx);
    await audit.record(ctx, 'review_cycle.closed', { entityType: 'review_cycle', entityId: id, newValues: { name: cycle.name } }, trx);
  });
}

async function deleteDraft(ctx, id) {
  if (!isAdmin(ctx)) throw E.forbidden('performance.manage');
  const n = await knex('review_cycles').where({ id, organization_id: ctx.organizationId, status: 'draft' }).del();
  if (!n) throw new AppError('CYCLE_LAUNCHED', 'Only draft cycles can be deleted.', 409);
}

async function listCycles(ctx) {
  const cycles = await knex('review_cycles').where({ organization_id: ctx.organizationId }).orderByRaw("FIELD(status, 'active', 'draft', 'closed')").orderBy('period_end', 'desc');
  const counts = await knex('reviews').where({ organization_id: ctx.organizationId }).groupBy('cycle_id', 'status').select('cycle_id', 'status').count({ n: '*' });
  return cycles.map((c) => {
    const by = Object.fromEntries(counts.filter((x) => x.cycle_id === c.id).map((x) => [x.status, Number(x.n)]));
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    return { ...c, competency_ids: parseJson(c.competency_ids, []), department_ids: parseJson(c.department_ids, []), counts: by, total, completedPct: total ? Math.round(((by.completed || 0) / total) * 100) : 0 };
  });
}

async function getCycle(ctx, id) {
  const cycle = (await listCycles(ctx)).find((c) => c.id === Number(id));
  if (!cycle) throw E.notFound('Review cycle');
  const ids = await scopeIds(ctx);
  const q = knex('reviews as r').join('employees as e', 'e.id', 'r.employee_id').leftJoin('departments as d', 'd.id', 'e.department_id')
    .leftJoin('users as u', 'u.id', 'r.reviewer_user_id').where({ 'r.cycle_id': id, 'r.organization_id': ctx.organizationId })
    .select('r.*', 'e.first_name', 'e.last_name', 'e.job_title', 'd.name as department_name', 'u.name as reviewer_name').orderBy(['e.first_name', 'e.last_name']);
  if (ids !== null) q.where((w) => w.whereIn('r.employee_id', ids.length ? ids : [-1]).orWhere('r.reviewer_user_id', ctx.userId));
  cycle.reviews = await q;
  cycle.distribution = [1, 2, 3, 4, 5].map((n) => cycle.reviews.filter((r) => r.final_rating === n).length);
  return cycle;
}

// ---------- Reviews ----------
/** Loads a review and works out the viewer's role: self, reviewer, admin or viewer (manager in the line). */
async function getReview(ctx, id) {
  const review = await knex('reviews as r').join('review_cycles as c', 'c.id', 'r.cycle_id').join('employees as e', 'e.id', 'r.employee_id')
    .leftJoin('departments as d', 'd.id', 'e.department_id').leftJoin('users as u', 'u.id', 'r.reviewer_user_id')
    .where({ 'r.id': id, 'r.organization_id': ctx.organizationId })
    .first('r.*', 'c.name as cycle_name', 'c.status as cycle_status', 'c.period_start', 'c.period_end', 'c.self_due', 'c.manager_due', 'c.goals_weight', 'c.include_self',
      'e.first_name', 'e.last_name', 'e.job_title', 'e.user_id as employee_user_id', 'd.name as department_name', 'u.name as reviewer_name');
  if (!review) throw E.notFound('Review');
  const self = review.employee_user_id === ctx.userId;
  const reviewer = review.reviewer_user_id === ctx.userId;
  const admin = isAdmin(ctx);
  let viewer = false;
  if (!self && !reviewer && !admin) {
    const ids = await scopeIds(ctx);
    viewer = ids === null ? ctx.permissions.has('performance.view') : ids.includes(review.employee_id) && ctx.permissions.has('performance.view');
  }
  if (!self && !reviewer && !admin && !viewer) throw E.notFound('Review');
  review.role = { self, reviewer, admin, viewer };
  // The employee sees the manager's assessment only once the cycle is closed.
  review.showManager = !self || reviewer || admin || review.cycle_status === 'closed';
  review.items = await knex('review_items').where({ review_id: id }).orderBy('sort_order');
  if (!review.showManager) {
    for (const it of review.items) { it.manager_rating = null; it.manager_comment = null; }
    for (const f of ['manager_summary', 'strengths', 'improvements', 'goals_score', 'competency_score', 'final_score', 'final_rating']) review[f] = null;
  }
  review.canSelf = self && review.status === 'self_review' && review.cycle_status === 'active';
  review.canManage = (reviewer || admin) && review.cycle_status === 'active' && (review.status === 'manager_review' || (review.status === 'self_review' && admin));
  review.canAcknowledge = self && review.cycle_status === 'closed' && review.status === 'completed' && !review.acknowledged_at;
  return review;
}

const rating = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null; };

async function saveSelf(ctx, id, input, submit) {
  await ent.assertCanWrite(ctx.organizationId);
  const review = await getReview(ctx, id);
  if (!review.canSelf) throw new AppError('REVIEW_LOCKED', 'This review cannot be edited now.', 409);
  const items = review.items;
  if (submit && items.some((it) => !rating(input[`self_rating_${it.id}`]))) throw E.validation({ items: 'Rate every item before submitting.' });
  await knex.transaction(async (trx) => {
    for (const it of items) {
      await trx('review_items').where({ id: it.id }).update({ self_rating: rating(input[`self_rating_${it.id}`]), self_comment: input[`self_comment_${it.id}`] ? String(input[`self_comment_${it.id}`]).slice(0, 2000) : null });
    }
    const patch = { self_summary: input.self_summary ? String(input.self_summary).slice(0, 5000) : null };
    if (submit) Object.assign(patch, { status: 'manager_review', self_submitted_at: new Date() });
    await trx('reviews').where({ id }).update(patch);
    if (submit && review.reviewer_user_id && review.reviewer_user_id !== ctx.userId) {
      await notifications.notify(ctx.organizationId, [review.reviewer_user_id], 'review_manager', { cycle: review.cycle_name, name: `${review.first_name} ${review.last_name}` }, `/app/performance/reviews/${id}`, trx);
    }
  });
}

async function saveManager(ctx, id, input, submit) {
  await ent.assertCanWrite(ctx.organizationId);
  const review = await getReview(ctx, id);
  if (!review.canManage) throw new AppError('REVIEW_LOCKED', 'This review cannot be edited now.', 409);
  const items = review.items;
  if (submit && items.some((it) => !rating(input[`manager_rating_${it.id}`]))) throw E.validation({ items: 'Rate every item before submitting.' });
  const updated = items.map((it) => ({ ...it, manager_rating: rating(input[`manager_rating_${it.id}`]) }));
  const s = score(updated, Number(review.goals_weight));
  const override = rating(input.final_rating);
  await knex.transaction(async (trx) => {
    for (const it of updated) {
      await trx('review_items').where({ id: it.id }).update({ manager_rating: it.manager_rating, manager_comment: input[`manager_comment_${it.id}`] ? String(input[`manager_comment_${it.id}`]).slice(0, 2000) : null });
    }
    const patch = {
      manager_summary: input.manager_summary ? String(input.manager_summary).slice(0, 5000) : null,
      strengths: input.strengths ? String(input.strengths).slice(0, 5000) : null, improvements: input.improvements ? String(input.improvements).slice(0, 5000) : null,
      goals_score: s.goals_score, competency_score: s.competency_score, final_score: s.final_score, final_rating: override || s.final_rating,
    };
    if (submit) Object.assign(patch, { status: 'completed', manager_submitted_at: new Date() });
    await trx('reviews').where({ id }).update(patch);
    if (submit) await audit.record(ctx, 'review.completed', { entityType: 'review', entityId: id, newValues: { name: `${review.first_name} ${review.last_name}`, rating: patch.final_rating } }, trx);
  });
}

async function acknowledge(ctx, id, comment) {
  const review = await getReview(ctx, id);
  if (!review.canAcknowledge) throw new AppError('REVIEW_LOCKED', 'This review cannot be acknowledged now.', 409);
  await knex('reviews').where({ id }).update({ acknowledged_at: new Date(), employee_comment: comment ? String(comment).slice(0, 5000) : null });
  await audit.record(ctx, 'review.acknowledged', { entityType: 'review', entityId: id, newValues: { name: review.cycle_name } });
}

/** Reviews waiting for this user (their own self review, and reviews they must write). */
async function myQueue(ctx) {
  const base = () => knex('reviews as r').join('review_cycles as c', 'c.id', 'r.cycle_id').join('employees as e', 'e.id', 'r.employee_id')
    .where({ 'r.organization_id': ctx.organizationId, 'c.status': 'active' })
    .select('r.id', 'r.status', 'c.name as cycle_name', 'c.self_due', 'c.manager_due', 'e.first_name', 'e.last_name');
  const [mine, toWrite] = await Promise.all([
    base().where({ 'e.user_id': ctx.userId, 'r.status': 'self_review' }),
    base().where({ 'r.reviewer_user_id': ctx.userId, 'r.status': 'manager_review' }).orderBy('e.first_name'),
  ]);
  return { mine, toWrite };
}

async function reviewsForEmployee(ctx, employeeId) {
  const self = await employees.linkedEmployeeId(ctx);
  const q = knex('reviews as r').join('review_cycles as c', 'c.id', 'r.cycle_id').where({ 'r.organization_id': ctx.organizationId, 'r.employee_id': employeeId })
    .select('r.id', 'r.status', 'r.final_rating', 'r.final_score', 'c.name as cycle_name', 'c.status as cycle_status', 'c.period_end').orderBy('c.period_end', 'desc');
  const rows = await q;
  // An employee only sees their rating after the cycle closes.
  if (self === Number(employeeId) && !isAdmin(ctx)) for (const r of rows) if (r.cycle_status !== 'closed') { r.final_rating = null; r.final_score = null; }
  return rows;
}

// ---------- Feedback ----------
async function giveFeedback(ctx, input) {
  await ent.assertFeature(ctx.organizationId, 'performance');
  await ent.assertCanWrite(ctx.organizationId);
  const employeeId = Number(input.employee_id);
  const body = String(input.body || '').trim();
  const errors = {};
  const employee = employeeId ? await knex('employees').where({ id: employeeId, organization_id: ctx.organizationId }).whereNot('status', 'terminated').first() : null;
  if (!employee) errors.employee_id = 'Choose an employee.';
  if (!body) errors.body = 'Write your feedback.';
  if (Object.keys(errors).length) throw E.validation(errors);
  if (employee.user_id === ctx.userId) throw E.validation({ employee_id: 'Choose someone other than yourself.' });
  const kind = input.kind === 'suggestion' ? 'suggestion' : 'praise';
  const visibility = kind === 'praise' && (input.visibility === 'public' || input.public === 'on') ? 'public' : 'private';
  const [id] = await knex('feedback').insert({ organization_id: ctx.organizationId, from_user_id: ctx.userId, employee_id: employeeId, kind, visibility, body: body.slice(0, 2000) });
  if (employee.user_id) await notifications.notify(ctx.organizationId, [employee.user_id], 'feedback_received', { kind }, '/app/performance/feedback', knex);
  return id;
}

/** Public praise for everyone, plus private feedback the viewer may see (received, given, or about their team). */
async function listFeedback(ctx, { employeeId } = {}) {
  const self = await employees.linkedEmployeeId(ctx);
  const ids = await scopeIds(ctx);
  const q = knex('feedback as f').join('employees as e', 'e.id', 'f.employee_id').leftJoin('users as u', 'u.id', 'f.from_user_id')
    .where('f.organization_id', ctx.organizationId)
    .select('f.*', 'e.first_name', 'e.last_name', 'e.job_title', 'u.name as from_name').orderBy('f.id', 'desc').limit(100);
  if (employeeId) q.where('f.employee_id', employeeId);
  q.where((w) => {
    w.where('f.visibility', 'public').orWhere('f.from_user_id', ctx.userId);
    if (self) w.orWhere('f.employee_id', self);
    if (ids === null) { if (ctx.permissions.has('performance.view')) w.orWhereNotNull('f.id'); } else if (ids.length && ctx.permissions.has('performance.view')) w.orWhereIn('f.employee_id', ids);
  });
  return q;
}

module.exports = {
  KINDS, score, listCompetencies, saveCompetency, saveCycle, launchCycle, closeCycle, deleteDraft, listCycles, getCycle,
  getReview, saveSelf, saveManager, acknowledge, myQueue, reviewsForEmployee, giveFeedback, listFeedback, participants,
};
