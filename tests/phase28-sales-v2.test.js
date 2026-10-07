// Release 1.11: phone numbers for WhatsApp, the wrong-password message, the email log, the services catalog,
// signed acceptance / decline reasons / negotiation, and document templates (Word and online editor).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const AdmZip = require('adm-zip');
const h = require('./helpers');
const mailer = require('../src/core/mailer');
const { normalizePhone } = require('../src/modules/integrations/messaging.service');
const { sanitizeHtml } = require('../src/core/sanitize-html');
const docx = require('../src/core/docx');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

function makeDocx(paragraphs) {
  const z = new AdmZip();
  z.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'));
  const body = paragraphs.map((runs) => `<w:p>${runs.map((r) => `<w:r><w:t xml:space="preserve">${r}</w:t></w:r>`).join('')}</w:p>`).join('');
  z.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`));
  return z.toBuffer();
}

let root; let sales; let support; let contactId;
async function teamMember(role) {
  const email = `${role}${Date.now()}${Math.random().toString(36).slice(2, 6)}@rw.test`;
  await h.knex('users').insert({ name: `${role} person`, email, password_hash: await bcrypt.hash('Password#123', 4), is_super_admin: true, platform_role: role, email_verified_at: new Date() });
  return h.login(email, 'Password#123');
}
const quoteBody = (extra = {}) => ({ customer_name: 'Ahmed', customer_email: 'ahmed@horizon.test', customer_phone: '+966 0501234567', locale: 'en', item_description: ['Setup'], item_quantity: ['1'], item_price: ['1000'], tax_rate: '15', ...extra });

before(async () => {
  await h.resetDatabase();
  root = await teamMember('owner'); sales = await teamMember('sales'); support = await teamMember('support');
  const stage = await h.knex('crm_stages').orderBy('sort_order').first('id');
  [contactId] = await h.knex('crm_contacts').insert({ name: 'Khalid', company_name: 'Ufuq Trading', email: 'khalid@ufuq.test', phone: '966551112233', source: 'manual', kind: 'lead', stage_id: stage.id });
});
after(async () => { await h.knex.destroy(); });

describe('Phones, sign-in and the email log', () => {
  test('phone numbers become valid WhatsApp numbers whatever way they are written', () => {
    for (const x of ['0501234567', '+966501234567', '00966501234567', '+9660501234567', '009660501234567', '9660501234567', '٠٥٠١٢٣٤٥٦٧', '+966 (50) 123-4567']) {
      assert.equal(normalizePhone(x), '966501234567', x);
    }
    assert.equal(normalizePhone('+9620791234567'), '962791234567');
    assert.equal(normalizePhone('12'), null);
  });

  test('a wrong password shows the message on the sign-in page (not an error page)', async () => {
    const a = h.request.agent(h.getApp());
    const page = await a.get('/login');
    const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    const r = await a.post('/login').type('form').send({ _csrf: csrf, email: 'nobody@x.test', password: 'wrong' });
    assert.equal(r.status, 401);
    assert.match(r.text, /action="\/login"/, 'the sign-in form is shown again');
    assert.match(r.text, /alert alert-error/);
    assert.match(r.text, /value="nobody@x.test"/, 'the email stays filled');
  });

  test('every email is logged: sent, not sent and why, including resets for unknown addresses', async () => {
    const a = h.request.agent(h.getApp());
    const page = await a.get('/forgot');
    const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    await a.post('/forgot').type('form').send({ _csrf: csrf, email: 'ghost@nowhere.test' });
    const ghost = await h.knex('email_log').where({ to_addr: 'ghost@nowhere.test' }).first();
    assert.equal(ghost.status, 'not_sent'); assert.equal(ghost.reason, 'no_account'); assert.equal(ghost.kind, 'password_reset');
    const co = await h.createCompany({ plan: 'business' });
    await a.post('/forgot').type('form').send({ _csrf: csrf, email: co.email });
    const real = await h.knex('email_log').where({ to_addr: co.email, kind: 'password_reset' }).first();
    assert.ok(real, 'the reset email is logged');
    const log = await root.get(`/admin/email/log?q=${encodeURIComponent('ghost@')}`);
    assert.equal(log.status, 200); assert.match(log.text, /ghost@nowhere\.test/);
    assert.equal((await support.get('/admin/email/log')).status, 403);
  });
});

describe('Services, signed acceptance and negotiation', () => {
  let svcId; let qid; let token;
  test('services are ticked into a quotation and priced for the customer', async () => {
    assert.equal((await sales.form('/admin/quotes/services', { name_ar: '', price: '-1' })).status, 422);
    assert.equal((await sales.form('/admin/quotes/services', { name_ar: 'اشتراك', name_en: 'Subscription', unit_en: 'per employee / month', price: '35' })).status, 302);
    svcId = (await h.knex('sales_services').first('id')).id;
    const form = await sales.get('/admin/quotes/new');
    assert.match(form.text, /data-service-picker/); assert.match(form.text, /data-text-en="Subscription \(per employee \/ month\)"/);
    const r = await sales.form('/admin/quotes', quoteBody({ contact_id: String(contactId), item_description: ['Subscription (per employee / month)'], item_quantity: ['40'], item_price: ['30'], item_service_id: [String(svcId)] }));
    qid = Number(r.headers.location.match(/(\d+)$/)[1]);
    const q = await h.knex('quotes').where({ id: qid }).first();
    token = q.token;
    assert.equal(Number(q.subtotal), 1200, 'the price set for this customer, not the default');
    assert.equal(q.customer_phone, '+966501234567', 'phone saved in one clean format');
    assert.equal((await h.knex('quote_items').where({ quote_id: qid }).first()).service_id, svcId);
    // A used service is hidden, not deleted
    await sales.form(`/admin/quotes/services/${svcId}/delete`, {});
    assert.equal(Boolean((await h.knex('sales_services').where({ id: svcId }).first()).active), false);
  });

  test('negotiation: the customer proposes, the team replies and revises on the same link', async () => {
    const anon = h.request.agent(h.getApp());
    const v = await anon.get(`/quote/${token}?tab=negotiate`);
    const csrf = v.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    assert.equal((await anon.post(`/quote/${token}/negotiate`).type('form').send({ _csrf: csrf, message: '' })).status, 422);
    mailer.testOutbox.length = 0;
    assert.equal((await anon.post(`/quote/${token}/negotiate`).type('form').send({ _csrf: csrf, amount: '1,100', message: 'Better price for 2 years?' })).status, 302);
    assert.equal((await h.knex('quotes').where({ id: qid }).first()).status, 'negotiating');
    assert.ok(mailer.testOutbox.some((m) => /negotiate/.test(m.subject)), 'the team is told');
    assert.ok(await h.knex('crm_activities').where({ contact_id: contactId, type: 'quote_negotiation' }).first());
    mailer.testOutbox.length = 0;
    await sales.form(`/admin/quotes/${qid}/reply`, { message: 'We can offer 10% off.', email: ['0', '1'] });
    assert.ok(mailer.testOutbox.some((m) => m.to === 'ahmed@horizon.test' && /10% off/.test(m.html)));
    await sales.form(`/admin/quotes/${qid}`, quoteBody({ contact_id: String(contactId), item_description: ['Subscription'], item_quantity: ['40'], item_price: ['27'] }));
    const q = await h.knex('quotes').where({ id: qid }).first();
    assert.equal(q.status, 'sent'); assert.equal(q.revision, 2);
    const page = await anon.get(`/quote/${token}`);
    assert.match(page.text, /We can offer 10% off\./); assert.match(page.text, /Better price for 2 years\?/); assert.match(page.text, /revision 2/);
  });

  test('accepting with a signed and stamped upload instead of drawing', async () => {
    const anon = h.request.agent(h.getApp());
    const v = await anon.get(`/quote/${token}`);
    const csrf = v.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    const bad = await anon.post(`/quote/${token}/accept`).field('_csrf', csrf).field('name', 'Ahmed').attach('signed_file', Buffer.from('nope'), 'x.pdf');
    assert.equal(bad.status, 422);
    const ok = await anon.post(`/quote/${token}/accept`).field('_csrf', csrf).field('name', 'Ahmed').attach('signed_file', PDF, 'signed.pdf');
    assert.equal(ok.status, 302);
    const q = await h.knex('quotes').where({ id: qid }).first();
    assert.equal(q.status, 'accepted'); assert.equal(q.signed_file_mime, 'application/pdf');
    const f = await anon.get(`/quote/${token}/signed-file`).buffer(true);
    assert.equal(f.status, 200); assert.equal(f.headers['content-type'], 'application/pdf');
  });

  test('declining needs a reason; it is shown to the team', async () => {
    const r = await sales.form('/admin/quotes', quoteBody({ customer_email: '' }));
    const id = Number(r.headers.location.match(/(\d+)$/)[1]);
    const q = await h.knex('quotes').where({ id }).first();
    const anon = h.request.agent(h.getApp());
    const v = await anon.get(`/quote/${q.token}?tab=decline`);
    const csrf = v.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    assert.equal((await anon.post(`/quote/${q.token}/decline`).type('form').send({ _csrf: csrf })).status, 422);
    assert.equal((await anon.post(`/quote/${q.token}/decline`).type('form').send({ _csrf: csrf, reason: 'other' })).status, 422, '"other" needs the reason written');
    assert.equal((await anon.post(`/quote/${q.token}/decline`).type('form').send({ _csrf: csrf, reason: 'other_provider', note: 'Went with X' })).status, 302);
    const admin = await sales.get(`/admin/quotes/${id}`);
    assert.match(admin.text, /We chose another provider/); assert.match(admin.text, /Went with X/);
  });
});

describe('Document templates', () => {
  test('the cleaner keeps formatting and removes anything unsafe', () => {
    const out = sanitizeHtml('<h2 style="text-align: center;" onclick="x">Hi {company_name}</h2><script>alert(1)</script><img src=x onerror=y><a href="javascript:z">l</a>');
    assert.equal(out, '<h2 style="text-align: center;">Hi {company_name}</h2><a>l</a>');
  });

  test('Word placeholders split across runs are found and filled', () => {
    const buf = makeDocx([['Dear {cust', 'omer_name},'], ['{اسم_الشركة} &amp; partners']]);
    assert.deepEqual(docx.placeholders(buf).sort(), ['customer_name', 'اسم_الشركة'].sort());
    const xml = new AdmZip(docx.fill(buf, { customer_name: 'Khalid <K>', 'اسم_الشركة': 'Ufuq' })).readAsText('word/document.xml');
    assert.match(xml, /Dear Khalid &lt;K&gt;,/); assert.match(xml, /Ufuq &amp; partners/);
  });

  test('a Word template filled for a CRM contact is saved and sent as a file', async () => {
    const bad = await sales.agent.post('/admin/templates').field('_csrf', sales.csrf).attach('file', PDF, 'x.docx');
    assert.equal(bad.status, 422);
    const r = await sales.agent.post('/admin/templates').field('_csrf', sales.csrf).field('name', 'Agreement').attach('file', makeDocx([['Agreement with {company_name} — {contract_period}']]), 'agreement.docx');
    const tid = Number(r.headers.location.match(/(\d+)$/)[1]);
    const page = await sales.get(`/admin/templates/${tid}?contact=${contactId}`);
    assert.match(page.text, /value="Ufuq Trading"/, 'company filled from the CRM');
    const g = await sales.form(`/admin/templates/${tid}/generate`, { contact_id: String(contactId), field_name: ['company_name', 'contract_period'], field_value: ['Ufuq Trading', '12 months'] });
    assert.match(g.headers.location, /\/admin\/files\/\d+\?contact=\d+#send/);
    const f = await h.knex('sales_files').orderBy('id', 'desc').first();
    assert.equal(f.contact_id, contactId); assert.equal(f.template_id, tid);
    const file = await h.request.agent(h.getApp()).get(`/file/${f.token}`).buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
    assert.match(new AdmZip(file.body).readAsText('word/document.xml'), /Agreement with Ufuq Trading — 12 months/);
  });

  test('an online template: written, filled, shown to the customer, editable, and unsafe input removed', async () => {
    const r = await sales.form('/admin/templates/html', { name: 'Proposal', body_html: '<h2>Dear {company_name}</h2><p>Period: {مدة_العقد}</p><script>steal()</script>' });
    const tid = Number(r.headers.location.match(/(\d+)$/)[1]);
    const t = await h.knex('document_templates').where({ id: tid }).first();
    assert.doesNotMatch(t.body_html, /script/); assert.deepEqual(JSON.parse(t.fields), ['company_name', 'مدة_العقد']);
    await sales.form(`/admin/templates/${tid}/generate`, { contact_id: String(contactId), field_name: ['company_name', 'مدة_العقد'], field_value: ['Ufuq <b>Trading</b>', 'سنة'] });
    const f = await h.knex('sales_files').orderBy('id', 'desc').first();
    const v = await h.request.agent(h.getApp()).get(`/file/${f.token}`);
    assert.equal(v.status, 200); assert.match(v.text, /Dear Ufuq &lt;b&gt;Trading&lt;\/b&gt;/, 'values are text, never HTML'); assert.match(v.text, /Period: سنة/);
    await sales.form(`/admin/files/${f.id}/body`, { body_html: '<p>Changed for Khalid</p>' });
    assert.match((await h.request.agent(h.getApp()).get(`/file/${f.token}`)).text, /Changed for Khalid/);
    assert.equal((await support.get('/admin/templates')).status, 403);
  });
});
