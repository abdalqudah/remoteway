// Landing page content, editable from Super Admin: the header, an ordered list of sections and the
// footer. Every text has an Arabic and an English version. Until the platform saves its own version,
// the content is built from the translation files, so the page looks exactly as it always did.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { translator } = require('../../core/i18n');
const { E } = require('../../core/errors');

const KEY = 'site_content';

// Icons available in the sprite (public/icons.svg)
const ICONS = (() => {
  try {
    const svg = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'icons.svg'), 'utf8');
    return [...svg.matchAll(/id="i-([a-z0-9-]+)"/g)].map((m) => m[1]).sort();
  } catch { return []; }
})();

// ---------- Section types: what can be edited in each ----------
// kinds: text (one line), textarea, link (a URL/path), icon, select, plain (not translated)
const BADGES = ['none', 'available', 'soon', 'auto'];
const BTN_STYLES = ['primary', 'dark', 'secondary'];
const TYPES = {
  hero: {
    fields: [['eyebrow', 'text'], ['eyebrow_icon', 'icon'], ['title_1', 'text'], ['title_accent', 'text'], ['title_3', 'text'], ['lead', 'textarea'],
      ['btn1_label', 'text'], ['btn1_href', 'link'], ['btn2_label', 'text'], ['btn2_href', 'link'], ['note', 'text'],
      ['panel_big', 'text'], ['panel_text', 'text'], ['panel_tag', 'plain']],
    items: [['label', 'text'], ['highlight', 'select', ['no', 'yes']]],
  },
  stats: { fields: [['title', 'text']], items: [['value', 'plain'], ['label', 'text']] },
  jobs: { dynamic: true, fields: [['title', 'text'], ['lead', 'text'], ['button_label', 'text'], ['button_href', 'link']] },
  talent: { dynamic: true, fields: [['title', 'text'], ['lead', 'text'], ['button_label', 'text'], ['button_href', 'link']] },
  cards: { fields: [['title', 'text'], ['lead', 'text']], items: [['icon', 'icon'], ['title', 'text'], ['text', 'textarea'], ['button_label', 'text'], ['button_href', 'link'], ['style', 'select', BTN_STYLES]] },
  modules: { fields: [['title', 'text'], ['lead', 'textarea']], items: [['icon', 'icon'], ['title', 'text'], ['text', 'textarea'], ['badge', 'select', BADGES], ['feature', 'feature']] },
  list: { fields: [['title', 'text'], ['lead', 'textarea']], items: [['icon', 'icon'], ['title', 'text'], ['text', 'text'], ['badge', 'select', BADGES.slice(0, 3)]] },
  grid: { fields: [['title', 'text'], ['lead', 'textarea']], items: [['icon', 'icon'], ['title', 'text'], ['text', 'textarea']] },
  pricing: { dynamic: true, fields: [['title', 'text'], ['lead', 'text']] },
  faq: { fields: [['title', 'text']], items: [['q', 'text'], ['a', 'textarea']] },
  text: { fields: [['title', 'text'], ['body', 'textarea']] },
  cta: { fields: [['title_1', 'text'], ['title_2', 'text'], ['btn1_label', 'text'], ['btn1_href', 'link'], ['btn2_label', 'text'], ['btn2_href', 'link']] },
};
const HEADER = { items: [['label', 'text'], ['href', 'link']], fields: [['login_label', 'text'], ['join_label', 'text'], ['signup_label', 'text'], ['signup_href', 'link'], ['show_login', 'select', ['yes', 'no']], ['show_join', 'select', ['yes', 'no']]] };
const FOOTER = { items: [['label', 'text'], ['href', 'link']], fields: [['tagline', 'text'], ['copyright', 'plain']] };
const isI18n = (kind) => ['text', 'textarea'].includes(kind);

// ---------- Starting content (the original page, from the translation files) ----------
function defaults() {
  const en = translator('en');
  const ar = translator('ar');
  const T = (k, vars) => ({ en: en(k, vars), ar: ar(k, vars) });
  const same = (v) => ({ en: v, ar: v });
  const id = (s) => s;
  return {
    header: {
      items: [['site.nav_platform', '/#platform'], ['site.nav_modules', '/#modules'], ['talent.nav_jobs', '/jobs'], ['talent.nav_talent', '/talent'],
        ['site.nav_security', '/#security'], ['site.pricing', '/pricing'], ['site.nav_faq', '/#faq']].map(([k, href]) => ({ label: T(k), href })),
      login_label: T('auth.login'), join_label: T('talent.join_cta'), signup_label: T('site.start_free'), signup_href: '/signup', show_login: 'yes', show_join: 'yes',
    },
    sections: [
      { id: id('hero'), type: 'hero', anchor: 'platform', hidden: false, data: {
        eyebrow: T('site.eyebrow'), eyebrow_icon: 'sparkles', title_1: T('site.hero_1'), title_accent: T('site.hero_2'), title_3: T('site.hero_3'), lead: T('site.hero_lead'),
        btn1_label: T('site.start_free'), btn1_href: '/signup', btn2_label: T('site.book_demo'), btn2_href: '/demo', note: T('site.hero_note'),
        panel_big: same('From Anywhere.'), panel_text: T('site.panel_text'), panel_tag: '#REMOTE WAY',
        items: ['recruit', 'hire', 'onboard', 'manage', 'track', 'pay', 'evaluate', 'develop', 'retain'].map((k, i) => ({ label: T(`site.life_${k}`), highlight: i === 3 ? 'yes' : 'no' })),
      } },
      { id: 'jobs', type: 'jobs', anchor: 'latest-jobs', hidden: false, data: { title: T('talent.latest_jobs'), lead: T('talent.latest_jobs_lead'), button_label: T('talent.all_jobs'), button_href: '/jobs' } },
      { id: 'talent', type: 'talent', anchor: 'discover-talent', hidden: false, data: { title: T('talent.discover_title'), lead: T('talent.discover_home_lead'), button_label: T('talent.browse_talent'), button_href: '/talent' } },
      { id: 'join', type: 'cards', anchor: 'join', hidden: false, data: { title: same(''), lead: same(''), items: [
        { icon: 'user-round-plus', title: T('talent.cta_individual'), text: T('talent.cta_individual_text'), button_label: T('talent.join_cta'), button_href: '/join', style: 'primary' },
        { icon: 'briefcase', title: T('talent.cta_company'), text: T('talent.cta_company_text'), button_label: T('site.start_free'), button_href: '/signup', style: 'dark' },
      ] } },
      { id: 'modules', type: 'modules', anchor: 'modules', hidden: false, data: { title: T('site.modules_title'), lead: T('site.modules_lead'), items: [
        ['users', 'workforce', 'employees'], ['calendar-check', 'attendance', 'attendance'], ['file-text', 'documents', 'documents'],
        ['briefcase', 'recruitment', 'recruitment'], ['user-round-plus', 'onboarding', 'onboarding'], ['wallet', 'payroll', 'payroll'],
        ['target', 'performance', 'performance'], ['graduation-cap', 'learning', 'learning'], ['chart-column', 'analytics', 'analytics'],
        ['shield-check', 'compliance', 'compliance'], ['zap', 'automation', 'automation'], ['sparkles', 'ai', 'ai_recruitment'],
        ['key-round', 'sso', 'sso'], ['user-cog', 'rbac', ''], ['badge-check', 'white_label', 'white_label'],
        ['user-round-plus', 'talent_marketplace', 'talent_marketplace'], ['search', 'talent_ai', 'ai_recruitment'], ['globe', 'jobs_board', 'talent_marketplace'],
      ].map(([icon, k, feature]) => ({ icon, title: T(`site.mod_${k}_title`), text: T(`site.mod_${k}_text`), badge: feature ? 'auto' : 'available', feature })) } },
      { id: 'integrations', type: 'list', anchor: 'integrations', hidden: false, data: { title: T('site.integrations_title'), lead: T('site.integrations_lead'), items: [
        ['mail', 'email', 1], ['phone', 'sms', 1], ['message-square', 'chat', 1], ['calendar-days', 'calendar', 1], ['send', 'webhooks', 1], ['plug', 'api', 1], ['credit-card', 'payments', 1], ['wallet', 'payway', 0],
      ].map(([icon, k, live]) => ({ icon, title: T(`site.int_${k}`), text: T(`site.int_${k}_text`), badge: live ? 'available' : 'soon' })) } },
      { id: 'security', type: 'grid', anchor: 'security', hidden: false, data: { title: T('site.security_title'), lead: T('site.security_lead'), items: [
        ['lock', 'isolation'], ['user-cog', 'rbac'], ['history', 'audit'], ['key-round', 'secrets'], ['shield-check', 'web'], ['globe', 'locale'],
      ].map(([icon, k]) => ({ icon, title: T(`site.sec_${k}`), text: T(`site.sec_${k}_text`) })) } },
      { id: 'pricing', type: 'pricing', anchor: 'pricing', hidden: false, data: { title: T('site.pricing_title'), lead: T('site.pricing_lead') } },
      { id: 'faq', type: 'faq', anchor: 'faq', hidden: false, data: { title: T('site.faq_title'), items: [1, 2, 3, 4, 5, 6].map((i) => ({ q: T(`site.faq_q${i}`), a: T(`site.faq_a${i}`) })) } },
      { id: 'cta', type: 'cta', anchor: 'start', hidden: false, data: { title_1: T('site.cta_1'), title_2: T('site.cta_2'), btn1_label: T('site.start_free'), btn1_href: '/signup', btn2_label: T('site.see_pricing'), btn2_href: '/pricing' } },
    ],
    footer: { tagline: T('site.footer_tagline'), copyright: 'RemoteWay', items: [['legal.privacy_title', '/privacy'], ['legal.terms_title', '/terms'], ['legal.contact', '/demo']].map(([k, href]) => ({ label: T(k), href })) },
  };
}

// ---------- Reading ----------
async function get() {
  return cache.remember('site:content', async () => {
    const row = await knex('platform_settings').where({ key: KEY }).first();
    if (!row) return defaults();
    const v = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    return v && v.sections ? v : defaults();
  }, 60_000);
}
const isCustomised = async () => Boolean(await knex('platform_settings').where({ key: KEY }).first('key'));

async function save(ctx, content, action) {
  const value = JSON.stringify(content);
  if (value.length > 400_000) throw E.validation({ content: 'The page is too large.' });
  await knex('platform_settings').insert({ key: KEY, value }).onConflict('key').merge({ value, updated_at: new Date() });
  cache.forgetPrefix('site:');
  await audit.record(ctx, 'platform.site_updated', { newValues: { action } });
}

async function reset(ctx) {
  await knex('platform_settings').where({ key: KEY }).del();
  cache.forgetPrefix('site:');
  await audit.record(ctx, 'platform.site_reset', {});
}

// ---------- Form parsing ----------
const clip = (v, n) => String(v ?? '').replace(/\r/g, '').trim().slice(0, n);
/** Only site paths, in-page anchors, https links, mail and phone links (never javascript: and friends). */
function safeHref(v) {
  const s = clip(v, 500);
  if (!s) return '';
  if (/^(\/(?!\/)|#|https:\/\/|http:\/\/|mailto:|tel:)/i.test(s)) return s;
  return '';
}
const arr = (body, name) => [].concat(body[name] ?? []);

function parseField(body, prefix, [key, kind, options]) {
  if (isI18n(kind)) return { ar: clip(body[`${prefix}${key}_ar`], kind === 'textarea' ? 4000 : 400), en: clip(body[`${prefix}${key}_en`], kind === 'textarea' ? 4000 : 400) };
  if (kind === 'link') return safeHref(body[`${prefix}${key}`]);
  if (kind === 'icon') return ICONS.includes(body[`${prefix}${key}`]) ? body[`${prefix}${key}`] : '';
  if (kind === 'select') return options.includes(body[`${prefix}${key}`]) ? body[`${prefix}${key}`] : options[0];
  return clip(body[`${prefix}${key}`], 200); // plain / feature
}

function parseItems(body, fields) {
  // Rows arrive as parallel arrays (it_<field>[_ar|_en]); the first field decides the row count.
  const [k0, kind0] = fields[0];
  const count = arr(body, isI18n(kind0) ? `it_${k0}_ar` : `it_${k0}`).length;
  const rows = [];
  for (let i = 0; i < Math.min(count, 60); i += 1) {
    const row = {};
    for (const [key, kind, options] of fields) {
      if (isI18n(kind)) row[key] = { ar: clip(arr(body, `it_${key}_ar`)[i], kind === 'textarea' ? 4000 : 400), en: clip(arr(body, `it_${key}_en`)[i], kind === 'textarea' ? 4000 : 400) };
      else if (kind === 'link') row[key] = safeHref(arr(body, `it_${key}`)[i]);
      else if (kind === 'icon') row[key] = ICONS.includes(arr(body, `it_${key}`)[i]) ? arr(body, `it_${key}`)[i] : '';
      else if (kind === 'select') row[key] = options.includes(arr(body, `it_${key}`)[i]) ? arr(body, `it_${key}`)[i] : options[0];
      else row[key] = clip(arr(body, `it_${key}`)[i], 200);
    }
    const empty = Object.values(row).every((v) => (typeof v === 'object' ? !v.ar && !v.en : !v || ['no', 'none', 'primary', 'yes', 'available'].includes(v)));
    if (!empty) rows.push(row);
  }
  return rows;
}

const cleanAnchor = (v) => clip(v, 40).toLowerCase().replace(/[^a-z0-9-]/g, '');

// ---------- Editing ----------
async function updateSection(ctx, id, body) {
  const content = structuredClone(await get());
  const s = content.sections.find((x) => x.id === id);
  if (!s) throw E.notFound('Section');
  const schema = TYPES[s.type];
  const data = {};
  for (const f of schema.fields) data[f[0]] = parseField(body, 'f_', f);
  if (schema.items) data.items = parseItems(body, schema.items);
  s.data = data;
  s.anchor = cleanAnchor(body.anchor) || s.anchor;
  s.hidden = body.hidden === '1';
  await save(ctx, content, `section:${id}`);
}

async function updateBlock(ctx, which, body) {
  const content = structuredClone(await get());
  const schema = which === 'header' ? HEADER : FOOTER;
  const data = {};
  for (const f of schema.fields) data[f[0]] = parseField(body, 'f_', f);
  data.items = parseItems(body, schema.items);
  content[which] = data;
  await save(ctx, content, which);
}

function blankSection(type) {
  const schema = TYPES[type];
  const data = {};
  for (const [key, kind] of schema.fields) data[key] = isI18n(kind) ? { ar: '', en: '' } : '';
  if (type === 'text') data.title = { ar: 'قسم جديد', en: 'New section' };
  else if (data.title) data.title = { ar: 'قسم جديد', en: 'New section' };
  if (schema.items) data.items = [];
  return data;
}

async function addSection(ctx, type, afterId) {
  if (!TYPES[type]) throw E.validation({ type: 'Choose a section type.' });
  const content = structuredClone(await get());
  const id = `${type}-${crypto.randomBytes(3).toString('hex')}`;
  const section = { id, type, anchor: id, hidden: false, data: blankSection(type) };
  const at = content.sections.findIndex((x) => x.id === afterId);
  if (at >= 0) content.sections.splice(at + 1, 0, section); else content.sections.push(section);
  await save(ctx, content, `add:${type}`);
  return id;
}

async function removeSection(ctx, id) {
  const content = structuredClone(await get());
  const before = content.sections.length;
  content.sections = content.sections.filter((x) => x.id !== id);
  if (content.sections.length === before) throw E.notFound('Section');
  await save(ctx, content, `remove:${id}`);
}

async function moveSection(ctx, id, dir) {
  const content = structuredClone(await get());
  const i = content.sections.findIndex((x) => x.id === id);
  if (i < 0) throw E.notFound('Section');
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= content.sections.length) return;
  [content.sections[i], content.sections[j]] = [content.sections[j], content.sections[i]];
  await save(ctx, content, `move:${id}`);
}

async function toggleSection(ctx, id) {
  const content = structuredClone(await get());
  const s = content.sections.find((x) => x.id === id);
  if (!s) throw E.notFound('Section');
  s.hidden = !s.hidden;
  await save(ctx, content, `toggle:${id}`);
}

async function duplicateSection(ctx, id) {
  const content = structuredClone(await get());
  const i = content.sections.findIndex((x) => x.id === id);
  if (i < 0) throw E.notFound('Section');
  const copy = structuredClone(content.sections[i]);
  copy.id = `${copy.type}-${crypto.randomBytes(3).toString('hex')}`;
  copy.anchor = copy.id;
  content.sections.splice(i + 1, 0, copy);
  await save(ctx, content, `duplicate:${id}`);
  return copy.id;
}

module.exports = {
  ICONS, TYPES, HEADER, FOOTER, BADGES, isI18n, defaults, get, isCustomised, reset, safeHref,
  updateSection, updateBlock, addSection, removeSection, moveSection, toggleSection, duplicateSection,
};
