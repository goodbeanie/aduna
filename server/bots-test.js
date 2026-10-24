// Developer accounts, bots, explorer Bots tab, reports: node server/bots-test.js (needs TEST_DATABASE_URL)
process.env.ADMIN_USERNAMES = 'botadmin';
process.env.LISTING_REPORTS_TO_HIDE = '2';
const assert = require('assert');
const { webcrypto: crypto } = require('crypto');
const { cleanup } = require('./test-env');
const { httpServer, ready } = require('./index');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const step = (m) => console.log('✓', m);
async function makeUser(name) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const r = await call('/register', { method: 'POST', body: { username: name, email: name + '@example.com', password: 'password123', publicKey: JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }), encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  assert.strictEqual(r.status, 200, 'register ' + JSON.stringify(r));
  return r;
}

const CODE = "bot.on('message', (m) => { if (m.text === '!ping') bot.reply(m, 'pong'); });";
(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://localhost:' + httpServer.address().port;
  const dev = await makeUser('botdev'), other = await makeUser('botother'), admin = await makeUser('botadmin');
  const T = (u) => u.token;
  const { store } = require('./index');

  // developer account first
  let r = await call('/bots', { method: 'POST', body: { name: 'Pinger', code: CODE }, token: T(dev) });
  assert.deepStrictEqual([r.status, r.code], [403, 'not_developer']);
  assert.strictEqual((await call('/developer', { token: T(dev) })).developer, false);
  r = await call('/developer/join', { method: 'POST', body: {}, token: T(dev) });
  assert.strictEqual(r.status, 400, 'terms must be accepted');
  r = await call('/developer/join', { method: 'POST', body: { accept: true }, token: T(dev) });
  assert.deepStrictEqual([r.status, r.developer, r.user.developer], [200, true, true]);
  step('bots need a developer account');

  // create / validate
  r = await call('/bots', { method: 'POST', body: { name: 'Pinger', code: 'bot.on(' }, token: T(dev) });
  assert.strictEqual(r.status, 400, 'syntax errors are refused');
  r = await call('/bots', { method: 'POST', body: { name: 'Pinger', description: 'Answers !ping', tags: ['fun'], code: CODE }, token: T(dev) });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  const id = r.bot.id;
  assert.deepStrictEqual([r.bot.visibility, r.bot.mine, r.bot.code], ['private', true, CODE]);
  step('create works; new bots are private');

  // private bots are invisible to everyone else, and the code is never shown to others
  assert.strictEqual((await call(`/bots/${id}`, { method: 'PATCH', body: { name: 'X' }, token: T(other) })).status, 403, 'a non-developer is refused first');
  assert.strictEqual((await call('/developer/join', { method: 'POST', body: { accept: true }, token: T(other) })).status, 200);
  assert.strictEqual((await call(`/bots/${id}`, { token: T(other) })).status, 404);
  assert.strictEqual((await call(`/bots/${id}`, { method: 'PATCH', body: { name: 'X' }, token: T(other) })).status, 404);
  assert.strictEqual((await call(`/bots/${id}`, { method: 'DELETE', token: T(other) })).status, 404);
  assert.ok(!((await call('/explore/bots', { token: T(other) })).bots || []).some((b) => b.id === id));
  step('private bots stay private');

  // going public: text checks, then listed without the code
  r = await call(`/bots/${id}`, { method: 'PATCH', body: { visibility: 'public', description: 'see https://example.com' }, token: T(dev) });
  assert.strictEqual(r.status, 400, 'links refused');
  r = await call(`/bots/${id}`, { method: 'PATCH', body: { visibility: 'public' }, token: T(dev) });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  let list = (await call('/explore/bots?q=fun', { token: T(other) })).bots;
  assert.ok(list.some((b) => b.id === id), 'listed');
  assert.ok(!JSON.stringify(list).includes('bot.reply'), 'code is not in the listing');
  assert.strictEqual((await call(`/bots/${id}`, { token: T(other) })).bot.code, undefined);
  step('public bots are listed and searchable; code stays hidden');

  // limit per developer
  for (let i = 0; i < 4; i++) await call('/bots', { method: 'POST', body: { name: 'B' + i, code: CODE }, token: T(dev) });
  r = await call('/bots', { method: 'POST', body: { name: 'Sixth', code: CODE }, token: T(dev) });
  assert.strictEqual(r.status, 400, 'five bots at most');
  step('per-developer limit');

  // reports
  r = await call(`/bots/${id}/report`, { method: 'POST', body: { reason: 'spam' }, token: T(dev) });
  assert.strictEqual(r.status, 400, 'own bot');
  r = await call(`/bots/${id}/report`, { method: 'POST', body: { reason: 'spam' }, token: T(other) });
  assert.strictEqual(r.status, 200);
  const old = Date.now() - 3 * 24 * 3600 * 1000;
  store.db.users[other.user.id].createdAt = old; store.db.users[admin.user.id].createdAt = old;
  await call(`/bots/${id}/report`, { method: 'POST', body: { reason: 'spam' }, token: T(admin) });
  assert.ok(!((await call('/explore/bots?q=fun', { token: T(other) })).bots || []).some((b) => b.id === id), 'hidden after enough reports');
  assert.strictEqual((await call(`/bots/${id}`, { token: T(other) })).status, 404, 'hidden bots cannot be opened by others');
  r = await call(`/bots/${id}`, { method: 'PATCH', body: { description: 'new text' }, token: T(dev) });
  assert.strictEqual(r.status, 400, 'owner cannot edit a listing under review');
  assert.strictEqual((await call(`/bots/${id}`, { token: T(dev) })).bot.review, 'hidden');
  assert.strictEqual((await call('/admin/bot-reports', { token: T(other) })).status, 404, 'admins only');
  const rep = await call('/admin/bot-reports', { token: T(admin) });
  assert.strictEqual(rep.bots.find((b) => b.botId === id).reports.length, 2);
  r = await call(`/admin/bots/${id}/listing`, { method: 'POST', body: { action: 'restore' }, token: T(admin) });
  assert.strictEqual(r.status, 200);
  assert.ok(((await call('/explore/bots?q=fun', { token: T(other) })).bots || []).some((b) => b.id === id), 'restored');
  r = await call(`/admin/bots/${id}/listing`, { method: 'POST', body: { action: 'remove' }, token: T(admin) });
  assert.strictEqual((await call(`/bots/${id}`, { token: T(dev) })).bot.visibility, 'private', 'removal makes it private');
  r = await call(`/bots/${id}`, { method: 'PATCH', body: { visibility: 'public' }, token: T(dev) });
  assert.strictEqual(r.status, 400, 'a removed bot cannot go public again');
  step('reports hide a bot; moderators restore or remove it');

  r = await call(`/bots/${id}`, { method: 'DELETE', token: T(dev) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await call(`/bots/${id}`, { token: T(dev) })).status, 404);
  step('developer can delete a bot');

  // test run through the sandbox (needs quickjs-emscripten; skipped with a note when it is not installed)
  const sb = require('./sandbox');
  if (sb.available()) {
    const nd = await makeUser('botnodev');
    r = await call('/developer/test', { method: 'POST', body: { code: CODE, text: '!ping' }, token: T(nd) });
    assert.strictEqual(r.status, 403, 'test runs need a developer account');
    r = await call('/developer/test', { method: 'POST', body: { code: CODE, text: '!ping' }, token: T(dev) });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.deepStrictEqual(r.result.actions.map((a) => a.text), ['pong'], JSON.stringify(r.result));
    r = await call('/developer/test', { method: 'POST', body: { code: CODE, text: 'nothing' }, token: T(dev) });
    assert.deepStrictEqual(r.result.actions, []);
    r = await call('/developer/test', { method: 'POST', body: { code: "bot.on('message', () => { for(;;){} });" }, token: T(dev) });
    assert.ok(r.result.timedOut && !r.result.ok, 'loops are stopped');
    r = await call('/developer/test', { method: 'POST', body: { code: 'bot.on(' }, token: T(dev) });
    assert.strictEqual(r.status, 400, 'syntax errors are caught before running');
    const mine = (await call('/bots', { method: 'POST', body: { name: 'Saved', code: CODE }, token: T(dev) }));
    if (mine.bot) {
      r = await call('/developer/test', { method: 'POST', body: { botId: mine.bot.id, text: '!ping' }, token: T(dev) });
      assert.deepStrictEqual(r.result.actions.map((a) => a.text), ['pong']);
      r = await call('/developer/test', { method: 'POST', body: { botId: mine.bot.id }, token: T(other) });
      assert.strictEqual(r.status, 404, "cannot run someone else's bot");
    }
    // the chat simulator: acts as made-up people and carries saved data and timers from one run into the next
    const SIM = "bot.on('message', (m) => { const n = bot.store.incr('seen'); if (m.text === '!timer') bot.timer.after('t', 30, { by: m.author.username }); bot.reply(m, m.author.displayName + ' #' + n + ' ' + m.mentionsBot + ' ' + m.author.id); bot.react(m, '\u{1F44D}'); });\n"
      + "bot.on('timer', (e) => bot.send(e.channels[0].id, 'timer ' + e.name + ' ' + JSON.stringify(e.data) + ' ' + bot.store.get('seen')));";
    r = await call('/developer/test', { method: 'POST', body: { code: SIM, text: 'hi', as: 'alex', messageId: 'm1' }, token: T(dev) });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.deepStrictEqual(r.result.actions.map((a) => a.text), ['Alex #1 false a1e0000000000001'], JSON.stringify(r.result));
    assert.strictEqual(r.result.actions[0].replyTo, 'm1', 'the answer points at the message that was sent');
    assert.deepStrictEqual(r.result.reactions, [{ messageId: 'm1', emoji: '\u{1F44D}' }]);
    assert.deepStrictEqual(r.result.dropped, [], JSON.stringify(r.result.dropped));
    let st = r.result.state;
    assert.deepStrictEqual(st.kv, { seen: '1' });
    r = await call('/developer/test', { method: 'POST', body: { code: SIM, text: '!timer', as: 'sam', messageId: 'm2', mentionBot: true, state: st }, token: T(dev) });
    assert.deepStrictEqual(r.result.actions.map((a) => a.text), ['Sam #2 true a5a0000000000002'], JSON.stringify(r.result));
    st = r.result.state;
    assert.deepStrictEqual([st.kv.seen, st.timers.length, st.timers[0].name, st.timers[0].data], ['2', 1, 't', '{"by":"sam"}']);
    r = await call('/developer/test', { method: 'POST', body: { code: SIM, event: 'timer', name: 't', kind: 'after', data: st.timers[0].data, state: { kv: st.kv, timers: [] } }, token: T(dev) });
    assert.deepStrictEqual(r.result.actions.map((a) => a.text), ['timer t {"by":"sam"} 2'], JSON.stringify(r.result));
    r = await call('/developer/test', { method: 'POST', body: { code: SIM, text: 'x', state: { kv: { seen: 'not json', __proto__: 'x' }, timers: [{ name: 'bad name', kind: 'after' }] } }, token: T(dev) });
    assert.ok(/ #1 false /.test(r.result.actions[0].text), 'state sent from the browser is rebuilt: a value that is not JSON is ignored, so the counter starts again: ' + r.result.actions[0].text);
    await sb.stop();
    step('test runs go through the sandbox, and the simulator keeps saved data and timers between runs');
  } else console.log('(skipped sandbox test run: quickjs-emscripten not installed)');

  console.log('\nAll bot checks passed.');
  await cleanup();
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
