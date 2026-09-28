// Talent & Jobs Marketplace: individual sign-up and profiles, privacy, the jobs board, applying with a
// profile into the company pipeline, discover/search, saved lists, invitations, rule-based matching,
// AI talent search / recommendations / profile analysis through the existing AI layer, homepage carousels.
process.env.INTEGRATIONS_ALLOW_PRIVATE = 'true'; // local AI stub
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const stubServer = require('./ai-stub');
const secrets = require('../src/core/secrets');
const ai = require('../src/modules/ai/ai.service');
const matching = require('../src/modules/talent/matching.service');
const profiles = require('../src/modules/talent/profile.service');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
let stub; let co; let owner; let jobId; let orgSlug;
const pub = () => h.request(h.getApp());

async function join(name, email) {
  const agent = h.request.agent(h.getApp());
  const page = await agent.get('/join');
  const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)[1];
  const r = await agent.post('/join').type('form').send({ _csrf: csrf, name, email, password: 'Password#123', terms: 'on' });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  // Confirm the email with the link that was sent
  const mail = require('../src/core/mailer').testOutbox.filter((m) => m.to === email).pop();
  const link = mail.html.match(/\/verify-email\/([a-f0-9]{64})/)[1];
  assert.equal((await agent.get(`/verify-email/${link}`)).status, 302);
  const home = await agent.get('/me');
  const token = home.text.match(/name="csrf-token" content="([^"]+)"/)[1];
  return { agent, csrf: token, get: (u) => agent.get(u), form: (u, b) => agent.post(u).type('form').send({ _csrf: token, ...b }) };
}

async function buildProfile(s, { headline, specialization, skills, years, modes = ['remote'], visibility = 'public', city = 'Riyadh' }) {
  await s.form('/me/profile/basics', { headline, specialization, bio: 'I plan and run digital campaigns end to end, from keyword research to reporting, for B2B and retail brands.', country_code: 'SA', city, years_experience: String(years) });
  await s.form('/me/profile/skills', { skills: skills.join(', ') });
  await s.form('/me/profile/section/experience', { exp_title: ['Marketing Specialist'], exp_company: ['Acme'], exp_start: ['2021-01'], exp_end: [''], exp_description: ['Ran SEO and paid search.'] });
  await s.form('/me/profile/section/education', { edu_degree: ["Bachelor's"], edu_field: ['Marketing'], edu_school: ['King Saud University'], edu_start: ['2014'], edu_end: ['2018'] });
  await s.form('/me/profile/section/languages', { lang_name: ['Arabic', 'English'], lang_level: ['native', 'fluent'] });
  await s.form('/me/profile/preferences', { pref_titles: 'Digital Marketing Specialist', pref_work_modes: modes, pref_job_types: ['full_time'], visibility, open_to_work: 'on' });
}

before(async () => {
  await h.resetDatabase();
  stub = await stubServer.start();
  process.env.AI_PROVIDER_BASE_URL = stub.url;
  co = await h.createCompany({ plan: 'business' });
  owner = await h.login(co.email, co.password);
  orgSlug = (await h.knex('organizations').where({ id: co.organizationId }).first()).slug;
});
after(async () => { delete process.env.AI_PROVIDER_BASE_URL; stub.server.close(); await h.knex.destroy(); });

describe('Phase 15 — talent & jobs marketplace', () => {
  let nora; let omar; let pia;
  test('individual sign-up, profile sections, completion, photo and CV', async () => {
    nora = await join('Nora Haddad', 'nora@talent.test');
    assert.match((await nora.get('/me')).text, /Profile completion/);
    await buildProfile(nora, { headline: 'Digital Marketing Specialist · SEO & Paid Ads', specialization: 'Digital Marketing', skills: ['SEO', 'Google Ads', 'GA4', 'Content'], years: 4 });
    let r = await nora.agent.post('/me/profile/photo').field('_csrf', nora.csrf).attach('file', PNG, 'me.png');
    assert.equal(r.status, 302);
    r = await nora.agent.post('/me/profile/cv').field('_csrf', nora.csrf).attach('file', PDF, 'cv.pdf');
    assert.equal(r.status, 302);
    const p = await profiles.forUser((await h.knex('users').where({ email: 'nora@talent.test' }).first()).id);
    assert.deepEqual(p.skills, ['SEO', 'Google Ads', 'GA4', 'Content']);
    assert.equal(p.experience[0].current, true);
    assert.ok(p.computed_years >= 4);
    assert.ok(p.completion >= 80, `completion ${p.completion}`);
    assert.equal((await h.knex('talent_skills').where({ profile_id: p.id })).length, 4);
    // Validation
    r = await nora.form('/me/profile/section/experience', { exp_title: ['X'], exp_company: ['Y'], exp_start: ['2023-05'], exp_end: ['2022-01'] });
    assert.equal(r.status, 422);
    r = await nora.agent.post('/me/profile/photo').field('_csrf', nora.csrf).attach('file', Buffer.from('<svg/>'), 'x.svg');
    assert.equal(r.status, 422);
    // Sign-in sends individuals to their dashboard
    const again = h.request.agent(h.getApp());
    const lp = await again.get('/login');
    const lr = await again.post('/login').type('form').send({ _csrf: lp.text.match(/name="csrf-token" content="([^"]+)"/)[1], email: 'nora@talent.test', password: 'Password#123' });
    assert.equal(lr.headers.location, '/me');
    assert.equal((await again.get('/app')).headers.location, '/me');
  });

  test('privacy: public, companies-only and private profiles', async () => {
    omar = await join('Omar Saleh', 'omar@talent.test');
    await buildProfile(omar, { headline: 'Performance Marketer', specialization: 'Digital Marketing', skills: ['Google Ads', 'Meta Ads', 'GA4'], years: 2, visibility: 'companies', modes: ['onsite'], city: 'Jeddah' });
    pia = await join('Pia Private', 'pia@talent.test');
    await buildProfile(pia, { headline: 'SEO Lead', specialization: 'Digital Marketing', skills: ['SEO', 'Google Ads', 'GA4'], years: 6, visibility: 'private' });
    const slugOf = async (email) => (await h.knex('talent_profiles as p').join('users as u', 'u.id', 'p.user_id').where('u.email', email).first('p.slug')).slug;
    assert.equal((await pub().get(`/talent/${await slugOf('nora@talent.test')}`)).status, 200);
    assert.equal((await pub().get(`/talent/${await slugOf('omar@talent.test')}`)).status, 404, 'companies only');
    assert.equal((await pub().get(`/talent/${await slugOf('pia@talent.test')}`)).status, 404, 'private');
    const list = await pub().get('/talent');
    assert.match(list.text, /Nora Haddad/);
    assert.doesNotMatch(list.text, /Omar Saleh|Pia Private/);
    assert.doesNotMatch((await pub().get(`/talent/${await slugOf('nora@talent.test')}`)).text, /nora@talent\.test/, 'contact hidden by default');
    // Business plan has the marketplace: companies see companies-only profiles, never private ones
    const found = await owner.get('/app/talent?q=marketing');
    assert.equal(found.status, 200);
    assert.match(found.text, /Omar Saleh/);
    assert.doesNotMatch(found.text, /Pia Private/);
    // Starter has no marketplace
    const st = await h.createCompany({ plan: 'starter' });
    assert.equal((await (await h.login(st.email, st.password)).get('/app/talent')).status, 402);
  });

  test('a job published on the board; applying with a profile lands in the pipeline', async () => {
    let r = await owner.form('/app/recruitment/jobs', { title: 'Digital Marketing Specialist', work_mode: 'remote', employment_type: 'full_time', experience_years: '3', skills: 'SEO, Google Ads, GA4', description: 'Grow our pipeline.', publish: '1', marketplace_field: '1', marketplace: 'on' });
    assert.equal(r.status, 302);
    jobId = Number(r.headers.location.split('/').pop());
    const job = await h.knex('jobs').where({ id: jobId }).first();
    assert.equal(job.marketplace, 1);
    assert.equal(job.status, 'open');
    const board = await pub().get('/jobs?q=marketing');
    assert.match(board.text, /Digital Marketing Specialist/);
    const home = await pub().get('/');
    assert.match(home.text, /Latest jobs/);
    assert.match(home.text, /Discover talent/);
    assert.match(home.text, /Nora Haddad/);
    // Apply
    r = await nora.form(`/jobs/${orgSlug}/${job.slug}/apply`, { cover_note: 'I would love to join.' });
    assert.equal(r.status, 302);
    const noraUser = await h.knex('users').where({ email: 'nora@talent.test' }).first();
    const cand = await h.knex('candidates').where({ organization_id: co.organizationId, user_id: noraUser.id }).first();
    assert.equal(cand.source, 'remoteway');
    assert.ok(cand.cv_storage_key && cand.cv_storage_key.startsWith(`org-${co.organizationId}/`), 'the company gets its own CV copy');
    const app = await h.knex('applications').where({ candidate_id: cand.id, job_id: jobId }).first();
    assert.equal(app.stage, 'applied');
    assert.match(app.cover_note, /\/talent\//);
    assert.ok(await h.knex('notifications').where({ user_id: co.userId, type: 'candidate_applied' }).first());
    assert.match((await nora.get('/me/applications')).text, /Submitted/);
    assert.match((await nora.get(`/jobs/${orgSlug}/${job.slug}`)).text, /You applied to this job/);
    // Applying twice is refused; the company now sees her contact details
    assert.equal((await nora.form(`/jobs/${orgSlug}/${job.slug}/apply`, {})).status, 409);
    assert.match((await owner.get(`/app/talent/p/${(await profiles.forUser(noraUser.id)).id}`)).text, /nora@talent\.test/);
    // A barely started profile cannot apply
    const empty = await join('Empty Person', 'empty@talent.test');
    assert.equal((await empty.form(`/jobs/${orgSlug}/${job.slug}/apply`, {})).status, 409);
    // Unpublishing removes it from the board
    await owner.form(`/app/talent/jobs/${jobId}/marketplace`, { on: '0' });
    assert.doesNotMatch((await pub().get('/jobs')).text, /Digital Marketing Specialist/);
    await owner.form(`/app/talent/jobs/${jobId}/marketplace`, { on: '1' });
  });

  test('rule-based matching ranks by skills, experience and preferences', async () => {
    const c = await matching.criteriaFromText('أريد Digital Marketing Specialist، خبرة 3 سنوات، SEO وGoogle Ads وGA4، ويفضل Remote');
    assert.deepEqual(c.skills.sort(), ['ga4', 'google ads', 'seo']);
    assert.equal(c.min_years, 3);
    assert.equal(c.work_mode, 'remote');
    const res = await matching.candidatesFor(c, { limit: 10 });
    const names = res.map((r) => r.profile.name);
    assert.equal(names[0], 'Nora Haddad', 'all skills, 4 years, prefers remote');
    assert.ok(names.includes('Omar Saleh'));
    assert.ok(!names.includes('Pia Private'), 'private profiles never appear in search');
    const omarR = res.find((r) => r.profile.name === 'Omar Saleh');
    assert.deepEqual(omarR.missing_skills, ['seo']);
    assert.ok(res[0].score > omarR.score);
    // The job page shows recommended people
    assert.match((await owner.get(`/app/recruitment/jobs/${jobId}`)).text, /Recommended candidates/);
  });

  test('AI talent search uses the company AI settings and quota; falls back to rules without AI', async () => {
    let r = await owner.form('/app/talent/ai', { query: 'Digital Marketing Specialist, 3 years, SEO, Google Ads and GA4, remote preferred' });
    assert.equal(r.status, 200);
    assert.match(r.text, /Rule-based match/, 'AI not configured yet');
    assert.match(r.text, /Omar Saleh/);
    // Configure AI + move the company to Professional (AI recruitment) and switch the area on
    const value = JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5', api_key_enc: secrets.encrypt('sk-test-123'), enabled: true, max_tokens: 1500, personal_daily_limit: 2 });
    await h.knex('platform_settings').insert({ key: 'ai', value }).onConflict('key').merge({ value });
    ai.invalidateConfig();
    const plan = await h.knex('plans').where({ key: 'professional' }).first();
    await h.knex('subscriptions').where({ organization_id: co.organizationId }).update({ plan_id: plan.id, status: 'active' });
    await h.knex('ai_settings').insert({ organization_id: co.organizationId, enabled: true, features: JSON.stringify(ai.AREA_KEYS) }).onConflict('organization_id').merge();
    h.cache.clear();
    stub.requests.length = 0;
    stub.reply = (prompt) => {
      const refs = [...prompt.matchAll(/### (C\d+)\nHeadline: ([^|]+)/g)].map((m) => [m[1], m[2].trim()]);
      return { results: refs.map(([ref, head]) => ({ ref, match: head.startsWith('Digital') ? 92 : 61, reason: `Strong fit: ${head}`, matched_skills: ['SEO'], experience: '4 years in marketing', gaps: head.startsWith('Digital') ? [] : ['SEO'] })).concat([{ ref: 'C99', match: 99, reason: 'invented' }]) };
    };
    r = await owner.form('/app/talent/ai', { query: 'Digital Marketing Specialist, 3 years, SEO, Google Ads and GA4, remote preferred. Call 0551234567' });
    assert.equal(r.status, 200);
    assert.match(r.text, /Ranked and explained by AI/);
    assert.match(r.text, /92%/);
    assert.match(r.text, /Strong fit: Digital Marketing Specialist/);
    assert.doesNotMatch(r.text, /invented/, 'unknown refs are dropped');
    const prompt = stub.requests[0].prompt;
    assert.ok(!prompt.includes('Nora') && !prompt.includes('nora@talent.test') && !prompt.includes('0551234567'), 'anonymised and redacted');
    const log = await h.knex('ai_requests').where({ organization_id: co.organizationId, action: 'talent_search' }).first();
    assert.equal(log.status, 'ok');
    assert.equal(Number((await h.knex('usage_records').where({ organization_id: co.organizationId, metric: 'ai_requests' }).first()).quantity), 1);
    // For a job: already-applied people are left out
    stub.requests.length = 0;
    r = await owner.form('/app/talent/ai', { job_id: String(jobId) });
    assert.doesNotMatch(stub.requests[0].prompt, /Digital Marketing Specialist · SEO/, 'Nora already applied');
    stub.reply = null;
  });

  test('personal AI: recommended jobs and profile analysis with a daily allowance', async () => {
    const omarUser = await h.knex('users').where({ email: 'omar@talent.test' }).first();
    let r = await omar.get('/me/jobs');
    assert.match(r.text, /Digital Marketing Specialist/);
    stub.reply = (prompt) => (prompt.includes('Review this professional profile')
      ? { summary: 'A focused performance marketer.', strengths: ['Paid ads'], gaps: ['No SEO'], suggestions: ['Add SEO projects'], suggested_roles: ['PPC Specialist'], missing_skills: ['SEO'], headline_suggestion: 'Performance Marketer · Google & Meta Ads' }
      : { results: [{ ref: 'J1', match: 74, reason: 'Your paid search work fits', gaps: ['SEO'] }] });
    r = await omar.form('/me/jobs', {});
    assert.equal(r.status, 200);
    assert.match(r.text, /Your paid search work fits/);
    r = await omar.form('/me/analysis', {});
    assert.equal(r.status, 302);
    const p = await profiles.forUser(omarUser.id);
    assert.equal(p.ai_analysis.headline_suggestion, 'Performance Marketer · Google & Meta Ads');
    assert.match((await omar.get('/me')).text, /A focused performance marketer/);
    const logs = await h.knex('ai_requests').where({ user_id: omarUser.id, feature: 'talent' }).whereNull('organization_id');
    assert.equal(logs.length, 2);
    // Daily allowance (2) reached
    r = await omar.form('/me/jobs', {});
    assert.equal(r.status, 429);
    stub.reply = null;
  });

  test('save, shortlist and invite; the person sees and can decline the invitation', async () => {
    const omarP = await profiles.forUser((await h.knex('users').where({ email: 'omar@talent.test' }).first()).id);
    let r = await owner.form(`/app/talent/p/${omarP.id}/save`, { list: 'shortlist', job_id: String(jobId) });
    assert.equal(r.status, 302);
    assert.match((await owner.get('/app/talent/saved?list=shortlist')).text, /Omar Saleh/);
    r = await owner.form(`/app/talent/p/${omarP.id}/invite`, { job_id: String(jobId), message: 'We like your paid ads work.' });
    assert.equal(r.status, 302);
    assert.equal((await h.knex('talent_invitations').where({ profile_id: omarP.id })).length, 1);
    await owner.form(`/app/talent/p/${omarP.id}/invite`, { job_id: String(jobId) });
    assert.equal((await h.knex('talent_invitations').where({ profile_id: omarP.id })).length, 1, 'no duplicate invitation');
    const dash = await omar.get('/me');
    assert.match(dash.text, /We like your paid ads work/);
    const inv = await h.knex('talent_invitations').where({ profile_id: omarP.id }).first();
    await omar.form(`/me/invitations/${inv.id}/decline`, {});
    assert.equal((await h.knex('talent_invitations').where({ id: inv.id }).first()).status, 'declined');
    // Private profiles cannot be opened, saved or invited by companies they did not apply to
    const piaP = await profiles.forUser((await h.knex('users').where({ email: 'pia@talent.test' }).first()).id);
    assert.equal((await owner.get(`/app/talent/p/${piaP.id}`)).status, 404);
    assert.equal((await owner.form(`/app/talent/p/${piaP.id}/invite`, {})).status, 302);
    assert.equal((await h.knex('talent_invitations').where({ profile_id: piaP.id })).length, 0);
    // Employees without recruitment access cannot use the talent tools
    const emp = await h.addMember(co.organizationId, 'employee');
    assert.equal((await (await h.login(emp.email, emp.password)).get('/app/talent')).status, 403);
    // A company member can also open their own career profile
    assert.equal((await owner.get('/me')).status, 200);
  });
});
