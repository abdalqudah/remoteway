const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const goalsSvc = require('../src/modules/performance/goals.service');
const reviewsSvc = require('../src/modules/performance/reviews.service');

describe('Phase 5 — performance (pure)', () => {
  test('key result progress handles rising, falling and reached targets', () => {
    assert.equal(goalsSvc.krProgress({ start_value: 0, target_value: 200, current_value: 50 }), 25);
    assert.equal(goalsSvc.krProgress({ start_value: 10, target_value: 2, current_value: 4 }), 75); // lower is better
    assert.equal(goalsSvc.krProgress({ start_value: 0, target_value: 10, current_value: 15 }), 100); // clamped
    assert.equal(goalsSvc.krProgress({ start_value: 0, target_value: 10, current_value: -3 }), 0);
    assert.equal(goalsSvc.krProgress({ start_value: 5, target_value: 5, current_value: 5 }), 100);
    assert.equal(goalsSvc.goalProgress([{ start_value: 0, target_value: 10, current_value: 5 }, { start_value: 0, target_value: 1, current_value: 1 }]), 75);
    assert.equal(goalsSvc.goalProgress([]), null);
  });

  test('review score weights goals and competencies, and falls back when one is missing', () => {
    const items = [{ item_type: 'goal', manager_rating: 4 }, { item_type: 'goal', manager_rating: 5 }, { item_type: 'competency', manager_rating: 3 }];
    assert.deepEqual(reviewsSvc.score(items, 60), { goals_score: 4.5, competency_score: 3, final_score: 3.9, final_rating: 4 });
    assert.equal(reviewsSvc.score(items, 0).final_score, 3);
    assert.deepEqual(reviewsSvc.score([{ item_type: 'competency', manager_rating: 2 }], 60), { goals_score: null, competency_score: 2, final_score: 2, final_rating: 2 });
    assert.equal(reviewsSvc.score([], 50).final_rating, null);
  });
});

describe('Phase 5 — performance (integration)', () => {
  let C; let O; let owner; let other; let hrU; let hr; let mgrU; let mgr; let saraU; let sara; let noraU; let nora;
  let mgrEmp; let saraEmp; let noraEmp;

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
    mgrEmp = (await h.createEmployee(owner, { first_name: 'Omar', email: mgrU.email })).body.data;
    saraEmp = (await h.createEmployee(owner, { first_name: 'Sara', email: saraU.email, manager_id: mgrEmp.id })).body.data;
    noraEmp = (await h.createEmployee(owner, { first_name: 'Nora', email: noraU.email })).body.data;
  });
  after(() => h.knex.destroy());

  test('performance is not part of the Starter plan', async () => {
    const S = await h.createCompany({ plan: 'starter' });
    const s = await h.login(S.email, S.password);
    assert.equal((await s.get('/app/performance')).status, 402);
  });

  let companyGoal; let saraGoal;
  test('goal permissions: own goals, manager for reports, HR for company goals', async () => {
    const c = await hr.form('/app/performance/goals', { scope: 'company', title: 'Grow revenue', kr_title: ['ARR'], kr_start: [0], kr_target: [10], kr_unit: ['M'], kr_id: [''] });
    assert.equal(c.status, 302, c.text.slice(0, 300));
    companyGoal = Number(c.headers.location.split('/').pop());
    // Sara sets her own goal (no owner field → herself), aligned to the company goal.
    const own = await sara.form('/app/performance/goals', { title: 'Ship billing', parent_id: companyGoal, kr_title: ['Screens', 'Coverage'], kr_start: [0, 40], kr_target: [6, 80], kr_unit: ['', '%'], kr_id: ['', ''] });
    assert.equal(own.status, 302, own.text.slice(0, 300));
    saraGoal = Number(own.headers.location.split('/').pop());
    const g = await h.knex('goals').where({ id: saraGoal }).first();
    assert.equal(g.employee_id, saraEmp.id);
    assert.equal(g.parent_id, companyGoal);
    // Employees cannot create company goals or goals for others.
    assert.equal((await sara.form('/app/performance/goals', { scope: 'company', title: 'Mine now' })).status, 403);
    assert.equal((await sara.form('/app/performance/goals', { title: 'For Nora', employee_id: noraEmp.id })).status, 403);
    // A manager sets goals for their report, not for others.
    assert.equal((await mgr.form('/app/performance/goals', { title: 'For Sara', employee_id: saraEmp.id })).status, 302);
    assert.equal((await mgr.form('/app/performance/goals', { title: 'For Nora', employee_id: noraEmp.id })).status, 403);
    assert.ok(await h.knex('notifications').where({ user_id: saraU.userId, type: 'goal_assigned' }).first());
    // Validation.
    assert.equal((await sara.form('/app/performance/goals', { title: 'Bad KR', kr_title: ['X'], kr_start: [0], kr_target: [''], kr_id: [''] })).status, 422);
  });

  test('goal visibility: individual goals stay within the line; company goals are for everyone', async () => {
    assert.equal((await nora.get(`/app/performance/goals/${saraGoal}`)).status, 404);
    assert.equal((await mgr.get(`/app/performance/goals/${saraGoal}`)).status, 200);
    assert.equal((await hr.get(`/app/performance/goals/${saraGoal}`)).status, 200);
    assert.equal((await nora.get(`/app/performance/goals/${companyGoal}`)).status, 200);
    assert.equal((await other.get(`/app/performance/goals/${companyGoal}`)).status, 404);
    const list = await nora.api('get', '/api/v1/performance/goals');
    assert.deepEqual(list.body.data.map((x) => x.id), [companyGoal]);
  });

  test('check-ins move key results and progress; only the owner line can check in', async () => {
    const krs = await h.knex('goal_key_results').where({ goal_id: saraGoal }).orderBy('sort_order');
    const r = await sara.form(`/app/performance/goals/${saraGoal}/checkin`, { [`kr_${krs[0].id}`]: 3, [`kr_${krs[1].id}`]: 60, health: 'at_risk', note: 'Halfway' });
    assert.equal(r.status, 302);
    const g = await h.knex('goals').where({ id: saraGoal }).first();
    assert.equal(Number(g.progress), 50); // (50% + 50%) / 2
    assert.equal(g.health, 'at_risk');
    assert.equal((await h.knex('goal_checkins').where({ goal_id: saraGoal })).length, 1);
    await nora.form(`/app/performance/goals/${saraGoal}/checkin`, { [`kr_${krs[0].id}`]: 6 });
    assert.equal(Number((await h.knex('goal_key_results').where({ id: krs[0].id }).first()).current_value), 3);
    // Employees cannot check in on the company goal.
    await sara.form(`/app/performance/goals/${companyGoal}/checkin`, { progress: 90 });
    assert.equal(Number((await h.knex('goals').where({ id: companyGoal }).first()).progress), 0);
  });

  let cycleId; let saraReview;
  test('only HR creates and launches cycles; launch builds reviews with goals and competencies', async () => {
    const comps = await reviewsSvc.listCompetencies(C.organizationId);
    const body = { name: 'H2 review', kind: 'semi_annual', period_start: '2026-07-01', period_end: '2026-12-31', include_self: 'on', goals_weight: 60, competency_ids: comps.slice(0, 2).map((x) => String(x.id)) };
    assert.equal((await mgr.form('/app/performance/cycles', body)).status, 403);
    const res = await hr.form('/app/performance/cycles', body);
    assert.equal(res.status, 302, res.text.slice(0, 300));
    cycleId = Number(res.headers.location.split('/').pop());
    assert.equal((await hr.form(`/app/performance/cycles/${cycleId}/launch`, {})).status, 302);
    const reviews = await h.knex('reviews').where({ cycle_id: cycleId });
    assert.equal(reviews.length, 3);
    saraReview = reviews.find((r) => r.employee_id === saraEmp.id);
    assert.equal(saraReview.reviewer_user_id, mgrU.userId);
    assert.equal(saraReview.status, 'self_review');
    const items = await h.knex('review_items').where({ review_id: saraReview.id });
    assert.equal(items.filter((i) => i.item_type === 'goal').length, 2); // her own goal + the one her manager set
    assert.equal(items.filter((i) => i.item_type === 'competency').length, 2);
    assert.ok(await h.knex('notifications').where({ user_id: saraU.userId, type: 'review_self' }).first());
    assert.equal((await hr.form(`/app/performance/cycles/${cycleId}/launch`, {})).status, 302);
    assert.equal((await h.knex('reviews').where({ cycle_id: cycleId })).length, 3); // launching twice does nothing
  });

  test('self review: only the employee, all items rated to submit', async () => {
    const items = await h.knex('review_items').where({ review_id: saraReview.id });
    assert.equal((await nora.get(`/app/performance/reviews/${saraReview.id}`)).status, 404);
    assert.equal((await other.get(`/app/performance/reviews/${saraReview.id}`)).status, 404);
    const partial = await sara.form(`/app/performance/reviews/${saraReview.id}/self`, { action: 'submit', [`self_rating_${items[0].id}`]: 4 });
    assert.equal(partial.status, 422);
    const full = { action: 'submit', self_summary: 'Good half' };
    for (const it of items) full[`self_rating_${it.id}`] = 4;
    assert.equal((await sara.form(`/app/performance/reviews/${saraReview.id}/self`, full)).status, 302);
    assert.equal((await h.knex('reviews').where({ id: saraReview.id }).first()).status, 'manager_review');
    assert.ok(await h.knex('notifications').where({ user_id: mgrU.userId, type: 'review_manager' }).first());
    // Sara cannot write her manager's part.
    assert.equal((await sara.form(`/app/performance/reviews/${saraReview.id}/manager`, { action: 'submit' })).status, 409);
  });

  test('manager review is scored and stays hidden from the employee until the cycle closes', async () => {
    const items = await h.knex('review_items').where({ review_id: saraReview.id });
    const input = { action: 'submit', manager_summary: 'SECRET-MANAGER-NOTE' };
    for (const it of items) input[`manager_rating_${it.id}`] = it.item_type === 'goal' ? 5 : 3;
    assert.equal((await mgr.form(`/app/performance/reviews/${saraReview.id}/manager`, input)).status, 302);
    const r = await h.knex('reviews').where({ id: saraReview.id }).first();
    assert.equal(r.status, 'completed');
    assert.equal(Number(r.final_score), 4.2); // 5×60% + 3×40%
    assert.equal(r.final_rating, 4);
    const before = await sara.get(`/app/performance/reviews/${saraReview.id}`);
    assert.equal(before.status, 200);
    assert.doesNotMatch(before.text, /SECRET-MANAGER-NOTE/);
    const api = await sara.api('get', `/api/v1/performance/reviews/${saraReview.id}`);
    assert.equal(api.body.data.final_rating, null);
    assert.equal(api.body.data.items.every((i) => i.manager_rating === null), true);
    assert.equal((await sara.form(`/app/performance/reviews/${saraReview.id}/acknowledge`, {})).status, 409);
    // Close → released.
    assert.equal((await mgr.form(`/app/performance/cycles/${cycleId}/close`, {})).status, 403);
    assert.equal((await hr.form(`/app/performance/cycles/${cycleId}/close`, {})).status, 302);
    const after = await sara.get(`/app/performance/reviews/${saraReview.id}`);
    assert.match(after.text, /SECRET-MANAGER-NOTE/);
    assert.ok(await h.knex('notifications').where({ user_id: saraU.userId, type: 'review_released' }).first());
    assert.equal((await sara.form(`/app/performance/reviews/${saraReview.id}/acknowledge`, { comment: 'Thanks' })).status, 302);
    assert.ok((await h.knex('reviews').where({ id: saraReview.id }).first()).acknowledged_at);
    // Closed cycles are locked.
    assert.equal((await mgr.form(`/app/performance/reviews/${saraReview.id}/manager`, { action: 'save' })).status, 409);
  });

  test('feedback: public praise for all, private feedback only for the people concerned', async () => {
    assert.equal((await sara.form('/app/performance/feedback', { employee_id: saraEmp.id, body: 'Me!' })).status, 422);
    assert.equal((await mgr.form('/app/performance/feedback', { employee_id: saraEmp.id, kind: 'suggestion', body: 'PRIVATE-TIP', public: 'on' })).status, 302);
    assert.equal((await nora.form('/app/performance/feedback', { employee_id: saraEmp.id, kind: 'praise', body: 'PUBLIC-THANKS', public: 'on' })).status, 302);
    const tip = await h.knex('feedback').where({ body: 'PRIVATE-TIP' }).first();
    assert.equal(tip.visibility, 'private'); // suggestions are never public
    const seen = async (s) => (await s.api('get', '/api/v1/performance/feedback')).body.data.map((f) => f.body);
    assert.ok((await seen(sara)).includes('PRIVATE-TIP'));
    assert.ok((await seen(mgr)).includes('PRIVATE-TIP'));
    assert.ok((await seen(hr)).includes('PRIVATE-TIP'));
    assert.ok(!(await seen(nora)).includes('PRIVATE-TIP'));
    assert.ok((await seen(nora)).includes('PUBLIC-THANKS'));
    assert.equal((await seen(other)).length, 0);
    assert.ok(await h.knex('notifications').where({ user_id: saraU.userId, type: 'feedback_received' }).first());
  });
});
