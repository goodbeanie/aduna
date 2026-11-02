// Sticker rules without a server or database: node server/stickers-test.js
// The pack limits, the checks on an uploaded picture, who may send which sticker, the picker's data, and how packs behave in artists.js and shop.js.
const assert = require('assert');
const zlib = require('zlib');
const S = require('./stickers');
const A = require('./artists');
const shop = require('./shop');

const step = (m) => console.log('✓', m);
const hexId = (n) => n.toString(16).padStart(32, '0');

function crc32(buf) { let crc = 0xffffffff; for (const byte of buf) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }
function png(w, h, pad = 0) { // `pad` bytes of comment make a bigger file without changing the picture
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...(pad ? [chunk('tEXt', Buffer.alloc(pad, 0x61))] : []), chunk('IDAT', zlib.deflateSync(Buffer.alloc((w * 3 + 1) * h, 0x7f))), chunk('IEND', Buffer.alloc(0))]);
}
// A GIF with `frames` frames. The checks only walk its blocks (nothing is decoded), so each frame carries a few made-up bytes.
function gif(w, h, frames) {
  const head = Buffer.from([...Buffer.from('GIF89a', 'latin1'), w & 255, w >> 8, h & 255, h >> 8, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]);
  const frame = Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 2, 2, 0x44, 0x01, 0]);
  return Buffer.concat([head, ...Array.from({ length: frames }, () => frame), Buffer.from([0x3b])]);
}

// ---- names and tokens ----
assert.strictEqual(S.token(hexId(1)), `<stk:${hexId(1)}>`);
assert.strictEqual(S.idOf(S.token(hexId(1))), hexId(1));
assert.strictEqual(S.idOf('  ' + S.token(hexId(2)) + '\n'), hexId(2), 'spaces around the token do not matter');
assert.strictEqual(S.idOf('hi ' + S.token(hexId(1))), null, 'a token in a sentence is not a sticker message');
assert.strictEqual(S.idOf('<stk:abc>'), null); assert.strictEqual(S.idOf('<stk:' + 'G'.repeat(32) + '>'), null); assert.strictEqual(S.idOf(null), null);
assert.strictEqual(S.mixed('hi ' + S.token(hexId(1))), true);
assert.strictEqual(S.mixed(S.token(hexId(1))), false, 'a lone token is a sticker, not a mix');
assert.strictEqual(S.mixed('no tokens here'), false);
assert.deepStrictEqual(S.cleanName('  Happy   cat '), { name: 'Happy cat' });
assert.deepStrictEqual(S.cleanName('<b>Hi</b>'), { name: 'bHi/b' }, 'angle brackets are removed');
assert.ok(S.cleanName('').error); assert.ok(S.cleanName('x'.repeat(25)).error); assert.ok(!S.cleanName('x'.repeat(24)).error);
step('tokens and names');

// ---- the checks on an uploaded picture ----
let r = S.check(png(128, 128));
assert.deepStrictEqual([r.mime, r.animated, r.w, r.h], ['image/png', false, 128, 128]);
assert.ok(!S.check(png(64, 64)).error, 'the smallest size is allowed'); assert.ok(!S.check(png(512, 512)).error, 'and so is the largest');
assert.ok(S.check(png(63, 200)).error, 'under 64px'); assert.ok(S.check(png(513, 300)).error, 'over 512px');
assert.ok(!S.check(png(256, 128)).error, '2:1 is allowed'); assert.ok(S.check(png(300, 100)).error, 'wider than 2:1 is not');
assert.ok(S.check(png(100, 300)).error, 'nor taller than 2:1');
assert.ok(S.check(Buffer.from('not an image')).error); assert.ok(S.check(Buffer.alloc(0)).error); assert.ok(S.check(null).error);
assert.ok(!S.check(png(128, 128, 400 * 1024)).error, 'under 512 KB');
assert.ok(S.check(png(128, 128, 520 * 1024)).error, 'over 512 KB');
r = S.check(gif(100, 100, 3));
assert.deepStrictEqual([r.mime, r.animated, r.w, r.h], ['image/gif', true, 100, 100]);
assert.strictEqual(S.check(gif(100, 100, 1)).animated, false, 'a one-frame GIF is not animated');
assert.ok(S.check(gif(100, 100, 151)).error, 'more than 150 frames');
assert.ok(S.check(gif(40, 40, 2)).error, 'a GIF follows the same size rules');
assert.ok(S.check(Buffer.concat([gif(100, 100, 2).subarray(0, 40)])).error, 'a truncated GIF');
step('uploaded pictures: size, ratio, weight, GIF frames');

// ---- a pack ----
const sticker = (n, extra = {}) => ({ id: hexId(n), name: 'S' + n, animated: false, w: 128, h: 128, ...extra });
const pack = (o = {}) => ({ id: 'pack1', kind: 'stickers', name: 'Cats', price: 100, artistId: 'ada', status: 'draft', stickers: [], ...o });
assert.deepStrictEqual(S.roomFor(pack(), 'New'), { ok: true });
assert.strictEqual(S.roomFor({ id: 'b', kind: 'badge' }, 'x').status, 400, 'only packs hold stickers');
assert.strictEqual(S.roomFor(pack({ status: 'approved' }), 'x').status, 409, 'an approved pack is locked');
assert.deepStrictEqual([S.roomFor(pack({ status: 'pending' }), 'x').ok, S.roomFor(pack({ status: 'rejected' }), 'x').ok], [true, true]);
const full = pack({ stickers: Array.from({ length: S.LIMITS.maxPack }, (_, i) => sticker(i + 1)) });
assert.strictEqual(S.roomFor(full, 'Extra').status, 400, 'a pack holds 16');
assert.strictEqual(S.roomFor(pack({ stickers: [sticker(1)] }), 's1').status, 409, 'names are unique, ignoring case');
assert.strictEqual(S.readyToSend(pack({ stickers: [sticker(1), sticker(2)] })).status, 400, 'two are not enough');
assert.ok(S.readyToSend(pack({ stickers: [sticker(1), sticker(2), sticker(3)] })).ok, 'three are');
step('pack limits');

// ---- who may send what ----
const owned = pack({ id: 'p-owned', status: 'approved', artistId: 'ada', stickers: [sticker(1), sticker(2), sticker(3)] });
const draft = pack({ id: 'p-draft', status: 'draft', artistId: 'ada', stickers: [sticker(4)] });
const pending = pack({ id: 'p-pending', status: 'pending', artistId: 'cy', stickers: [sticker(5)] });
const badges = { [owned.id]: owned, [draft.id]: draft, [pending.id]: pending, plain: { id: 'plain', kind: 'badge' } };
const bob = { id: 'bob', badges: ['p-owned', 'p-pending', 'plain'] }, ada = { id: 'ada', badges: [] }, eve = { id: 'eve', badges: [] };
assert.strictEqual(S.mayUse(bob, badges, hexId(1)), true, 'a buyer of an approved pack');
assert.strictEqual(S.mayUse(eve, badges, hexId(1)), false, 'someone who does not own it');
assert.strictEqual(S.mayUse(ada, badges, hexId(1)), true, 'the artist always can');
assert.strictEqual(S.mayUse(ada, badges, hexId(4)), true, 'an artist can try a draft');
assert.strictEqual(S.mayUse(bob, badges, hexId(4)), false, 'but nobody else can use a draft');
assert.strictEqual(S.mayUse(bob, badges, hexId(5)), false, 'owning an unapproved pack is not enough');
assert.strictEqual(S.mayUse(bob, badges, hexId(99)), false, 'an id that is in no pack');
assert.strictEqual(S.mayUse(bob, badges, 'nope'), false); assert.strictEqual(S.mayUse(null, badges, hexId(1)), false);
assert.strictEqual(S.findSticker(badges, hexId(2)).pack.id, 'p-owned');
assert.strictEqual(S.findSticker({ __proto__: null, x: null }, hexId(2)), null, 'odd tables do not throw');
step('who may send which sticker');

// ---- the picker ----
let packs = S.ownedPacks(bob, badges);
assert.deepStrictEqual(packs.map((p) => [p.id, p.mine, p.stickers.length]), [['p-owned', false, 3]], 'bought and approved only');
assert.deepStrictEqual(Object.keys(packs[0].stickers[0]).sort(), ['animated', 'h', 'id', 'name', 'w']);
packs = S.ownedPacks(ada, badges);
assert.deepStrictEqual(packs.map((p) => [p.id, p.mine]).sort(), [['p-draft', true], ['p-owned', true]], 'an artist sees their own packs, drafts too');
assert.deepStrictEqual(S.ownedPacks(eve, badges), []);
assert.deepStrictEqual(S.ownedPacks({ id: 'z', badges: ['p-owned', 'p-owned'] }, badges).length, 1, 'a pack is listed once');
assert.deepStrictEqual(S.ownedPacks({ id: 'z', badges: ['gone', '__proto__'] }, badges), [], 'unknown ids are skipped');
step('the picker lists the right packs');

// ---- artists.js and shop.js ----
assert.strictEqual(A.isStickers(pack()), true); assert.strictEqual(A.kindOf(pack()), 'stickers');
let p = pack({ stickers: [sticker(1), sticker(2)] });
assert.strictEqual(A.submitItem(p).status, 400, 'two stickers: not ready'); assert.strictEqual(p.status, 'draft');
p.stickers.push(sticker(3));
assert.ok(A.submitItem(p).ok); assert.strictEqual(p.status, 'pending', 'a pack needs no single picture');
assert.strictEqual(A.submitItem(pack({ stickers: [sticker(1), sticker(2), sticker(3)], price: null })).status, 400, 'but it needs a price');
assert.strictEqual(A.cleanItem({ kind: 'stickers', name: 'Cats', price: 100 }).out.kind, 'stickers');
const live = pack({ id: 'live', status: 'approved', stickers: [sticker(1), sticker(2), sticker(3)] });
const row = shop.view({ badges: [] }, { live }).find((i) => i.id === 'live');
assert.deepStrictEqual([row.kind, row.stickers.length, row.image], ['stickers', 3, null], 'the shop shows the stickers');
// 12 ordinary badges held: a pack can still be bought
const twelve = {}; const held = [];
for (let i = 0; i < 12; i++) { twelve['b' + i] = { id: 'b' + i, name: 'B' + i, price: 10, kind: 'badge' }; held.push('b' + i); }
twelve.live = live;
const buyer = { badges: held };
assert.ok(shop.buy(buyer, 'live', () => true, { badges: twelve }).ok, 'packs do not count against the 12-badge limit');
assert.strictEqual(buyer.badges.length, 13);
twelve.more = { id: 'more', name: 'More', price: 10, kind: 'badge' };
assert.strictEqual(shop.buy(buyer, 'more', () => true, { badges: twelve }).status, 400, 'and do not use up room either: 12 badges are still 12');
step('packs in artists.js and shop.js');

console.log('\nstickers-test: all passed');
