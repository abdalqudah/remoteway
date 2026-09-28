// A local stand-in for the Moyasar, Tap, HyperPay and PayTabs APIs used by the tests. It keeps each
// created payment in memory; tests change a payment's state with setState() to play the customer.
const http = require('http');
const crypto = require('crypto');

const GOOD = {
  moyasar: `Basic ${Buffer.from('sk_test_good123:').toString('base64')}`,
  tap: 'Bearer sk_test_good123',
  hyperpay: 'Bearer hp_access_token_good_0123456789',
  paytabs: 'PT_SERVER_KEY_GOOD_0123456789',
};

function createStub() {
  const payments = new Map(); // id → { gateway, status, amount, currency, body }
  const requests = [];
  let seq = 0;
  const id = (prefix) => `${prefix}${Date.now().toString(36)}${(seq += 1)}${crypto.randomBytes(3).toString('hex')}`;
  const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://stub');
      const path = url.pathname;
      let body = {};
      try { body = req.headers['content-type'] === 'application/x-www-form-urlencoded' ? Object.fromEntries(new URLSearchParams(raw)) : (raw ? JSON.parse(raw) : {}); } catch { body = {}; }
      const auth = req.headers.authorization || '';
      requests.push({ method: req.method, path, body, auth });

      // ---- Moyasar ----
      if (path.startsWith('/v1/invoices')) {
        if (auth !== GOOD.moyasar) return send(res, 401, { type: 'authentication_error', message: 'Invalid authorization credentials' });
        if (req.method === 'GET' && path === '/v1/invoices') return send(res, 200, { invoices: [], meta: {} });
        if (req.method === 'POST') {
          const pid = id('inv_');
          payments.set(pid, { gateway: 'moyasar', status: 'initiated', amount: body.amount, currency: body.currency, body });
          return send(res, 201, { id: pid, status: 'initiated', amount: body.amount, currency: body.currency, url: `https://checkout.moyasar.test/invoices/${pid}` });
        }
        const p = payments.get(decodeURIComponent(path.split('/')[3]));
        if (!p) return send(res, 404, { type: 'invalid_request_error', message: 'Object not found' });
        const pays = p.status === 'paid' ? [{ id: `pay_${p.ref || 'x1'}`, status: 'paid' }] : p.status === 'failed' ? [{ id: 'pay_f', status: 'failed', source: { message: 'INSUFFICIENT_FUNDS' } }] : [];
        return send(res, 200, { id: path.split('/')[3], status: p.status, amount: p.amount, currency: p.currency, payments: pays });
      }
      // ---- Tap ----
      if (path.startsWith('/v2/charges')) {
        if (auth !== GOOD.tap) return send(res, 401, { errors: [{ code: '2107', description: 'Invalid API key' }] });
        if (req.method === 'POST') {
          const pid = id('chg_TS');
          payments.set(pid, { gateway: 'tap', status: 'INITIATED', amount: body.amount, currency: body.currency, body });
          return send(res, 200, { id: pid, status: 'INITIATED', amount: body.amount, currency: body.currency, transaction: { url: `https://checkout.tap.test/${pid}` } });
        }
        const pid = decodeURIComponent(path.split('/')[3]);
        const p = payments.get(pid);
        if (!p) return send(res, 404, { errors: [{ code: '1144', description: 'Charge not found' }] });
        return send(res, 200, { id: pid, status: p.status, amount: p.amount, currency: p.currency, response: { code: p.status === 'CAPTURED' ? '000' : '507', message: p.status === 'CAPTURED' ? 'Captured' : 'Declined' } });
      }
      // ---- HyperPay ----
      if (path.startsWith('/v1/checkouts')) {
        if (auth !== GOOD.hyperpay) return send(res, 401, { result: { code: '800.900.300', description: 'invalid authentication information' } });
        if (req.method === 'POST') {
          const pid = id('HP').toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(32, '0').slice(0, 32);
          payments.set(pid, { gateway: 'hyperpay', status: '000.200.000', amount: body.amount, currency: body.currency, body, reads: 0 });
          return send(res, 200, { result: { code: '000.200.100', description: 'successfully created checkout' }, id: pid });
        }
        const pid = decodeURIComponent(path.split('/')[3]);
        const p = payments.get(pid);
        if (!p) return send(res, 200, { result: { code: '200.300.404', description: 'invalid or missing parameter' } });
        p.reads += 1;
        if (url.searchParams.get('entityId') !== p.body.entityId) return send(res, 200, { result: { code: '200.300.404', description: 'wrong entity' } });
        return send(res, 200, { id: `8ac7${pid.slice(0, 8)}`, amount: p.amount, currency: p.currency, result: { code: p.status, description: p.status.startsWith('000.000') ? 'Transaction succeeded' : 'transaction pending or declined' } });
      }
      // ---- PayTabs ----
      if (path === '/payment/request' || path === '/payment/query') {
        if (auth !== GOOD.paytabs) return send(res, 401, { code: 1, message: 'Authentication failed. Check authentication header.' });
        if (path === '/payment/request') {
          const pid = id('TST').toUpperCase();
          payments.set(pid, { gateway: 'paytabs', status: 'P', amount: String(body.cart_amount), currency: body.cart_currency, body });
          return send(res, 200, { tran_ref: pid, cart_id: body.cart_id, redirect_url: `https://secure.paytabs.test/payment/page/${pid}` });
        }
        const p = payments.get(body.tran_ref);
        if (!p) return send(res, 400, { code: 2, message: 'Transaction not found' });
        return send(res, 200, { tran_ref: body.tran_ref, cart_amount: p.amount, cart_currency: p.currency, payment_result: { response_status: p.status, response_message: p.status === 'A' ? 'Authorised' : 'Declined' } });
      }
      return send(res, 404, { message: 'stub: unknown path' });
    });
  });

  return {
    GOOD, payments, requests,
    last: (gateway) => [...payments.entries()].filter(([, p]) => p.gateway === gateway).pop(),
    setState(pid, patch) { Object.assign(payments.get(pid), patch); },
    listen: (port = 0) => new Promise((resolve) => { server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); }),
    close: () => new Promise((resolve) => { server.close(() => resolve()); }),
  };
}

module.exports = { createStub };

if (require.main === module) {
  const stub = createStub();
  stub.listen(Number(process.env.PORT || 4030)).then((u) => console.log(`[payments-stub] ${u}`));
}
