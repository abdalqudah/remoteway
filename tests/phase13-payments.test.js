// Online payments: gateway settings (validation, encryption, connection test, test/live mode), paying an
// invoice with Moyasar, Tap, HyperPay and PayTabs against a local stub, trusting only the gateway's own
// status (return, webhook, reconciler), amount checks, idempotency, renewal invoices and permissions.
process.env.INTEGRATIONS_ALLOW_PRIVATE = 'true'; // talk to the local gateway stub in these tests only
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers');
const { createStub } = require('./payments-stub');
const payments = require('../src/modules/payments/payments.service');
const subscriptions = require('../src/modules/billing/subscription.service');

const stub = createStub();
let admin; let co; let owner; let sub;
const ENTITY_CARD = 'a'.repeat(32); const ENTITY_MADA = 'b'.repeat(32);
const tokenOf = (text) => (text.match(/\/payments\/(?:return|hyperpay)\/([a-f0-9]{48})/) || [])[1];
const pub = () => h.request(h.getApp());
let invSeq = 0;
async function mkInvoice(total = 115) {
  invSeq += 1;
  const [id] = await h.knex('invoices').insert({
    organization_id: co.organizationId, subscription_id: sub.id, number: `T-${Date.now()}-${invSeq}`, issue_date: new Date(), due_date: new Date(),
    period_start: new Date(), period_end: new Date(), currency: 'SAR', subtotal: total / 1.15, tax_rate: 15, tax: total - total / 1.15, total, status: 'issued',
  });
  return id;
}
const payment = (invoiceId) => h.knex('payments').where({ invoice_id: invoiceId }).orderBy('id', 'desc').first();
const invoice = (id) => h.knex('invoices').where({ id }).first();

before(async () => {
  await h.resetDatabase();
  process.env.PAYMENTS_BASE_URL = await stub.listen();
  const [adminId] = await h.knex('users').insert({ name: 'Root', email: `root${Date.now()}@test.local`, password_hash: await bcrypt.hash('Password#123', 4), is_super_admin: true });
  admin = await h.login((await h.knex('users').where({ id: adminId }).first()).email, 'Password#123');
  co = await h.createCompany({ plan: 'business' });
  owner = await h.login(co.email, co.password);
  sub = await h.knex('subscriptions').where({ organization_id: co.organizationId }).first();
});
after(async () => { delete process.env.PAYMENTS_BASE_URL; await stub.close(); await h.knex.destroy(); });

describe('Phase 13 — payments', () => {
  test('without a gateway the invoice shows bank-transfer instructions', async () => {
    const r = await owner.form('/app/billing/activate', {});
    assert.equal(r.status, 302);
    const page = await owner.get(r.headers.location);
    assert.match(page.text, /transfer the total/);
    assert.doesNotMatch(page.text, /\/pay"/);
  });

  test('gateway settings: validation, encrypted keys, connection test and mode', async () => {
    let r = await admin.form('/admin/payments/moyasar', { secret_key: 'pk_test_abc', enabled: 'on' });
    assert.equal(r.status, 422);
    r = await admin.form('/admin/payments/moyasar', { secret_key: 'sk_live_abc123', enabled: 'on' });
    assert.equal(r.status, 422, 'a live key is refused in test mode');
    r = await admin.form('/admin/payments/moyasar/test', { secret_key: 'sk_test_wrong1' });
    assert.equal(r.status, 502);
    assert.match(r.text, /rejected the key/);
    r = await admin.form('/admin/payments/moyasar/test', { secret_key: 'sk_test_good123' });
    assert.equal(r.status, 302);
    r = await admin.form('/admin/payments/moyasar', { secret_key: 'sk_test_good123', enabled: 'on' });
    assert.equal(r.status, 302);
    const raw = (await h.knex('platform_settings').where({ key: 'payments' }).first()).value;
    assert.ok(!JSON.stringify(raw).includes('sk_test_good123'), 'the key is stored encrypted');
    // Saving again with an empty key keeps it
    r = await admin.form('/admin/payments/moyasar', { secret_key: '', enabled: 'on' });
    assert.equal(r.status, 302);
    assert.equal((await payments.config()).providers.moyasar.secret_key, 'sk_test_good123');
    const page = await admin.get('/admin/payments');
    assert.equal(page.status, 200);
    assert.ok(!page.text.includes('sk_test_good123'));
    assert.match(page.text, /\/payments\/webhook\/moyasar/);
    // Switching to live turns off gateways holding test keys
    await admin.form('/admin/payments/mode', { mode: 'live' });
    assert.deepEqual(await payments.available(), []);
    await admin.form('/admin/payments/mode', { mode: 'test' });
    await admin.form('/admin/payments/moyasar', { secret_key: '', enabled: 'on' });
    assert.deepEqual((await payments.available()).map((g) => g.key), ['moyasar']);
    // Only super admins
    assert.equal((await owner.get('/admin/payments')).status, 403);
  });

  test('Moyasar: pay, return before paying, then paid → invoice paid and subscription active (once)', async () => {
    const inv = await h.knex('invoices').where({ organization_id: co.organizationId, status: 'issued' }).first();
    const page = await owner.get(`/app/billing/invoices/${inv.id}`);
    assert.match(page.text, new RegExp(`/app/billing/invoices/${inv.id}/pay`));
    const r = await owner.form(`/app/billing/invoices/${inv.id}/pay`, { gateway: 'moyasar' });
    assert.equal(r.status, 200);
    assert.match(r.headers.refresh, /^0; url=https:\/\/checkout\.moyasar\.test\/invoices\//);
    const [ref, gw] = stub.last('moyasar');
    assert.equal(gw.amount, Math.round(Number(inv.total) * 100), 'amount in halalas');
    assert.equal(gw.currency, 'SAR');
    const token = tokenOf(gw.body.success_url);
    assert.ok(token);
    assert.match(gw.body.callback_url, /\/payments\/webhook\/moyasar$/);

    let back = await pub().get(`/payments/return/${token}?id=${ref}&status=paid`); // the query claims "paid"…
    assert.equal(back.status, 303);
    assert.equal(back.headers.location, `/app/billing/invoices/${inv.id}?payment=initiated`, '…but the gateway says it is not');
    assert.equal((await invoice(inv.id)).status, 'issued');

    stub.setState(ref, { status: 'paid', ref: 'abc' });
    back = await pub().get(`/payments/return/${token}`);
    assert.equal(back.headers.location, `/app/billing/invoices/${inv.id}?payment=paid`);
    const paid = await invoice(inv.id);
    assert.equal(paid.status, 'paid');
    assert.equal(paid.payment_reference, 'moyasar:pay_abc');
    const s = await h.knex('subscriptions').where({ id: sub.id }).first();
    assert.equal(s.status, 'active');
    assert.ok(s.current_period_end > new Date());
    assert.ok(await h.knex('notifications').where({ user_id: co.userId, type: 'payment_received' }).first());
    await pub().get(`/payments/return/${token}`);
    const count = await h.knex('audit_logs').where({ action: 'invoice.paid', entity_id: String(inv.id) }).count({ c: '*' });
    assert.equal(Number(count[0].c), 1, 'returning twice does not pay twice');
    assert.match((await owner.get(`/app/billing/invoices/${inv.id}?payment=paid`)).text, /Payment received/);
  });

  test('Tap: webhooks only point at a payment; a wrong amount is refused', async () => {
    await admin.form('/admin/payments/tap', { secret_key: 'sk_test_good123', enabled: 'on' });
    const id1 = await mkInvoice(230);
    let r = await owner.form(`/app/billing/invoices/${id1}/pay`, { gateway: 'tap' });
    assert.match(r.headers.refresh, /checkout\.tap\.test/);
    let [ref, gw] = stub.last('tap');
    assert.equal(gw.amount, 230);
    assert.equal(gw.body.source.id, 'src_all');
    // A forged webhook saying CAPTURED changes nothing while Tap itself still says INITIATED
    r = await pub().post('/payments/webhook/tap').send({ id: ref, status: 'CAPTURED' });
    assert.equal(r.status, 200);
    assert.equal((await invoice(id1)).status, 'issued');
    stub.setState(ref, { status: 'CAPTURED' });
    await pub().post('/payments/webhook/tap').send({ id: ref });
    assert.equal((await invoice(id1)).status, 'paid');
    assert.equal((await payment(id1)).status, 'paid');
    // Unknown references are ignored
    assert.equal((await pub().post('/payments/webhook/tap').send({ id: 'chg_nope' })).status, 200);

    const id2 = await mkInvoice(99);
    await owner.form(`/app/billing/invoices/${id2}/pay`, { gateway: 'tap' });
    [ref] = stub.last('tap');
    stub.setState(ref, { status: 'CAPTURED', amount: 1 });
    await pub().post('/payments/webhook/tap').send({ id: ref });
    const p = await payment(id2);
    assert.equal(p.status, 'failed');
    assert.match(p.failure_reason, /amount_mismatch/);
    assert.equal((await invoice(id2)).status, 'issued');
    assert.ok(await h.knex('audit_logs').where({ action: 'payment.amount_mismatch' }).first());
  });

  test('HyperPay: mada uses its own entity, the widget page has its own policy', async () => {
    let r = await admin.form('/admin/payments/hyperpay', { access_token: 'hp_access_token_good_0123456789', entity_card: 'xyz', enabled: 'on' });
    assert.equal(r.status, 422);
    r = await admin.form('/admin/payments/hyperpay', { access_token: 'hp_access_token_good_0123456789', entity_card: ENTITY_CARD, entity_mada: ENTITY_MADA, enabled: 'on' });
    assert.equal(r.status, 302);
    const id = await mkInvoice(57.5);
    const page = await owner.get(`/app/billing/invoices/${id}`);
    assert.match(page.text, /value="hyperpay:mada"/);
    assert.match(page.text, /value="hyperpay:card"/);
    r = await owner.form(`/app/billing/invoices/${id}/pay`, { gateway: 'hyperpay:mada' });
    assert.equal(r.status, 303);
    const [ref, gw] = stub.last('hyperpay');
    assert.equal(gw.body.entityId, ENTITY_MADA);
    assert.equal(gw.body.amount, '57.50');
    assert.equal(gw.body.testMode, undefined, 'mada is tested without testMode');
    const widget = await owner.get(r.headers.location);
    assert.equal(widget.status, 200);
    assert.match(widget.text, /data-brands="MADA"/);
    assert.match(widget.text, new RegExp(`paymentWidgets\\.js\\?checkoutId=${ref}`));
    assert.match(widget.headers['content-security-policy'], new RegExp(`script-src 'self' 'unsafe-inline' ${process.env.PAYMENTS_BASE_URL.replace(/[.]/g, '\\.')}`));
    stub.setState(ref, { status: '000.000.000' });
    const back = await pub().get(`/payments/return/${tokenOf(r.headers.location)}?id=${ref}&resourcePath=/v1/checkouts/${ref}/payment`);
    assert.equal(back.headers.location, `/app/billing/invoices/${id}?payment=paid`);
    assert.equal((await invoice(id)).status, 'paid');
    assert.equal((await owner.get(r.headers.location)).status, 303, 'a finished payment page sends you back to the invoice');
    // Card payments in test mode carry testMode=EXTERNAL
    const id2 = await mkInvoice(10);
    await owner.form(`/app/billing/invoices/${id2}/pay`, { gateway: 'hyperpay:card' });
    const [, gw2] = stub.last('hyperpay');
    assert.equal(gw2.body.entityId, ENTITY_CARD);
    assert.equal(gw2.body.testMode, 'EXTERNAL');
    assert.equal((await owner.form(`/app/billing/invoices/${id2}/pay`, { gateway: 'hyperpay:applepay' })).status, 422);
  });

  test('PayTabs: declined then approved; the return is a cross-site POST without a session', async () => {
    await admin.form('/admin/payments/paytabs', { server_key: 'PT_SERVER_KEY_GOOD_0123456789', profile_id: '12345', region: 'sa', enabled: 'on' });
    const id = await mkInvoice(345);
    await owner.form(`/app/billing/invoices/${id}/pay`, { gateway: 'paytabs' });
    let [ref, gw] = stub.last('paytabs');
    assert.equal(gw.body.profile_id, 12345);
    assert.equal(gw.body.cart_amount, 345);
    const token = tokenOf(gw.body.return);
    stub.setState(ref, { status: 'D' });
    let back = await pub().post(`/payments/return/${token}`).type('form').send({ tranRef: ref, respStatus: 'A' });
    assert.equal(back.status, 303);
    assert.equal(back.headers.location, `/app/billing/invoices/${id}?payment=failed`);
    assert.equal((await payment(id)).failure_reason, 'Declined');
    assert.match((await owner.get(`/app/billing/invoices/${id}?payment=failed`)).text, /was not completed/);
    await owner.form(`/app/billing/invoices/${id}/pay`, { gateway: 'paytabs' });
    [ref, gw] = stub.last('paytabs');
    stub.setState(ref, { status: 'A' });
    back = await pub().post(`/payments/return/${tokenOf(gw.body.return)}`).type('form').send({});
    assert.equal(back.headers.location, `/app/billing/invoices/${id}?payment=paid`);
    assert.equal((await invoice(id)).status, 'paid');
    assert.equal((await pub().post(`/payments/return/${'f'.repeat(48)}`).send({})).status, 404);
  });

  test('reconciler: settles abandoned returns, expires HyperPay checkouts after one read, flags double payments', async () => {
    const id = await mkInvoice(20);
    await owner.form(`/app/billing/invoices/${id}/pay`, { gateway: 'moyasar' });
    await owner.form(`/app/billing/invoices/${id}/pay`, { gateway: 'moyasar' }); // a second tab
    const [p2, p1] = await h.knex('payments').where({ invoice_id: id }).orderBy('id', 'desc');
    stub.setState(p1.provider_ref, { status: 'paid' });
    stub.setState(p2.provider_ref, { status: 'paid' });
    await h.knex('payments').where({ invoice_id: id }).update({ created_at: new Date(Date.now() - 5 * 60_000) });
    const hid = await mkInvoice(30);
    await owner.form(`/app/billing/invoices/${hid}/pay`, { gateway: 'hyperpay:card' });
    await h.knex('payments').where({ invoice_id: hid }).update({ created_at: new Date(Date.now() - 40 * 60_000) });
    await payments.reconcile();
    assert.equal((await invoice(id)).status, 'paid');
    const both = await h.knex('payments').where({ invoice_id: id }).orderBy('id');
    assert.deepEqual(both.map((p) => p.status), ['paid', 'paid']);
    assert.equal(both[1].note, 'invoice_already_paid');
    assert.match((await admin.get('/admin/payments')).text, /refund this payment/);
    const hp = await payment(hid);
    assert.equal(hp.status, 'expired');
    assert.equal(stub.payments.get(hp.provider_ref).reads, 1);
  });

  test('renewals: invoice a week before the period ends, paying extends the period, unpaid goes past due', async () => {
    const [co2Id] = [co.organizationId];
    await h.knex('invoices').where({ organization_id: co2Id, status: 'issued' }).update({ status: 'void' });
    const end = new Date(Date.now() + 3 * 86_400_000);
    await h.knex('subscriptions').where({ id: sub.id }).update({ status: 'active', current_period_end: end, billing_cycle: 'monthly' });
    assert.deepEqual(await subscriptions.renewalSweep(), { issued: 1, overdue: 0 });
    assert.deepEqual(await subscriptions.renewalSweep(), { issued: 0, overdue: 0 }, 'only once');
    const inv = await h.knex('invoices').where({ organization_id: co2Id, status: 'issued' }).first();
    assert.equal(new Date(inv.due_date).toISOString().slice(0, 10), end.toISOString().slice(0, 10));
    assert.ok(await h.knex('notifications').where({ user_id: co.userId, type: 'renewal_invoice' }).first());
    await subscriptions.markInvoicePaid({ organizationId: co2Id, userId: null }, inv.id, 'x');
    const s = await h.knex('subscriptions').where({ id: sub.id }).first();
    assert.ok(new Date(s.current_period_start).getTime() >= end.getTime() - 1000, 'the new period starts when the old one ends');
    // Unpaid renewal after the period ended → past due with grace
    await h.knex('subscriptions').where({ id: sub.id }).update({ current_period_end: new Date(Date.now() - 86_400_000) });
    assert.deepEqual(await subscriptions.renewalSweep(), { issued: 1, overdue: 1 });
    const late = await h.knex('subscriptions').where({ id: sub.id }).first();
    assert.equal(late.status, 'past_due');
    assert.ok(late.grace_ends_at > new Date());
  });

  test('permissions, other companies and a switched-off gateway', async () => {
    const id = await mkInvoice(40);
    const emp = await h.addMember(co.organizationId, 'employee');
    const es = await h.login(emp.email, emp.password);
    assert.equal((await es.form(`/app/billing/invoices/${id}/pay`, { gateway: 'moyasar' })).status, 403);
    const other = await h.createCompany({ plan: 'business' });
    const os = await h.login(other.email, other.password);
    assert.equal((await os.form(`/app/billing/invoices/${id}/pay`, { gateway: 'moyasar' })).status, 404);
    await admin.form('/admin/payments/moyasar', { secret_key: '', enabled: '' });
    const r = await owner.form(`/app/billing/invoices/${id}/pay`, { gateway: 'moyasar' });
    assert.equal(r.status, 409);
    assert.match(r.text, /Online payment is not available yet/);
    const paidId = (await h.knex('invoices').where({ organization_id: co.organizationId, status: 'paid' }).first()).id;
    assert.equal((await owner.form(`/app/billing/invoices/${paidId}/pay`, { gateway: 'tap' })).status, 409);
  });
});
