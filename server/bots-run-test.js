// Bots part 3: bot accounts, installing, events, limits, clean-up. node server/bots-run-test.js (needs TEST_DATABASE_URL and `npm install`)
process.env.ADMIN_USERNAMES = 'runadmin';
const assert = require('assert');
const { webcrypto: crypto } = require('crypto');
const { io: connect } = require('socket.io-client');
const { cleanup } = require('./test-env');
const { httpServer, ready, store } = require('./index');
const sandbox = require('./sandbox');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const step = (m) => console.log('✓', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ack = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
async function until(fn, what, ms = 6000) {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) assert.fail('timed out waiting for ' + what); await sleep(40); }
}
async function makeUser(name) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const r = await call('/register', { method: 'POST', body: { username: name, email: name + '@example.com', password: 'password123', publicKey: JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }), encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  assert.strictEqual(r.status, 200, 'register ' + JSON.stringify(r));
  return r;
}
const T = (u) => u.token;

(async () => {
  await ready;
  await sandbox.ready();
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://localhost:' + httpServer.address().port;

  const owner = await makeUser('runowner'), dev = await makeUser('rundev'), dev2 = await makeUser('rundev2'), mem = await makeUser('runmem'),
    out = await makeUser('runout'), admin = await makeUser('runadmin');
  for (const u of [dev, dev2, admin]) assert.strictEqual((await call('/developer/join', { method: 'POST', body: { accept: true }, token: T(u) })).status, 200);
  const mkBot = async (u, name, code, extra = {}) => { const r = await call('/bots', { method: 'POST', body: { name, code, ...extra }, token: T(u) }); assert.strictEqual(r.status, 200, JSON.stringify(r)); return r.bot; };
  const pub = (id, u = dev) => call(`/bots/${id}`, { method: 'PATCH', body: { visibility: 'public', description: 'A helpful bot' }, token: T(u) });

  // a server with the owner and one ordinary member
  const sv = (await call('/servers', { method: 'POST', body: { name: 'Bot Land' }, token: T(owner) })).server;
  const code = sv.inviteCode;
  assert.strictEqual((await call('/servers/join', { method: 'POST', body: { code }, token: T(mem) })).status, 200);
  const chan = async (name, type) => (await call(`/servers/${sv.id}/channels`, { method: 'POST', body: { name, ...(type ? { type } : {}) }, token: T(owner) })).server.channels.find((c) => c.name === name);
  const general = sv.channels[0], side = await chan('side'), voice = await chan('lounge', 'voice'), rules = await chan('rules', 'rules');

  const sock = (u) => connect(base, { auth: { token: T(u) } });
  const so = sock(owner), sm = sock(mem);
  const seen = []; // every message:new the member's socket receives
  sm.on('message:new', (m) => seen.push(m));
  const botMsgs = (botUserId) => seen.filter((m) => m.authorId === botUserId);
  await until(() => so.connected && sm.connected, 'sockets');
  let sayN = 0; // the server allows 8 socket events per 5 s per connection, so pace our own chatter
  const say = async (u, ch, content) => { if (++sayN % 6 === 0) await sleep(5200); const r = await ack(u === owner ? so : sm, 'message:send', { channelId: ch.id, content }); assert.ok(r.ok, JSON.stringify(r)); };

  const PING = "bot.on('message', (m) => { if (m.text === '!ping') bot.reply(m, 'pong <@' + m.author.id + '>'); });";
  const pinger = await mkBot(dev, 'Pinger', PING, { tags: ['fun'] });
  const secret = await mkBot(dev, 'Secret', PING);
  await pub(pinger.id);

  // ---------- installing ----------
  assert.strictEqual((await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: pinger.id }, token: T(out) })).status, 404, 'outsiders get nothing');
  assert.strictEqual((await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: pinger.id }, token: T(mem) })).status, 403, 'members need Manage server');
  assert.strictEqual((await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: secret.id }, token: T(owner) })).status, 404, "someone else's private bot cannot be installed");
  for (const bad of ['nope', '__proto__', 'constructor', '', null, 5]) assert.strictEqual((await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: bad }, token: T(owner) })).status, 404, 'odd bot ids: ' + bad);
  assert.strictEqual((await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: pinger.id, channels: [voice.id] }, token: T(owner) })).status, 400, 'only text channels can be picked');
  assert.strictEqual((await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: pinger.id, channels: ['zzz'] }, token: T(owner) })).status, 400);
  let r = await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: pinger.id }, token: T(owner) });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  const botUser = r.server.members.find((m) => m.bot);
  assert.ok(botUser && botUser.displayName === 'Pinger' && /^bot-[0-9a-f]{12}$/.test(botUser.username), 'the bot is a member with a BOT flag and a dash-name nobody can register');
  assert.deepStrictEqual(r.server.bots, [{ botId: pinger.id, userId: botUser.id, channels: null }]);
  assert.ok(!('passHash' in botUser) && !('email' in botUser));
  assert.strictEqual((await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: pinger.id }, token: T(owner) })).status, 400, 'twice is refused');
  assert.strictEqual((await call('/register', { method: 'POST', body: { username: 'bot-' + botUser.id.slice(0, 12), email: 'x@example.com', password: 'password123', publicKey: 'k', encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } })).status, 400, 'a person cannot register a dash-name');
  step('install: permissions, odd ids, one account per bot, BOT flag');

  // the account is not a way in
  assert.strictEqual((await call('/login', { method: 'POST', body: { username: botUser.username, password: 'password123' } })).status, 401, 'a bot cannot log in');
  assert.strictEqual((await call('/login', { method: 'POST', body: { username: botUser.username, password: '' } })).status, 401);
  assert.strictEqual((await call('/friends/request', { method: 'POST', body: { username: botUser.username }, token: T(owner) })).status, 404, 'a bot cannot be friended (no DMs, no calls)');
  assert.strictEqual((await call('/me', { token: 'x' })).status, 401);
  assert.strictEqual((await call(`/users/${botUser.id}`, { token: T(mem) })).user.bot, true, 'its profile can be opened');
  assert.strictEqual((await call(`/servers/${sv.id}/members/${botUser.id}/kick`, { method: 'POST', token: T(owner) })).status, 400, 'kick does not apply to bots');
  step('a bot account cannot log in, be friended or kicked like a person');

  // ---------- events ----------
  await say(mem, general, '!ping');
  const pong = await until(() => botMsgs(botUser.id)[0], 'the bot reply');
  assert.deepStrictEqual([pong.bot, pong.everyone, pong.mentions, pong.content], [true, false, [mem.user.id], `pong <@${mem.user.id}>`], 'the bot pings only the person it answers');
  assert.strictEqual(pong.channelId, general.id);
  const hist = (await call(`/channels/${general.id}/messages`, { token: T(mem) })).messages || [];
  assert.ok(hist.some((m) => m.id === pong.id && m.bot === true), 'bot messages are stored and marked');
  await say(mem, general, 'just chatting');
  await sleep(400);
  assert.strictEqual(botMsgs(botUser.id).length, 1, 'no reply to messages the code ignores');
  step('events: a message reaches the bot, its reply is marked bot and pings only the asker');

  // a bot cannot ping others or everyone, cannot use other channels, other servers, voice or rules; bots do not answer bots
  const sv2 = (await call('/servers', { method: 'POST', body: { name: 'Elsewhere' }, token: T(owner) })).server;
  const NAUGHTY = `bot.on('message', (m) => {
    if (m.text !== '!naughty') return;
    bot.send(m.channelId, '@everyone <@${owner.user.id}> hello');
    bot.send('${voice.id}', 'in voice'); bot.send('${rules.id}', 'in rules'); bot.send('${sv2.channels[0].id}', 'other server');
    bot.reply(m, 'a reply in the same channel is fine'); // the sandbox keeps 5 actions per event, so this is the 5th
  });`;
  const naughty = await mkBot(dev, 'Naughty', NAUGHTY);
  await pub(naughty.id); // the owner is not its developer, so only a public bot can be added
  r = await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: naughty.id }, token: T(owner) });
  const nUser = r.server.members.find((m) => m.bot && m.displayName === 'Naughty');
  await say(mem, general, '!naughty');
  const nm = await until(() => botMsgs(nUser.id)[0], 'naughty reply');
  await sleep(500);
  assert.strictEqual(botMsgs(nUser.id).length, 2, 'only the allowed text-channel messages arrived (the 3 others were refused)');
  const sent = botMsgs(nUser.id);
  assert.ok(sent.every((m) => m.channelId === general.id && m.everyone === false && m.mentions.length === 0), 'no @everyone, no pings of others');
  assert.ok(!(await call(`/channels/${sv2.channels[0].id}/messages`, { token: T(owner) })).messages?.some((m) => m.bot), 'nothing reached the other server');
  assert.ok(!(await call(`/channels/${voice.id}/messages`, { token: T(owner) })).messages?.some((m) => m.bot), 'nothing in voice');
  const nlogs = (await call(`/bots/${naughty.id}/logs`, { token: T(dev) })).logs;
  assert.ok(nlogs[0].dropped.length >= 3 && nlogs[0].sent === 2, 'the developer sees what was refused: ' + JSON.stringify(nlogs[0]));
  // two bots that answer everything do not start a loop
  const echo = await mkBot(dev2, 'Echo', "bot.on('message', (m) => bot.send(m.channelId, 'echo'));");
  await pub(echo.id, dev2);
  await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: echo.id }, token: T(owner) });
  const eUser = store.db.users[store.db.bots[echo.id].userId];
  await say(mem, general, 'hello everyone');
  await until(() => botMsgs(eUser.id).length >= 1, 'echo');
  await sleep(800);
  assert.strictEqual(botMsgs(eUser.id).length, 1, 'bots do not receive events caused by bots: no loop');
  await call(`/servers/${sv.id}/bots/${echo.id}`, { method: 'DELETE', token: T(owner) });
  await call(`/servers/${sv.id}/bots/${naughty.id}`, { method: 'DELETE', token: T(owner) });
  step('actions: other channels, servers, voice, rules, @everyone and pings of others refused; no bot loops');

  // ---------- channel allow-list ----------
  r = await call(`/servers/${sv.id}/bots/${pinger.id}`, { method: 'PATCH', body: { channels: [side.id] }, token: T(owner) });
  assert.deepStrictEqual(r.server.bots[0].channels, [side.id]);
  assert.strictEqual((await call(`/servers/${sv.id}/bots/${pinger.id}`, { method: 'PATCH', body: { channels: [voice.id] }, token: T(owner) })).status, 400);
  assert.strictEqual((await call(`/servers/${sv.id}/bots/${pinger.id}`, { method: 'PATCH', body: { channels: [side.id] }, token: T(mem) })).status, 403);
  const before = botMsgs(botUser.id).length;
  await say(mem, general, '!ping');
  await sleep(600);
  assert.strictEqual(botMsgs(botUser.id).length, before, 'a channel the admin did not allow stays unseen: no event, no reply');
  await say(mem, side, '!ping');
  await until(() => botMsgs(botUser.id).length === before + 1, 'reply in the allowed channel');
  await call(`/servers/${sv.id}/bots/${pinger.id}`, { method: 'PATCH', body: { channels: null }, token: T(owner) });
  step('channel allow-list limits what a bot reads and where it writes');

  // ---------- memberJoin ----------
  const WELCOME = "bot.on('memberJoin', (e) => bot.send(e.channels[0].id, 'Welcome <@' + e.user.id + '>!'));";
  const welcomer = await mkBot(dev, 'Welcomer', WELCOME);
  await pub(welcomer.id);
  r = await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: welcomer.id, channels: [side.id] }, token: T(owner) });
  const wUser = r.server.members.find((m) => m.displayName === 'Welcomer');
  assert.strictEqual((await call('/servers/join', { method: 'POST', body: { code }, token: T(out) })).status, 200);
  const hi = await until(() => botMsgs(wUser.id)[0], 'welcome message');
  assert.deepStrictEqual([hi.channelId, hi.mentions, hi.content], [side.id, [out.user.id], `Welcome <@${out.user.id}>!`], 'welcome goes to an allowed channel and pings the new member');
  await call(`/servers/${sv.id}/leave`, { method: 'POST', token: T(out) });
  step('memberJoin: a welcome bot greets the person who joined');

  // ---------- hostile code: loops are stopped, repeated timeouts pause the bot, new code resumes it ----------
  const hog = await mkBot(dev2, 'Hog', "bot.on('message', () => { for (;;) {} });");
  await pub(hog.id, dev2);
  await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: hog.id }, token: T(owner) });
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) await say(mem, general, 'wake the hog ' + i);
  await until(async () => ((await call(`/bots/${hog.id}/logs`, { token: T(dev2) })).pausedUntil), 'the hog to be paused', 15000);
  const lg = await call(`/bots/${hog.id}/logs`, { token: T(dev2) });
  assert.ok(lg.logs.some((l) => l.timedOut), 'timeouts are logged');
  await say(mem, general, 'after the pause');
  await sleep(300);
  assert.ok((await call(`/bots/${hog.id}/logs`, { token: T(dev2) })).logs.some((l) => /paused/.test(l.skipped || '')), 'events are skipped while paused');
  assert.strictEqual((await call(`/bots/${hog.id}/logs`, { token: T(dev) })).status, 404, "another developer cannot read a bot's logs");
  assert.strictEqual((await call(`/bots/${hog.id}/logs`, { token: T(owner) })).status, 404, 'neither can the server owner');
  assert.strictEqual((await call(`/bots/${hog.id}`, { method: 'PATCH', body: { code: "bot.on('message', (m) => bot.log('fine'));" }, token: T(dev2) })).status, 200);
  assert.strictEqual((await call(`/bots/${hog.id}/logs`, { token: T(dev2) })).pausedUntil, null, 'saving new code lifts the pause');
  await call(`/servers/${sv.id}/bots/${hog.id}`, { method: 'DELETE', token: T(owner) });
  // the server stayed responsive the whole time
  const probe = Date.now(); assert.strictEqual((await call('/me', { token: T(owner) })).status, 200); assert.ok(Date.now() - probe < 1500);
  step('hostile code: an infinite loop is stopped, repeated timeouts pause the bot, saving fixed code resumes it');

  // ---------- message rate limit: 20 per minute per bot per server ----------
  const flood = await mkBot(dev2, 'Flooder', "bot.on('message', (m) => { for (let i = 0; i < 5; i++) bot.send(m.channelId, 'f' + i); });");
  await pub(flood.id, dev2);
  r = await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: flood.id }, token: T(owner) });
  const fUser = r.server.members.find((m) => m.displayName === 'Flooder');
  for (let i = 0; i < 6; i++) await say(mem, general, 'flood ' + i);
  await until(() => botMsgs(fUser.id).length >= 20, '20 flood messages');
  await sleep(1000);
  assert.strictEqual(botMsgs(fUser.id).length, 20, 'a bot may post 20 messages a minute in a server, not 30');
  assert.ok((await call(`/bots/${flood.id}/logs`, { token: T(dev2) })).logs.some((l) => l.dropped.some((d) => /over the limit/.test(d))), 'and the developer is told');
  await call(`/servers/${sv.id}/bots/${flood.id}`, { method: 'DELETE', token: T(owner) });
  step('rate limit: 20 messages per minute per bot per server');

  // ---------- bots are not people ----------
  const mk = async (name) => (await call('/servers', { method: 'POST', body: { name }, token: T(owner) })).server;
  const pubSrv = await mk('Public Place');
  for (const [n, t] of [['a1', 'text'], ['a2', 'text'], ['a3', 'text'], ['v1', 'voice'], ['v2', 'voice'], ['ru', 'rules'], ['an', 'announcements']]) await call(`/servers/${pubSrv.id}/channels`, { method: 'POST', body: { name: n, type: t }, token: T(owner) });
  assert.strictEqual((await call(`/servers/${pubSrv.id}/publish`, { method: 'PUT', body: { visibility: 'public', description: 'A friendly place to chat' }, token: T(owner) })).status, 200);
  await call(`/servers/${pubSrv.id}/bots`, { method: 'POST', body: { botId: pinger.id }, token: T(owner) });
  const listed = (await call('/explore?q=Public', { token: T(mem) })).servers.find((x) => x.serverId === pubSrv.id);
  assert.strictEqual(listed.memberCount, 1, 'a bot does not count as a member in the explorer');
  assert.strictEqual((await call(`/servers/${pubSrv.id}/transfer`, { method: 'POST', body: { userId: store.db.bots[pinger.id].userId, password: 'password123' }, token: T(owner) })).status, 400, 'ownership cannot go to a bot');
  const lone = await call(`/servers/${pubSrv.id}/leave`, { method: 'POST', token: T(owner) });
  assert.deepStrictEqual([lone.status, lone.deleted], [200, true], 'an owner with only bots left is alone: leaving deletes the server');
  assert.ok(!store.db.bots[pinger.id].installs.includes(pubSrv.id), 'and the bot forgets it');
  step('bots do not count as members (explorer, ownership, being alone)');

  // ---------- uninstall, going private, deleting, moderation ----------
  assert.strictEqual((await call(`/servers/${sv.id}/bots/${pinger.id}`, { method: 'DELETE', token: T(mem) })).status, 403);
  // a stranger's server has the public Pinger; when the developer makes it private only servers they manage keep it
  const strange = (await call('/servers', { method: 'POST', body: { name: 'Stranger Server' }, token: T(out) })).server;
  await call(`/servers/${strange.id}/bots`, { method: 'POST', body: { botId: pinger.id }, token: T(out) });
  const devSrv = (await call('/servers', { method: 'POST', body: { name: 'Dev Server' }, token: T(dev) })).server;
  await call(`/servers/${devSrv.id}/bots`, { method: 'POST', body: { botId: pinger.id }, token: T(dev) });
  assert.strictEqual((await call('/explore/bots', { token: T(mem) })).bots.find((b) => b.id === pinger.id).installs, 3);
  await call(`/bots/${pinger.id}`, { method: 'PATCH', body: { visibility: 'private' }, token: T(dev) });
  assert.ok(store.db.servers[strange.id].members.every((id) => !store.db.users[id].bot), "going private removes the bot from servers its developer doesn't manage");
  assert.ok(store.db.servers[devSrv.id].members.some((id) => store.db.users[id].bot), 'but not from their own');
  assert.ok(!store.db.servers[sv.id].members.includes(store.db.bots[pinger.id].userId), 'nor does a server owner keep it after it went private');
  await pub(pinger.id);
  // moderation removal: leaves every server, tells the developer live
  const sd = sock(dev); const got = []; sd.on('bot:update', (b) => got.push(b));
  await until(() => sd.connected, 'dev socket');
  await call(`/servers/${devSrv.id}/bots`, { method: 'POST', body: { botId: pinger.id }, token: T(dev) });
  r = await call(`/admin/bots/${pinger.id}/listing`, { method: 'POST', body: { action: 'remove' }, token: T(admin) });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.ok(Object.values(store.db.servers).every((s) => !(s.installedBots || []).some((i) => i.botId === pinger.id)), 'a removed bot leaves every server');
  const upd = await until(() => got[0], 'bot:update');
  assert.strictEqual(upd.review, 'removed', 'the developer hears about it live');
  assert.strictEqual((await call(`/servers/${devSrv.id}/bots`, { method: 'POST', body: { botId: pinger.id }, token: T(dev) })).status, 400, 'a removed bot cannot be installed again, even by its developer');
  sd.close();
  step('going private and moderation removal take a bot out of servers; developer is told');

  // deleting a bot
  const doomed = await mkBot(dev2, 'Doomed', "bot.on('message', (m) => bot.reply(m, 'bye'));");
  await pub(doomed.id, dev2);
  await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: doomed.id }, token: T(owner) });
  const dUserId = store.db.bots[doomed.id].userId;
  await say(mem, general, 'hi doomed');
  const last = await until(() => botMsgs(dUserId)[0], 'doomed reply');
  assert.strictEqual((await call(`/bots/${doomed.id}`, { method: 'DELETE', token: T(dev) })).status, 404, "another developer cannot delete it");
  assert.strictEqual((await call(`/bots/${doomed.id}`, { method: 'DELETE', token: T(dev2) })).status, 200);
  assert.ok(!store.db.servers[sv.id].members.includes(dUserId) && !(store.db.servers[sv.id].installedBots || []).some((i) => i.botId === doomed.id), 'a deleted bot leaves its servers');
  assert.strictEqual((await call(`/users/${dUserId}`, { token: T(mem) })).user.displayName, 'Doomed', 'its old messages keep a name');
  assert.ok((await call(`/channels/${general.id}/messages`, { token: T(mem) })).messages.some((m) => m.id === last.id), 'and stay in the channel');
  step('deleting a bot removes it from servers but keeps what it said');

  // ---------- developer test run uses the real shapes and shows what a server would refuse ----------
  r = await call('/developer/test', { method: 'POST', body: { code: "bot.on('message', (m) => { bot.send('wrong', 'x'); bot.reply(m, 'ok ' + m.author.username + ' ' + m.mentionsBot); });", text: 'hi' }, token: T(dev) });
  assert.deepStrictEqual(r.result.actions.map((a) => a.text), ['x', 'ok rundev false']);
  assert.strictEqual(r.result.dropped.length, 1, 'a wrong channel id shows up as refused');
  r = await call('/developer/test', { method: 'POST', body: { event: 'memberJoin', code: "bot.on('memberJoin', (e) => bot.send(e.channels[0].id, 'hi ' + e.user.username));" }, token: T(dev) });
  assert.deepStrictEqual([r.result.actions.map((a) => a.text), r.result.dropped], [['hi rundev'], []]);
  step('developer test runs: same event shapes, refused actions are reported');

  for (const s of [so, sm]) s.close();
  await sandbox.stop();
  console.log('\nAll bot runtime checks passed.');
  await cleanup();
  process.exit(0);
})().catch(async (e) => { console.error('\n✗ FAILED:', e && e.stack || e); try { await sandbox.stop(); await cleanup(); } catch {} process.exit(1); });
