// Switches end to end (needs TEST_DATABASE_URL, see test-env.js): node server/switches-flow-test.js
// The real routes: only a creator flips a switch, a closed Payments switch stops every way of STARTING a payment for the public (and nothing else),
// and creators are never closed out.
const assert = require('assert');
const { cleanup } = require('./test-env');
process.env.RESEND_API_KEY = 're_test_not_real'; // verification on; NODE_ENV=test keeps mail in mailer.outbox
process.env.CREATOR_EMAILS = 'switch.creator@gmail.com';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';      // purchases are "set up", so the views can say paused instead of not set up
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
const mailer = require('./mailer');
const { httpServer, ready } = require('./index');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const reg = async (name, email) => {
  const mark = mailer.outbox.length;
  const r = await call('/register', { method: 'POST', body: { username: name, email, password: 'password123', publicKey: 'k' + name, encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  const m = mailer.outbox.slice(mark).find((x) => x.to === email.trim().toLowerCase());
  const code = m && (/\b(\d{6})\b/.exec(m.subject) || [])[1];
  assert.ok(/^\d{6}$/.test(code), 'a code was sent to ' + email);
  assert.strictEqual((await call('/me/verify-email', { method: 'POST', token: r.token, body: { code } })).status, 200);
  return r;
};
const step = (m) => console.log('✓', m);
const flip = (acc, on) => call('/admin/switches/payments', { method: 'POST', token: acc.token, body: { on } });
const STARTS = [['POST', '/credits/checkout'], ['POST', '/credits/paypal/order'], ['POST', '/storage/subscribe'], ['POST', '/storage/vault/order'], ['GET', '/payments']];

(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://127.0.0.1:' + httpServer.address().port;
  const creator = await reg('switch_creator', 'switch.creator@gmail.com');
  const nina = await reg('switch_nina', 'nina.switch@example.com');

  // everything starts on
  let r = await call('/admin/switches', { token: creator.token });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.switches.map((s) => [s.id, s.on]), [['payments', true]]);
  r = await call('/credits/checkout', { method: 'POST', token: nina.token, body: { packId: 'bogus' } });
  assert.strictEqual(r.status, 400, 'open: the checkout route answers for itself (a bad pack)');
  assert.strictEqual((await call('/payments', { token: nina.token })).status, 200);
  r = await call('/credits', { token: nina.token });
  assert.deepStrictEqual([r.purchases, r.paused], [true, false]);
  step('everything starts on: payments open for a normal account');

  // only a creator can see or flip a switch
  assert.strictEqual((await call('/admin/switches', { token: nina.token })).status, 404, 'not an admin: a plain 404');
  assert.strictEqual((await flip(nina, false)).status, 404);
  assert.strictEqual((await call('/admin/switches')).status, 401);
  assert.strictEqual((await call('/admin/switches/nope', { method: 'POST', token: creator.token, body: { on: false } })).status, 404, 'unknown switch');
  assert.strictEqual((await call('/admin/switches/payments', { method: 'POST', token: creator.token, body: { on: 'off' } })).status, 400, 'on must be true or false');
  assert.strictEqual((await call('/credits/checkout', { method: 'POST', token: nina.token, body: { packId: 'bogus' } })).status, 400, 'and nothing changed');
  step('only a creator can read or flip a switch; bad ids and values are refused');

  // off: every way of starting a payment is closed for the public
  r = await flip(creator, false);
  assert.ok(r.status === 200 && r.switches[0].on === false && r.switches[0].by === 'switch_creator', JSON.stringify(r));
  for (const [method, path] of STARTS) {
    r = await call(path, { method, token: nina.token, body: method === 'POST' ? { packId: 'p500' } : undefined });
    assert.ok(r.status === 503 && r.code === 'feature_off' && r.feature === 'payments' && /paused/i.test(r.error), method + ' ' + path + ' -> ' + JSON.stringify(r));
  }
  r = await call('/credits', { token: nina.token });
  assert.deepStrictEqual([r.status, r.purchases, r.paused], [200, false, true], 'the credits view says paused, not "not set up"');
  assert.strictEqual((await call('/credits/checkout', { method: 'POST', body: { packId: 'p500' } })).status, 401, 'signed out: the route\'s own login check answers');
  step('payments off: checkout, PayPal order, Plus subscribe, card-on-file order and the Payments page are all closed for the public');

  // what stays open, and who is never closed out
  r = await call('/storage/cancel', { method: 'POST', token: nina.token });
  assert.notStrictEqual(r.code, 'feature_off', 'cancelling a plan is not closed');
  r = await call('/credits/paypal/capture', { method: 'POST', token: nina.token, body: { orderId: '../x' } });
  assert.notStrictEqual(r.code, 'feature_off', 'capturing an order that is already paid for is not closed');
  r = await call('/credits/checkout', { method: 'POST', token: creator.token, body: { packId: 'bogus' } });
  assert.strictEqual(r.status, 400, 'a creator is never closed out');
  assert.strictEqual((await call('/payments', { token: creator.token })).status, 200);
  r = await call('/credits', { token: creator.token });
  assert.deepStrictEqual([r.purchases, r.paused], [true, false]);
  step('cancelling and capturing paid orders stay open; the creator keeps full use of payments');

  // back on
  assert.strictEqual((await flip(creator, true)).switches[0].on, true);
  assert.strictEqual((await call('/credits/checkout', { method: 'POST', token: nina.token, body: { packId: 'bogus' } })).status, 400);
  assert.strictEqual((await call('/payments', { token: nina.token })).status, 200);
  r = await call('/credits', { token: nina.token });
  assert.deepStrictEqual([r.purchases, r.paused], [true, false]);
  step('turned back on, payments open for everyone at once');

  // every change is in the log
  const log = (await call('/admin/log', { token: creator.token })).log.map((l) => l.action);
  assert.ok(log.includes('switch off') && log.includes('switch on'), JSON.stringify(log));
  step('both changes are in the admin log');

  console.log('\nswitches-flow-test: all passed');
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; }).finally(async () => { httpServer.close(); await cleanup(); process.exit(process.exitCode || 0); });
