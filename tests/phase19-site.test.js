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

describe('website media and alignment', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f3b13b0000000049454e44ae426082', 'hex');
  const MP4 = Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(64)]);
  let imgId; let vidId; let embedId;
  test('upload images and videos (checked by content), add YouTube links', async () => {
    const bad = await admin.agent.post('/admin/site/media').field('_csrf', admin.csrf).attach('file', Buffer.from('<svg onload=alert(1)>'), 'x.png');
    assert.equal(bad.status, 302);
    assert.equal(await h.knex('site_media').first(), undefined, 'fake image refused');
    assert.equal((await admin.agent.post('/admin/site/media').field('_csrf', admin.csrf).field('name', 'Office').attach('file', PNG, 'office.png')).status, 302);
    assert.equal((await admin.agent.post('/admin/site/media').field('_csrf', admin.csrf).attach('file', MP4, 'tour.mp4')).status, 302);
    await admin.form('/admin/site/media/embed', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', name: 'Intro' });
    await admin.form('/admin/site/media/embed', { url: 'https://evil.example/x', name: 'Bad' });
    const rows = await h.knex('site_media').orderBy('id');
    assert.deepEqual(rows.map((r) => r.kind), ['image', 'video', 'embed']);
    [imgId, vidId, embedId] = rows.map((r) => r.id);
    const file = await pub().get(`/site-media/${imgId}/${rows[0].sha}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers['content-type'], 'image/png');
    assert.equal((await pub().get(`/site-media/${imgId}/0000000000000000`)).status, 404);
    const video = await pub().get(`/site-media/${vidId}/${rows[1].sha}`).set('Range', 'bytes=0-9');
    assert.equal(video.status, 206, 'videos support range requests');
    assert.match((await admin.get('/admin/site/media')).text, /Office/);
  });

  test('sections get alignment and media; cards get images', async () => {
    const c = await require('../src/modules/site/content.service').get();
    const faq = c.sections.find((x) => x.type === 'faq');
    await admin.form(`/admin/site/sections/${faq.id}`, {
      f_title_ar: 'أسئلة', f_title_en: 'Questions', it_q_ar: ['س'], it_q_en: ['Q'], it_a_ar: ['ج'], it_a_en: ['A'], anchor: 'faq',
      d_title_align: 'center', d_text_align: 'justify', d_media: String(imgId), d_media_pos: 'start', d_media_size: 'large', d_video_mode: 'controls',
    });
    let home = (await pub().get('/?lang=en')).text;
    assert.match(home, /class="section faq al-t-center al-x-justify"/);
    assert.match(home, /class="sec-split media-start"/);
    assert.match(home, new RegExp(`/site-media/${imgId}/`));
    const hero = c.sections.find((x) => x.type === 'hero');
    const body = { anchor: 'platform', d_media: String(embedId), d_media_pos: 'panel', d_video_mode: 'autoplay', d_title_align: 'default', d_text_align: 'default', d_media_size: 'medium' };
    for (const k of ['eyebrow', 'title_1', 'title_accent', 'title_3', 'lead', 'btn1_label', 'btn2_label', 'note', 'panel_big', 'panel_text']) { body[`f_${k}_ar`] = 'x'; body[`f_${k}_en`] = 'x'; }
    await admin.form(`/admin/site/sections/${hero.id}`, body);
    home = (await pub().get('/?lang=en')).text;
    assert.match(home, /hero-panel-media/);
    assert.match(home, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?autoplay=1&amp;mute=1/);
    // background video on the CTA band, image on a card
    const cta = c.sections.find((x) => x.type === 'cta');
    await admin.form(`/admin/site/sections/${cta.id}`, { f_title_1_en: 'Go', f_title_2_en: 'now', anchor: 'start', d_media: String(vidId), d_media_pos: 'background', d_title_align: 'default', d_text_align: 'default', d_media_size: 'medium', d_video_mode: 'autoplay' });
    const cards = c.sections.find((x) => x.type === 'cards');
    await admin.form(`/admin/site/sections/${cards.id}`, { anchor: 'join', it_icon: ['briefcase'], it_image: [String(imgId)], it_title_ar: ['بطاقة'], it_title_en: ['Card'], it_text_ar: [''], it_text_en: [''], it_button_label_ar: [''], it_button_label_en: [''], it_button_href: [''], it_style: ['primary'] });
    home = (await pub().get('/?lang=en')).text;
    assert.match(home, /has-bg/);
    assert.match(home, /<video class="sec-bg"/);
    assert.match(home, /class="card-media"/);
    // Deleting a file leaves the page working
    await admin.form(`/admin/site/media/${imgId}/delete`, {});
    const after = await pub().get('/?lang=en');
    assert.equal(after.status, 200);
    assert.ok(!after.text.includes(`/site-media/${imgId}/`));
  });
});
