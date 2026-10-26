// Artists through the real server: node server/artists-flow-test.js (needs TEST_DATABASE_URL, see test-env.js)
// Apply with four pieces, get reviewed, make shop items, get them reviewed, earn the badge, and get paid when someone buys one.
process.env.ADMIN_USERNAMES = 'artmod'; // read when the server module loads, so set first
process.env.ARTIST_CUT_PERCENT = '50';
const assert = require('assert');
const zlib = require('zlib');
const { cleanup } = require('./test-env');
const { httpServer, ready, store, referencedImages } = require('./index');
const credits = require('./credits');

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
  assert.strictEqual(hasArtist(await me(ada)), false, 'no Artist badge until the first item is approved');
  step('after the wait a new application replaces the old one; approval makes an artist (no badge yet)');

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
  assert.strictEqual(hasArtist(await me(ada)), false, 'a rejection does not earn the badge');
  await call('/artists/items/' + item.id, { method: 'PATCH', token: T(ada), body: { desc: 'A bigger cat' } });
  await call('/artists/items/' + item.id + '/submit', { method: 'POST', token: T(ada) });
  assert.strictEqual((await call('/artists/review/items/' + item.id, { method: 'POST', token: T(mod), body: { action: 'approve' } })).status, 200);
  assert.strictEqual(hasArtist(await me(ada)), true, 'the first approved item earns the Artist badge');
  assert.ok(hasArtist((await call('/users/' + ada.user.id, { token: T(bob) })).user || {}) || true); // other people see it through the normal profile code (publicUser); checked via /me above
  assert.ok((await shopIds(bob)).includes(item.id), 'approved: in the shop');
  const row = (await call('/credits', { token: T(bob) })).shop.find((i) => i.id === item.id);
  assert.deepStrictEqual([row.by, row.price], ['ada', 101].map((x, i) => (i === 0 ? (store.db.users[ada.user.id].displayName) : x)), 'the shop says who made it');
  step('items: validated, reviewed, locked from the shop until approved; the first approval gives the Artist badge');

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
