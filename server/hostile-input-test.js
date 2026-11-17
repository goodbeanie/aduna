// Hostile input: every socket event with malformed payloads, plus odd path parameters. The server must stay up and no handler may throw.
// Run: node server/hostile-input-test.js
const assert = require('assert');
const { cleanup } = require('./test-env');
const { httpServer, ready } = require('./index');
const { io: ioc } = require('socket.io-client');
const errs = {}; const origErr = console.error;
console.error = (...a) => { const m = a.join(' '); if (m.startsWith('socket handler failed')) { errs[m] = (errs[m] || 0) + 1; } else origErr(...a); };
const blob = { salt: 'a', iv: 'b', data: 'c' };
let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const reg = (u) => call('/register', { method: 'POST', body: { username: u, email: u + '@example.com', password: 'password123', publicKey: 'pk' + u, encPrivKey: blob } });
ready.then(() => httpServer.listen(0, async () => {
  base = 'http://127.0.0.1:' + httpServer.address().port;
  const a = await reg('fuzz_a'), b = await reg('fuzz_b');
  const s = await call('/servers', { method: 'POST', token: a.token, body: { name: 'S' } });
  const chan = s.server.channels[0].id;
  await call('/servers/join', { method: 'POST', token: b.token, body: { code: s.server.inviteCode } });
  const mk = (tok) => new Promise((res) => { const so = ioc(base, { auth: { token: tok }, extraHeaders: { origin: base } }); so.on('connect', () => res(so)); });
  const sa = await mk(a.token), sb = await mk(b.token);
  const m = await new Promise((r) => sa.emit('message:send', { channelId: chan, content: 'hi' }, r));
  const mid = Object.keys(require('./db').db.messages)[0];
  assert.deepStrictEqual(m, { ok: true });
  assert.deepStrictEqual(await new Promise((r) => sa.emit('reaction:toggle', { kind: 'channel', messageId: mid, emoji: '👍' }, r)), { ok: true });
  for (const e of ['toString', 'valueOf', '__proto__', 'constructor']) assert.strictEqual((await new Promise((r) => sa.emit('reaction:toggle', { kind: 'channel', messageId: mid, emoji: e }, r))).error, 'Bad emoji', e + ' is not an emoji');
  console.log('✓ plain words (toString, valueOf, ...) are refused as reactions');
  // leaving a server must also drop you from its voice channel (used to keep you in the call until you disconnected)
  const vc = await call('/servers/' + s.server.id + '/channels', { method: 'POST', token: a.token, body: { name: 'talk', type: 'voice' } });
  assert.strictEqual(vc.status, 200, 'voice channel created');
  const vid = vc.channel ? vc.channel.id : vc.server.channels.find((c) => c.type === 'voice').id;
  assert.ok((await new Promise((r) => sb.emit('voice:join', { channelId: vid }, r))).ok, 'b joined voice');
  await call('/servers/' + s.server.id + '/leave', { method: 'POST', token: b.token });
  const rejoin = await new Promise((r) => sa.emit('voice:join', { channelId: vid }, r));
  assert.deepStrictEqual(rejoin.peers, [], 'someone who left the server is no longer in its voice call');
  console.log('✓ leaving a server removes you from its voice channel');
  await call('/servers/join', { method: 'POST', token: b.token, body: { code: s.server.inviteCode } });
  const evs = ['call:accept','call:decline','call:hangup','call:invite','call:signal','dm:send','message:delete','message:edit','message:pin','message:send','poll:vote','poll:close','reaction:toggle','typing','voice:join','voice:leave','voice:signal','soundboard:play'];
  const payloads = [undefined, null, 0, 'x', [], {}, { kind: 'channel' }, { kind: 'dm' }, { kind: 'channel', messageId: mid, emoji: 'toString' }, { kind: 'channel', messageId: mid, content: {} },
    { channelId: chan, content: 123, attachments: 'x' }, { channelId: chan, content: 'a', attachments: [null] }, { channelId: chan, content: 'a', attachments: {} }, { channelId: chan, content: 'a', replyTo: {} },
    { to: b.user.id, content: {} }, { to: b.user.id, ciphertext: 5 }, { to: 'x', iv: [] }, { userId: {}, signal: 1 }, { to: {}, kind: 'channel' }, { channelId: {}, kind: 'channel' }, { kind: 'channel', channelId: chan, typing: 1 }, { kind: 'dm', userId: b.user.id },
    { channelId: chan, content: 'a', replyTo: '__proto__' }, { kind: 'channel', messageId: '__proto__', emoji: '👍' }, { kind: 'dm', messageId: 'constructor', emoji: '👍' }, { messageId: mid, pinned: true }, { messageId: '__proto__', pinned: true }];
  for (const ev of evs) for (const p of payloads) {
    await new Promise((r) => { let done = false; const fin = () => { if (!done) { done = true; r(); } }; sa.emit(ev, p, fin); setTimeout(fin, 15); });
    await new Promise((r) => { sa.emit(ev, p); setTimeout(r, 5); }); // no ack
  }
  // also with non-function ack
  for (const ev of evs) { sa.emit(ev, {}, 'notfn'); sa.emit(ev, {}, {}); }
  await new Promise((r) => setTimeout(r, 300));
  const alive = await call('/me', { token: a.token });
  assert.strictEqual(alive.status, 200); console.log('✓ server survived malformed payloads on every socket event');
  assert.deepStrictEqual(errs, {}, 'a socket handler threw: ' + JSON.stringify(errs)); console.log('✓ no handler threw');
  // http fuzz of path params
  const ids = ['constructor', '__proto__', 'toString', 'hasOwnProperty', '%00', 'a'.repeat(5000), '..%2f..%2fetc%2fpasswd'];
  const bad = [];
  for (const id of ids) for (const [m2, p] of [['GET','/users/'],['GET','/servers/'+id+'/publish'],['GET','/channels/'],['GET','/dms/'],['GET','/files/'],['GET','/images/'],['GET','/emoji/'+id+'/image'],['POST','/emoji/'+id+'/report'],['POST','/emoji/'+id+'/save'],['DELETE','/emoji/'],['GET','/invites/'],['GET','/servers/'+id+'/invite-check?code=a'],['PATCH','/servers/'],['POST','/servers/'+id+'/leave'],['POST','/friends/'+id+'/accept'],['DELETE','/friends/']]) {
    const path = p.endsWith('/') ? p + id : p;
    const tail = p.startsWith('/channels/') || p.startsWith('/dms/') ? '/messages' : '';
    const r = await fetch(base + '/api' + path + tail, { method: m2, headers: { Authorization: 'Bearer ' + a.token, 'Content-Type': 'application/json' }, body: m2 === 'GET' ? undefined : '{}' }).catch((e) => ({ status: 'ERR ' + e.message }));
    if (r.status >= 500 || r.status === 200 && path.includes('users/')) bad.push(m2 + ' ' + path.slice(0, 60) + ' -> ' + r.status);
  }
  assert.deepStrictEqual(bad, [], 'odd responses: ' + bad.join('; ')); console.log('✓ odd path parameters (constructor, __proto__, huge, encoded) give no 5xx');
  // JSON bodies: an object with a toString key used to throw inside String() and answer 500
  const obj = { toString: 'x' };
  const sid = s.server.id;
  const tries = [['/servers/join', 'POST', { code: obj }], ['/servers', 'POST', { name: obj }], ['/servers/' + sid, 'PATCH', { name: obj }], ['/servers/' + sid + '/categories', 'POST', { name: obj }],
    ['/servers/' + sid + '/channels', 'POST', { name: obj }], ['/servers/' + sid + '/roles', 'POST', { name: obj }], ['/me', 'PATCH', { displayName: obj }], ['/me', 'PATCH', { username: obj }],
    ['/me', 'PATCH', { email: obj }], ['/me', 'PATCH', { links: [{ label: obj, url: obj }] }], ['/me/device-login/lookup', 'POST', { request: obj }], ['/me/device-login/approve', 'POST', { request: obj }],
    ['/me/device-login/deny', 'POST', { request: obj }]];
  const crashed = [];
  for (const [p, m2, body] of tries) { const r = await call(p, { method: m2, token: a.token, body }); if (r.status >= 500) crashed.push(m2 + ' ' + p + ' -> ' + r.status); }
  assert.deepStrictEqual(crashed, [], 'an object body crashed: ' + crashed.join('; ')); console.log('✓ an object where text is expected is refused, never a 500');
  assert.strictEqual((await call('/servers/join', { method: 'POST', token: b.token, body: { code: 123 } })).status, 404, 'a number is not an invite code');
  // names are plain text: markup and control characters are refused, too long is an error and not a silent cut
  const html = '<img src=x onerror=alert(1)>';
  const refused = async (what, p, m2, body) => { const r = await call(p, { method: m2, token: a.token, body }); assert.strictEqual(r.status, 400, what + ' should be refused, got ' + r.status); };
  await refused('display name with markup', '/me', 'PATCH', { displayName: html });
  await refused('display name over 32', '/me', 'PATCH', { displayName: 'x'.repeat(5000) });
  await refused('display name that is not text', '/me', 'PATCH', { displayName: 5 });
  await refused('server name with markup', '/servers/' + sid, 'PATCH', { name: html });
  await refused('new server with markup', '/servers', 'POST', { name: html });
  await refused('category with markup', '/servers/' + sid + '/categories', 'POST', { name: html });
  await refused('role with markup', '/servers/' + sid + '/roles', 'POST', { name: html, color: '#ffffff' });
  await refused('role with markup and a short colour', '/servers/' + sid + '/roles', 'POST', { name: html, color: '#fff' });
  const shortRole = await call('/servers/' + sid + '/roles', { method: 'POST', token: a.token, body: { name: 'Short colour', color: '#FFF' } });
  assert.strictEqual(shortRole.status, 200, 'a 3-digit colour is accepted');
  assert.strictEqual(shortRole.server.roles.find((r) => r.name === 'Short colour').color, '#ffffff', 'and stored as 6 digits');
  await refused('link label with markup', '/me', 'PATCH', { links: [{ label: html, url: 'https://example.com' }] });
  const okName = await call('/me', { method: 'PATCH', token: a.token, body: { displayName: 'Cool Guy ✨' } });
  assert.strictEqual(okName.status, 200, 'an ordinary display name with spaces and an emoji still works');
  console.log('✓ names refuse markup and control characters, and too long is a 400');
  console.log('\nhostile-input-test: all passed');
  httpServer.close(); await cleanup(); process.exit(0);
}));
