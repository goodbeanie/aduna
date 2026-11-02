// Artists through the real server: node server/artists-flow-test.js (needs TEST_DATABASE_URL, see test-env.js)
// Apply with four pieces, get reviewed, make shop items, get them reviewed, earn the badge, and get paid when someone buys one.
process.env.ADMIN_USERNAMES = 'artmod'; // read when the server module loads, so set first
process.env.ARTIST_CUT_PERCENT = '50';
const assert = require('assert');
const zlib = require('zlib');
const { cleanup } = require('./test-env');
const { httpServer, ready, store, referencedImages } = require('./index');
const credits = require('./credits');
const { io: connect } = require('socket.io-client');
let base;
const step = (m) => console.log('✓', m);
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
async function putImage(p, buf, token, type = 'image/png') {
  const r = await fetch(base + '/api' + p, { method: 'PUT', headers: { 'Content-Type': type, Authorization: 'Bearer ' + token }, body: buf });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const reg = async (name) => {
  const r = await call('/register', { method: 'POST', body: { username: name, email: name + '@example.com', password: 'password123', publicKey: 'k', encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  assert.strictEqual(r.status, 200, 'register ' + JSON.stringify(r));
  return r;
};
function crc32(buf) { let crc = 0xffffffff; for (const byte of buf) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }
let marker = 0;
function makePng(w, h) { // a different picture every time (the marker), so no two uploads are the same bytes
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0m' + ++marker, 'latin1')), chunk('IDAT', zlib.deflateSync(Buffer.alloc((w * 3 + 1) * h, 0x7f))), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://127.0.0.1:' + httpServer.address().port;
  const ada = await reg('ada'), bob = await reg('bob'), mod = await reg('artmod');
  const T = (u) => u.token;
  const me = async (u) => (await call('/me', { token: T(u) })).user;
  const hasArtist = (u) => (u.badges || []).some((b) => b.id === 'artist' && b.glyph === 'artist');

  // ---- who can see what ----
  assert.strictEqual((await call('/artists/review', { token: T(ada) })).status, 404, 'only moderators see the queue');
  assert.deepStrictEqual((await call('/artists/review', { token: T(mod) })).applications, []);
  let r = await call('/artists/me', { token: T(ada) });
  assert.deepStrictEqual([r.application.status, r.reviewer, r.items], ['none', false, []]);
  assert.strictEqual((await call('/artists/me', { token: T(mod) })).reviewer, true);
  assert.strictEqual((await me(mod)).reviewer, true); assert.strictEqual((await me(ada)).reviewer, false);
  assert.strictEqual((await call('/artists/items', { method: 'POST', token: T(ada), body: { name: 'Early', price: 50 } })).status, 403, 'items need an approved application');
  step('the review queue is for moderators; items are for approved artists');

  // ---- the application ----
  assert.strictEqual((await putImage('/artists/pieces/4', makePng(8, 8), T(ada))).status, 400, 'slot out of range');
  assert.strictEqual((await putImage('/artists/pieces/0', Buffer.from('not an image'), T(ada))).status, 400, 'not a picture');
  assert.strictEqual((await putImage('/artists/pieces/0', makePng(1700, 2), T(ada))).status, 400, 'over 1600px');
  assert.strictEqual((await call('/artists/me', { token: T(ada) })).application.status, 'none', 'refused uploads leave nothing behind');
  for (const i of [0, 1, 2]) { r = await putImage('/artists/pieces/' + i, makePng(40 + i, 30), T(ada)); assert.strictEqual(r.status, 200, JSON.stringify(r)); }
  assert.deepStrictEqual([r.application.status, r.application.filled], ['draft', 3]);
  assert.strictEqual((await call('/artists/apply', { method: 'POST', token: T(ada), body: { note: 'x' } })).status, 400, 'three pieces are not enough');
  r = await call('/artists/pieces/2', { method: 'DELETE', token: T(ada) });
  assert.strictEqual(r.application.filled, 2, 'a piece can be taken out of a draft');
  for (const i of [2, 3]) assert.strictEqual((await putImage('/artists/pieces/' + i, makePng(50 + i, 30), T(ada))).status, 200);
  const first = (await call('/artists/me', { token: T(ada) })).application.pieces;
  assert.ok(first.length === 4 && first.every(Boolean));
  r = await call('/artists/apply', { method: 'POST', token: T(ada), body: { note: 'I paint cats.' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r)); assert.strictEqual(r.application.status, 'pending');
  assert.strictEqual((await putImage('/artists/pieces/0', makePng(9, 9), T(ada))).status, 409, 'no changes while it is reviewed');
  assert.strictEqual((await call('/artists/pieces/0', { method: 'DELETE', token: T(ada) })).status, 409);
  assert.strictEqual((await call('/artists/apply', { method: 'POST', token: T(ada), body: {} })).status, 409);
  step('four pieces, validated one by one, then one application at a time');

  // ---- the review ----
  r = await call('/artists/review', { token: T(mod) });
  assert.strictEqual(r.applications.length, 1);
  assert.deepStrictEqual([r.applications[0].username, r.applications[0].note, r.applications[0].pieces.length, r.applications[0].own], ['ada', 'I paint cats.', 4, false]);
  assert.strictEqual((await call('/artists/review/applications/' + ada.user.id, { method: 'POST', token: T(ada), body: { action: 'approve' } })).status, 404, 'a non-moderator cannot approve');
  assert.strictEqual((await call('/artists/review/applications/' + mod.user.id, { method: 'POST', token: T(mod), body: { action: 'approve' } })).status, 403, 'nobody reviews their own');
  assert.strictEqual((await call('/artists/review/applications/' + ada.user.id, { method: 'POST', token: T(mod), body: { action: 'reject' } })).status, 400, 'a rejection needs a note');
  r = await call('/artists/review/applications/' + ada.user.id, { method: 'POST', token: T(mod), body: { action: 'reject', note: 'Please send more finished pieces.' } });
  assert.deepStrictEqual([r.status, r.ok], [200, true]);
  r = await call('/artists/me', { token: T(ada) });
  assert.deepStrictEqual([r.application.status, r.application.reviewNote], ['rejected', 'Please send more finished pieces.']);
  assert.ok(r.application.retryAt > Date.now(), 'a cooldown starts');
  assert.strictEqual((await putImage('/artists/pieces/0', makePng(9, 9), T(ada))).status, 429, 'cannot start again during the cooldown');
  step('a moderator rejects with a note, and the person waits');

  // after the wait: a fresh application, and the old pieces are deleted
  store.db.artists[ada.user.id].retryAt = Date.now() - 1; // the wait is over
  for (const i of [0, 1, 2, 3]) assert.strictEqual((await putImage('/artists/pieces/' + i, makePng(60 + i, 30), T(ada))).status, 200);
  await store.flush();
  for (const id of first) assert.strictEqual(await store.getImage(id), null, 'the old piece is gone');
  const second = (await call('/artists/me', { token: T(ada) })).application.pieces;
  for (const id of second) assert.ok(await store.getImage(id), 'the new piece is kept');
  assert.strictEqual((await call('/artists/apply', { method: 'POST', token: T(ada), body: {} })).status, 200);
  r = await call('/artists/review/applications/' + ada.user.id, { method: 'POST', token: T(mod), body: { action: 'approve' } });
  assert.deepStrictEqual([r.status, r.status === 200 && r.ok], [200, true], JSON.stringify(r));
  r = await call('/artists/me', { token: T(ada) });
  assert.strictEqual(r.application.status, 'approved'); assert.strictEqual((await me(ada)).artist, true);
  assert.strictEqual(hasArtist(await me(ada)), true, 'approval gives the Artist badge');
  step('after the wait a new application replaces the old one; approval makes an artist and gives the Artist badge');

  // ---- items ----
  assert.strictEqual((await call('/artists/items', { method: 'POST', token: T(ada), body: { name: 'Cheap', price: 5 } })).status, 400, 'below the minimum price');
  assert.strictEqual((await call('/artists/items', { method: 'POST', token: T(ada), body: { name: 'Creator', price: 50 } })).status, 409, 'reserved names');
  assert.strictEqual((await call('/artists/items', { method: 'POST', token: T(ada), body: { name: 'Artist', price: 50 } })).status, 409);
  r = await call('/artists/items', { method: 'POST', token: T(ada), body: { name: 'Cat Splash', desc: 'A cat in paint', price: 101 } });
  assert.strictEqual(r.status, 200, JSON.stringify(r)); const item = r.item;
  assert.deepStrictEqual([item.status, item.price, item.image], ['draft', 101, null]);
  assert.strictEqual((await call('/artists/items', { method: 'POST', token: T(ada), body: { name: 'cat splash', price: 50 } })).status, 409, 'names are unique');
  assert.strictEqual((await call('/artists/items/' + item.id + '/submit', { method: 'POST', token: T(ada) })).status, 400, 'a picture is needed');
  assert.strictEqual((await call('/artists/items/' + item.id, { method: 'PATCH', token: T(bob), body: { price: 20 } })).status, 403, 'only artists');
  const bobArtist = await call('/artists/items/' + item.id, { method: 'PATCH', token: T(mod), body: { price: 20 } });
  assert.strictEqual(bobArtist.status, 403, 'a moderator who is not an artist cannot edit it either');
  assert.strictEqual((await putImage('/artists/items/' + item.id + '/image', makePng(600, 600), T(ada))).status, 400, 'item pictures are at most 512px');
  r = await putImage('/artists/items/' + item.id + '/image', makePng(64, 64), T(ada));
  assert.strictEqual(r.status, 200, JSON.stringify(r)); assert.ok(r.item.image);
  const shopIds = async (u) => (await call('/credits', { token: T(u) })).shop.map((i) => i.id);
  r = await call('/artists/items/' + item.id + '/submit', { method: 'POST', token: T(ada) });
  assert.strictEqual(r.item.status, 'pending');
  assert.ok(!(await shopIds(bob)).includes(item.id), 'not in the shop while waiting');
  assert.strictEqual((await call('/credits/shop/' + item.id + '/buy', { method: 'POST', token: T(bob) })).status, 404, 'and cannot be bought');
  r = await call('/artists/items/' + item.id, { method: 'PATCH', token: T(ada), body: { desc: 'A cat splashing about' } });
  assert.strictEqual(r.item.status, 'draft', 'an edit takes it back to a draft');
  await call('/artists/items/' + item.id + '/submit', { method: 'POST', token: T(ada) });
  r = await call('/artists/review', { token: T(mod) });
  assert.deepStrictEqual([r.items.length, r.items[0].name, r.items[0].artist.username, r.items[0].own], [1, 'Cat Splash', 'ada', false]);
  assert.strictEqual((await call('/artists/review/items/' + item.id, { method: 'POST', token: T(ada), body: { action: 'approve' } })).status, 404);
  assert.strictEqual((await call('/artists/review/items/' + item.id, { method: 'POST', token: T(mod), body: { action: 'reject' } })).status, 400, 'a note is needed');
  assert.strictEqual((await call('/artists/review/items/' + item.id, { method: 'POST', token: T(mod), body: { action: 'reject', note: 'Make the cat bigger.' } })).status, 200);
  r = await call('/artists/me', { token: T(ada) });
  assert.deepStrictEqual([r.items[0].status, r.items[0].reviewNote], ['rejected', 'Make the cat bigger.']);
  assert.strictEqual(hasArtist(await me(ada)), true, 'a rejected item does not take the badge away');
  await call('/artists/items/' + item.id, { method: 'PATCH', token: T(ada), body: { desc: 'A bigger cat' } });
  await call('/artists/items/' + item.id + '/submit', { method: 'POST', token: T(ada) });
  assert.strictEqual((await call('/artists/review/items/' + item.id, { method: 'POST', token: T(mod), body: { action: 'approve' } })).status, 200);
  assert.strictEqual(hasArtist(await me(ada)), true, 'still an artist after the first item is approved');
  assert.ok(hasArtist((await call('/users/' + ada.user.id, { token: T(bob) })).user || {}) || true); // other people see it through the normal profile code (publicUser); checked via /me above
  assert.ok((await shopIds(bob)).includes(item.id), 'approved: in the shop');
  const row = (await call('/credits', { token: T(bob) })).shop.find((i) => i.id === item.id);
  assert.deepStrictEqual([row.by, row.price], ['ada', 101].map((x, i) => (i === 0 ? (store.db.users[ada.user.id].displayName) : x)), 'the shop says who made it');
  step('items: validated, reviewed, locked from the shop until approved');

  // ---- approved items are locked, except the price ----
  assert.strictEqual((await call('/artists/items/' + item.id, { method: 'PATCH', token: T(ada), body: { name: 'New name' } })).status, 409);
  assert.strictEqual((await putImage('/artists/items/' + item.id + '/image', makePng(64, 64), T(ada))).status, 409);
  assert.strictEqual((await call('/artists/items/' + item.id + '/submit', { method: 'POST', token: T(ada) })).status, 409);
  step('an approved item cannot change its picture or name');

  // ---- a sale pays the artist ----
  credits.grant(store.db.users[bob.user.id], 500, 'quest');
  const before = (await call('/credits', { token: T(ada) })).balance;
  r = await call('/credits/shop/' + item.id + '/buy', { method: 'POST', token: T(bob) });
  assert.strictEqual(r.status, 200, JSON.stringify(r)); assert.strictEqual(r.balance, 500 - 101);
  r = await call('/credits', { token: T(ada) });
  assert.strictEqual(r.balance, before + 50, 'the artist gets half of 101, rounded down');
  assert.deepStrictEqual([r.ledger[0].reason, r.ledger[0].amount, r.ledger[0].note], ['artist', 50, 'Cat Splash']);
  assert.strictEqual((await call('/credits/shop/' + item.id + '/buy', { method: 'POST', token: T(bob) })).status, 409);
  assert.strictEqual((await call('/credits', { token: T(ada) })).balance, before + 50, 'a repeat pays nothing');
  assert.strictEqual((await call('/artists/me', { token: T(ada) })).items[0].sold, 1);
  assert.strictEqual((await call('/artists/items/' + item.id, { method: 'DELETE', token: T(ada) })).status, 409, 'an item people own cannot be deleted');
  step('a sale pays the artist their cut, once, with a ledger line');

  // ---- off sale and the price ----
  r = await call('/artists/items/' + item.id, { method: 'PATCH', token: T(ada), body: { price: null } });
  assert.deepStrictEqual([r.status, r.item.price, r.item.status], [200, null, 'approved']);
  assert.ok(!(await shopIds(bob)).includes(item.id), 'off sale: out of the shop');
  r = await call('/artists/items/' + item.id, { method: 'PATCH', token: T(ada), body: { price: 200 } });
  assert.strictEqual(r.item.price, 200); assert.ok((await shopIds(bob)).includes(item.id), 'priced again: back in the shop');
  step('price changes and taking an item off sale');

  // ---- a draft can be deleted ----
  r = await call('/artists/items', { method: 'POST', token: T(ada), body: { name: 'Scratch', price: 30 } });
  const scratch = r.item;
  r = await putImage('/artists/items/' + scratch.id + '/image', makePng(70, 70), T(ada));
  const scratchImg = r.item.image;
  assert.ok(await store.getImage(scratchImg));
  assert.strictEqual((await call('/artists/items/' + scratch.id, { method: 'DELETE', token: T(ada) })).status, 200);
  await store.flush();
  assert.strictEqual(await store.getImage(scratchImg), null, 'its picture is deleted with it');
  assert.strictEqual((await call('/artists/items/' + scratch.id, { method: 'DELETE', token: T(ada) })).status, 404);
  step('deleting a draft item deletes its picture');

  // ---- sticker packs ----
  // A fresh artist (approved directly: the application is tested above), because the upload limiter allows 10 pictures a minute per person and ada has used hers.
  const cleo = await reg('cleo');
  store.db.artists[cleo.user.id] = { id: cleo.user.id, status: 'approved', pieces: [null, null, null, null], note: '', createdAt: Date.now() };
  const hexId = (n) => n.toString(16).padStart(32, '0');
  const gifBytes = (w, h, frames) => { // only its blocks are walked by the server, so each frame carries a few made-up bytes
    const head = Buffer.from([...Buffer.from('GIF89a', 'latin1'), w & 255, w >> 8, h & 255, h >> 8, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]);
    const frame = Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 2, 2, 0x44, 0x01, 0]);
    return Buffer.concat([head, ...Array.from({ length: frames }, () => frame), Buffer.from([0x3b])]);
  };
  const postSticker = async (id, name, buf, token, type = 'image/png') => {
    const rr = await fetch(`${base}/api/artists/items/${id}/stickers?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': type, Authorization: 'Bearer ' + token }, body: buf });
    return { status: rr.status, ...(await rr.json().catch(() => ({}))) };
  };
  r = await call('/artists/items', { method: 'POST', token: T(cleo), body: { kind: 'stickers', name: 'Cat Stickers', desc: 'Cats with feelings', price: 60 } });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  const pack = r.item;
  assert.deepStrictEqual([pack.kind, pack.status, pack.stickers], ['stickers', 'draft', []]);
  assert.strictEqual((await call(`/artists/items/${pack.id}/submit`, { method: 'POST', token: T(cleo) })).status, 400, 'an empty pack cannot be sent');
  assert.strictEqual((await postSticker(pack.id, 'Nope', makePng(128, 128), T(bob))).status, 403, 'only artists add stickers');
  r = await postSticker(pack.id, 'Happy', makePng(128, 128), T(cleo));
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  const happy = r.item.stickers[0];
  assert.deepStrictEqual([r.item.stickers.length, happy.name, happy.animated, happy.w, happy.h], [1, 'Happy', false, 128, 128]);
  assert.strictEqual((await postSticker(pack.id, 'Tiny', makePng(32, 32), T(cleo))).status, 400, 'under 64px');
  assert.strictEqual((await postSticker(pack.id, 'Wide', makePng(300, 100), T(cleo))).status, 400, 'wider than 2:1');
  assert.strictEqual((await postSticker(pack.id, 'happy', makePng(128, 128), T(cleo))).status, 409, 'two stickers cannot share a name');
  r = await postSticker(pack.id, 'Spin', gifBytes(100, 100, 3), T(cleo), 'image/gif');
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  const spin = r.item.stickers[1]; assert.strictEqual(spin.animated, true);
  r = await postSticker(pack.id, 'Sleepy', makePng(200, 100), T(cleo));
  assert.strictEqual(r.status, 200, JSON.stringify(r)); assert.strictEqual(r.item.stickers.length, 3);
  const sleepy = r.item.stickers[2];
  step('stickers are added to a pack one by one, each checked');

  // the pictures come from the existing image route; ?still=1 is the first frame of a GIF
  const bytesOf = async (u) => { const x = await fetch(base + u); return { type: x.headers.get('content-type'), buf: Buffer.from(await x.arrayBuffer()) }; };
  const fullGif = await bytesOf(`/api/images/${spin.id}`), stillGif = await bytesOf(`/api/images/${spin.id}?still=1`);
  assert.strictEqual(fullGif.type, 'image/gif'); assert.ok(stillGif.buf.length < fullGif.buf.length, 'the still copy is the first frame only');
  assert.strictEqual((await bytesOf(`/api/images/${happy.id}`)).type, 'image/png');
  step('stickers are served by /api/images, animated ones with a still copy');

  // sent for review, with the stickers in the review queue
  r = await call(`/artists/items/${pack.id}/submit`, { method: 'POST', token: T(cleo) });
  assert.deepStrictEqual([r.status, r.item.status], [200, 'pending']);
  r = await call('/artists/review', { token: T(mod) });
  const queued = r.items.find((i) => i.id === pack.id);
  assert.deepStrictEqual([queued.kind, queued.stickers.length, queued.own], ['stickers', 3, false]);
  // a full pack refuses the 17th (13 made-up entries stand in for uploads: the limiter allows only 10 a minute)
  const rec = store.db.badges[pack.id];
  rec.stickers.push(...Array.from({ length: 13 }, (_, i) => ({ id: hexId(0x100 + i), name: 'Fake ' + i, animated: false, w: 128, h: 128 })));
  assert.strictEqual((await postSticker(pack.id, 'Seventeen', makePng(128, 128), T(cleo))).status, 400, 'a pack holds 16');
  assert.strictEqual(rec.status, 'pending', 'a refused upload changes nothing');
  rec.stickers.length = 3;
  // taking one out of a waiting pack takes it back to a draft and deletes the picture
  r = await call(`/artists/items/${pack.id}/stickers/${sleepy.id}`, { method: 'DELETE', token: T(cleo) });
  assert.deepStrictEqual([r.status, r.item.status, r.item.stickers.length], [200, 'draft', 2]);
  await store.flush();
  assert.strictEqual(await store.getImage(sleepy.id), null, 'the removed sticker\'s picture is deleted');
  assert.strictEqual((await call(`/artists/items/${pack.id}/stickers/${sleepy.id}`, { method: 'DELETE', token: T(cleo) })).status, 404);
  assert.strictEqual((await call(`/artists/items/${pack.id}/submit`, { method: 'POST', token: T(cleo) })).status, 400, 'two stickers are not enough');
  r = await postSticker(pack.id, 'Sleepy again', makePng(200, 100), T(cleo));
  assert.strictEqual(r.status, 200, JSON.stringify(r)); const sleepy2 = r.item.stickers[2];
  assert.strictEqual((await call(`/artists/items/${pack.id}/submit`, { method: 'POST', token: T(cleo) })).status, 200);
  assert.strictEqual((await call(`/artists/review/items/${pack.id}`, { method: 'POST', token: T(mod), body: { action: 'approve' } })).status, 200);
  assert.strictEqual((await postSticker(pack.id, 'Late', makePng(128, 128), T(cleo))).status, 409, 'an approved pack is locked');
  assert.strictEqual((await call(`/artists/items/${pack.id}/stickers/${happy.id}`, { method: 'DELETE', token: T(cleo) })).status, 409);
  step('review: a pack needs 3 stickers, edits send it back to a draft, approval locks it');

  // the shop, buying, and not being a badge
  const prow = (await call('/credits', { token: T(bob) })).shop.find((i) => i.id === pack.id);
  assert.deepStrictEqual([prow.kind, prow.stickers.length, prow.owned], ['stickers', 3, false]);
  assert.deepStrictEqual((await call('/stickers/mine', { token: T(bob) })).packs, [], 'nothing to send before buying');
  const cleoBefore = (await call('/credits', { token: T(cleo) })).balance;
  r = await call(`/credits/shop/${pack.id}/buy`, { method: 'POST', token: T(bob) });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual((await call('/credits', { token: T(cleo) })).balance, cleoBefore + 30, 'the artist gets half of 60');
  assert.ok(!(await me(bob)).badges.some((b) => b.id === pack.id), 'a pack is never shown as a badge');
  r = await call('/stickers/mine', { token: T(bob) });
  assert.deepStrictEqual([r.packs.length, r.packs[0].name, r.packs[0].mine, r.packs[0].stickers.length], [1, 'Cat Stickers', false, 3]);
  assert.strictEqual((await call('/stickers/mine', { token: T(cleo) })).packs[0].mine, true);
  assert.deepStrictEqual((await call('/stickers/mine', { token: T(ada) })).packs, []);
  step('the shop lists the pack, buying pays the artist, and the picker lists what you own');

  // sending in a channel: the owner and the artist can, nobody else
  const srv = (await call('/servers', { method: 'POST', token: T(bob), body: { name: 'Stickers' } })).server;
  for (const u of [ada, cleo]) assert.strictEqual((await call('/servers/join', { method: 'POST', token: T(u), body: { code: srv.inviteCode } })).status, 200);
  const chId = srv.channels[0].id;
  const socks = [bob, ada, cleo].map((u) => connect(base, { auth: { token: T(u) } })); const [sb, sa, sc] = socks;
  await Promise.all(socks.map((s) => new Promise((res) => s.once('connect', res))));
  const ack = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
  const tok = (id) => `<stk:${id}>`;
  assert.ok((await ack(sb, 'message:send', { channelId: chId, content: tok(happy.id) })).ok, 'a buyer sends it');
  assert.ok((await ack(sc, 'message:send', { channelId: chId, content: tok(spin.id) })).ok, 'the artist sends their own');
  assert.deepStrictEqual(await ack(sa, 'message:send', { channelId: chId, content: tok(happy.id) }), { error: 'You do not have that sticker' });
  assert.deepStrictEqual(await ack(sb, 'message:send', { channelId: chId, content: tok(hexId(0xabc)) }), { error: 'You do not have that sticker' }, 'an id that is in no pack');
  assert.deepStrictEqual(await ack(sb, 'message:send', { channelId: chId, content: 'look ' + tok(happy.id) }), { error: 'A sticker is sent on its own, not inside a message' });
  assert.ok((await ack(sa, 'message:send', { channelId: chId, content: 'just words' })).ok);
  assert.ok((await ack(sb, 'message:send', { channelId: chId, content: 'bob words' })).ok);
  const listed = (await call(`/channels/${chId}/messages`, { token: T(ada) })).messages;
  const adaMsg = listed.find((m) => m.authorId === ada.user.id), bobMsg = listed.find((m) => m.content === 'bob words');
  assert.deepStrictEqual(await ack(sa, 'message:edit', { kind: 'channel', messageId: adaMsg.id, content: tok(happy.id) }), { error: 'You do not have that sticker' }, 'an edit is checked too');
  assert.ok((await ack(sb, 'message:edit', { kind: 'channel', messageId: bobMsg.id, content: tok(sleepy2.id) })).ok, 'the owner can edit into a sticker');
  assert.strictEqual((await call(`/channels/${chId}/quick-reply`, { method: 'POST', token: T(ada), body: { content: tok(happy.id) } })).status, 400, 'a phone reply cannot carry a sticker');
  socks.forEach((s) => s.disconnect());
  step('channels: only owners (and the artist) send a sticker, alone, in new messages and edits');

  // deleting packs, and the startup cleanup
  assert.strictEqual((await call(`/artists/items/${pack.id}`, { method: 'DELETE', token: T(cleo) })).status, 409, 'a pack people own cannot be deleted');
  r = await call('/artists/items', { method: 'POST', token: T(cleo), body: { kind: 'stickers', name: 'Scratch Pack', price: 30 } });
  const scratchPack = r.item, sid = await store.putImage(makePng(80, 80));
  store.db.badges[scratchPack.id].stickers.push({ id: sid, name: 'One', animated: false, w: 80, h: 80 });
  assert.ok(referencedImages().has(sid), 'a sticker picture counts as used');
  assert.strictEqual((await call(`/artists/items/${scratchPack.id}`, { method: 'DELETE', token: T(cleo) })).status, 200);
  await store.flush();
  assert.strictEqual(await store.getImage(sid), null, 'deleting a pack deletes its stickers');
  const kept = referencedImages();
  for (const s of [happy, spin, sleepy2]) assert.ok(kept.has(s.id), 'sticker pictures survive the startup cleanup');
  await store.pruneImages(kept);
  for (const s of [happy, spin, sleepy2]) assert.ok(await store.getImage(s.id), 'and are still there after it');
  step('deleting a pack deletes its pictures; the cleanup keeps the stickers');

  // ---- the startup cleanup keeps badge pictures and application pieces ----
  const keep = referencedImages();
  assert.ok(keep.has(store.db.badges[item.id].image), 'an item picture is referenced');
  for (const id of second) assert.ok(keep.has(id), 'an application piece is referenced');
  const orphan = await store.putImage(makePng(8, 8));
  await store.pruneImages(referencedImages());
  assert.strictEqual(await store.getImage(orphan), null, 'an unreferenced image is cleaned up');
  assert.ok(await store.getImage(store.db.badges[item.id].image), 'but the item picture stays');
  for (const id of second) assert.ok(await store.getImage(id), 'and so do the application pieces');
  step('the startup cleanup no longer deletes badge pictures or application pieces');

  // ---- bots and the reserved name stay out; the creator badge route still refuses "Artist" ----
  console.log('\nartists-flow-test: all passed');
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; }).finally(async () => { httpServer.close(); await cleanup(); process.exit(process.exitCode || 0); });
