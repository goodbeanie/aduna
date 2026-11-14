// Server automod through the real server (needs TEST_DATABASE_URL like the other DB tests): node server/automod-flow-test.js
// The rules themselves are in automod-test.js; this checks the routes, the send and edit checks, timeouts, kicks and exemptions.
const assert = require('assert');
const { webcrypto: crypto } = require('crypto');
const { cleanup } = require('./test-env');
const { httpServer, ready, store } = require('./index');
const { io: connect } = require('socket.io-client');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const step = (m) => console.log('✓', m);
const once = (s, ev, ms = 8000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timed out waiting for ' + ev)), ms); s.once(ev, (x) => { clearTimeout(t); res(x); }); });
async function makeUser(name) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const r = await call('/register', { method: 'POST', body: { username: name, email: name + '@example.com', password: 'password123', publicKey: JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }), encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  assert.strictEqual(r.status, 200, 'register ' + JSON.stringify(r));
  return r;
}
// one connection per attempt: the server allows only a few acknowledged events per connection
async function emit(token, ev, p, wantNew) {
  const s = connect(base, { auth: { token }, extraHeaders: { origin: base } });
  try {
    await once(s, 'connect');
    const made = wantNew ? once(s, 'message:new') : null;
    if (made) made.catch(() => {}); // a refused message never arrives, and that is fine
    const ack = await new Promise((res) => s.emit(ev, p, res));
    return { ...ack, message: ack.ok && made ? await made : undefined };
  } finally { s.close(); }
}

(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://localhost:' + httpServer.address().port;
  const owner = await makeUser('amowner'), alice = await makeUser('amalice'), mod = await makeUser('ammod'), vip = await makeUser('amvip');
  const T = (u) => u.token;
  const sv = (await call('/servers', { method: 'POST', body: { name: 'Quiet Place' }, token: T(owner) })).server;
  const id = sv.id, chan = sv.channels[0].id;
  for (const u of [alice, mod, vip]) await call('/servers/join', { method: 'POST', body: { code: sv.inviteCode }, token: T(u) });
  const say = (u, content) => emit(T(u), 'message:send', { channelId: chan, content }, true);
  const put = (u, body) => call(`/servers/${id}/automod`, { method: 'PUT', body, token: T(u) });
  const settings = { enabled: true, words: ['badword'], rules: { words: { on: true, warn: true } }, strikes: { expireDays: 30, ladder: [{ at: 2, action: 'timeout', minutes: 5 }] } };

  // only people who manage the server can read or change it
  assert.strictEqual((await put(alice, settings)).status, 403, 'a member cannot change automod');
  assert.strictEqual((await call(`/servers/${id}/automod`, { token: T(alice) })).status, 403, 'or read the word list');
  assert.strictEqual((await put(owner, { ...settings, words: 'nope' })).status, 400, 'bad settings are refused');
  let r = await put(owner, settings);
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.deepStrictEqual(r.config.words, ['badword']);
  assert.ok(!JSON.stringify((await call('/servers', { token: T(alice) })).servers).includes('badword'), 'the word list is not in what members receive');
  step('settings are for managers only, validated, and the word list stays private');

  // a refused message is never stored; a warning is counted
  r = await say(alice, 'hello there');
  assert.ok(r.ok, JSON.stringify(r));
  r = await say(alice, 'you BADWORD');
  assert.match(String(r.error), /Message not sent: .*Warning 1\. At 2 warnings you will be timed out for 5 minutes/, JSON.stringify(r));
  assert.ok(!r.message, 'nothing was posted');
  r = await say(owner, 'badword is exempt for the owner');
  assert.ok(r.ok, 'the owner is not checked');
  step('a banned word is refused with a warning, the owner is exempt');

  // the second warning is a timeout, which covers everything until it ends
  r = await say(alice, 'badword again');
  assert.match(String(r.error), /timed out for 5 minutes/, JSON.stringify(r));
  r = await say(alice, 'a perfectly fine message');
  assert.match(String(r.error), /timed out in this server for 5 minutes/, 'a timed out member cannot post');
  r = await call(`/servers/${id}/automod`, { token: T(owner) });
  assert.strictEqual(r.strikes.length, 1);
  assert.strictEqual(r.strikes[0].userId, alice.user.id);
  assert.strictEqual(r.strikes[0].count, 2);
  assert.ok(r.strikes[0].until > Date.now());
  assert.strictEqual(r.log.length, 2);
  assert.strictEqual(r.log[0].action, 'timeout', 'newest first');
  assert.strictEqual(r.log[1].action, 'warned');
  step('the second warning is a timeout, and the settings screen shows it');

  // forgiving ends the timeout and clears the count
  assert.strictEqual((await call(`/servers/${id}/automod/strikes/${alice.user.id}`, { method: 'DELETE', token: T(alice) })).status, 403);
  r = await call(`/servers/${id}/automod/strikes/${alice.user.id}`, { method: 'DELETE', token: T(owner) });
  assert.deepStrictEqual(r.strikes, []);
  assert.ok((await say(alice, 'back again')).ok);
  step('a manager can forgive someone');

  // edits are checked too
  const posted = await say(alice, 'a clean message');
  r = await emit(T(alice), 'message:edit', { kind: 'channel', messageId: posted.message.id, content: 'now with badword' });
  assert.match(String(r.error), /Message not sent/, 'an edit cannot get around the filter');
  r = await emit(T(alice), 'message:edit', { kind: 'channel', messageId: posted.message.id, content: 'a clean edit' });
  assert.ok(r.ok);
  step('edits are checked');

  // file names are read against the word list, and the log channel hears about each action
  const logId = (await call(`/servers/${id}/channels`, { method: 'POST', body: { name: 'mod-log' }, token: T(owner) })).server.channels.find((c) => c.name === 'mod-log').id;
  await call(`/servers/${id}/automod/strikes/${alice.user.id}`, { method: 'DELETE', token: T(owner) });
  r = await put(owner, { ...settings, strikes: { expireDays: 30, ladder: [] }, logChannel: logId });
  assert.strictEqual(r.config.logChannel, logId);
  r = await emit(T(alice), 'message:send', { channelId: chan, content: 'a photo', attachments: [{ id: 'nope', name: 'badword.png', type: 'image/png' }] });
  assert.match(String(r.error), /Message not sent: a file name has a word/, JSON.stringify(r));
  r = await emit(T(alice), 'message:send', { channelId: chan, content: '', attachments: [{ gif: true, url: 'https://example.com/a.gif', w: 10, h: 10, title: 'badword gif' }] });
  assert.match(String(r.error), /Message not sent: a file name has a word/, 'a GIF title counts as a name');
  const logLines = () => Object.values(store.db.messages).filter((m) => m.channelId === logId && m.authorId === 'hook:automod');
  assert.strictEqual(logLines().length, 2, 'each warning reached the log channel');
  assert.ok(logLines().every((m) => m.hook.name === 'Automod' && m.bot), 'the lines come from Automod');
  assert.ok(logLines().some((m) => m.content === 'amalice was warned in #general (words: badword). Warning 1.'), JSON.stringify(logLines().map((m) => m.content)));
  assert.strictEqual((await say(alice, 'a clean photo')).ok, true, 'clean messages are not logged');
  assert.strictEqual(logLines().length, 2);
  await call(`/servers/${id}/automod/strikes/${alice.user.id}`, { method: 'DELETE', token: T(owner) });
  r = await put(owner, { ...settings, logChannel: null });
  assert.strictEqual(r.config.logChannel, null);
  await emit(T(alice), 'message:send', { channelId: chan, content: 'badword' });
  assert.strictEqual(logLines().length, 2, 'no log channel, no lines');
  await call(`/servers/${id}/automod/strikes/${alice.user.id}`, { method: 'DELETE', token: T(owner) });
  step('file names are checked and actions reach the log channel');

  // a warning that ends in a kick removes the member like a manual kick
  r = await put(owner, { ...settings, strikes: { expireDays: 30, ladder: [{ at: 1, action: 'kick' }] } });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  r = await say(alice, 'badword');
  assert.match(String(r.error), /removed from this server/, JSON.stringify(r));
  assert.ok(!(await call('/servers', { token: T(alice) })).servers.some((s) => s.id === id), 'no longer a member');
  assert.ok(!(await call('/servers', { token: T(owner) })).servers.find((s) => s.id === id).members.some((m) => m.id === alice.user.id));
  await call('/servers/join', { method: 'POST', body: { code: sv.inviteCode }, token: T(alice) });
  assert.strictEqual((await call(`/servers/${id}/automod`, { token: T(owner) })).strikes.length, 0, 'a kicked member starts clean');
  step('a kick step removes the member');

  // exempt roles, and Manage messages
  r = await call(`/servers/${id}/roles`, { method: 'POST', body: { name: 'vip' }, token: T(owner) });
  const vipRole = r.server.roles.find((x) => x.name === 'vip').id;
  r = await call(`/servers/${id}/roles`, { method: 'POST', body: { name: 'mods', perms: ['manageMessages'] }, token: T(owner) });
  const modRole = r.server.roles.find((x) => x.name === 'mods').id;
  await call(`/servers/${id}/members/${vip.user.id}/roles`, { method: 'PUT', body: { roles: [vipRole] }, token: T(owner) });
  await call(`/servers/${id}/members/${mod.user.id}/roles`, { method: 'PUT', body: { roles: [modRole] }, token: T(owner) });
  r = await put(owner, { ...settings, exemptRoles: [vipRole, 'gone'], exemptChannels: [] });
  assert.deepStrictEqual(r.config.exemptRoles, [vipRole], 'a role that does not exist is dropped');
  assert.ok((await say(vip, 'badword')).ok, 'an exempt role is not checked');
  assert.ok((await say(mod, 'badword')).ok, 'Manage messages is not checked');
  assert.ok(String((await say(alice, 'badword')).error).includes('Message not sent'), 'everyone else is');
  r = await put(owner, { ...settings, exemptChannels: [chan] });
  assert.ok((await say(alice, 'badword in an exempt channel')).ok, 'an exempt channel is not checked');
  r = await put(owner, { ...settings, enabled: false });
  assert.ok((await say(alice, 'badword with automod off')).ok, 'off means off');
  step('exempt roles, Manage messages, exempt channels and the off switch');

  console.log('\nAll automod checks passed.');
  await cleanup();
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
