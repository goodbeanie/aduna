// End-to-end smoke test: node server/smoke-test.js
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { webcrypto: crypto } = require('crypto');

const { rawDb, cleanup } = require('./test-env');
process.env.CALL_RING_MS = '600';
const { httpServer, ready } = require('./index');
const { io: connect } = require('socket.io-client');
const store = require('./db');

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (b) => Buffer.from(b).toString('base64');
const ub64 = (s) => Buffer.from(s, 'base64');
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const once = (s, ev) => new Promise((res) => s.once(ev, res));
const ack = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
const step = (m) => console.log('✓', m);

async function makeUser(name) {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicKey = JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y });
  const r = await call('/register', { method: 'POST', body: { username: name, password: 'password123', publicKey, encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  assert.strictEqual(r.status, 200, 'register ' + name + ' ' + JSON.stringify(r));
  return { ...r, privateKey: pair.privateKey, publicKey };
}
async function shared(priv, theirPub) {
  const pub = await crypto.subtle.importKey('jwk', JSON.parse(theirPub), ECDH, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ---- tiny image builders for the upload tests ----
const zlib = require('zlib');
const { sniffImage } = require('./images');
function crc32(buf) { let crc = 0xffffffff; for (const byte of buf) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) { const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }
function makePng(w, h, { text, headerOnly } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = headerOnly ? Buffer.alloc(0) : Buffer.alloc((w * 3 + 1) * h, 0x7f);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), ...(text ? [pngChunk('tEXt', Buffer.from('Comment\0' + text, 'latin1'))] : []), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
function makeJpeg(w, h) {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
function riff(chunk) { const b = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunk]); const hd = Buffer.alloc(8); hd.write('RIFF', 0, 'latin1'); hd.writeUInt32LE(b.length, 4); return Buffer.concat([hd, b]); }
function makeWebpX(w, h) { const c = Buffer.alloc(18); c.write('VP8X', 0, 'latin1'); c.writeUInt32LE(10, 4); c.writeUIntLE(w - 1, 12, 3); c.writeUIntLE(h - 1, 15, 3); return riff(c); }
function makeWebpL(w, h) { const c = Buffer.alloc(18); c.write('VP8L', 0, 'latin1'); c.writeUInt32LE(10, 4); c[8] = 0x2f; c.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 9); return riff(c); }
function makeWebpLossy(w, h) { const c = Buffer.alloc(18); c.write('VP8 ', 0, 'latin1'); c.writeUInt32LE(10, 4); c[11] = 0x9d; c[12] = 0x01; c[13] = 0x2a; c.writeUInt16LE(w, 14); c.writeUInt16LE(h, 16); return riff(c); }
async function putImg(kind, body, type, token) {
  const r = await fetch(base + '/api/me/' + kind, { method: 'PUT', headers: { 'Content-Type': type, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://localhost:' + httpServer.address().port;

  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  step('registered two users');

  assert.strictEqual((await call('/register', { method: 'POST', body: { username: 'ALICE', password: 'password123', publicKey: 'x', encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } })).status, 409);
  assert.strictEqual((await call('/login', { method: 'POST', body: { username: 'alice', password: 'wrongpass' } })).status, 401);
  assert.strictEqual((await call('/login', { method: 'POST', body: { username: 'alice', password: 'password123' } })).status, 200);
  assert.strictEqual((await call('/me')).status, 401);
  step('duplicate names, bad password and missing token are rejected');

  const sa = connect(base, { auth: { token: alice.token } });
  const sb = connect(base, { auth: { token: bob.token } });
  await Promise.all([once(sa, 'connect'), once(sb, 'connect')]);
  const bad = connect(base, { auth: { token: 'nope' } });
  await once(bad, 'connect_error'); bad.close();
  step('sockets connect; bad token refused');

  // channel chat
  assert.strictEqual((await call('/servers', { token: alice.token })).servers.length, 0);
  assert.strictEqual((await call('/servers', { token: bob.token })).servers.length, 0);
  step('new accounts start in no servers (no default server)');

  const { server: hub } = await call('/servers', { method: 'POST', token: alice.token, body: { name: 'Hub' } });
  await call('/servers/join', { method: 'POST', token: bob.token, body: { code: hub.inviteCode } });
  const general = hub.channels[0];
  let got = once(sb, 'message:new');
  assert.ok((await ack(sa, 'message:send', { channelId: general.id, content: 'hello bob' })).ok);
  const m1 = await got;
  assert.strictEqual(m1.content, 'hello bob');
  got = once(sa, 'message:new');
  await ack(sb, 'message:send', { channelId: general.id, content: 'hi alice', replyTo: m1.id });
  assert.strictEqual((await got).replyTo, m1.id);
  step('channel messages and replies delivered in real time');

  // reactions
  let ru = once(sa, 'reaction:update');
  await ack(sb, 'reaction:toggle', { kind: 'channel', messageId: m1.id, emoji: '👍' });
  assert.deepStrictEqual((await ru).reactions, { '👍': [bob.user.id] });
  ru = once(sa, 'reaction:update');
  await ack(sb, 'reaction:toggle', { kind: 'channel', messageId: m1.id, emoji: '👍' });
  assert.deepStrictEqual((await ru).reactions, {});
  step('reactions toggle on and off');

  // friend requests
  const dummy = { ciphertext: 'x', iv: 'y' };
  assert.ok((await ack(sa, 'dm:send', { to: bob.user.id, ...dummy })).error, 'DM before friending must fail');
  const fReq = (tok, username) => call('/friends/request', { method: 'POST', token: tok, body: { username } });
  assert.strictEqual((await fReq(alice.token, 'alice')).status, 400);
  assert.strictEqual((await fReq(alice.token, 'nobody_here')).status, 404);
  let changed = once(sb, 'friends:changed');
  const sent = await fReq(alice.token, '@Bob');
  assert.strictEqual(sent.status, 200); assert.strictEqual(sent.result, 'sent'); assert.strictEqual(sent.user.username, 'bob');
  await changed;
  assert.strictEqual((await fReq(alice.token, 'bob')).status, 400);
  const bobView = await call('/friends', { token: bob.token });
  assert.strictEqual(bobView.incoming.length, 1); assert.strictEqual(bobView.incoming[0].user.id, alice.user.id);
  assert.strictEqual((await call('/friends', { token: alice.token })).outgoing.length, 1);
  assert.strictEqual((await call(`/friends/${bob.user.id}/accept`, { method: 'POST', token: alice.token })).status, 404, 'sender cannot accept own request');
  assert.ok((await ack(sb, 'dm:send', { to: alice.user.id, ...dummy })).error, 'pending request is not friendship');
  changed = once(sa, 'friends:changed');
  assert.strictEqual((await call(`/friends/${alice.user.id}/accept`, { method: 'POST', token: bob.token })).status, 200);
  await changed;
  assert.strictEqual((await call('/friends', { token: alice.token })).friends[0].id, bob.user.id);
  assert.strictEqual((await call('/friends', { token: bob.token })).friends[0].id, alice.user.id);
  step('friend requests: send, pending, accept; DMs blocked until friends');

  // E2EE DM
  const secret = 'meet at 9, the password is hunter2';
  const ka = await shared(alice.privateKey, bob.publicKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ka, enc.encode(secret)));
  const dmGot = once(sb, 'dm:new');
  assert.ok((await ack(sa, 'dm:send', { to: bob.user.id, ciphertext: ct, iv: b64(iv) })).ok);
  const dm = await dmGot;
  const kb = await shared(bob.privateKey, alice.publicKey);
  const plain = dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(dm.iv) }, kb, ub64(dm.ciphertext)));
  assert.strictEqual(plain, secret);
  step('bob decrypted the DM with his own derived key');

  // edit + delete
  const iv2 = crypto.getRandomValues(new Uint8Array(12));
  const ct2 = b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv2 }, ka, enc.encode('edited text')));
  assert.ok((await ack(sb, 'message:edit', { kind: 'dm', messageId: dm.id, ciphertext: ct2, iv: b64(iv2) })).error, 'recipient cannot edit sender\'s DM');
  const edited = once(sb, 'message:edited');
  assert.ok((await ack(sa, 'message:edit', { kind: 'dm', messageId: dm.id, ciphertext: ct2, iv: b64(iv2) })).ok);
  const ed = (await edited).message;
  assert.ok(ed.editedAt && ed.ciphertext === ct2);
  assert.ok((await ack(sb, 'message:delete', { kind: 'dm', messageId: dm.id })).error, 'recipient cannot delete sender\'s DM');
  const deleted = once(sb, 'message:deleted');
  assert.ok((await ack(sa, 'message:delete', { kind: 'dm', messageId: dm.id })).ok);
  assert.strictEqual((await deleted).messageId, dm.id);
  assert.strictEqual((await call(`/dms/${bob.user.id}/messages`, { token: alice.token })).messages.length, 0);
  assert.ok((await ack(sa, 'dm:send', { to: bob.user.id, ciphertext: ct, iv: b64(iv) })).ok); // keep one DM for later checks
  step('DM edit/delete: only the author can; both sides are notified');

  // channel message + everything else must be unreadable on disk too
  const { server: gs } = await call('/servers', { method: 'POST', token: alice.token, body: { name: 'Vault Club' } });
  assert.ok((await ack(sa, 'message:send', { channelId: gs.channels[0].id, content: 'channel secret: pineapple-42' })).ok);

  await store.flush();
  const raw = await rawDb();
  assert.ok((await store.query('SELECT count(*)::int AS n FROM users')).rows[0].n >= 1, 'expected rows in Postgres');
  for (const needle of ['hunter2', 'meet at 9', 'pineapple-42', 'attachment-marker-xyzzy', 'dm-file-marker-plugh', 'alice', 'Vault Club', '$2a$', '$2b$', ct])
    assert.ok(!raw.includes(needle), `plaintext "${needle}" leaked to disk`);
  step('database file holds no readable usernames, password hashes, channel messages or DMs');

  // custom emoji
  const makeGif = (w, h, { comment = '', frames = 1 } = {}) => {
    const lsd = Buffer.alloc(7); lsd.writeUInt16LE(w, 0); lsd.writeUInt16LE(h, 2); lsd[4] = 0x80;
    const parts = [Buffer.from('GIF89a'), lsd, Buffer.from([0, 0, 0, 255, 255, 255])];
    if (comment) parts.push(Buffer.from([0x21, 0xfe, comment.length]), Buffer.from(comment, 'latin1'), Buffer.from([0]));
    if (frames > 1) parts.push(Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0]));
    for (let i = 0; i < frames; i++) {
      parts.push(Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]));
      const d = Buffer.alloc(10); d[0] = 0x2c; d.writeUInt16LE(w, 5); d.writeUInt16LE(h, 7);
      parts.push(d, Buffer.from([2, 3, 0x44, 0x01 + i, 0x05, 0]));
    }
    parts.push(Buffer.from([0x3b]));
    return Buffer.concat(parts);
  };
  const putEmoji = async (token, name, bytes, type = 'image/png') => {
    const r = await fetch(`${base}/api/emoji?name=${encodeURIComponent(name)}`, { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': type }, body: bytes });
    return { status: r.status, ...(await r.json()) };
  };
  const ePng = makePng(64, 64, { text: 'emoji-exif-secret' });
  const e1 = await putEmoji(alice.token, 'party_cat', ePng);
  assert.strictEqual(e1.status, 200); assert.strictEqual(e1.emoji.mine, true);
  const eImg = await fetch(`${base}/api/emoji/${e1.emoji.id}/image`);
  assert.strictEqual(eImg.status, 200); assert.strictEqual(eImg.headers.get('content-type'), 'image/png');
  const ea = await makeUser('emoji_a'), eb = await makeUser('emoji_b'); // the upload limiter is per user
  for (const [label, name, bytes, type, code, who] of [
    ['bad name', 'Bad Name!', makePng(32, 32), 'image/png', 400],
    ['blocked word', 'n1gger', makePng(40, 40), 'image/png', 400],
    ['blocked word with filler', 'xx_n4zi_xx', makePng(41, 41), 'image/png', 400],
    ['too small', 'tiny', makePng(8, 8), 'image/png', 400],
    ['too big', 'huge', makePng(600, 600), 'image/png', 400],
    ['not square', 'wide', makePng(300, 50), 'image/png', 400],
    ['svg', 'vector', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png', 400],
    ['html as png', 'sneaky', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png', 400],
    ['truncated gif', 'brokengif', makeGif(32, 32).subarray(0, 40), 'image/gif', 400],
    ['svg content type', 'svgtype', makePng(32, 32), 'image/svg+xml', 400],
    ['oversized', 'bigfile', Buffer.concat([makePng(64, 64), Buffer.alloc(300 * 1024)]), 'image/png', 413],
  ].map((row, i) => [...row, i < 7 ? ea : eb])) assert.strictEqual((await putEmoji(who.token, name, bytes, type)).status, code, `emoji check should refuse: ${label}`);
  for (const [i, n] of ['cucumber', 'scumbag', 'cocktail'].entries()) assert.strictEqual((await putEmoji(eb.token, n, makePng(20 + i, 20 + i))).status, 200, `harmless name ${n} is allowed`);
  assert.strictEqual((await putEmoji(alice.token, 'party_cat', makePng(50, 50))).status, 409, 'name taken in your own list');
  const dupe = await putEmoji(bob.token, 'my_copy', ePng);
  assert.strictEqual(dupe.status, 409); assert.strictEqual(dupe.existing.id, e1.emoji.id, 'identical image is detected');
  const g = await putEmoji(alice.token, 'dancing', makeGif(32, 32, { comment: 'GPS-LEAK-12345', frames: 3 }), 'image/gif');
  assert.strictEqual(g.status, 200); assert.strictEqual(g.emoji.animated, true);
  const gifBack = Buffer.from(await (await fetch(`${base}/api/emoji/${g.emoji.id}/image`)).arrayBuffer());
  assert.ok(!gifBack.toString('latin1').includes('GPS-LEAK'), 'GIF comments are stripped');
  assert.ok(gifBack.toString('latin1').includes('NETSCAPE2.0'), 'GIF loop info is kept');
  const saved = await call(`/emoji/${e1.emoji.id}/save`, { method: 'POST', token: bob.token });
  assert.strictEqual(saved.status, 200); assert.strictEqual(saved.emoji.mine, false);
  assert.strictEqual((await call('/emoji/mine', { token: bob.token })).emoji.length, 1);
  assert.strictEqual((await call(`/emoji/${e1.emoji.id}/report`, { method: 'POST', token: alice.token })).status, 400, 'cannot report your own');
  // reactions with a custom emoji
  await call('/servers/join', { method: 'POST', token: bob.token, body: { code: gs.inviteCode } });
  const eMsg = once(sa, 'message:new');
  await new Promise((r) => setTimeout(r, 5200));
  assert.ok((await ack(sa, 'message:send', { channelId: gs.channels[0].id, content: `hi <:party_cat:${e1.emoji.id}>` })).ok);
  const em = await eMsg;
  const rx = once(sb, 'reaction:update');
  assert.ok((await ack(sb, 'reaction:toggle', { kind: 'channel', messageId: em.id, emoji: 'c:' + e1.emoji.id })).ok);
  assert.deepStrictEqual((await rx).reactions['c:' + e1.emoji.id], [bob.user.id]);
  assert.ok((await ack(sb, 'reaction:toggle', { kind: 'channel', messageId: em.id, emoji: 'c:' + '0'.repeat(16) })).error, 'unknown custom emoji refused');
  // reports from enough different people switch it off, and the same picture cannot come back
  const rep1 = await makeUser('rep1'), rep2 = await makeUser('rep2');
  assert.strictEqual((await call(`/emoji/${e1.emoji.id}/report`, { method: 'POST', token: bob.token })).disabled, false);
  assert.strictEqual((await call(`/emoji/${e1.emoji.id}/report`, { method: 'POST', token: rep1.token })).disabled, false);
  assert.strictEqual((await call(`/emoji/${e1.emoji.id}/report`, { method: 'POST', token: rep2.token })).disabled, true);
  assert.strictEqual((await fetch(`${base}/api/emoji/${e1.emoji.id}/image`)).status, 404, 'disabled emoji is no longer served');
  assert.strictEqual((await call('/emoji/mine', { token: alice.token })).emoji.some((x) => x.id === e1.emoji.id), false);
  assert.match((await putEmoji(eb.token, 'again', ePng)).error, /removed after reports/);
  assert.ok((await ack(sb, 'reaction:toggle', { kind: 'channel', messageId: em.id, emoji: 'c:' + e1.emoji.id })).error, 'cannot react with a disabled emoji');
  const gdel = await call(`/emoji/${g.emoji.id}`, { method: 'DELETE', token: alice.token });
  assert.strictEqual(gdel.status, 200); assert.strictEqual((await fetch(`${base}/api/emoji/${g.emoji.id}/image`)).status, 404);
  step('custom emoji: format/size/shape/name checks, GIF cleaning, duplicates, save, reactions, reports and re-upload block');

  // history endpoints + access control
  const hist = await call(`/dms/${bob.user.id}/messages`, { token: alice.token });
  assert.strictEqual(hist.messages.length, 1);
  const carol = await makeUser('carol');
  // attachments (pause so the socket flood limit of 8 events / 5s does not interfere)
  const pause = () => new Promise((r) => setTimeout(r, 5200));
  await pause();
  const upload = async (token, kind, target, bytes) => {
    const r = await fetch(`${base}/api/files?kind=${kind}&target=${target}`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }, body: bytes });
    return { status: r.status, ...(await r.json()) };
  };
  const getFile = (token, id) => fetch(`${base}/api/files/${id}`, { headers: { Authorization: 'Bearer ' + token } });
  const cid = gs.channels[0].id;
  const fmarker = Buffer.from('attachment-fmarker-xyzzy-' + 'x'.repeat(200));
  const fup = await upload(alice.token, 'channel', cid, fmarker);
  assert.strictEqual(fup.status, 200);
  assert.strictEqual((await getFile(alice.token, fup.id)).status, 200, 'owner can read own pending upload');
  assert.strictEqual((await getFile(bob.token, fup.id)).status, 404, 'others cannot read a pending upload');
  assert.strictEqual((await upload(ea.token, 'channel', cid, fmarker)).status, 403, 'non-members cannot upload to a channel');
  assert.strictEqual((await upload(alice.token, 'channel', cid, Buffer.alloc(21 * 1024 * 1024, 1))).status, 413, 'oversized file refused');
  assert.strictEqual((await ack(sa, 'message:send', { channelId: cid, content: '', attachments: [{ id: fup.id }, { id: fup.id }] })).error, 'Bad attachment', 'same file twice refused');
  assert.strictEqual((await ack(sa, 'message:send', { channelId: cid, content: '', attachments: [{ id: 'f'.repeat(32) }] })).error, 'Bad attachment');
  assert.strictEqual((await ack(sa, 'message:send', { channelId: cid, content: 'x', attachments: [{ gif: true, url: 'https://evil.example/x.gif', w: 10, h: 10 }] })).error, 'Bad attachment', 'GIFs only from the GIF host');
  const got1 = once(sa, 'message:new');
  assert.ok((await ack(sa, 'message:send', { channelId: cid, content: '', attachments: [{ id: fup.id, name: 'notes.txt', type: 'text/html' }, { gif: true, url: 'https://media2.giphy.com/media/abc/200.gif', w: 200, h: 100, title: 'ok' }] })).ok, 'attachment-only message allowed');
  const am = await got1;
  assert.strictEqual(am.attachments[0].type, 'application/octet-stream', 'unknown types are never rendered inline');
  assert.strictEqual(am.attachments[0].size, fmarker.length);
  assert.strictEqual((await ack(sa, 'message:send', { channelId: cid, content: 'reuse', attachments: [{ id: fup.id }] })).error, 'Bad attachment', 'a file belongs to one message');
  assert.strictEqual((await getFile(alice.token, fup.id)).status, 200);
  const dlRes = await getFile(alice.token, fup.id);
  assert.strictEqual(dlRes.headers.get('content-type'), 'application/octet-stream');
  assert.ok(Buffer.from(await dlRes.arrayBuffer()).equals(fmarker));
  assert.strictEqual((await getFile(carol.token, fup.id)).status, 404, 'non-members cannot download');
  const sharedPrivate = await call('/servers/join', { method: 'POST', token: bob.token, body: { code: gs.inviteCode } });
  assert.strictEqual((await getFile(bob.token, fup.id)).status, 200, 'members can download');
  await pause();
  // DM files: bytes are ciphertext chosen by the browser
  const dmBytes = Buffer.from('dm-file-fmarker-plugh-' + 'y'.repeat(200));
  const dup = await upload(alice.token, 'dm', bob.user.id, dmBytes);
  assert.strictEqual(dup.status, 200);
  assert.strictEqual((await upload(carol.token, 'dm', bob.user.id, dmBytes)).status, 403, 'non-friends cannot upload into a DM');
  assert.strictEqual((await getFile(carol.token, dup.id)).status, 404);
  assert.strictEqual((await ack(sa, 'dm:send', { to: bob.user.id, ciphertext: ct, iv: b64(iv), files: [fup.id] })).error, 'Bad attachment', 'channel file cannot be sent in a DM');
  const dmFileMsg = once(sb, 'dm:new');
  assert.ok((await ack(sa, 'dm:send', { to: bob.user.id, ciphertext: ct, iv: b64(iv), files: [dup.id] })).ok);
  const dfm = await dmFileMsg;
  assert.strictEqual((await getFile(bob.token, dup.id)).status, 200, 'recipient can download DM file');
  const delFile = once(sb, 'message:deleted');
  assert.ok((await ack(sa, 'message:delete', { kind: 'dm', messageId: dfm.id })).ok);
  await delFile;
  assert.strictEqual((await getFile(alice.token, dup.id)).status, 404, 'deleting a message deletes its files');
  assert.strictEqual((await call('/gifs/config', { token: alice.token })).enabled, false);
  await store.flush();
  const rawFiles = await rawDb();
  assert.ok(!rawFiles.includes('attachment-marker-xyzzy'), 'attachment bytes leaked to disk');
  step('attachments: scoped uploads, one-message-per-file, GIF host check, access control, cleanup on delete, encrypted at rest');

  // calls
  const reasonOf = (sock, r) => new Promise((res) => { const h = (e) => { if (e.reason === r) { sock.off('call:ended', h); res(e); } }; sock.on('call:ended', h); });
  const callee = connect(base, { auth: { token: bob.token } });
  await once(callee, 'connect');
  const callerSock = connect(base, { auth: { token: alice.token } });
  await once(callerSock, 'connect');
  const cs = connect(base, { auth: { token: carol.token } });
  await once(cs, 'connect');
  assert.ok((await ack(callerSock, 'call:invite', { to: carol.user.id, video: true })).error, 'only friends can be called');
  const incP = once(callee, 'call:incoming');
  const inv1 = await ack(callerSock, 'call:invite', { to: bob.user.id, video: true });
  assert.ok(inv1.ok && inv1.callId);
  const incoming = await incP;
  assert.strictEqual(incoming.from, alice.user.id); assert.strictEqual(incoming.video, true);
  assert.ok((await ack(callerSock, 'call:invite', { to: bob.user.id })).error, 'caller cannot start a second call');
  const bobOther = connect(base, { auth: { token: bob.token } }); await once(bobOther, 'connect');
  const callHandled = once(bobOther, 'call:handled');
  const callAccepted = once(callerSock, 'call:accepted');
  assert.ok((await ack(cs, 'call:accept', { callId: inv1.callId })).error, 'a stranger cannot answer');
  assert.ok((await ack(callee, 'call:accept', { callId: inv1.callId })).ok);
  await callAccepted; await callHandled;
  const sigP = once(callee, 'call:signal');
  callerSock.emit('call:signal', { callId: inv1.callId, data: { ciphertext: 'opaque-offer', iv: 'iv1' } });
  const sigGot = await sigP;
  assert.deepStrictEqual(sigGot.data, { ciphertext: 'opaque-offer', iv: 'iv1' });
  let leaked = false; cs.once('call:signal', () => { leaked = true; });
  cs.emit('call:signal', { callId: inv1.callId, data: { ciphertext: 'x', iv: 'y' } });
  callerSock.emit('call:signal', { callId: inv1.callId, data: { ciphertext: 7, iv: 'y' } });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!leaked, 'signals only reach the other participant');
  assert.ok((await ack(cs, 'call:invite', { to: bob.user.id })).error, 'non-friends cannot call');
  const callEnded = reasonOf(callerSock, 'hangup');
  callee.emit('call:hangup', { callId: inv1.callId });
  assert.strictEqual((await callEnded).reason, 'hangup');
  // decline, cancel and missed
  let e2 = reasonOf(callerSock, 'declined');
  const incP2 = once(callee, 'call:incoming');
  const inv2 = await ack(callerSock, 'call:invite', { to: bob.user.id });
  await incP2; callee.emit('call:decline', { callId: inv2.callId });
  assert.strictEqual((await e2).reason, 'declined');
  e2 = reasonOf(callee, 'cancelled');
  const inv3 = await ack(callerSock, 'call:invite', { to: bob.user.id });
  callerSock.emit('call:hangup', { callId: inv3.callId });
  assert.strictEqual((await e2).reason, 'cancelled');
  e2 = reasonOf(callerSock, 'missed');
  await ack(callerSock, 'call:invite', { to: bob.user.id });
  assert.strictEqual((await e2).reason, 'missed', 'unanswered calls time out');
  // dropping the connection ends the call (fresh friends with a single socket each)
  const px = await makeUser('callx'), py = await makeUser('callyy');
  store.db.friendships[[px.user.id, py.user.id].sort().join(':')] = { from: px.user.id, to: py.user.id, status: 'friends', createdAt: Date.now() };
  assert.ok((await ack(callerSock, 'call:invite', { to: py.user.id })).error, 'not friends with them');
  const sx = connect(base, { auth: { token: px.token } }); await once(sx, 'connect');
  assert.ok((await ack(sx, 'call:invite', { to: py.user.id })).error, 'offline friends cannot be called');
  const sy = connect(base, { auth: { token: py.token } }); await once(sy, 'connect');
  const ring = once(sy, 'call:incoming');
  const inv4 = await ack(sx, 'call:invite', { to: py.user.id });
  await ring; await ack(sy, 'call:accept', { callId: inv4.callId });
  e2 = reasonOf(sx, 'dropped');
  sy.close();
  assert.strictEqual((await e2).reason, 'dropped');
  sx.close();
  callee.close(); bobOther.close(); callerSock.close(); cs.close();
  step('calls: friends only, ringing, accept on one device, opaque signal relay, decline/cancel/missed/dropped');

  assert.strictEqual((await call(`/dms/${bob.user.id}/messages`, { token: carol.token })).messages.length, 0);
  const rLeak = await call(`/dms/${alice.user.id}/messages`, { token: carol.token });
  assert.strictEqual(rLeak.messages.length, 0);
  const sc = connect(base, { auth: { token: carol.token } });
  await once(sc, 'connect');
  assert.ok((await ack(sc, 'reaction:toggle', { kind: 'dm', messageId: dm.id, emoji: '👀' })).error);
  sc.close();
  step('third parties cannot read or react to someone else\'s DMs');

  // private servers
  const { server: priv } = await call('/servers', { method: 'POST', token: alice.token, body: { name: 'Secret Club' } });
  assert.strictEqual((await call(`/channels/${priv.channels[0].id}/messages`, { token: bob.token })).status, 403);
  assert.ok((await ack(sb, 'message:send', { channelId: priv.channels[0].id, content: 'let me in' })).error);
  const joined = await call('/servers/join', { method: 'POST', token: bob.token, body: { code: priv.inviteCode } });
  assert.strictEqual(joined.server.members.length, 2);
  assert.strictEqual((await call(`/servers/${priv.id}/channels`, { method: 'POST', token: bob.token, body: { name: 'nope' } })).status, 403);
  const ch = await call(`/servers/${priv.id}/channels`, { method: 'POST', token: alice.token, body: { name: 'Game Night!' } });
  assert.strictEqual(ch.server.channels[1].name, 'game-night');
  step('server membership, invites and owner-only channels enforced');
  // categories + custom invite codes
  assert.strictEqual((await call(`/servers/${priv.id}/categories`, { method: 'POST', token: bob.token, body: { name: 'Nope' } })).status, 403);
  const catRes = await call(`/servers/${priv.id}/categories`, { method: 'POST', token: alice.token, body: { name: 'Games' } });
  assert.strictEqual(catRes.server.categories.length, 1);
  assert.strictEqual((await call(`/servers/${priv.id}/categories`, { method: 'POST', token: alice.token, body: { name: 'games' } })).status, 400, 'duplicate category');
  const catId = catRes.server.categories[0].id;
  assert.strictEqual((await call(`/servers/${priv.id}/channels`, { method: 'POST', token: alice.token, body: { name: 'bad', categoryId: 'nope' } })).status, 400);
  const inCat = await call(`/servers/${priv.id}/channels`, { method: 'POST', token: alice.token, body: { name: 'chess', categoryId: catId } });
  assert.strictEqual(inCat.server.channels.find((c) => c.name === 'chess').categoryId, catId);
  assert.strictEqual(inCat.server.channels[0].categoryId, undefined, 'older channels stay ungrouped');
  const ivan = await makeUser('ivan');
  const { server: other } = await call('/servers', { method: 'POST', token: alice.token, body: { name: 'Other Place' } });
  const oldCode = priv.inviteCode;
  assert.strictEqual((await call(`/servers/${priv.id}/invite-check?code=my-crew`, { token: bob.token })).status, 403);
  assert.strictEqual((await call(`/servers/${priv.id}/invite-check?code=my-crew`, { token: alice.token })).available, true);
  assert.strictEqual((await call(`/servers/${priv.id}/invite-check?code=ab`, { token: alice.token })).available, false);
  assert.strictEqual((await call(`/servers/${priv.id}`, { method: 'PATCH', token: alice.token, body: { inviteCode: 'My-Crew' } })).server.inviteCode, 'my-crew');
  assert.strictEqual((await call('/servers/join', { method: 'POST', token: ivan.token, body: { code: oldCode } })).status, 404, 'old code stops working');
  assert.strictEqual((await call('/servers/join', { method: 'POST', token: ivan.token, body: { code: 'MY-CREW' } })).status, 200);
  const taken = await call(`/servers/${other.id}`, { method: 'PATCH', token: alice.token, body: { name: 'Should not stick', inviteCode: 'my-crew' } });
  assert.strictEqual(taken.status, 409);
  assert.notStrictEqual((await call('/servers', { token: alice.token })).servers.find((x) => x.id === other.id).name, 'Should not stick', 'failed save changes nothing');
  assert.strictEqual((await call(`/servers/${other.id}/invite-check?code=my-crew`, { token: alice.token })).available, false);
  const info = await call('/invites/my-crew', { token: ivan.token });
  assert.strictEqual(info.invite.name, priv.name);
  assert.strictEqual((await call('/invites/nothing-here', { token: ivan.token })).status, 404);
  step('categories and custom invite codes');

  // accounts without keys can set them up once, and only once
  const dave = await makeUser('dave');
  delete store.db.users[dave.user.id].publicKey; delete store.db.users[dave.user.id].encPrivKey;
  const keys = { publicKey: bob.publicKey, encPrivKey: { salt: 'a', iv: 'b', data: 'c' } };
  assert.strictEqual((await call('/me/keys', { method: 'PUT', token: dave.token, body: keys })).status, 200);
  assert.strictEqual((await call('/me/keys', { method: 'PUT', token: dave.token, body: keys })).status, 409);
  step('keyless accounts can set up encryption keys once');

  // non-friends cannot DM, and requests cross-accept
  const sc2 = connect(base, { auth: { token: carol.token } });
  await once(sc2, 'connect');
  assert.ok((await ack(sc2, 'dm:send', { to: bob.user.id, ...dummy })).error);
  sc2.close();
  const cr = await fReq(carol.token, 'dave'); assert.strictEqual(cr.status, 200); assert.strictEqual((await call('/friends', { token: dave.token })).incoming.length, 1);
  const crossed = await fReq(dave.token, 'carol'); assert.strictEqual(crossed.status, 200); assert.strictEqual(crossed.result, 'friends');
  assert.strictEqual((await call('/friends', { token: carol.token })).friends.length, 1);
  assert.strictEqual((await call(`/friends/${dave.user.id}`, { method: 'DELETE', token: carol.token })).status, 200);
  assert.strictEqual((await call('/friends', { token: dave.token })).friends.length, 0);
  assert.strictEqual((await call(`/friends/${dave.user.id}`, { method: 'DELETE', token: carol.token })).status, 404);
  step('requests cross-accept, unfriend works, non-friends cannot DM');

  // profile customization
  const up = await call('/me', { method: 'PATCH', token: alice.token, body: { displayName: 'Alice ✨', bio: 'hi', avatarEmoji: '🦊', accentColor: '#ff00aa', bannerColor: 'not-a-color', status: 'dnd' } });
  assert.strictEqual(up.user.displayName, 'Alice ✨');
  assert.strictEqual(up.user.accentColor, '#ff00aa');
  assert.notStrictEqual(up.user.bannerColor, 'not-a-color');
  assert.strictEqual(up.user.status, 'dnd');
  step('profile customization saved; invalid colour ignored');

  // ---- profile pictures and banners ----
  // header parsing for each format
  for (const [name, buf, w, h] of [['png', makePng(64, 32), 64, 32], ['jpeg', makeJpeg(300, 200), 300, 200], ['webp (VP8X)', makeWebpX(1200, 300), 1200, 300], ['webp (VP8L)', makeWebpL(256, 256), 256, 256], ['webp (VP8)', makeWebpLossy(640, 480), 640, 480]]) {
    const info = sniffImage(buf);
    assert.ok(info, name + ' should be recognised');
    assert.deepStrictEqual([info.width, info.height], [w, h], name + ' dimensions');
  }
  for (const [name, buf] of [['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')], ['html', Buffer.from('<html><script>alert(1)</script></html>')], ['gif', Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')], ['empty', Buffer.alloc(0)], ['truncated png', makePng(8, 8).subarray(0, 20)], ['random', require('crypto').randomBytes(200)]])
    assert.strictEqual(sniffImage(buf), null, name + ' must be rejected');
  step('image sniffer reads PNG/JPEG/WebP headers and rejects SVG, HTML, GIF, truncated and random data');

  const marker = 'PICTURE-MARKER-' + Date.now();
  const png1 = makePng(64, 64, { text: marker });
  const firstUp = await putImg('avatar', png1, 'image/png', alice.token);
  assert.strictEqual(firstUp.status, 200, JSON.stringify(firstUp));
  const avatarId = firstUp.user.avatarImage;
  assert.ok(/^[0-9a-f]{32}$/.test(avatarId), 'unguessable 128-bit id');
  const imgRes = await fetch(base + '/api/images/' + avatarId); // plain <img> request: no Authorization header
  assert.strictEqual(imgRes.status, 200);
  assert.strictEqual(imgRes.headers.get('content-type'), 'image/png');
  assert.strictEqual(imgRes.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(/immutable/.test(imgRes.headers.get('cache-control')));
  assert.ok(Buffer.from(await imgRes.arrayBuffer()).equals(png1), 'image comes back byte-for-byte');
  assert.strictEqual((await call('/users/' + alice.user.id, { token: bob.token })).user.avatarImage, avatarId, 'other users see the picture');
  assert.strictEqual((await fetch(base + '/api/images/' + '0'.repeat(32))).status, 404);
  assert.strictEqual((await fetch(base + '/api/images/..%2f..%2fetc%2fpasswd')).status, 404);
  step('avatar upload works and is served to everyone');

  // replacing deletes the old file; the new one gets a new URL
  const secondUp = await putImg('avatar', makeJpeg(256, 256), 'image/jpeg', alice.token);
  assert.strictEqual(secondUp.status, 200);
  assert.notStrictEqual(secondUp.user.avatarImage, avatarId);
  assert.strictEqual((await fetch(base + '/api/images/' + avatarId)).status, 404, 'old image is deleted');
  assert.strictEqual((await fetch(base + '/api/images/' + secondUp.user.avatarImage)).headers.get('content-type'), 'image/jpeg');
  const bannerUp = await putImg('banner', makeWebpX(1200, 300), 'image/webp', alice.token);
  assert.strictEqual(bannerUp.status, 200);
  assert.ok(bannerUp.user.bannerImage && bannerUp.user.avatarImage === secondUp.user.avatarImage, 'banner is independent of avatar');
  step('replacing a picture deletes the old one; banner upload works');

  // image bytes are encrypted on disk, like everything else
  await store.flush();
  const rawImg = await rawDb();
  assert.ok(!rawImg.includes(marker), 'uploaded image bytes must not appear in plaintext in the database');
  step('uploaded image bytes are encrypted at rest');

  // removing
  const removed = await call('/me/avatar', { method: 'DELETE', token: alice.token });
  assert.strictEqual(removed.user.avatarImage, null);
  assert.strictEqual((await fetch(base + '/api/images/' + secondUp.user.avatarImage)).status, 404);
  assert.strictEqual((await call('/me/avatar', { method: 'DELETE', token: alice.token })).status, 200, 'removing twice is harmless');
  step('removing a picture works');

  // bad uploads are refused (using bob so alice keeps her upload allowance)
  assert.strictEqual((await putImg('avatar', makePng(8, 8), 'image/png', null)).status, 401);
  const refusedCases = [
    ['html pretending to be a png', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png'],
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'],
    ['png sent as text/plain', makePng(8, 8), 'text/plain'],
    ['huge dimensions in a tiny file', makePng(5000, 5000, { headerOnly: true }), 'image/png'],
    ['avatar over 2048px', makePng(3000, 3000, { headerOnly: true }), 'image/png'],
  ];
  for (const [name, body, type] of refusedCases) {
    const r = await putImg('avatar', body, type, bob.token);
    assert.strictEqual(r.status, 400, name + ' should be refused, imgRes ' + r.status);
    assert.ok(r.error);
  }
  const oversize = await putImg('banner', Buffer.alloc(1200 * 1024, 1), 'image/png', bob.token);
  assert.strictEqual(oversize.status, 413);
  assert.ok(/too large/i.test(oversize.error), 'oversized upload gets a JSON error');
  assert.ok(!(await call('/me', { token: bob.token })).user.avatarImage, 'refused uploads change nothing');
  step('non-images, SVG, wrong types, giant dimensions and oversized files are refused');

  // rate limit: 10 uploads a minute per user
  let rateLimited = false;
  for (let i = 0; i < 12 && !rateLimited; i++) rateLimited = (await putImg('avatar', makePng(8, 8), 'image/png', bob.token)).status === 429;
  assert.ok(rateLimited, 'upload rate limit should kick in');
  step('upload rate limit works');

  // server settings: name, icon, banner and theme are owner-only, saved, and pushed to members live
  // fresh accounts: alice and bob have used up their upload quota above
  const erin = await makeUser('erin'), frank = await makeUser('frank');
  const { server: themed } = await call('/servers', { method: 'POST', token: erin.token, body: { name: 'Themed' } });
  await call('/servers/join', { method: 'POST', token: alice.token, body: { code: themed.inviteCode } });
  await call('/servers/join', { method: 'POST', token: frank.token, body: { code: themed.inviteCode } });
  assert.strictEqual(themed.theme, null); assert.strictEqual(themed.iconImage, null); assert.strictEqual(themed.bannerImage, null);
  const putSrv = async (id, kind, body, type, token) => {
    const r = await fetch(base + `/api/servers/${id}/${kind}`, { method: 'PUT', headers: { 'Content-Type': type, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const pushed = once(sa, 'server:update');
  const th = await call(`/servers/${themed.id}`, { method: 'PATCH', token: erin.token, body: { name: '  Night Owls ', theme: { dark: true, bg: '#101820', accent: '#FFB000' } } });
  assert.strictEqual(th.status, 200);
  assert.strictEqual(th.server.name, 'Night Owls');
  assert.deepStrictEqual(th.server.theme, { dark: true, bg: '#101820', accent: '#ffb000' });
  assert.deepStrictEqual((await pushed).theme, th.server.theme, 'members get the theme live');
  assert.strictEqual((await call(`/servers/${themed.id}`, { method: 'PATCH', token: alice.token, body: { name: 'Hijacked' } })).status, 403, 'members cannot edit');
  assert.strictEqual((await call(`/servers/${themed.id}`, { method: 'PATCH', token: dave.token, body: { name: 'x' } })).status, 404, 'outsiders cannot see it');
  for (const bad of [{ dark: 'yes', bg: '#101820', accent: '#ffffff' }, { dark: true, bg: 'red', accent: '#ffffff' }, { dark: true, bg: '#101820' }, 'dark', 5]) {
    assert.strictEqual((await call(`/servers/${themed.id}`, { method: 'PATCH', token: erin.token, body: { theme: bad } })).status, 400, 'bad theme ' + JSON.stringify(bad));
  }
  assert.strictEqual((await call(`/servers/${themed.id}`, { method: 'PATCH', token: erin.token, body: { name: '   ' } })).status, 400);
  assert.deepStrictEqual((await call('/servers', { token: alice.token })).servers.find((x) => x.id === themed.id).theme, th.server.theme, 'listed with the theme');

  const icon1 = await putSrv(themed.id, 'icon', makePng(256, 256), 'image/png', erin.token);
  assert.strictEqual(icon1.status, 200);
  assert.ok(/^[0-9a-f]{32}$/.test(icon1.server.iconImage));
  assert.strictEqual((await fetch(base + '/api/images/' + icon1.server.iconImage)).status, 200);
  const banner1 = await putSrv(themed.id, 'banner', makeWebpX(960, 320), 'image/webp', erin.token);
  assert.ok(banner1.server.bannerImage && banner1.server.iconImage === icon1.server.iconImage, 'banner is independent of icon');
  const icon2 = await putSrv(themed.id, 'icon', makeJpeg(200, 200), 'image/jpeg', erin.token);
  assert.notStrictEqual(icon2.server.iconImage, icon1.server.iconImage);
  assert.strictEqual((await fetch(base + '/api/images/' + icon1.server.iconImage)).status, 404, 'old icon deleted');
  assert.strictEqual((await putSrv(themed.id, 'icon', makePng(8, 8), 'image/png', frank.token)).status, 403, 'members cannot upload');
  assert.strictEqual((await putSrv(themed.id, 'icon', makePng(8, 8), 'image/png', null)).status, 401);
  assert.strictEqual((await putSrv(themed.id, 'icon', makePng(900, 900, { headerOnly: true }), 'image/png', erin.token)).status, 400, 'icon over 512px refused');
  assert.strictEqual((await putSrv(themed.id, 'icon', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png', erin.token)).status, 400, 'not an image');
  assert.strictEqual((await call(`/servers/${themed.id}/icon`, { method: 'DELETE', token: frank.token })).status, 403);
  const noIcon = await call(`/servers/${themed.id}/icon`, { method: 'DELETE', token: erin.token });
  assert.strictEqual(noIcon.server.iconImage, null);
  assert.strictEqual((await fetch(base + '/api/images/' + icon2.server.iconImage)).status, 404, 'removed icon deleted');
  const noTheme = await call(`/servers/${themed.id}`, { method: 'PATCH', token: erin.token, body: { theme: null } });
  assert.strictEqual(noTheme.server.theme, null, 'theme can be removed');
  assert.strictEqual(noTheme.server.bannerImage, banner1.server.bannerImage, 'unrelated fields untouched');
  step('server settings: owner-only name, icon, banner and theme, validated, replaced images deleted, pushed live');

  // images no profile points at get cleaned up on start
  const orphanId = await store.putImage(makePng(8, 8));
  await store.pruneImages(new Set(Object.values(store.db.users).flatMap((u) => [u.avatarImage, u.bannerImage]).concat(Object.values(store.db.servers).flatMap((sv) => [sv.iconImage, sv.bannerImage])).filter(Boolean)));
  assert.strictEqual(await store.getImage(orphanId), null, 'orphaned image removed');
  assert.ok(await store.getImage(bannerUp.user.bannerImage), 'referenced image kept');
  step('orphaned images are pruned, referenced ones kept');

  // survives a restart: reload from Postgres and compare
  await store.flush();
  const before = JSON.stringify(store.db);
  await store.reload();
  assert.strictEqual(JSON.stringify(store.db), before);
  assert.ok(Object.values(store.db.users).some((u) => u.username === 'alice' && u.passHash.startsWith('$2')));
  step('encrypted data reloads from the database identically');

  // wrong key / missing key / tampering / secret persistence need fresh processes (the key is read at startup)
  const { spawnSync } = require('child_process');
  const here = path.join(__dirname, 'db.js');
  const probe = `const s=require(${JSON.stringify(here)});s.init().then(async()=>{console.log('SECRET:'+s.jwtSecret);await s.close();process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})`;
  const run = (env) => spawnSync(process.execPath, ['-e', probe], { env: { ...process.env, ...env }, encoding: 'utf8' });

  const same = run({});
  assert.strictEqual(same.status, 0, same.stderr);
  assert.ok(same.stdout.includes('SECRET:' + store.jwtSecret), 'the session secret is stored in the database and survives restarts');
  step('session secret persists across restarts (no JWT_SECRET needed)');

  const wrongKey = run({ DB_ENCRYPTION_KEY: 'ab'.repeat(32) });
  assert.notStrictEqual(wrongKey.status, 0);
  assert.ok(/Cannot decrypt/.test(wrongKey.stderr), 'wrong key should be refused');
  const noKey = run({ DB_ENCRYPTION_KEY: '', NODE_ENV: 'production' });
  assert.notStrictEqual(noKey.status, 0);
  assert.ok(/DB_ENCRYPTION_KEY is not set/.test(noKey.stderr), 'production must not invent a key');
  const noUrl = run({ DATABASE_URL: '' });
  assert.ok(/DATABASE_URL is not set/.test(noUrl.stderr), 'missing DATABASE_URL gives a clear error');
  step('wrong or missing master key / DATABASE_URL is refused');

  // tamper: move one row's ciphertext onto another row; GCM + AAD must reject it
  const victim = (await store.query('SELECT id, data FROM messages LIMIT 1')).rows[0];
  const donor = (await store.query('SELECT data FROM users LIMIT 1')).rows[0];
  await store.query('UPDATE messages SET data = $1 WHERE id = $2', [donor.data, victim.id]);
  const tam = run({});
  await store.query('UPDATE messages SET data = $1 WHERE id = $2', [victim.data, victim.id]);
  assert.notStrictEqual(tam.status, 0, 'tampered ciphertext should not load');
  step('ciphertext swapped between rows is detected');

  console.log('\nAll checks passed.');
  sa.close(); sb.close();
  await cleanup();
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
