// Bots part 4: storage, timers, fetch, reactions, avatars and the extra events, through the real routes and sockets.
//   node server/bots-more-test.js (needs TEST_DATABASE_URL and `npm install`)
const assert = require('assert');
const { webcrypto: crypto } = require('crypto');
const { io: connect } = require('socket.io-client');
const { cleanup } = require('./test-env');
const { httpServer, ready, store, botHost, fetcher } = require('./index');
const sandbox = require('./sandbox');

let base;
async function call(p, { method = 'GET', body, token, raw, type } = {}) {
  const headers = { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(raw ? { 'Content-Type': type } : { 'Content-Type': 'application/json' }) };
  const r = await fetch(base + '/api' + p, { method, headers, body: raw ? raw : body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const step = (m) => console.log('✓', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ack = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
async function until(fn, what, ms = 6000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) assert.fail('timed out waiting for ' + what); await sleep(40); } }
async function makeUser(name) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const r = await call('/register', { method: 'POST', body: { username: name, email: name + '@example.com', password: 'password123', publicKey: JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }), encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  assert.strictEqual(r.status, 200, 'register ' + JSON.stringify(r));
  return r;
}
const T = (u) => u.token;
// a PNG header is all the server reads (it never decodes pixels); the bytes after it are padding
function png(w, h) { const b = Buffer.alloc(64); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; }

(async () => {
  await ready;
  await sandbox.ready();
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://localhost:' + httpServer.address().port;

  const owner = await makeUser('moreowner'), dev = await makeUser('moredev'), dev2 = await makeUser('moredev2'), mem = await makeUser('moremem');
  for (const u of [dev, dev2]) assert.strictEqual((await call('/developer/join', { method: 'POST', body: { accept: true }, token: T(u) })).status, 200);
  const mkBot = async (u, name, code) => { const r = await call('/bots', { method: 'POST', body: { name, code }, token: T(u) }); assert.strictEqual(r.status, 200, JSON.stringify(r)); return r.bot; };

  const sv = (await call('/servers', { method: 'POST', body: { name: 'More Land' }, token: T(owner) })).server;
  assert.strictEqual((await call('/servers/join', { method: 'POST', body: { code: sv.inviteCode }, token: T(mem) })).status, 200);
  const general = sv.channels[0];
  const so = connect(base, { auth: { token: T(owner) } }), sm = connect(base, { auth: { token: T(mem) } });
  const seen = [], reactionEvents = [], edited = [];
  sm.on('message:new', (m) => seen.push(m));
  sm.on('reaction:update', (e) => reactionEvents.push(e));
  await until(() => so.connected && sm.connected, 'sockets');
  let sayN = 0;
  const say = async (u, ch, content) => { if (++sayN % 6 === 0) await sleep(5200); const r = await ack(u === owner ? so : sm, 'message:send', { channelId: ch.id, content }); assert.ok(r.ok, JSON.stringify(r)); return r; };
  const fromBot = (uid) => seen.filter((m) => m.authorId === uid);
  const inst = () => store.db.servers[sv.id].installedBots.find((i) => i.botId === counter.id);

  const CODE = `
    bot.on('install', (e) => { bot.send(e.channels[0].id, 'installed by ' + e.by.username); bot.timer.after('hello', 5, { who: e.by.username }); bot.timer.daily('morning', '09:00', 'UTC'); });
    bot.on('message', (m) => {
      if (m.text === '!count') { const n = bot.store.incr('count'); bot.reply(m, 'count ' + n); }
      else if (m.text === '!react') { bot.react(m, '👍'); bot.react(m, '🎉'); }
      else if (m.text === '!stars') bot.fetch('https://api.github.com/repos/aduna/aduna', 'stars');
      else if (m.text === '!evil') { bot.fetch('https://evil.example.com/x', 'evil'); bot.fetch('http://api.github.com/x', 'plain'); }
    });
    bot.on('messageEdit', (m) => bot.send(m.channelId, 'saw edit: ' + m.text));
    bot.on('memberLeave', (e) => bot.send(e.channels[0].id, 'goodbye ' + e.user.username + ' (' + e.reason + ')'));
    bot.on('timer', (t) => bot.send(t.channels[0].id, 'timer ' + t.name + ' ' + JSON.stringify(t.data)));
    bot.on('fetch', (f) => bot.send(f.channels[0].id, f.name + ' ' + (f.ok ? 'stars=' + f.json.stargazers_count : 'failed: ' + f.error)));`;
  const counter = await mkBot(dev, 'Counter', CODE);
  assert.strictEqual((await call(`/bots/${counter.id}`, { method: 'PATCH', body: { visibility: 'public', description: 'Counts things' }, token: T(dev) })).status, 200);

  // ---------- install event, serverView hides the bot's data ----------
  let r = await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: counter.id }, token: T(owner) });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  const bu = r.server.members.find((m) => m.bot).id;
  const hello = await until(() => fromBot(bu).find((m) => /installed by/.test(m.content)), 'the install message');
  assert.strictEqual(hello.content, 'installed by moreowner');
  assert.ok(!JSON.stringify(r.server).includes('"kv"') && !JSON.stringify(r.server).includes('timers'), 'serverView carries no storage or timers');
  step('install event: the bot hears it was added and by whom; storage and timers stay out of the server view');

  // ---------- storage: a counter that lives on the install ----------
  for (let i = 1; i <= 3; i++) await say(mem, general, '!count');
  await until(() => fromBot(bu).filter((m) => /^count/.test(m.content)).length === 3, 'three counts');
  assert.deepStrictEqual(fromBot(bu).filter((m) => /^count/.test(m.content)).map((m) => m.content), ['count 1', 'count 2', 'count 3']);
  assert.strictEqual(inst().kv.count, '3');
  step('storage: a counter that survives events (bot.store.incr)');

  // ---------- reactions ----------
  const q = await say(mem, general, '!react');
  const target = await until(() => Object.values(store.db.messages).find((m) => m.content === '!react' && m.authorId === mem.user.id), 'the message');
  await until(() => Object.keys(target.reactions || {}).length === 2, 'both reactions');
  assert.deepStrictEqual(target.reactions, { '👍': [bu], '🎉': [bu] });
  await until(() => reactionEvents.filter((e) => e.messageId === target.id).length === 2, 'live updates');
  assert.ok(reactionEvents.every((e) => e.kind === 'channel'), 'members see the reactions live, in the same event people trigger');
  step('reactions: the bot reacts, people see it live');

  // ---------- fetch (the network is replaced; the real address rules are not) ----------
  const asked = [];
  const realGet = fetcher.get;
  fetcher.get = async (u) => { asked.push(u); return { ok: true, status: 200, text: '{"stargazers_count":99}', json: { stargazers_count: 99 }, truncated: false, error: null }; };
  await say(mem, general, '!stars');
  const stars = await until(() => fromBot(bu).find((m) => /^stars /.test(m.content)), 'fetch answer');
  assert.strictEqual(stars.content, 'stars stars=99');
  assert.deepStrictEqual(asked, ['https://api.github.com/repos/aduna/aduna']);
  await say(mem, general, '!evil'); await sleep(600);
  assert.deepStrictEqual(asked, ['https://api.github.com/repos/aduna/aduna'], 'addresses off the allow-list and plain http never reach the fetcher');
  const logs = (await call(`/bots/${counter.id}/logs`, { token: T(dev) })).logs;
  const evil = logs.find((l) => l.event === 'message' && (l.dropped || []).some((d) => /not on the allowed list/.test(d)));
  assert.ok(evil && evil.dropped.length === 2, 'the developer sees why: ' + JSON.stringify(logs.map((l) => l.dropped)));
  assert.ok(logs.some((l) => l.event === 'fetch' && l.ok), 'and the fetch answer appears as its own run');
  fetcher.get = realGet;
  step('fetch: only allow-listed addresses go out; the answer comes back as an event; refusals are logged for the developer');

  // ---------- timers ----------
  assert.deepStrictEqual(inst().timers.map((t) => t.name).sort(), ['hello', 'morning']);
  const hi = inst().timers.find((t) => t.name === 'hello'); hi.at = Date.now() - 1;
  botHost.tick();
  const tm = await until(() => fromBot(bu).find((m) => /^timer hello/.test(m.content)), 'the timer message');
  assert.strictEqual(tm.content, 'timer hello {"who":"moreowner"}');
  assert.ok(!inst().timers.some((t) => t.name === 'hello') && inst().timers.some((t) => t.name === 'morning'), 'the one-shot is gone, the daily stays');
  botHost.tick(); await sleep(300);
  assert.strictEqual(fromBot(bu).filter((m) => /^timer hello/.test(m.content)).length, 1);
  step('timers: a due timer fires once with its data');

  // ---------- messageEdit, memberLeave (left and kicked) ----------
  const mine = await say(mem, general, 'typo');
  const typo = await until(() => Object.values(store.db.messages).find((m) => m.content === 'typo'), 'typo message');
  await sleep(300);
  assert.strictEqual((await ack(sm, 'message:edit', { kind: 'channel', messageId: typo.id, content: 'fixed' })).ok, true);
  await until(() => fromBot(bu).find((m) => m.content === 'saw edit: fixed'), 'edit event');
  const mem2 = await makeUser('moremem2');
  await call('/servers/join', { method: 'POST', body: { code: sv.inviteCode }, token: T(mem2) });
  assert.strictEqual((await call(`/servers/${sv.id}/leave`, { method: 'POST', token: T(mem2) })).status, 200);
  await until(() => fromBot(bu).find((m) => m.content === 'goodbye moremem2 (left)'), 'leave event');
  const mem3 = await makeUser('moremem3');
  await call('/servers/join', { method: 'POST', token: T(mem3), body: { code: sv.inviteCode } });
  assert.strictEqual((await call(`/servers/${sv.id}/members/${mem3.user.id}/kick`, { method: 'POST', token: T(owner) })).status, 200);
  await until(() => fromBot(bu).find((m) => m.content === 'goodbye moremem3 (kicked)'), 'kick event');
  step('events: message edits, someone leaving, someone kicked');

  // ---------- removing a bot erases what it stored; installing again starts clean ----------
  assert.strictEqual((await call(`/servers/${sv.id}/bots/${counter.id}`, { method: 'DELETE', token: T(owner) })).status, 200);
  assert.strictEqual(store.db.servers[sv.id].installedBots.length, 0);
  r = await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: counter.id }, token: T(owner) });
  assert.strictEqual(r.status, 200);
  assert.ok(!inst().kv || inst().kv.count === undefined, 'a new install starts with empty storage');
  await say(mem, general, '!count');
  await until(() => fromBot(bu).filter((m) => m.content === 'count 1').length === 2, 'count restarted at 1');
  step('uninstalling erases the bot\'s storage and timers in that server');

  // ---------- avatars ----------
  const put = (id, buf, u = dev, type = 'image/png') => call(`/bots/${id}/avatar`, { method: 'PUT', raw: buf, type, token: T(u) });
  assert.strictEqual((await put(counter.id, png(64, 64), dev2)).status, 404, "another developer cannot change it");
  assert.strictEqual((await put(counter.id, png(64, 64), mem)).status, 403, 'a person without a developer account cannot');
  assert.strictEqual((await put(counter.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), dev, 'image/png')).status, 400, 'not a real image');
  assert.strictEqual((await put(counter.id, png(600, 600))).status, 400, 'too big');
  assert.strictEqual((await put(counter.id, Buffer.alloc(0))).status, 400);
  assert.ok([400, 415].includes((await put(counter.id, png(64, 64), dev, 'image/svg+xml')).status), 'svg type refused');
  r = await put(counter.id, png(64, 64));
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  const first = r.bot.avatarImage;
  assert.ok(/^[0-9a-f]{16,}$/.test(first || ''), 'an image id: ' + first);
  assert.strictEqual(store.db.users[bu].avatarImage, first, 'the bot account shows the same picture');
  assert.strictEqual((await fetch(base + '/api/images/' + first)).status, 200);
  assert.strictEqual((await call('/explore/bots?q=counter', { token: T(mem) })).bots[0].avatarImage, first, 'the explorer card gets it');
  assert.strictEqual((await call(`/servers/${sv.id}`, { token: T(mem) })).server?.members?.find?.((m) => m.id === bu)?.avatarImage ?? first, first);
  r = await put(counter.id, png(80, 80));
  assert.notStrictEqual(r.bot.avatarImage, first);
  assert.strictEqual((await fetch(base + '/api/images/' + first)).status, 404, 'the replaced picture is deleted');
  assert.strictEqual(store.db.users[bu].avatarImage, r.bot.avatarImage);
  r = await call(`/bots/${counter.id}/avatar`, { method: 'DELETE', token: T(dev) });
  assert.deepStrictEqual([r.status, r.bot.avatarImage, store.db.users[bu].avatarImage], [200, null, null]);
  // a held listing cannot change its picture
  store.db.bots[counter.id].listingHold = { state: 'hidden' };
  assert.strictEqual((await put(counter.id, png(64, 64))).status, 400);
  delete store.db.bots[counter.id].listingHold;
  // an avatar set before the bot is ever installed lands on its account when it is
  const early = await mkBot(dev, 'Early', "bot.on('message', () => {});");
  const ea = (await put(early.id, png(32, 32))).bot.avatarImage;
  const sv2 = (await call('/servers', { method: 'POST', body: { name: 'Early Server' }, token: T(dev) })).server;
  const ir = await call(`/servers/${sv2.id}/bots`, { method: 'POST', body: { botId: early.id }, token: T(dev) });
  assert.strictEqual(ir.server.members.find((m) => m.bot).avatarImage, ea, 'installing a bot that already has a picture shows it');
  step('avatars: upload checks, replace deletes the old one, account and explorer follow, held listings locked, set-before-install works');

  // ---------- the developer test run knows every event and shows what would be stored, scheduled, reacted to and fetched ----------
  const test = (body) => call('/developer/test', { method: 'POST', body, token: T(dev) });
  r = await test({ event: 'message', text: 'x', code: `bot.on('message', (m) => { bot.store.incr('n', 2); bot.store.set('bad key', 1); bot.timer.after('t', 60, { a: 1 }); bot.timer.after('t2', 1); bot.react(m, '👍'); bot.react(m, 'word'); bot.fetch('https://api.github.com/a', 'a'); bot.fetch('https://evil.com/'); });` });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.deepStrictEqual(r.result.stored, [{ key: 'n', value: '2' }]);
  assert.deepStrictEqual(r.result.timersSet.map((t) => t.name), ['t']);
  assert.strictEqual(r.result.reactions.length, 2); assert.strictEqual(r.result.fetches.length, 2);
  assert.strictEqual(r.result.dropped.length, 4, JSON.stringify(r.result.dropped)); // bad key, timer too soon, "word", evil.com
  for (const [event, code, want] of [
    ['messageEdit', "bot.on('messageEdit', (m) => bot.reply(m, 'e:' + m.text + !!m.editedAt));", 'e:xtrue'],
    ['memberLeave', "bot.on('memberLeave', (e) => bot.send(e.channels[0].id, e.reason));", 'left'],
    ['install', "bot.on('install', (e) => bot.send(e.channels[0].id, e.serverName));", 'Test server'],
    ['timer', "bot.on('timer', (t) => bot.send(t.channels[0].id, 'timer ' + t.name));", 'timer test'],
    ['fetch', "bot.on('fetch', (f) => bot.send(f.channels[0].id, f.name + f.json.stargazers_count));", 'fetch42'],
  ]) {
    r = await test({ event, text: event === 'fetch' ? '{"stargazers_count":42}' : 'x', code });
    assert.deepStrictEqual(r.result.actions.map((a) => a.text), [want], event + ': ' + JSON.stringify(r.result));
  }
  assert.strictEqual(asked.length, 1, 'a test run never touches the network');
  step('developer test run: every event, and a preview of storage, timers, reactions and fetches with what would be refused');

  for (const s of [so, sm]) s.close();
  await sandbox.stop();
  console.log('\nAll bot platform checks passed.');
  await cleanup();
  process.exit(0);
})().catch(async (e) => { console.error('\n✗ FAILED:', e && e.stack || e); try { await sandbox.stop(); await cleanup(); } catch {} process.exit(1); });
