// Sales documents and message texts: editable email/WhatsApp texts, quotations (totals, customer link,
// accept/decline, CRM timeline), files to send, invoice links, sending by email and WhatsApp, permissions.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers');
const mailer = require('../src/core/mailer');
const messages = require('../src/core/messages');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
let root; let sales; let support; let contactId;

async function teamMember(role) {
  const email = `${role}${Date.now()}${Math.random().toString(36).slice(2, 6)}@rw.test`;
  await h.knex('users').insert({ name: `${role} person`, email, password_hash: await bcrypt.hash('Password#123', 4), is_super_admin: true, platform_role: role, email_verified_at: new Date() });
  return h.login(email, 'Password#123');
}
const quoteBody = (extra = {}) => ({
  customer_name: 'Ahmed Alotaibi', customer_company: 'Horizon Trading', customer_email: 'ahmed@horizon.test', customer_phone: '0501234567', locale: 'en',
  item_description: ['Business plan (annual, 50 people)', 'Setup and training'], item_quantity: ['1', '2'], item_price: ['10000', '750'], discount: '500', tax_rate: '15', ...extra,
});
const idFrom = (res) => Number((res.headers.location || '').match(/\/admin\/quotes\/(\d+)/)[1]);

before(async () => {
  await h.resetDatabase();
  root = await teamMember('owner');
  sales = await teamMember('sales');
  support = await teamMember('support');
  const stage = await h.knex('crm_stages').orderBy('sort_order').first('id');
  [contactId] = await h.knex('crm_contacts').insert({ name: 'Ahmed Alotaibi', email: 'ahmed@horizon.test', phone: '966501234567', company_name: 'Horizon Trading', source: 'manual', kind: 'lead', stage_id: stage.id });
});
after(async () => { await h.knex.destroy(); });

describe('Message texts', () => {
  test('defaults keep the current wording; an edited text is used by the real email', async () => {
    const d = await messages.compose('verify_email', 'en', { name: 'Sara', hours: 48, app: 'RemoteWay' });
    assert.equal(d.subject, 'RemoteWay — Confirm your email');
    assert.match(d.body, /Hello Sara/);
    const r = await root.form('/admin/messages/invitation', { en_subject: 'Join {org} — your team is waiting', ar_body: 'أهلًا، انضم إلى {org} بدور {role}.' });
    assert.equal(r.status, 302);
    mailer.testOutbox.length = 0;
    await mailer.sendInvitation({ email: 'new@x.test', link: 'http://localhost:3000/invite/abc', organizationName: 'Acme', roleName: 'HR', locale: 'en' });
    assert.equal(mailer.testOutbox.pop().subject, 'Join Acme — your team is waiting');
    await mailer.sendInvitation({ email: 'new@x.test', link: 'http://localhost:3000/invite/abc', organizationName: 'Acme', roleName: 'HR', locale: 'ar' });
    assert.match(mailer.testOutbox.pop().html, /انضم إلى Acme بدور HR/);
  });

  test('unknown placeholders and over-long subjects are refused; reset brings the default back', async () => {
    const bad = await root.form('/admin/messages/quote_whatsapp', { en_text: 'Hi {nmae}, {link}' });
    assert.equal(bad.status, 422);
    assert.match(bad.text, /does not exist for this message|غير متاح/);
    assert.equal((await root.form('/admin/messages/invitation/reset', {})).status, 302);
    assert.equal((await messages.compose('invitation', 'en', { org: 'Acme', app: 'RemoteWay' })).subject, "You're invited to Acme on RemoteWay");
  });

  test('sales can read the texts but only owners/admins change them; support cannot open them', async () => {
    assert.equal((await sales.get('/admin/messages')).status, 200);
    assert.equal((await sales.form('/admin/messages/invitation', { en_subject: 'x {org}' })).status, 403);
    assert.equal((await support.get('/admin/messages')).status, 403);
  });
});

describe('Quotations', () => {
  let qid; let token;
  test('seller details are validated and saved', async () => {
    assert.equal((await root.form('/admin/quotes/settings', { vat_number: '123', iban: 'nope', valid_days: '30', tax_rate: '15' })).status, 422);
    const r = await root.form('/admin/quotes/settings', { legal_name_en: 'RemoteWay IT Co.', legal_name_ar: 'شركة ريموت واي', vat_number: '310123456700003', iban: 'SA03 8000 0000 6080 1016 7519', bank_name: 'Al Rajhi', valid_days: '14', tax_rate: '15', currency: 'SAR', terms_en: 'Prices in SAR.' });
    assert.equal(r.status, 302);
    assert.equal((await sales.get('/admin/quotes/settings')).status, 403, 'only owners/admins change company details');
  });

  test('creating a quotation: validation, totals with discount and VAT, yearly number', async () => {
    const bad = await sales.form('/admin/quotes', quoteBody({ customer_name: '', item_description: ['x'], item_quantity: ['0'], item_price: ['5'] }));
    assert.equal(bad.status, 422);
    const r = await sales.form('/admin/quotes', quoteBody({ contact_id: String(contactId) }));
    assert.equal(r.status, 302);
    qid = idFrom(r);
    const q = await h.knex('quotes').where({ id: qid }).first();
    assert.equal(Number(q.subtotal), 11500);
    assert.equal(Number(q.discount), 500);
    assert.equal(Number(q.tax), 1650);
    assert.equal(Number(q.total), 12650);
    assert.match(q.number, new RegExp(`^Q-${new Date().getUTCFullYear()}-\\d{4}$`));
    assert.equal(q.status, 'draft');
    token = q.token;
    const d = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
    const expected = new Date(`${d(q.issue_date)}T00:00:00Z`); expected.setUTCDate(expected.getUTCDate() + 14);
    assert.equal(d(q.valid_until), expected.toISOString().slice(0, 10), 'valid for the 14 days set in the company details');
    const page = await sales.get(`/admin/quotes/${qid}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /12,650/);
    assert.match(page.text, /310123456700003/, 'seller VAT number on the document');
  });

  test('WhatsApp: opens wa.me with the number and the ready text, logs it and marks the quotation sent', async () => {
    const r = await sales.form(`/admin/quotes/${qid}/whatsapp`, { phone: '0501234567', text: 'Hello Ahmed, here is your quotation: LINK', locale: 'en', contact_id: String(contactId) });
    assert.equal(r.status, 200);
    assert.match(r.headers.refresh, /^0; url=https:\/\/wa\.me\/966501234567\?text=Hello%20Ahmed/);
    assert.equal((await h.knex('quotes').where({ id: qid }).first()).status, 'sent');
    const log = await h.knex('document_sends').where({ doc_type: 'quote', doc_id: qid }).first();
    assert.equal(log.channel, 'whatsapp'); assert.equal(log.recipient, '+966501234567'); assert.equal(log.status, 'opened');
    assert.ok(await h.knex('crm_activities').where({ contact_id: contactId, type: 'whatsapp', direction: 'out' }).first(), 'on the CRM timeline');
    const bad = await sales.form(`/admin/quotes/${qid}/whatsapp`, { phone: '12', text: 'x' });
    assert.equal(bad.status, 302, 'a wrong number goes back with a message');
  });

  test('the ready texts carry the customer link; email sends it with a button', async () => {
    const page = await sales.get(`/admin/quotes/${qid}?send_lang=en`);
    assert.ok(page.text.includes(`/quote/${token}`));
    assert.match(page.text, /Hello Ahmed Alotaibi/);
    mailer.testOutbox.length = 0;
    const r = await sales.form(`/admin/quotes/${qid}/send-email`, { to: 'ahmed@horizon.test', subject: 'Your quotation', body: 'Hello Ahmed,\nPlease see the quotation.', locale: 'en' });
    assert.equal(r.status, 302);
    const m = mailer.testOutbox.pop();
    assert.equal(m.to, 'ahmed@horizon.test');
    assert.ok(m.html.includes(`/quote/${token}`));
    assert.match(m.html, /Hello Ahmed,<br>Please see/);
    assert.equal((await sales.form(`/admin/quotes/${qid}/send-email`, { to: 'bad', subject: '', body: '' })).status, 302);
    assert.equal(await h.knex('document_sends').where({ doc_type: 'quote', doc_id: qid, channel: 'email' }).count({ n: '*' }).then(([x]) => Number(x.n)), 1);
  });

  test('the customer link: views are counted (not the team), then the customer accepts', async () => {
    await root.get(`/quote/${token}`);
    assert.equal((await h.knex('quotes').where({ id: qid }).first()).view_count, 0, 'the team opening it is not a customer view');
    const anon = h.request.agent(h.getApp());
    const v = await anon.get(`/quote/${token}`);
    assert.equal(v.status, 200);
    assert.equal(v.headers['x-robots-tag'], 'noindex, nofollow');
    assert.match(v.text, /Horizon Trading/);
    const q = await h.knex('quotes').where({ id: qid }).first();
    assert.equal(q.view_count, 1); assert.ok(q.first_viewed_at);
    assert.ok(await h.knex('crm_activities').where({ contact_id: contactId, type: 'quote_viewed' }).first());
    const csrf = v.text.match(/name="_csrf" value="([^"]+)"/)[1];
    assert.equal((await anon.post(`/quote/${token}/respond`).type('form').send({ _csrf: csrf, action: 'accept', name: '' })).status, 422, 'a name is needed to accept');
    mailer.testOutbox.length = 0;
    const ok = await anon.post(`/quote/${token}/respond`).type('form').send({ _csrf: csrf, action: 'accept', name: 'Ahmed Alotaibi', note: 'Start next month' });
    assert.equal(ok.status, 302);
    const done = await h.knex('quotes').where({ id: qid }).first();
    assert.equal(done.status, 'accepted'); assert.equal(done.response_name, 'Ahmed Alotaibi');
    assert.ok(await h.knex('crm_activities').where({ contact_id: contactId, type: 'quote_accepted' }).first());
    assert.ok(mailer.testOutbox.some((m) => /accepted/.test(m.subject)), 'the quotation maker is told');
    assert.equal((await anon.post(`/quote/${token}/respond`).type('form').send({ _csrf: csrf, action: 'decline' })).status, 409, 'answered once');
    assert.equal((await sales.form(`/admin/quotes/${qid}`, quoteBody())).status, 409, 'an answered quotation is not edited');
  });

  test('duplicate, delete only drafts, expired links refuse answers, unknown links are 404', async () => {
    const d = await sales.form(`/admin/quotes/${qid}/duplicate`, {});
    const copyId = Number(d.headers.location.match(/\/admin\/quotes\/(\d+)/)[1]);
    const copy = await h.knex('quotes').where({ id: copyId }).first();
    assert.equal(copy.status, 'draft'); assert.equal(Number(copy.total), 12650); assert.notEqual(copy.token, token);
    await sales.form(`/admin/quotes/${qid}/delete`, {});
    assert.ok(await h.knex('quotes').where({ id: qid }).first(), 'an accepted quotation stays');
    await h.knex('quotes').where({ id: copyId }).update({ valid_until: '2020-01-01', issue_date: '2019-12-01' });
    const anon = h.request.agent(h.getApp());
    const v = await anon.get(`/quote/${copy.token}`);
    assert.match(v.text, /expired/i);
    assert.doesNotMatch(v.text, /\/respond"/, 'no accept form on an expired quotation');
    const csrf = v.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    assert.equal((await anon.post(`/quote/${copy.token}/respond`).type('form').send({ _csrf: csrf, action: 'accept', name: 'X' })).status, 409);
    await sales.form(`/admin/quotes/${copyId}/delete`, {});
    assert.equal(await h.knex('quotes').where({ id: copyId }).first(), undefined);
    assert.equal((await anon.get('/quote/not-a-real-token-at-all-xxxxx')).status, 404);
  });

  test('the CRM contact shows the quotations and a WhatsApp button', async () => {
    const page = await sales.get(`/admin/crm/contacts/${contactId}`);
    assert.match(page.text, /href="\/admin\/quotes\/new\?contact=\d+"/);
    assert.match(page.text, /href="https:\/\/wa\.me\/966501234567"/);
    assert.equal((await support.get('/admin/quotes')).status, 403);
  });
});

describe('Files to send and invoices', () => {
  let fid; let ftoken;
  test('upload checks the content; the link serves the file and counts opens', async () => {
    const fake = await root.agent.post('/admin/files').field('_csrf', root.csrf).field('title', 'x').attach('file', Buffer.from('not a pdf'), 'profile.pdf');
    assert.equal(fake.status, 422);
    const r = await root.agent.post('/admin/files').field('_csrf', root.csrf).field('title', 'Company profile').attach('file', PDF, 'profile.pdf');
    assert.equal(r.status, 302);
    fid = Number(r.headers.location.match(/\/admin\/files\/(\d+)/)[1]);
    ftoken = (await h.knex('sales_files').where({ id: fid }).first()).token;
    const anon = h.request.agent(h.getApp());
    const f = await anon.get(`/file/${ftoken}`).buffer(true);
    assert.equal(f.status, 200); assert.equal(f.headers['content-type'], 'application/pdf');
    assert.equal((await h.knex('sales_files').where({ id: fid }).first()).open_count, 1);
  });

  test('a file goes to a CRM contact by email with the file attached', async () => {
    mailer.testOutbox.length = 0;
    const r = await sales.form(`/admin/files/${fid}/send-email`, { to: 'ahmed@horizon.test', subject: 'Our company profile', body: 'Hello', attach: '1', contact_id: String(contactId), locale: 'en' });
    assert.equal(r.status, 302);
    const m = mailer.testOutbox.pop();
    assert.equal(m.attachments[0].filename, 'Company profile.pdf');
    assert.ok(m.html.includes(`/file/${ftoken}`));
    assert.ok(await h.knex('document_sends').where({ doc_type: 'file', doc_id: fid, contact_id: contactId }).first());
    await root.form(`/admin/files/${fid}`, { title: 'Company profile', active: '0' });
    assert.equal((await h.request.agent(h.getApp()).get(`/file/${ftoken}`)).status, 404, 'a switched-off link stops working');
  });

  test('invoices get a customer link and can be sent; voided ones cannot', async () => {
    const co = await h.createCompany({ plan: 'business', name: 'Billed Co' });
    const [iid] = await h.knex('invoices').insert({ organization_id: co.organizationId, number: `RW-T-${Date.now()}`, issue_date: '2026-09-01', due_date: '2026-09-08', currency: 'SAR', subtotal: 1000, tax_rate: 15, tax: 150, total: 1150, status: 'issued' });
    await h.knex('invoice_items').insert({ invoice_id: iid, description: 'Business plan', quantity: 1, unit_price: 1000, amount: 1000 });
    const page = await root.get(`/admin/invoices/${iid}/send`);
    assert.equal(page.status, 200);
    const link = page.text.match(/data-copy-source dir="ltr">([^<]+)</)[1];
    assert.match(link, /\/invoice\/[A-Za-z0-9_-]+$/);
    const v = await h.request.agent(h.getApp()).get(new URL(link).pathname);
    assert.equal(v.status, 200); assert.match(v.text, /Billed Co/); assert.match(v.text, /SA03 8000/);
    assert.equal((await h.knex('invoices').where({ id: iid }).first()).view_count, 1);
    mailer.testOutbox.length = 0;
    await root.form(`/admin/invoices/${iid}/send-email`, { to: co.email, subject: 'Invoice', body: 'Please find the invoice.', locale: 'en' });
    assert.ok(mailer.testOutbox.pop().html.includes(new URL(link).pathname));
    await h.knex('invoices').where({ id: iid }).update({ status: 'void' });
    assert.equal((await h.request.agent(h.getApp()).get(new URL(link).pathname)).status, 404);
    assert.notEqual((await root.get(`/admin/invoices/${iid}/send`)).status, 200);
  });
});
