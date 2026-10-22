// Credits end to end (needs TEST_DATABASE_URL): node server/credits-test.js
// Covers what the database-free credits-logic-test.js cannot: the real routes, the raw-body Stripe webhook through
// Express, rewards over a socket, privacy of balances, and persistence.
const assert = require('assert');
const crypto = require('crypto');
const { cleanup } = require('./test-env');
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
const { httpServer, ready } = require('./index');
const { io: connect } = require('socket.io-client');
const store = require('./db');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const blob = { salt: 'a', iv: 'b', data: 'c' };
const reg = (username) => call('/register', { method: 'POST', body: { username, email: username + '@example.com', password: 'password123', publicKey: 'pk' + username, encPrivKey: blob } });
const ack = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
const once = (s, ev) => new Promise((res) => s.once(ev, res));
const step = (m) => console.log('✓', m);
const sign = (body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex')}`;
async function hook(evt, header) {
  const body = JSON.stringify(evt);
  const r = await fetch(base + '/api/credits/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header ?? sign(body) }, body });
  return r.status;
}

ready.then(() => httpServer.listen(0, async () => {
  base = 'http://127.0.0.1:' + httpServer.address().port;
  let sa, sb;
  try {
    assert.strictEqual((await call('/credits')).status, 401, 'login required');
    const a = await reg('alice_c'), b = await reg('bob_c'), c = await reg('carol_c');
    for (const u of [a, b, c]) store.db.users[u.user.id].createdAt -= 3 * 3600_000; // old enough to earn
    let r = await call('/credits', { token: a.token });
    assert.deepStrictEqual([r.status, r.balance, r.purchases], [200, 0, true]);
    assert.ok(r.packs.length >= 3 && r.quests.length >= 5);
    step('new account starts at 0; packs and quests listed; purchases on when both Stripe keys are set');

    // a server with three members, bob speaks first, then alice types a real message
    const srv = (await call('/servers', { method: 'POST', token: a.token, body: { name: 'Credits' } })).server;
    for (const u of [b, c]) await call('/servers/join', { method: 'POST', token: u.token, body: { code: srv.inviteCode } });
    const ch = srv.channels[0].id;
    sa = require('socket.io-client').io(base, { auth: { token: a.token } });
    sb = require('socket.io-client').io(base, { auth: { token: b.token } });
    await Promise.all([once(sa, 'connect'), once(sb, 'connect')]);
    const text = 'Hello everyone, how is the weekend going for you all';
    const proof = { t: text.length, p: 0, ms: text.length * 150, ev: text.length, j: 50 };
    assert.ok((await ack(sb, 'message:send', { channelId: ch, content: 'Morning all, anyone up for a long walk later today?' })).ok);
    const upd = once(sa, 'credits:update');
    assert.ok((await ack(sa, 'message:send', { channelId: ch, content: text, typing: proof })).ok);
    assert.deepStrictEqual(await upd, { balance: 2, delta: 2, reason: 'message' });
    assert.strictEqual((await call('/credits', { token: a.token })).balance, 2);
    step('a typed, real message in a server pays 2 credits and the balance is pushed to the sender');

    // pasted / no proof / repeat pay nothing
    const sent = (content, typing) => ack(sa, 'message:send', { channelId: ch, content, typing });
    assert.ok((await sent('Another perfectly fine sentence that was pasted here', { ...proof, p: 40 })).ok, 'the message itself still sends');
    assert.ok((await sent('Yet another sentence with no typing information at all')).ok);
    assert.strictEqual((await call('/credits', { token: a.token })).balance, 2, 'but pasted / unproven messages earn nothing');
    step('messages without proof or with pasted text still send but earn nothing');

    // balances are private
    assert.ok(!JSON.stringify((await call('/users/' + a.user.id, { token: b.token }))).includes('credits'), 'other people cannot see balances');
    assert.ok(!JSON.stringify((await call('/servers', { token: b.token }))).includes('"balance"'));
    step('balances do not leak through profiles or server member lists');

    // quests
    assert.strictEqual((await call('/credits/quests/checkin/claim', { method: 'POST', token: a.token })).amount, 10);
    assert.strictEqual((await call('/credits/quests/checkin/claim', { method: 'POST', token: a.token })).status, 409);
    assert.strictEqual((await call('/credits/quests/avatar/claim', { method: 'POST', token: a.token })).status, 400, 'unfinished');
    assert.strictEqual((await call('/credits/quests/server/claim', { method: 'POST', token: a.token })).amount, 25, 'alice created a server');
    step('quests claim once, only when really finished');

    // Stripe webhook through the real Express stack
    const evt = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid', amount_total: 999, currency: 'usd', payment_intent: 'pi_test_1', metadata: { userId: a.user.id, packId: 'p1200' } } } };
    const before = (await call('/credits', { token: a.token })).balance;
    assert.strictEqual(await hook(evt, 't=1,v1=' + '0'.repeat(64)), 400, 'bad signature');
    assert.strictEqual((await call('/credits', { token: a.token })).balance, before, 'forged webhook changes nothing');
    const pushed = once(sa, 'credits:update');
    assert.strictEqual(await hook(evt), 200);
    assert.strictEqual((await call('/credits', { token: a.token })).balance, before + 1200);
    assert.deepStrictEqual(await pushed, { balance: before + 1200, delta: 1200, reason: 'purchase' });
    assert.strictEqual(await hook(evt), 200);
    assert.strictEqual((await call('/credits', { token: a.token })).balance, before + 1200, 'replay pays nothing');
    step('signed webhook credits a purchase once; forged and replayed ones do nothing');

    // checkout needs a real pack
    assert.strictEqual((await call('/credits/checkout', { method: 'POST', token: a.token, body: { packId: 'nope' } })).status, 400);

    // persisted (and encrypted) in Postgres
    await store.flush();
    assert.strictEqual((await store.query('SELECT id FROM payments')).rows.length, 1);
    await store.reload();
    assert.strictEqual(store.db.users[a.user.id].credits.balance, before + 1200, 'balance survives a reload');
    assert.ok(store.db.payments.cs_test_1);
    step('purchase record and balance are stored and survive a reload');

    // refund takes it back
    const refund = { id: 'evt_2', type: 'charge.refunded', data: { object: { refunded: true, payment_intent: 'pi_test_1' } } };
    assert.strictEqual(await hook(refund), 200);
    assert.strictEqual((await call('/credits', { token: a.token })).balance, before);
    step('a full refund takes the credits back');

    console.log('\nAll credits checks passed.');
    sa.close(); sb.close();
    await cleanup();
    process.exit(0);
  } catch (e) { console.error('\n✗ FAILED:', e); try { sa?.close(); sb?.close(); await cleanup(); } catch {} process.exit(1); }
}));
