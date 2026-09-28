// Search & AI visibility (SEO/AEO/GEO), social links, advertising pixels with consent,
// Sign in with Google and white-label custom domains.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers');
const cache = require('../src/core/cache');
const google = require('../src/modules/auth/google.service');

let owner; let co;
const anon = () => h.request(h.getApp());
const GOOGLE_META = { issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth', token_endpoint: 'https://oauth2.googleapis.com/token', jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs' };

before(async () => {
  await h.resetDatabase();
  const [id] = await h.knex('users').insert({ name: 'Root', email: `root${Date.now()}@test.local`, password_hash: await bcrypt.hash('Password#123', 4), is_super_admin: true, platform_role: 'owner', email_verified_at: new Date() });
  owner = await h.login((await h.knex('users').where({ id }).first()).email, 'Password#123');
  co = await h.createCompany({ plan: 'business' });
});
after(async () => { google.setTestExchange(null); await h.knex.destroy(); });

const seoBody = (extra = {}) => ({
  site_name_ar: 'ريموت واي', site_name_en: 'RemoteWay', description_ar: 'منصة لإدارة القوى العاملة والتوظيف عن بعد في السعودية، بالعربية والإنجليزية.', description_en: 'Workforce management and remote hiring for Saudi companies, in Arabic and English.',
  p_pricing_title_en: 'RemoteWay pricing — plans for every team', p_pricing_desc_en: 'Compare RemoteWay plans.', p_terms_noindex: '1',
  v_google: 'abc123_XYZ', o_email: 'hello@remoteway.net', o_country: 'sa',
  s_organization: '1', s_website: '1', s_software: '1', s_faq: '1', s_jobs: '1',
  b_gptbot: '1', b_claudebot: '1', b_perplexitybot: '1', b_oai_searchbot: '1', b_chatgpt_user: '1', b_google_extended: '1', b_applebot_extended: '1', b_bytespider: '1', // CCBot off
  ...extra,
});

describe('Phase 20 — SEO, AEO, GEO, marketing, Google sign-in, custom domains', () => {
  test('SEO: page tags, canonical/hreflang, verification, structured data, no-index', async () => {
    assert.equal((await owner.form('/admin/seo', seoBody({ o_email: 'not-an-email' }))).status, 422);
    assert.equal((await owner.form('/admin/seo', seoBody())).status, 302);

    const home = (await anon().get('/?lang=en')).text;
    assert.match(home, /<link rel="canonical" href="http:\/\/[^"]+\/\?lang=en">/);
    assert.match(home, /hreflang="ar"/);
    assert.match(home, /hreflang="x-default"/);
    assert.match(home, /<meta property="og:image" content="[^"]+\/brand\/logo-primary\.png">/);
    assert.match(home, /<meta name="google-site-verification" content="abc123_XYZ">/);
    assert.match(home, /<meta name="description" content="Workforce management and remote hiring/);
    const ld = [...home.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const types = ld.map((d) => d['@type']);
    for (const t of ['Organization', 'WebSite', 'SoftwareApplication', 'FAQPage']) assert.ok(types.includes(t), t);
    assert.equal(ld.find((d) => d['@type'] === 'Organization').contactPoint[0].email, 'hello@remoteway.net');
    assert.ok(ld.find((d) => d['@type'] === 'FAQPage').mainEntity.length >= 3, 'FAQ from the website section');

    const pricing = (await anon().get('/pricing?lang=en')).text;
    assert.match(pricing, /<title>RemoteWay pricing — plans for every team<\/title>/);
    assert.match((await anon().get('/terms')).text, /<meta name="robots" content="noindex, follow">/);
    // Signed-in and one-time pages never get tags or structured data
    const reset = (await anon().get('/reset/nope')).text;
    assert.match(reset, /noindex, nofollow/);
    assert.doesNotMatch(reset, /application\/ld\+json/);
  });

  test('GEO and sitemaps: robots AI switches, llms.txt, hreflang sitemap', async () => {
    const robots = (await anon().get('/robots.txt')).text;
    assert.match(robots, /User-agent: CCBot\nDisallow: \/\n/);
    assert.match(robots, /User-agent: GPTBot\n(Disallow: \/[a-z]+.*\n)+Allow: \//);
    assert.match(robots, /Disallow: \/admin/);
    const sitemap = (await anon().get('/sitemap.xml')).text;
    assert.match(sitemap, /xmlns:xhtml/);
    assert.match(sitemap, /hreflang="ar" href="[^"]+\/pricing\?lang=ar"/);
    assert.doesNotMatch(sitemap, /\/terms</, 'no-index pages are left out');
    let llms = await anon().get('/llms.txt');
    assert.match(llms.headers['content-type'], /text\/plain/);
    assert.match(llms.text, /^# RemoteWay/);
    assert.match(llms.text, /## Frequently asked questions/);
    await owner.form('/admin/seo', seoBody({ llms: '# RemoteWay\n\nCustom summary for assistants.' }));
    llms = await anon().get('/llms.txt');
    assert.match(llms.text, /Custom summary for assistants/);
    assert.equal((await owner.get('/admin/seo')).status, 200);
    assert.match((await owner.get('/admin/seo/llms-default')).text, /## Main pages/);
  });

  test('marketing: social links in the footer and structured data; validation', async () => {
    assert.equal((await owner.form('/admin/marketing', { social_x: 'http://x.com/rw' })).status, 422);
    assert.equal((await owner.form('/admin/marketing', { social_x: 'https://x.com/remoteway', pixel_meta: 'abc' })).status, 422);
    assert.equal((await owner.form('/admin/marketing', { social_x: 'https://x.com/remoteway', social_linkedin: 'https://www.linkedin.com/company/remoteway', events: '1' })).status, 302);
    const home = (await anon().get('/?lang=en')).text;
    assert.match(home, /class="row wrap footer-social"/);
    assert.match(home, /href="https:\/\/x\.com\/remoteway"[^>]*rel="noopener me"/);
    assert.match(home, /#b-x"/);
    const org = [...home.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)].map((m) => JSON.parse(m[1])).find((d) => d['@type'] === 'Organization');
    assert.deepEqual(org.sameAs, ['https://x.com/remoteway', 'https://www.linkedin.com/company/remoteway']);
    assert.match(home, /data-cookie-note/, 'essential-cookie note without pixels');
    assert.doesNotMatch(home, /rw-pixels/);
  });

  test('pixels: consent first, public pages only, CSP follows, conversions reported once', async () => {
    assert.equal((await owner.form('/admin/marketing', { social_x: 'https://x.com/remoteway', pixel_ga4: 'G-ABC1234567', pixel_meta: '123456789012345', events: '1' })).status, 302);
    let r = await anon().get('/?lang=en');
    assert.match(r.text, /name="choice" value="accept"/, 'visitors are asked');
    assert.match(r.text, /<meta name="rw-pixels" content="[^"]*&quot;consent&quot;:&quot;&quot;/, 'pixels.js gets no consent yet');
    assert.match(r.headers['content-security-policy'], /script-src 'self' https:\/\/www\.googletagmanager\.com https:\/\/connect\.facebook\.net/);
    r = await anon().post('/preferences/cookies').type('form').send({ choice: 'accept', _csrf: 'x' });
    // CSRF is enforced (the real form includes the token): nothing is stored
    assert.doesNotMatch(String(r.headers['set-cookie'] || ''), /rw_consent/);
    const agent = h.request.agent(h.getApp());
    const page = await agent.get('/?lang=en');
    const csrf = /name="csrf-token" content="([^"]+)"/.exec(page.text)[1];
    r = await agent.post('/preferences/cookies').type('form').send({ choice: 'accept', _csrf: csrf });
    assert.equal(r.status, 302);
    assert.match(String(r.headers['set-cookie']), /rw_consent=yes/);
    const after = (await agent.get('/?lang=en')).text;
    assert.match(after, /&quot;consent&quot;:&quot;yes&quot;/);
    assert.doesNotMatch(after, /value="accept"/, 'no more question');
    assert.match(after, /<script src="\/js\/pixels\.js/);
    // Privacy policy follows the real set-up, with a way to change the choice
    const privacy = (await agent.get('/privacy?lang=en')).text;
    assert.match(privacy, /Google Analytics, Meta \(Facebook\/Instagram\)/);
    assert.match(privacy, /id="cookie-choice"/);
    // Never inside accounts or the admin panel
    const adm = await owner.get('/admin');
    assert.doesNotMatch(adm.text, /rw-pixels/);
    assert.doesNotMatch(adm.headers['content-security-policy'], /facebook/);
    // A demo request is reported on its confirmation page
    const demo = await agent.post('/demo').type('form').send({ _csrf: csrf, name: 'Lead Person', email: 'lead@corp.test', company_name: 'Corp', phone: '0550000000', company_size: '11-50', message: 'Hello' });
    assert.equal(demo.status, 200);
    assert.match(demo.text, /&quot;event&quot;:&quot;lead&quot;/);
    // An individual sign-up is reported once on the (signed-in) profile page
    const join = await agent.post('/join').type('form').send({ _csrf: csrf, name: 'New Person', email: `px${Date.now()}@test.local`, password: 'Password#123', terms: 'on' });
    assert.equal(join.status, 302);
    const prof = await agent.get(join.headers.location);
    assert.match(prof.text, /&quot;event&quot;:&quot;join&quot;/);
    assert.match(prof.headers['content-security-policy'], /connect\.facebook\.net/);
    const again = await agent.get(join.headers.location);
    assert.doesNotMatch(again.text, /rw-pixels/, 'only once');
    assert.doesNotMatch(again.headers['content-security-policy'], /facebook/);
    // Declining keeps them off
    const d = h.request.agent(h.getApp());
    const p2 = await d.get('/');
    await d.post('/preferences/cookies').type('form').send({ choice: 'decline', _csrf: /name="csrf-token" content="([^"]+)"/.exec(p2.text)[1] });
    assert.match((await d.get('/')).text, /&quot;consent&quot;:&quot;no&quot;/);
    await owner.form('/admin/marketing', { social_x: 'https://x.com/remoteway' }); // pixels off again
  });

  test('Google sign-in: admin set-up, new individual, linking, 2FA, platform team refused', async () => {
    assert.equal((await owner.form('/admin/google', { enabled: '1', client_id: 'bad' })).status, 422);
    assert.equal((await owner.form('/admin/google', { enabled: '1', client_id: '123-abc.apps.googleusercontent.com' })).status, 422, 'secret required');
    assert.equal((await owner.form('/admin/google', { enabled: '1', allow_signup: '1', client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret' })).status, 302);
    const g = await h.knex('platform_settings').where({ key: 'google' }).first();
    assert.doesNotMatch(String(g.value), /GOCSPX-secret/, 'secret stored encrypted');
    cache.set('oidc:disc:https://accounts.google.com', GOOGLE_META, 3_600_000);
    assert.match((await anon().get('/login')).text, /href="\/auth\/google"/);

    let claims = {};
    google.setTestExchange(async (pending) => ({ ...claims, nonce: pending.nonce }));
    const flow = async (query = {}) => {
      const a = h.request.agent(h.getApp());
      const start = await a.get('/auth/google');
      assert.equal(start.status, 302);
      const u = new URL(start.headers.location);
      assert.equal(u.origin + u.pathname, GOOGLE_META.authorization_endpoint);
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      const cb = await a.get(`/auth/google/callback?state=${query.state || u.searchParams.get('state')}&code=abc`);
      return { a, cb };
    };
    // Wrong state
    let { cb } = await flow({ state: 'forged' });
    assert.equal(cb.status, 400);
    // Unverified email refused
    claims = { sub: 'g-1', email: 'new.person@gmail.com', email_verified: false, name: 'New Person' };
    ({ cb } = await flow());
    assert.equal(cb.status, 400);
    // New address → individual account, email confirmed, profile
    claims.email_verified = true;
    let a;
    ({ a, cb } = await flow());
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.location, '/me/profile');
    const u = await h.knex('users').where({ email: 'new.person@gmail.com' }).first();
    assert.equal(u.google_sub, 'g-1');
    assert.ok(u.email_verified_at);
    assert.ok(await h.knex('talent_profiles').where({ user_id: u.id }).first());
    assert.equal((await a.get('/me')).status, 200);
    // Existing company owner: linked by verified email, lands in the app
    claims = { sub: 'g-2', email: co.email, email_verified: 'true', name: 'Owner' };
    ({ cb } = await flow());
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.location, '/app');
    assert.equal((await h.knex('users').where({ email: co.email }).first()).google_sub, 'g-2');
    // Another Google account cannot take the linked account
    claims = { sub: 'g-3', email: co.email, email_verified: true };
    ({ cb } = await flow());
    assert.equal(cb.status, 409);
    // Two-step verification still applies
    await h.knex('users').where({ email: 'new.person@gmail.com' }).update({ two_factor_secret_enc: 'x', two_factor_enabled_at: new Date() });
    claims = { sub: 'g-1', email: 'new.person@gmail.com', email_verified: true };
    ({ cb } = await flow());
    assert.equal(cb.headers.location, '/login/2fa');
    // The platform team cannot use it
    const root = await h.knex('users').where({ is_super_admin: true }).first();
    claims = { sub: 'g-4', email: root.email, email_verified: true };
    ({ cb } = await flow());
    assert.equal(cb.status, 403);
    // Sign-up can be turned off
    await owner.form('/admin/google', { enabled: '1', client_id: '123-abc.apps.googleusercontent.com' });
    claims = { sub: 'g-5', email: 'someone.else@gmail.com', email_verified: true };
    ({ cb } = await flow());
    assert.equal(cb.status, 404);
    // Off → no button, no flow
    await owner.form('/admin/google', { client_id: '123-abc.apps.googleusercontent.com' });
    assert.doesNotMatch((await anon().get('/login')).text, /\/auth\/google/);
    assert.equal((await anon().get('/auth/google')).status, 302);
  });

  test('custom domains: admin list, approve, suspend, roles, cPanel settings', async () => {
    const ent = await h.createCompany({ plan: 'enterprise' }); // white label is an Enterprise feature
    co = ent;
    const cs = await h.login(co.email, co.password);
    assert.equal((await cs.form('/app/settings/branding/white-label', { white_label: 'on', brand_name: 'Co HR', custom_domain: 'hr.co-domain.test' })).status, 302);
    let row = await h.knex('organization_branding').where({ organization_id: co.organizationId }).first();
    assert.equal(row.domain_status, 'pending');
    assert.match(row.domain_token, /^[a-f0-9]{24}$/);
    const settings = (await cs.get('/app/settings/branding')).text;
    assert.ok(settings.includes(`remoteway-verify=${row.domain_token}`));
    assert.ok(settings.includes('_remoteway.hr.co-domain.test'));

    const list = await owner.get('/admin/domains');
    assert.equal(list.status, 200);
    assert.ok(list.text.includes('hr.co-domain.test'));
    assert.equal((await owner.form(`/admin/domains/${co.organizationId}/approve`, {})).status, 302);
    row = await h.knex('organization_branding').where({ organization_id: co.organizationId }).first();
    assert.equal(row.domain_status, 'verified');
    assert.match((await anon().get('/login').set('Host', 'hr.co-domain.test')).text, /Co HR/);
    // Company pages on their own domain: no platform SEO, pixels or Google button
    assert.doesNotMatch((await anon().get('/login').set('Host', 'hr.co-domain.test')).text, /application\/ld\+json|og:site_name/);
    assert.equal((await owner.form(`/admin/domains/${co.organizationId}/suspend`, {})).status, 302);
    assert.doesNotMatch((await anon().get('/login').set('Host', 'hr.co-domain.test')).text, /Co HR/);
    // Changing the domain starts over
    await owner.form(`/admin/domains/${co.organizationId}/approve`, {});
    await cs.form('/app/settings/branding/white-label', { white_label: 'on', brand_name: 'Co HR', custom_domain: 'people.co-domain.test' });
    row = await h.knex('organization_branding').where({ organization_id: co.organizationId }).first();
    assert.equal(row.domain_status, 'pending');
    // cPanel: token stored encrypted; "add" fails honestly without a reachable server
    assert.equal((await owner.form('/admin/domains/cpanel', { cp_host: 'not a host', cp_user: 'x' })).status, 422);
    assert.equal((await owner.form('/admin/domains/cpanel', { cp_host: 'server1.example.invalid', cp_user: 'rwuser', cp_token: 'TOKEN123', cp_auto: '1' })).status, 302);
    const cp = await h.knex('platform_settings').where({ key: 'cpanel' }).first();
    assert.doesNotMatch(String(cp.value), /TOKEN123/);
    // Roles: support can look, not change; sales cannot open it
    await owner.form('/admin/team', { name: 'Sam Support', email: 'sam@rw.test', role: 'support', password: 'Support12345' });
    await owner.form('/admin/team', { name: 'Sally Sales', email: 'sally@rw.test', role: 'sales', password: 'Sales1234567' });
    const sup = await h.login('sam@rw.test', 'Support12345');
    assert.equal((await sup.get('/admin/domains')).status, 200);
    assert.equal((await sup.form(`/admin/domains/${co.organizationId}/approve`, {})).status, 403);
    assert.equal((await sup.get('/admin/seo')).status, 403);
    const sales = await h.login('sally@rw.test', 'Sales1234567');
    assert.equal((await sales.get('/admin/domains')).status, 403);
    assert.equal((await sales.get('/admin/marketing')).status, 200);
    assert.equal((await sales.form('/admin/marketing', {})).status, 403);
  });
});
