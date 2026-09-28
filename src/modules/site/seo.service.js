// Search and AI visibility for the public website, managed from Super Admin:
//  • SEO  — titles and descriptions per page (Arabic/English), share image, canonical and language links,
//           search-console verification, no-index switches, sitemap.
//  • AEO  — structured data (Organization, WebSite, SoftwareApplication with the plans, FAQPage from the
//           FAQ section, JobPosting on job pages) so search and answer engines can quote the page.
//  • GEO  — /llms.txt (a plain summary for AI assistants) and per-bot crawling switches in robots.txt.
// Plus the marketing side: social media links (footer + Organization sameAs) and advertising pixels,
// which only load on public pages after the visitor accepts them.
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');

const PAGES = ['home', 'pricing', 'jobs', 'talent', 'join', 'signup', 'login', 'demo', 'privacy', 'terms'];
const PATH_PAGE = { '/': 'home', '/pricing': 'pricing', '/jobs': 'jobs', '/talent': 'talent', '/join': 'join', '/signup': 'signup', '/login': 'login', '/demo': 'demo', '/privacy': 'privacy', '/terms': 'terms' };
const AI_BOTS = { gptbot: 'GPTBot', oai_searchbot: 'OAI-SearchBot', chatgpt_user: 'ChatGPT-User', claudebot: 'ClaudeBot', perplexitybot: 'PerplexityBot', google_extended: 'Google-Extended', applebot_extended: 'Applebot-Extended', ccbot: 'CCBot', bytespider: 'Bytespider' };
// Signed-in and one-time pages: never indexed, never any pixel.
const PRIVATE_PATHS = ['/app', '/admin', '/me', '/api', '/security', '/reset', '/login/2fa', '/verify-email', '/payments', '/webhooks', '/org-brand', '/invitations', '/kiosk', '/q/', '/auth/', '/sso'];
const isPrivate = (p) => PRIVATE_PATHS.some((x) => p === x || p.startsWith(x.endsWith('/') ? x : `${x}/`));
const SOCIAL = ['x', 'linkedin', 'instagram', 'facebook', 'youtube', 'tiktok', 'snapchat', 'whatsapp', 'telegram', 'threads'];
// Pixel id formats and the hosts each one needs in the Content-Security-Policy.
const PIXELS = {
  ga4: { re: /^G-[A-Z0-9]{4,15}$/, script: ['https://www.googletagmanager.com'], connect: ['https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://*.googletagmanager.com'] },
  gtm: { re: /^GTM-[A-Z0-9]{4,12}$/, script: ['https://www.googletagmanager.com'], connect: ['https://*.google-analytics.com', 'https://*.googletagmanager.com'] },
  meta: { re: /^\d{8,20}$/, script: ['https://connect.facebook.net'], connect: ['https://www.facebook.com', 'https://connect.facebook.net'] },
  tiktok: { re: /^[A-Z0-9]{10,30}$/, script: ['https://analytics.tiktok.com'], connect: ['https://analytics.tiktok.com'] },
  snap: { re: /^[a-f0-9-]{20,40}$/i, script: ['https://sc-static.net'], connect: ['https://tr.snapchat.com', 'https://tr-shadow.snapchat.com'] },
  linkedin: { re: /^\d{4,12}$/, script: ['https://snap.licdn.com'], connect: ['https://px.ads.linkedin.com'] },
  x: { re: /^[a-z0-9]{4,12}$/i, script: ['https://static.ads-twitter.com'], connect: ['https://analytics.twitter.com', 'https://static.ads-twitter.com'] },
};

const clip = (v, n) => String(v ?? '').replace(/\r/g, '').trim().slice(0, n);
const bi = (body, key, n) => ({ ar: clip(body[`${key}_ar`], n), en: clip(body[`${key}_en`], n) });
const read = async (key) => {
  const row = await knex('platform_settings').where({ key }).first();
  return row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : {};
};

// ---------- SEO / AEO / GEO ----------
async function get() {
  return cache.remember('site:seo', async () => {
    const v = await read('seo');
    return {
      site_name: v.site_name || { ar: 'RemoteWay', en: 'RemoteWay' },
      description: v.description || { ar: '', en: '' },
      keywords: v.keywords || { ar: '', en: '' },
      og_image: v.og_image || '',
      x_handle: v.x_handle || '',
      pages: v.pages || {},
      verify: v.verify || {},
      org: v.org || {},
      schema: { organization: true, website: true, software: true, faq: true, jobs: true, ...(v.schema || {}) },
      llms: v.llms || '',
      bots: { ...Object.fromEntries(Object.keys(AI_BOTS).map((k) => [k, true])), ...(v.bots || {}) },
      updated_at: v.updated_at || null,
    };
  }, 60_000);
}

async function save(ctx, body) {
  const pages = {};
  for (const p of PAGES) pages[p] = { title: bi(body, `p_${p}_title`, 120), description: bi(body, `p_${p}_desc`, 320), noindex: body[`p_${p}_noindex`] === '1' };
  const verify = { google: clip(body.v_google, 120).replace(/[^\w-]/g, ''), bing: clip(body.v_bing, 120).replace(/[^\w-]/g, ''), yandex: clip(body.v_yandex, 120).replace(/[^\w-]/g, '') };
  const org = {
    legal_name: clip(body.o_legal_name, 150), email: clip(body.o_email, 150), phone: clip(body.o_phone, 40), city: clip(body.o_city, 80),
    country: clip(body.o_country, 2).toUpperCase(), address: clip(body.o_address, 200),
  };
  if (org.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(org.email)) throw E.validation({ o_email: 'Enter a valid email address.' });
  const value = {
    site_name: bi(body, 'site_name', 80), description: bi(body, 'description', 320), keywords: bi(body, 'keywords', 300),
    og_image: /^\d{1,10}$/.test(String(body.og_image || '')) ? String(body.og_image) : '',
    x_handle: clip(body.x_handle, 40).replace(/[^A-Za-z0-9_]/g, ''),
    pages, verify, org,
    schema: Object.fromEntries(['organization', 'website', 'software', 'faq', 'jobs'].map((k) => [k, body[`s_${k}`] === '1'])),
    llms: clip(body.llms, 20000),
    bots: Object.fromEntries(Object.keys(AI_BOTS).map((k) => [k, body[`b_${k}`] === '1'])),
    updated_at: new Date().toISOString(),
  };
  const json = JSON.stringify(value);
  await knex('platform_settings').insert({ key: 'seo', value: json }).onConflict('key').merge({ value: json, updated_at: new Date() });
  cache.forgetPrefix('site:');
  await audit.record(ctx, 'platform.seo_updated', {});
}

// ---------- Social links and pixels ----------
async function marketing() {
  return cache.remember('site:marketing', async () => {
    const v = await read('marketing');
    return { social: v.social || {}, pixels: v.pixels || {}, events: v.events !== false };
  }, 60_000);
}

let cspHosts = { script: [], connect: [] };
/** Hosts the enabled pixels need, for the Content-Security-Policy (kept in memory, refreshed on save). */
async function refreshCsp() {
  return cspFrom(await marketing().catch(() => ({ pixels: {} })));
}
function cspFrom(m) {
  const script = new Set(); const connect = new Set();
  for (const [k, id] of Object.entries(m.pixels || {})) {
    if (id && PIXELS[k]) { PIXELS[k].script.forEach((h) => script.add(h)); PIXELS[k].connect.forEach((h) => connect.add(h)); }
  }
  cspHosts = { script: [...script], connect: [...connect] };
  return cspHosts;
}
const csp = () => cspHosts;

async function saveMarketing(ctx, body) {
  const social = {};
  const errors = {};
  for (const k of SOCIAL) {
    const v = clip(body[`social_${k}`], 300);
    if (!v) continue;
    if (!/^https:\/\/[^\s<>"']+$/i.test(v)) errors[`social_${k}`] = 'Use a full link starting with https://';
    else social[k] = v;
  }
  const pixels = {};
  for (const [k, def] of Object.entries(PIXELS)) {
    const v = clip(body[`pixel_${k}`], 60);
    if (!v) continue;
    if (!def.re.test(v)) errors[`pixel_${k}`] = 'This ID does not look right. Copy it again from the platform.';
    else pixels[k] = v;
  }
  if (Object.keys(errors).length) throw E.validation(errors);
  const json = JSON.stringify({ social, pixels, events: body.events === '1' });
  await knex('platform_settings').insert({ key: 'marketing', value: json }).onConflict('key').merge({ value: json, updated_at: new Date() });
  cache.forgetPrefix('site:');
  await refreshCsp();
  await audit.record(ctx, 'platform.marketing_updated', { newValues: { pixels: Object.keys(pixels), social: Object.keys(social) } });
}

// ---------- Output helpers ----------
const L = (v, locale) => (v && typeof v === 'object' ? (v[locale] || v[locale === 'ar' ? 'en' : 'ar'] || '') : (v || ''));

/** Title, description and indexing for the page at this path. */
function pageMeta(seo, path, locale) {
  const key = PATH_PAGE[path] || null;
  const p = key ? seo.pages[key] || {} : {};
  return { key, title: L(p.title, locale), description: L(p.description, locale) || L(seo.description, locale), noindex: Boolean(p.noindex) };
}

/** JSON for a <script type="application/ld+json"> block (safe inside HTML). */
const ldJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

/** robots.txt, including the AI crawler switches (GEO). */
function robots(seo, base, privatePaths) {
  const lines = ['User-agent: *', ...privatePaths.map((p) => `Disallow: ${p}`), ''];
  for (const [k, agent] of Object.entries(AI_BOTS)) {
    lines.push(`User-agent: ${agent}`);
    if (seo.bots[k] === false) lines.push('Disallow: /');
    else lines.push(...privatePaths.map((p) => `Disallow: ${p}`), 'Allow: /');
    lines.push('');
  }
  lines.push(`Sitemap: ${base}/sitemap.xml`, '');
  return lines.join('\n');
}

// ---------- Structured data (AEO) ----------
const strip = (v) => String(v || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * JSON-LD objects for a public page. `page` carries what the view has: plans (home/pricing),
 * the site content (FAQ), a marketplace job.
 */
function structuredData({ seo, mkt, base, locale, path, logoUrl, site, plans, job }) {
  const out = [];
  const name = L(seo.site_name, locale) || 'RemoteWay';
  const orgId = `${base}/#organization`;
  const sameAs = Object.values(mkt.social || {}).filter(Boolean);
  const o = seo.org || {};
  if (seo.schema.organization && path === '/') {
    out.push({
      '@context': 'https://schema.org', '@type': 'Organization', '@id': orgId, name, url: `${base}/`, logo: logoUrl,
      ...(o.legal_name ? { legalName: o.legal_name } : {}), ...(sameAs.length ? { sameAs } : {}),
      ...(o.email || o.phone ? { contactPoint: [{ '@type': 'ContactPoint', contactType: 'customer support', ...(o.email ? { email: o.email } : {}), ...(o.phone ? { telephone: o.phone } : {}), availableLanguage: ['ar', 'en'] }] } : {}),
      ...(o.city || o.country || o.address ? { address: { '@type': 'PostalAddress', ...(o.address ? { streetAddress: o.address } : {}), ...(o.city ? { addressLocality: o.city } : {}), ...(o.country ? { addressCountry: o.country } : {}) } } : {}),
    });
  }
  if (seo.schema.website && path === '/') {
    out.push({ '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${base}/#website`, name, url: `${base}/`, inLanguage: ['ar', 'en'], publisher: { '@id': orgId },
      potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${base}/jobs?q={search_term_string}` }, 'query-input': 'required name=search_term_string' } });
  }
  if (seo.schema.software && (path === '/' || path === '/pricing') && Array.isArray(plans) && plans.length) {
    const offers = plans.filter((p) => p.price_monthly !== undefined && p.price_monthly !== null).map((p) => ({
      '@type': 'Offer', name: p.name, price: String(Number(p.price_monthly) || 0), priceCurrency: p.currency || 'SAR', url: `${base}/pricing`,
    }));
    out.push({ '@context': 'https://schema.org', '@type': 'SoftwareApplication', name, applicationCategory: 'BusinessApplication', operatingSystem: 'Web',
      description: L(seo.description, locale) || undefined, url: `${base}/`, publisher: { '@id': orgId }, ...(offers.length ? { offers } : {}) });
  }
  if (seo.schema.faq && path === '/' && site && Array.isArray(site.sections)) {
    const qa = [];
    for (const s of site.sections) {
      if (s.type !== 'faq' || s.hidden) continue;
      for (const it of s.data.items || []) { const q = strip(L(it.q, locale)); const a = strip(L(it.a, locale)); if (q && a) qa.push({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } }); }
    }
    if (qa.length) out.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: qa });
  }
  if (seo.schema.jobs && job) {
    const TYPES = { full_time: 'FULL_TIME', part_time: 'PART_TIME', contract: 'CONTRACTOR', freelance: 'CONTRACTOR', intern: 'INTERN' };
    const posted = job.marketplace_at || job.published_at;
    const jp = {
      '@context': 'https://schema.org', '@type': 'JobPosting', title: job.title,
      description: String(job.description || job.title) + (job.requirements ? `\n\n${job.requirements}` : ''),
      datePosted: posted ? new Date(posted).toISOString().slice(0, 10) : undefined,
      employmentType: TYPES[job.employment_type] || undefined,
      hiringOrganization: { '@type': 'Organization', name: job.org_name, ...(job.logo_sha ? { logo: `${base}/org-brand/${job.organization_id}/logo/${job.logo_sha}` } : {}) },
      directApply: true, url: `${base}/jobs/${job.org_slug}/${job.slug}`,
    };
    if (job.work_mode === 'remote') { jp.jobLocationType = 'TELECOMMUTE'; jp.applicantLocationRequirements = { '@type': 'Country', name: job.location_country || 'SA' }; }
    if (job.location_city || job.location_country) jp.jobLocation = { '@type': 'Place', address: { '@type': 'PostalAddress', ...(job.location_city ? { addressLocality: job.location_city } : {}), addressCountry: job.location_country || 'SA' } };
    if (job.show_salary && (job.salary_min || job.salary_max)) {
      jp.baseSalary = { '@type': 'MonetaryAmount', currency: job.salary_currency || job.org_currency || 'SAR', value: { '@type': 'QuantitativeValue', unitText: 'MONTH', ...(job.salary_min ? { minValue: Number(job.salary_min) } : {}), ...(job.salary_max ? { maxValue: Number(job.salary_max) } : {}) } };
    }
    out.push(jp);
  }
  return out;
}

// ---------- llms.txt (GEO) ----------
/** A plain-language summary for AI assistants, generated from the website content unless the admin wrote one. */
function llmsDefault({ seo, site, base, plans }) {
  const lines = [];
  const name = L(seo.site_name, 'en') || 'RemoteWay';
  lines.push(`# ${name}`, '');
  const desc = L(seo.description, 'en') || L(seo.description, 'ar');
  if (desc) lines.push(`> ${strip(desc)}`, '');
  const sections = (site && site.sections) || [];
  const hero = sections.find((s) => s.type === 'hero' && !s.hidden);
  const heroText = (lc) => [strip(['title_1', 'title_accent', 'title_3'].map((k) => L(hero.data[k], lc)).join(' ')), strip(L(hero.data.lead, lc))].filter(Boolean);
  if (hero) lines.push(...heroText('en'), '', ...heroText('ar'), '');
  lines.push('## Main pages', `- [Home](${base}/): product overview (Arabic and English)`, `- [Pricing](${base}/pricing): plans and prices`, `- [Jobs](${base}/jobs): open remote jobs from companies on the platform`,
    `- [Talent](${base}/talent): public professional profiles`, `- [Book a demo](${base}/demo)`, `- [Privacy policy](${base}/privacy)`, `- [Terms](${base}/terms)`, '');
  if (Array.isArray(plans) && plans.length) {
    lines.push('## Plans');
    for (const p of plans) lines.push(`- ${p.name}: ${Number(p.price_monthly) || 0} ${p.currency || 'SAR'} per month`);
    lines.push('');
  }
  for (const s of sections) {
    if (s.type !== 'faq' || s.hidden) continue;
    lines.push('## Frequently asked questions');
    for (const it of s.data.items || []) {
      const q = strip(L(it.q, 'en')); const a = strip(L(it.a, 'en'));
      if (q && a) lines.push(`### ${q}`, a, '');
    }
  }
  return `${lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n').trim()}\n`;
}

// ---------- <head> tags for public pages ----------
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function pixelTags(mkt, consent, event, assetV) {
  const pixels = Object.fromEntries(Object.entries(mkt.pixels || {}).filter(([, v]) => v));
  if (!Object.keys(pixels).length) return [];
  return [`<meta name="rw-pixels" content="${esc(JSON.stringify({ ids: pixels, consent: consent || '', event: event || '' }))}">`,
    `<script src="/js/pixels.js?v=${esc(assetV || '')}" defer></script>`];
}

/** What the public page's <head> gets: the <title> and the meta/link/JSON-LD tags. */
function head(o) {
  const { seo, mkt, base, locale, path, siteMedia, consent } = o;
  const meta = pageMeta(seo, path, locale);
  const siteName = L(seo.site_name, locale) || 'RemoteWay';
  if (isPrivate(path)) {
    // Signed-in pages never load pixels, except once to report a sign-up the visitor already consented to.
    const html = ['<meta name="robots" content="noindex, nofollow">'];
    if (o.pixelEvent && consent === 'yes' && mkt.events) html.push(...pixelTags(mkt, consent, o.pixelEvent, o.assetV));
    return { title: o.title ? `${o.title} · ${siteName}` : siteName, html: html.join('\n') };
  }
  const title = meta.title || (o.title ? `${o.title} · ${siteName}` : siteName);
  const description = meta.description || o.fallbackDescription || '';
  const tags = [];
  const m = (name, content, attr = 'name') => content && tags.push(`<meta ${attr}="${esc(name)}" content="${esc(content)}">`);
  m('description', description);
  m('keywords', L(seo.keywords, locale));
  if (meta.noindex || o.noindex) m('robots', 'noindex, follow');
  const url = `${base}${path}`;
  tags.push(`<link rel="canonical" href="${esc(`${url}?lang=${locale}`)}">`);
  for (const lc of ['ar', 'en']) tags.push(`<link rel="alternate" hreflang="${lc}" href="${esc(`${url}?lang=${lc}`)}">`);
  tags.push(`<link rel="alternate" hreflang="x-default" href="${esc(url)}">`);
  // Social sharing previews
  const img = seo.og_image && siteMedia && siteMedia[seo.og_image] && siteMedia[seo.og_image].kind === 'image' ? `${base}${siteMedia[seo.og_image].url}` : `${base}/brand/logo-primary.png`;
  m('og:type', o.job ? 'article' : 'website', 'property');
  m('og:site_name', siteName, 'property');
  m('og:title', meta.title || o.title || siteName, 'property');
  m('og:description', description, 'property');
  m('og:url', `${url}?lang=${locale}`, 'property');
  m('og:image', img, 'property');
  m('og:locale', locale === 'ar' ? 'ar_SA' : 'en_US', 'property');
  m('og:locale:alternate', locale === 'ar' ? 'en_US' : 'ar_SA', 'property');
  m('twitter:card', 'summary_large_image');
  if (seo.x_handle) m('twitter:site', `@${seo.x_handle}`);
  // Search console ownership
  m('google-site-verification', seo.verify.google);
  m('msvalidate.01', seo.verify.bing);
  m('yandex-verification', seo.verify.yandex);
  // Structured data (not executed, so the strict script policy does not apply)
  for (const d of structuredData({ ...o, logoUrl: `${base}/brand/logo-primary.png` })) tags.push(`<script type="application/ld+json">${ldJson(d)}</script>`);
  // Advertising pixels: settings in a meta tag, loaded by /js/pixels.js only after the visitor accepts.
  tags.push(...pixelTags(mkt, consent, mkt.events ? o.pixelEvent : '', o.assetV));
  return { title, html: tags.join('\n') };
}
/** Remembers a conversion (sign-up, demo request) for the next page, where the pixels report it once. */
const EVENTS = ['signup', 'join', 'lead'];
function markConversion(res, kind) {
  if (EVENTS.includes(kind)) res.cookie('rw_px_ev', kind, { maxAge: 10 * 60_000, httpOnly: true, sameSite: 'lax', secure: require('../../config').isProd }); // eslint-disable-line global-require
}
const hasPendingConversion = (req) => /(?:^|;\s*)rw_px_ev=/.test(req.headers.cookie || '');
const hasPixels = (mkt) => Object.values((mkt && mkt.pixels) || {}).some(Boolean);

module.exports = { EVENTS, markConversion, hasPendingConversion, cspFrom, PRIVATE_PATHS, isPrivate, head, hasPixels, structuredData, llmsDefault, PAGES, PATH_PAGE, AI_BOTS, SOCIAL, PIXELS, get, save, marketing, saveMarketing, refreshCsp, csp, pageMeta, ldJson, robots, L };
