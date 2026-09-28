// AI layer: governance (platform config, plan, company switches), quota metering, provider formats,
// output validation, data minimisation, access rules per feature, saved insights and tenant isolation.
process.env.INTEGRATIONS_ALLOW_PRIVATE = 'true'; // talk to the local AI stub in these tests only
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const h = require('./helpers');
const stubServer = require('./ai-stub');
const secrets = require('../src/core/secrets');
const storage = require('../src/core/storage');
const ai = require('../src/modules/ai/ai.service');
const providers = require('../src/modules/ai/providers');
const extract = require('../src/modules/ai/extract');

let stub;
const fetchPost = (s, url, body = {}) => s.agent.post(url).type('form').set('x-csrf-token', s.csrf).set('x-requested-with', 'fetch').set('accept', 'application/json').send({ _csrf: s.csrf, ...body });

async function configurePlatform(extra = {}) {
  const value = JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5', api_key_enc: secrets.encrypt('sk-test-123'), enabled: true, max_tokens: 1500, price_in: 3, price_out: 15, ...extra });
  await h.knex('platform_settings').insert({ key: 'ai', value }).onConflict('key').merge({ value });
  ai.invalidateConfig();
}
async function enableOrg(organizationId, features = ai.AREA_KEYS) {
  await h.knex('ai_settings').insert({ organization_id: organizationId, enabled: true, features: JSON.stringify(features) }).onConflict('organization_id').merge();
  h.cache.clear();
}
function docx(text) {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0"?><w:document><w:body>${text.split('\n').map((l) => `<w:p><w:r><w:t>${l.replace(/&/g, '&amp;')}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`));
  return zip.toBuffer();
}

async function recruitmentFixture(organizationId, { cv } = {}) {
  const [jobId] = await h.knex('jobs').insert({ organization_id: organizationId, title: 'Payroll Specialist', slug: `payroll-${Date.now()}`, status: 'open', description: 'Run payroll', requirements: '- 3+ years in payroll\n- GOSI', skills: JSON.stringify(['Payroll']) });
  let cvCols = {};
  if (cv) {
    const key = storage.newKey(organizationId, 'cvs');
    await storage.put(key, cv);
    cvCols = { cv_storage_key: key, cv_name: 'cv.docx', cv_mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', cv_size: cv.length };
  }
  const [candidateId] = await h.knex('candidates').insert({ organization_id: organizationId, first_name: 'Sara', last_name: 'Ali', email: `sara${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`, current_title: 'Payroll specialist', experience_years: 5, skills: JSON.stringify(['Payroll']), ...cvCols });
  const [applicationId] = await h.knex('applications').insert({ organization_id: organizationId, job_id: jobId, candidate_id: candidateId, stage: 'screening', cover_note: 'Call me on 0551234567 or sara@example.com' });
  return { jobId, candidateId, applicationId };
}

before(async () => {
  await h.resetDatabase();
  stub = await stubServer.start();
  process.env.AI_PROVIDER_BASE_URL = stub.url;
});
after(async () => {
  delete process.env.AI_PROVIDER_BASE_URL;
  stub.server.close();
  await h.knex.destroy();
});

describe('Phase 8 — AI (units)', () => {
  test('redaction masks contact details and IDs but keeps dates and amounts', () => {
    const out = ai.redact('Mail a.b@x.com, call +966 55 123 4567 or 0551234567, IBAN SA0380000000608010167519, ID 1012345678. Joined 2024-01-15, salary 15000.00');
    assert.ok(!out.includes('a.b@x.com') && !out.includes('0551234567') && !out.includes('608010167519') && !out.includes('1012345678'), out);
    assert.ok(out.includes('2024-01-15') && out.includes('15000.00'), out);
  });

  test('JSON answers are parsed even inside code fences', () => {
    assert.deepEqual(ai.parseJson('```json\n{"a": 1}\n```'), { a: 1 });
    assert.deepEqual(ai.parseJson('Here you go: {"a": 2} thanks'), { a: 2 });
    assert.equal(ai.parseJson('no json'), null);
  });

  test('Word CVs are converted to text', () => {
    assert.equal(extract.docxText(docx('Line one\nA & B')), 'Line one\nA & B');
  });

  test('each provider adapter speaks its own API format', async () => {
    const pdf = { mime: 'application/pdf', name: 'a.pdf', data: Buffer.from('%PDF-1.4 test') };
    const cases = [
      ['anthropic', { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'k1' }, (r) => {
        assert.equal(r.url, '/v1/messages'); assert.equal(r.headers['x-api-key'], 'k1'); assert.equal(r.headers['anthropic-version'], '2023-06-01');
        assert.equal(r.json.model, 'claude-sonnet-5'); assert.equal(r.json.messages[0].content[0].type, 'document');
      }],
      ['openai', { provider: 'openai', model: 'gpt-x', apiKey: 'k2' }, (r) => {
        assert.equal(r.url, '/v1/chat/completions'); assert.equal(r.headers.authorization, 'Bearer k2');
        assert.equal(r.json.messages[0].role, 'system'); assert.equal(r.json.messages[1].content[0].type, 'file'); assert.equal(r.json.response_format.type, 'json_object');
      }],
      ['gemini', { provider: 'gemini', model: 'gemini-x', apiKey: 'k3' }, (r) => {
        assert.equal(r.url, '/v1beta/models/gemini-x:generateContent'); assert.equal(r.headers['x-goog-api-key'], 'k3');
        assert.equal(r.json.contents[0].parts[0].inline_data.mime_type, 'application/pdf');
      }],
      ['azure', { provider: 'azure', model: 'dep1', deployment: 'dep1', apiKey: 'k4', apiVersion: '2024-10-21' }, (r) => {
        assert.equal(r.url, '/openai/deployments/dep1/chat/completions?api-version=2024-10-21'); assert.equal(r.headers['api-key'], 'k4');
      }],
    ];
    for (const [name, cfg, check] of cases) {
      stub.requests.length = 0;
      const files = providers.accepts(cfg.provider, pdf.mime) ? [pdf] : [];
      const out = await providers.complete(cfg, { system: 'sys', prompt: 'Return {"ok": true}.', files });
      assert.equal(out.tokensIn, 120, name); assert.equal(out.tokensOut, 80, name);
      assert.deepEqual(ai.parseJson(out.text), { ok: true }, name);
      check(stub.requests[0]);
    }
    assert.equal(providers.accepts('azure', 'application/pdf'), false);
  });

  test('provider errors are explained without leaking the key', async () => {
    stub.status = 401;
    await assert.rejects(providers.complete({ provider: 'anthropic', model: 'm', apiKey: 'secret-key' }, { system: 's', prompt: 'p' }), (e) => /API key/.test(e.message) && !e.message.includes('secret-key'));
    stub.status = 200;
  });
});

describe('Phase 8 — AI (governance, quota, features)', () => {
  let co; let owner;
  before(async () => {
    co = await h.createCompany({ plan: 'professional' });
    owner = await h.login(co.email, co.password);
  });

  test('nothing runs until the platform is configured and the company switches AI on', async () => {
    stub.requests.length = 0;
    let r = await fetchPost(owner, '/app/ai/recruitment/job-description', { title: 'Payroll Specialist' });
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'AI_NOT_CONFIGURED');
    await configurePlatform();
    r = await fetchPost(owner, '/app/ai/recruitment/job-description', { title: 'Payroll Specialist' });
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'AI_DISABLED');
    assert.equal(stub.requests.length, 0);
    // Company switch through Settings → AI (ai.manage)
    r = await owner.form('/app/settings/ai', { enabled: 'on', features: ['recruitment', 'documents', 'performance', 'learning', 'analytics'] });
    assert.equal(r.status, 302);
    h.cache.clear();
    const page = await owner.get('/app/settings/ai');
    assert.equal(page.status, 200);
    assert.match(page.text, /name="features" value="recruitment" checked/);
  });

  test('job description draft: validated output rendered with "use this" buttons, request metered and logged', async () => {
    stub.requests.length = 0;
    const r = await fetchPost(owner, '/app/ai/recruitment/job-description', { title: 'Payroll Specialist', description: 'Contact hr@acme.com', skills: 'Payroll' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.html, /data-ai-insert="f-description"/);
    assert.match(r.body.html, /GOSI/);
    assert.ok(!stub.requests[0].prompt.includes('hr@acme.com'), 'emails are masked before sending');
    assert.match(stub.requests[0].json.system, /never make or recommend hiring/);
    const usage = await h.knex('usage_records').where({ organization_id: co.organizationId, metric: 'ai_requests' }).first();
    assert.equal(Number(usage.quantity), 1);
    const log = await h.knex('ai_requests').where({ organization_id: co.organizationId }).orderBy('id', 'desc').first();
    assert.equal(log.status, 'ok'); assert.equal(log.tokens_in, 120); assert.equal(log.action, 'job_description');
    assert.equal(Number(log.cost_usd), Number(((120 * 3 + 80 * 15) / 1e6).toFixed(6)));
  });

  test('failed and invalid answers are not counted; the quota limit is enforced', async () => {
    const before = Number((await h.knex('usage_records').where({ organization_id: co.organizationId, metric: 'ai_requests' }).first()).quantity);
    stub.status = 500;
    let r = await fetchPost(owner, '/app/ai/recruitment/job-description', { title: 'Payroll Specialist' });
    assert.equal(r.status, 502); assert.equal(r.body.error.code, 'AI_PROVIDER_ERROR');
    stub.status = 200;
    stub.raw = 'not json at all';
    r = await fetchPost(owner, '/app/ai/recruitment/job-description', { title: 'Payroll Specialist' });
    assert.equal(r.status, 502); assert.equal(r.body.error.code, 'AI_INVALID_OUTPUT');
    stub.raw = null;
    const afterFail = Number((await h.knex('usage_records').where({ organization_id: co.organizationId, metric: 'ai_requests' }).first()).quantity);
    assert.equal(afterFail, before);
    const statuses = (await h.knex('ai_requests').where({ organization_id: co.organizationId }).orderBy('id', 'desc').limit(2)).map((x) => x.status);
    assert.deepEqual(statuses, ['invalid', 'error']);

    await h.knex('subscriptions').where({ organization_id: co.organizationId }).update({ custom_limits: JSON.stringify({ ai_requests_monthly: before + 1 }) });
    h.cache.clear();
    r = await fetchPost(owner, '/app/ai/recruitment/job-description', { title: 'Payroll Specialist' });
    assert.equal(r.status, 200);
    r = await fetchPost(owner, '/app/ai/recruitment/job-description', { title: 'Payroll Specialist' });
    assert.equal(r.status, 402); assert.equal(r.body.error.code, 'USAGE_LIMIT_REACHED');
    await h.knex('subscriptions').where({ organization_id: co.organizationId }).update({ custom_limits: null });
    h.cache.clear();
  });

  test('candidate match reads the Word CV, masks contacts, saves the insight and shows it on the application', async () => {
    const f = await recruitmentFixture(co.organizationId, { cv: docx('Five years as payroll specialist\nEmail: sara@example.com') });
    stub.requests.length = 0;
    const r = await fetchPost(owner, `/app/ai/recruitment/applications/${f.applicationId}/match`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = stub.requests[0].prompt;
    assert.ok(p.includes('Five years as payroll specialist'));
    assert.ok(!p.includes('sara@example.com') && !p.includes('0551234567'));
    assert.ok(!p.includes('Sara'), 'the candidate name is not sent');
    const page = await owner.get(`/app/recruitment/applications/${f.applicationId}`);
    assert.match(page.text, /How have you handled GOSI contributions\?/);
    // A recruiter without the company AI switch for recruitment gets nothing
    await enableOrg(co.organizationId, ['documents', 'performance', 'learning', 'analytics']);
    const off = await fetchPost(owner, `/app/ai/recruitment/applications/${f.applicationId}/match`);
    assert.equal(off.status, 409);
    await enableOrg(co.organizationId);
  });

  test('another company cannot run AI on this company\'s records', async () => {
    const f = await recruitmentFixture(co.organizationId);
    const other = await h.createCompany({ plan: 'professional' });
    await enableOrg(other.organizationId);
    const s = await h.login(other.email, other.password);
    const r = await fetchPost(s, `/app/ai/recruitment/applications/${f.applicationId}/match`);
    assert.equal(r.status, 404);
  });

  test('document summary attaches the PDF and needs documents access', async () => {
    const key = storage.newKey(co.organizationId, 'documents');
    const pdf = Buffer.from('%PDF-1.4\n% contract');
    await storage.put(key, pdf);
    const [docId] = await h.knex('documents').insert({ organization_id: co.organizationId, category: 'contract', title: 'Contract' });
    await h.knex('document_versions').insert({ organization_id: co.organizationId, document_id: docId, version: 1, storage_key: key, original_name: 'c.pdf', mime_type: 'application/pdf', size_bytes: pdf.length, sha256: 'x' });
    stub.requests.length = 0;
    const r = await fetchPost(owner, `/app/ai/documents/${docId}/summary`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(stub.requests[0].json.messages[0].content[0].type, 'document');
    assert.match(r.body.html, /data-ai-insert="f-expires_at" data-ai-text="2026-12-31"/);
    const saved = await ai.latestInsight(co.organizationId, 'document_summary', 'document', docId);
    assert.equal(saved.output.expiry_date, '2026-12-31');
    const emp = await h.addMember(co.organizationId, 'employee');
    const es = await h.login(emp.email, emp.password);
    const denied = await fetchPost(es, `/app/ai/documents/${docId}/summary`);
    assert.equal(denied.status, 403);
  });

  test('review draft is only for the person writing the review and never proposes a rating', async () => {
    const mgr = await h.addMember(co.organizationId, 'department_manager');
    const [empId] = await h.knex('employees').insert({ organization_id: co.organizationId, employee_number: `E${Date.now()}`, first_name: 'Omar', last_name: 'K' });
    const [cycleId] = await h.knex('review_cycles').insert({ organization_id: co.organizationId, name: 'H1', period_start: '2026-01-01', period_end: '2026-06-30', status: 'active', include_self: false });
    const [reviewId] = await h.knex('reviews').insert({ organization_id: co.organizationId, cycle_id: cycleId, employee_id: empId, reviewer_user_id: mgr.userId, status: 'manager_review' });
    const [itemId] = await h.knex('review_items').insert({ organization_id: co.organizationId, review_id: reviewId, item_type: 'competency', title: 'Communication' });
    const ms = await h.login(mgr.email, mgr.password);
    stub.requests.length = 0;
    const r = await fetchPost(ms, `/app/ai/performance/reviews/${reviewId}/draft`, { [`manager_rating_${itemId}`]: '4', [`manager_comment_${itemId}`]: 'Clear updates every week' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(stub.requests[0].prompt.includes('Clear updates every week'));
    assert.match(stub.requests[0].prompt, /Do not propose or change any rating/);
    assert.match(r.body.html, /data-ai-insert="rv-str"/);
    const outsider = await h.addMember(co.organizationId, 'employee');
    const os = await h.login(outsider.email, outsider.password);
    const denied = await fetchPost(os, `/app/ai/performance/reviews/${reviewId}/draft`);
    assert.equal(denied.status, 404);
  });

  test('quiz questions are validated (4 options, one correct) and need learning.manage', async () => {
    const [courseId] = await h.knex('courses').insert({ organization_id: co.organizationId, title: 'Leave policy' });
    await h.knex('course_lessons').insert({ organization_id: co.organizationId, course_id: courseId, title: 'Basics', kind: 'text', body: 'Managers approve leave. The pass mark is 70%.' });
    const r = await fetchPost(owner, `/app/ai/learning/courses/${courseId}/quiz`, { count: '5' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.html, /data-ai-quiz/);
    stub.reply = () => ({ questions: [{ question: 'Q', options: ['a', 'b'], correct_index: 0 }] });
    const bad = await fetchPost(owner, `/app/ai/learning/courses/${courseId}/quiz`, {});
    assert.equal(bad.status, 502);
    stub.reply = null;
    const rec = await h.addMember(co.organizationId, 'recruiter');
    const rs = await h.login(rec.email, rec.password);
    assert.equal((await fetchPost(rs, `/app/ai/learning/courses/${courseId}/quiz`)).status, 403);
  });

  test('analytics assistant sends only aggregate metrics the user may see and keeps a history', async () => {
    stub.requests.length = 0;
    const r = await owner.form('/app/insights/ask', { question: 'How many people work here?' });
    assert.equal(r.status, 302);
    const sent = stub.requests[0].prompt;
    assert.match(sent, /"headcount":/);
    assert.match(sent, /"payroll":/);
    assert.ok(!sent.includes('Omar'), 'no employee names');
    const page = await owner.get('/app/insights');
    assert.match(page.text, /Headcount is stable\./);
    // A suggestion button and the empty text box share the field name: the chosen text is used as-is.
    stub.requests.length = 0;
    await owner.agent.post('/app/insights/ask').type('form').send(`_csrf=${encodeURIComponent(owner.csrf)}&question=&question=${encodeURIComponent('Who left this year?')}`);
    assert.match(stub.requests[0].prompt, /## Question\nWho left this year\?/);
    // A department manager has reports.view but no company-wide employee or payroll access
    const mgr = await h.addMember(co.organizationId, 'department_manager');
    const ms = await h.login(mgr.email, mgr.password);
    stub.requests.length = 0;
    await ms.form('/app/insights/ask', { question: 'What is our payroll cost?' });
    assert.ok(!stub.requests[0].prompt.includes('"payroll":') && !stub.requests[0].prompt.includes('"headcount":'));
    const emp = await h.addMember(co.organizationId, 'employee');
    const es = await h.login(emp.email, emp.password);
    assert.equal((await es.get('/app/insights')).status, 403);
  });

  test('plans without AI features cannot use them even when switched on', async () => {
    const biz = await h.createCompany({ plan: 'business' });
    await enableOrg(biz.organizationId);
    const s = await h.login(biz.email, biz.password);
    const r = await fetchPost(s, '/app/ai/recruitment/job-description', { title: 'Accountant' });
    assert.equal(r.status, 402); assert.equal(r.body.error.code, 'FEATURE_NOT_IN_PLAN');
    const form = await s.get('/app/recruitment/jobs/new');
    assert.ok(!form.text.includes('data-ai-run'), 'no AI button is shown');
  });

  test('Settings → AI requires ai.manage', async () => {
    const hr = await h.addMember(co.organizationId, 'hr_manager');
    const s = await h.login(hr.email, hr.password);
    assert.equal((await s.get('/app/settings/ai')).status, 403);
  });
});

describe('Phase 8 — AI (Super Admin)', () => {
  test('the API key is stored encrypted, kept when left empty, and the connection test uses the stub', async () => {
    const bcrypt = require('bcryptjs');
    const [adminId] = await h.knex('users').insert({ name: 'Root', email: `root${Date.now()}@test.local`, password_hash: await bcrypt.hash('Password#123', 4), is_super_admin: true });
    const admin = await h.knex('users').where({ id: adminId }).first();
    const s = await h.login(admin.email, 'Password#123');
    let r = await s.form('/admin/ai', { provider: 'openai', model: 'gpt-test', api_key: 'sk-live-abcdef123456', enabled: 'on', max_tokens: '1200' });
    assert.equal(r.status, 302);
    const row = await h.knex('platform_settings').where({ key: 'ai' }).first();
    const saved = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    assert.ok(!JSON.stringify(saved).includes('sk-live-abcdef123456'));
    assert.equal(secrets.decrypt(saved.api_key_enc), 'sk-live-abcdef123456');
    r = await s.form('/admin/ai', { provider: 'openai', model: 'gpt-test-2', api_key: '', enabled: 'on', max_tokens: '1200' });
    assert.equal(r.status, 302);
    ai.invalidateConfig();
    assert.equal((await ai.config()).apiKey, 'sk-live-abcdef123456');
    stub.requests.length = 0;
    r = await s.form('/admin/ai/test', { provider: 'openai', model: 'gpt-test-2', api_key: '', max_tokens: '1200' });
    assert.equal(r.status, 302);
    assert.equal(stub.requests[0].url, '/v1/chat/completions');
    assert.equal(stub.requests[0].headers.authorization, 'Bearer sk-live-abcdef123456');
    r = await s.form('/admin/ai', { provider: 'azure', model: '', api_key: 'x', endpoint: 'http://', max_tokens: '1200' });
    assert.equal(r.status, 422);
    const page = await s.get('/admin/ai');
    assert.equal(page.status, 200);
  });
});
