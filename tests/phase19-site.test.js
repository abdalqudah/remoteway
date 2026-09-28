// Landing page editor: every text, icon, section, header and footer is editable from Super Admin.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers');

const pub = () => h.request(h.getApp());
let admin;
async function staff(role) {
  const email = `${role}${Date.now()}${Math.random().toString(36).slice(2, 5)}@rw.test`;
  await h.knex('users').insert({ name: role, email, password_hash: await bcrypt.hash('Password#123', 4), is_super_admin: true, platform_role: role });
  return h.login(email, 'Password#123');
}
const content = () => require('../src/modules/site/content.service').get();

before(async () => { await h.resetDatabase(); admin = await staff('admin'); });
after(async () => { await h.knex.destroy(); });

describe('landing page editor', () => {
  test('the page starts from the original content and lists every section', async () => {
    const home = await pub().get('/?lang=en');
    assert.equal(home.status, 200);
    assert.match(home.text, /id="modules"/);
    assert.match(home.text, /id="faq"/);
    const page = await admin.get('/admin/site');
    assert.equal(page.status, 200);
    for (const ty of ['Hero', 'Modules grid', 'Feature grid', 'Questions', 'Call to action band']) assert.ok(page.text.includes(ty), ty);
    const sales = await staff('sales');
    assert.equal((await sales.get('/admin/site')).status, 403);
  });

  test('editing texts (both languages), icons and items; unsafe input is neutralised', async () => {
    const edit = await admin.get('/admin/site/sections/hero');
    assert.equal(edit.status, 200);
    const r = await admin.form('/admin/site/sections/hero', {
      f_eyebrow_ar: 'منصة جديدة', f_eyebrow_en: 'Brand new <script>alert(1)</script>', f_eyebrow_icon: 'rocket',
      f_title_1_ar: 'عنوان', f_title_1_en: 'Headline', f_title_accent_ar: 'أخضر', f_title_accent_en: 'Green', f_title_3_ar: '', f_title_3_en: '',
      f_lead_ar: 'وصف', f_lead_en: 'Lead', f_btn1_label_ar: 'ابدأ', f_btn1_label_en: 'Start', f_btn1_href: 'javascript:alert(1)',
      f_btn2_label_ar: 'تواصل', f_btn2_label_en: 'Contact', f_btn2_href: '/demo', f_panel_tag: '#RW', anchor: 'top',
      it_label_ar: ['أ', 'ب'], it_label_en: ['A', 'B'], it_highlight: ['no', 'yes'],
    });
    assert.equal(r.status, 302);
    const c = await content();
    const hero = c.sections.find((s) => s.id === 'hero');
    assert.equal(hero.data.btn1_href, '', 'javascript: links are dropped');
    assert.equal(hero.data.eyebrow_icon, 'rocket');
    assert.equal(hero.data.items.length, 2);
    const en = await pub().get('/?lang=en');
    assert.match(en.text, /Brand new &lt;script&gt;/);
    assert.ok(!en.text.includes('<script>alert(1)'));
    assert.ok(!en.text.includes('javascript:alert'));
    assert.match(en.text, /id="top"/);
    assert.match((await pub().get('/?lang=ar')).text, /منصة جديدة/);
  });

  test('add, move, hide, duplicate and delete sections', async () => {
    const add = await admin.form('/admin/site/sections', { type: 'text', after: 'hero' });
    assert.equal(add.status, 302);
    const id = add.headers.location.split('/').pop();
    await admin.form(`/admin/site/sections/${id}`, { f_title_ar: 'من نحن', f_title_en: 'About us', f_body_ar: 'فقرة أولى\n\nفقرة ثانية', f_body_en: 'First\n\nSecond', anchor: 'about' });
    let c = await content();
    assert.equal(c.sections[1].id, id, 'added after the hero');
    let home = (await pub().get('/?lang=en')).text;
    assert.match(home, /About us/);
    assert.match(home, /<p>First<\/p>/);
    await admin.form(`/admin/site/sections/${id}/move`, { dir: 'down' });
    c = await content();
    assert.equal(c.sections[2].id, id);
    await admin.form(`/admin/site/sections/${id}/toggle`, {});
    assert.ok(!(await pub().get('/?lang=en')).text.includes('About us'), 'hidden');
    await admin.form(`/admin/site/sections/${id}/toggle`, {});
    await admin.form(`/admin/site/sections/${id}/duplicate`, {});
    c = await content();
    assert.equal(c.sections.filter((s) => s.type === 'text').length, 2);
    await admin.form('/admin/site/sections/faq/delete', {});
    home = (await pub().get('/?lang=en')).text;
    assert.ok(!home.includes('id="faq"'), 'FAQ removed');
    assert.equal((await admin.form('/admin/site/sections', { type: 'nope' })).status, 302);
  });

  test('header menu and footer are editable', async () => {
    await admin.form('/admin/site/header', {
      it_label_ar: ['الرئيسية', 'الوظائف'], it_label_en: ['Home', 'Jobs'], it_href: ['/', '/jobs'],
      f_login_label_ar: 'دخول', f_login_label_en: 'Log in', f_join_label_ar: 'انضم', f_join_label_en: 'Join', f_signup_label_ar: 'جرّب', f_signup_label_en: 'Try it', f_signup_href: '/signup', f_show_login: 'yes', f_show_join: 'no',
    });
    await admin.form('/admin/site/footer', { f_tagline_ar: 'شعارنا', f_tagline_en: 'Our tagline', f_copyright: 'RemoteWay Co', it_label_ar: ['الخصوصية'], it_label_en: ['Privacy'], it_href: ['/privacy'] });
    const home = (await pub().get('/pricing?lang=en')).text;
    assert.match(home, /<a href="\/jobs">Jobs<\/a>/);
    assert.match(home, /Try it/);
    assert.ok(!home.includes('href="/join"'), 'join button hidden');
    assert.match(home, /Our tagline/);
    assert.match(home, /RemoteWay Co/);
  });

  test('restore the original page', async () => {
    await admin.form('/admin/site/reset', {});
    const home = (await pub().get('/?lang=en')).text;
    assert.match(home, /id="faq"/);
    assert.ok(!home.includes('About us'));
  });
});
