// Artists, without a database: node server/artists-test.js
// The application and review rules, the artist items, how the shop treats unapproved items, and the artist's cut of a sale.
process.env.ARTIST_CUT_PERCENT = '50'; // read when artists.js loads
const assert = require('assert');
const C = require('./credits');
const S = require('./shop');
const A = require('./artists');

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
const DAY = 86_400_000;
const step = (m) => console.log('✓', m);
const user = (id) => ({ id, displayName: id.toUpperCase(), createdAt: T0 - DAY });
const fill = (rec, n = 4) => { for (let i = 0; i < n; i++) rec.pieces[i] = 'img' + i; return rec; };

// ---- the artist's cut ----
{
  assert.strictEqual(A.CUT_PERCENT, 50, 'ARTIST_CUT_PERCENT sets it');
  assert.strictEqual(A.cutFor(100), 50);
  assert.strictEqual(A.cutFor(101), 50, 'rounded down');
  assert.strictEqual(A.cutFor(10), 5);
  assert.strictEqual(A.cutFor(1), 0, 'too small to split');
  assert.deepStrictEqual([A.cutFor(100, 0), A.cutFor(100, 100), A.cutFor(100, 150), A.cutFor(100, -5), A.cutFor(100, 'junk'), A.cutFor(100, 33)], [0, 100, 100, 0, 50, 33]);
  assert.deepStrictEqual([A.cutFor(12.5), A.cutFor(-5), A.cutFor(0), A.cutFor('100'), A.cutFor(null)], [0, 0, 0, 0, 0], 'only whole positive prices');
  step('the artist gets a share of the price, rounded down, never more than the price');
}

// ---- applying ----
{
  assert.deepStrictEqual(A.view(null, T0), { status: 'none', pieces: [], filled: 0, note: '', reviewNote: '', retryAt: null, appliedAt: null });
  let o = A.open(null, 'u1', T0);
  assert.ok(o.ok && o.rec.status === 'draft' && o.rec.id === 'u1' && o.rec.pieces.length === 4 && o.rec.pieces.every((p) => p === null));
  const rec = o.rec;
  assert.strictEqual(A.validSlot('0'), 0); assert.strictEqual(A.validSlot(3), 3);
  assert.deepStrictEqual(['4', '-1', 'x', '', null, '01', '1.5'].map(A.validSlot), [-1, -1, -1, -1, -1, -1, -1], 'only slots 0 to 3');

  assert.strictEqual(A.submit(rec, 'hi', T0).status, 400, 'no pieces');
  fill(rec, 3);
  assert.strictEqual(A.submit(rec, 'hi', T0).status, 400, 'three is not enough');
  assert.strictEqual(rec.status, 'draft', 'a refused application stays a draft');
  fill(rec, 4);
  const long = '  ' + 'x'.repeat(400) + '  ';
  assert.strictEqual(A.submit(rec, long, T0).ok, true);
  assert.strictEqual(rec.status, 'pending'); assert.strictEqual(rec.note.length, A.LIMITS.note, 'the note is cut to its limit');
  assert.strictEqual(rec.appliedAt, T0);
  assert.strictEqual(A.open(rec, 'u1', T0).status, 409, 'cannot change pieces while it is being reviewed');
  assert.strictEqual(A.submit(rec, 'again', T0).status, 409, 'cannot send twice');
  assert.strictEqual(A.submit(null, 'x', T0).status, 409);
  assert.strictEqual(A.view(rec, T0).reviewNote, '', 'no review note while pending');
  step('four pieces are needed, one application at a time, and the note has a limit');

  // review
  assert.strictEqual(A.decide(rec, 'maybe', '', 'm1', T0).status, 400);
  assert.strictEqual(A.decide(rec, 'reject', '   ', 'm1', T0).status, 400, 'a rejection needs a note');
  assert.strictEqual(rec.status, 'pending', 'a refused decision changes nothing');
  assert.strictEqual(A.decide(null, 'approve', '', 'm1', T0).status, 404);
  assert.strictEqual(A.decide(rec, 'reject', 'Please send your own art, not screenshots.', 'm1', T0 + 1000).ok, true);
  assert.strictEqual(rec.status, 'rejected'); assert.strictEqual(rec.retryAt, T0 + 1000 + A.COOLDOWN_MS); assert.strictEqual(rec.reviewedBy, 'm1');
  let v = A.view(rec, T0 + 2000);
  assert.deepStrictEqual([v.status, v.reviewNote, v.retryAt], ['rejected', 'Please send your own art, not screenshots.', rec.retryAt]);
  assert.strictEqual(A.decide(rec, 'approve', '', 'm1', T0).status, 404, 'a decided application is not pending any more');
  step('review: approve or reject, a rejection needs a note and cannot be decided twice');

  // cooldown, then a fresh start
  o = A.open(rec, 'u1', T0 + DAY);
  assert.strictEqual(o.status, 429, 'cannot reapply during the cooldown');
  assert.ok(/days/.test(o.error));
  assert.strictEqual(A.cooldownLeft(rec, T0 + DAY) > 0, true);
  o = A.open(rec, 'u1', rec.retryAt + 1);
  assert.ok(o.ok && o.rec !== rec && o.rec.status === 'draft' && o.rec.pieces.every((p) => p === null), 'after the wait: an empty draft');
  assert.deepStrictEqual(o.dropped, ['img0', 'img1', 'img2', 'img3'], 'the old pieces are handed back to be deleted');
  assert.strictEqual(A.view(rec, rec.retryAt + 1).retryAt, null, 'the cooldown is over');
  step('a rejected person waits, then starts a fresh application and the old pieces are dropped');

  // approval
  const rec2 = fill(A.blank('u2', T0)); A.submit(rec2, '', T0);
  assert.strictEqual(A.decide(rec2, 'approve', 'Lovely work', 'm1', T0).ok, true);
  assert.strictEqual(A.isArtist(rec2), true); assert.strictEqual(A.isArtist(rec), false); assert.strictEqual(A.isArtist(null), false);
  assert.strictEqual(A.view(rec2, T0).reviewNote, 'Lovely work');
  assert.strictEqual(A.open(rec2, 'u2', T0).status, 409, 'an artist does not reapply');
  step('approval makes an artist');
}

// ---- items ----
{
  const ok = A.cleanItem({ name: '  Paint   Splash ', desc: ' a splash ', price: 50 });
  assert.deepStrictEqual(ok, { out: { name: 'Paint Splash', desc: 'a splash', price: 50 } });
  assert.ok(A.cleanItem({ name: '', price: 50 }).error);
  assert.ok(A.cleanItem({ name: 'x'.repeat(25), price: 50 }).error, 'a name is at most 24 characters');
  assert.ok(!A.cleanItem({ name: 'x'.repeat(24), price: 50 }).error);
  assert.ok(A.cleanItem({ name: 'A', desc: 'd'.repeat(81), price: 50 }).error);
  for (const price of [undefined, null, '', 9, 0, -5, 12.5, 'abc', 1_000_001]) assert.ok(A.cleanItem({ name: 'A', price }).error, 'bad price ' + price);
  assert.strictEqual(A.cleanItem({ name: 'A', price: '25' }).out.price, 25, 'a numeric string is fine');
  assert.deepStrictEqual(A.cleanItem({ price: null }, true), { out: { price: null } }, 'an edit can clear the price');
  assert.deepStrictEqual(A.cleanItem({}, true), { out: {} });
  step('item fields: name, description and a whole-credit price from the minimum up');

  // editing
  const b = { id: 'b1', artistId: 'u2', name: 'Splash', desc: '', price: 50, image: null, status: 'draft' };
  assert.strictEqual(A.editItem(b, { price: null }).status, 400, 'a draft needs a price');
  let r = A.editItem(b, { name: 'Splash 2', price: 60 });
  assert.ok(r.ok); A.applyEdit(b, r.out);
  assert.deepStrictEqual([b.name, b.price, b.status], ['Splash 2', 60, 'draft']);

  assert.strictEqual(A.submitItem(b, T0).status, 400, 'a picture is needed');
  b.image = 'pic';
  b.price = 5; assert.strictEqual(A.submitItem(b, T0).status, 400, 'and a price at or above the minimum'); b.price = 60;
  assert.strictEqual(A.submitItem(b, T0).ok, true);
  assert.deepStrictEqual([b.status, b.submittedAt], ['pending', T0]);
  assert.strictEqual(A.submitItem(b, T0).status, 409, 'cannot be sent twice');
  step('an item needs a picture and a price before it goes to review');

  // an edit while it is waiting, or after a rejection, takes it back to a draft
  r = A.editItem(b, { desc: 'changed' }); A.applyEdit(b, r.out);
  assert.strictEqual(b.status, 'draft', 'edited while pending: back to draft, so the reviewer never approves something that changed');
  A.submitItem(b, T0);
  assert.strictEqual(A.decideItem(b, 'reject', '', 'm1', T0).status, 400, 'a rejection needs a note');
  assert.strictEqual(A.decideItem(b, 'nope', 'x', 'm1', T0).status, 400);
  assert.strictEqual(A.decideItem(b, 'reject', 'The picture is blurry', 'm1', T0 + 5).ok, true);
  assert.deepStrictEqual([b.status, b.reviewNote], ['rejected', 'The picture is blurry']);
  assert.strictEqual(A.decideItem(b, 'approve', '', 'm1', T0).status, 404, 'not pending any more');
  r = A.editItem(b, { desc: 'sharper' }); A.applyEdit(b, r.out);
  assert.deepStrictEqual([b.status, b.reviewNote], ['draft', ''], 'fixing a rejected item makes it a draft again');
  A.submitItem(b, T0);
  assert.strictEqual(A.decideItem(b, 'approve', '', 'm1', T0 + 9).ok, true);
  assert.strictEqual(b.status, 'approved');
  step('review of an item: approve or reject with a note; fixing a rejected item starts again');

  // approved: locked except the price
  r = A.editItem(b, { name: 'Other' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(A.editItem(b, { desc: 'x' }).status, 409);
  r = A.editItem(b, { price: 80 }); assert.ok(r.ok); A.applyEdit(b, r.out);
  assert.deepStrictEqual([b.price, b.status, b.name], [80, 'approved', 'Splash 2'], 'the price changes and the item stays approved');
  r = A.editItem(b, { price: null }); assert.ok(r.ok); A.applyEdit(b, r.out);
  assert.strictEqual(b.price, null, 'an approved item can be taken off sale'); assert.strictEqual(b.status, 'approved');
  step('an approved item is locked except its price, and a null price takes it off sale');

  assert.strictEqual(A.isItem(b), true); assert.strictEqual(A.isItem({ id: 'x' }), false); assert.strictEqual(A.isItem(null), false);
  assert.strictEqual(A.itemRoom(Array(9).fill(0)), true); assert.strictEqual(A.itemRoom(Array(10).fill(0)), false);
  step('items are recognised by their artist, and an artist has a limit');
}

// ---- how the shop treats an artist's items ----
{
  const players = user('p1');
  const B = {
    c1: { id: 'c1', name: 'Creator star', price: 100, image: 'i' },                                              // a creator's badge: no artistId
    a1: { id: 'a1', name: 'Splash', price: 50, image: 'i', artistId: 'art', status: 'pending' },
    a2: { id: 'a2', name: 'Draft', price: 50, image: 'i', artistId: 'art', status: 'draft' },
    a3: { id: 'a3', name: 'Rejected', price: 50, image: 'i', artistId: 'art', status: 'rejected' },
    a4: { id: 'a4', name: 'Approved', price: 70, image: 'i', artistId: 'art', status: 'approved' },
    a5: { id: 'a5', name: 'Off sale', price: null, image: 'i', artistId: 'art', status: 'approved' },
  };
  const users = { art: { id: 'art', displayName: 'Ada' } };
  assert.deepStrictEqual(S.view(players, B, { now: T0, users }).map((i) => i.id).sort(), ['a4', 'c1'], 'only creator badges and approved artist items');
  const item = S.view(players, B, { now: T0, users }).find((i) => i.id === 'a4');
  assert.strictEqual(item.by, 'Ada', 'an artist item says who made it');
  assert.strictEqual(S.view(players, B, { now: T0 }).find((i) => i.id === 'a4').by, null, 'without the user table it is null, not a crash');
  assert.strictEqual('by' in S.view(players, B, { now: T0 }).find((i) => i.id === 'c1'), false, 'a creator badge has no artist');
  const all = S.view(players, B, { now: T0, all: true, users });
  assert.deepStrictEqual(Object.fromEntries(all.map((i) => [i.id, i.state])), { c1: 'live', a1: 'review', a2: 'review', a3: 'review', a4: 'live' }, 'the creator sees what is waiting, marked review');
  assert.strictEqual(S.listed(B.c1), true); assert.strictEqual(S.listed(B.a1), false); assert.strictEqual(S.listed(B.a4), true);

  C.grant(players, 5000, 'quest', { now: T0 });
  for (const id of ['a1', 'a2', 'a3', 'a5']) {
    assert.strictEqual(S.buy(players, id, C.spend, { badges: B, now: T0 }).status, 404, id + ' cannot be bought');
  }
  assert.strictEqual(C.acct(players).balance, 5000, 'and costs nothing');
  const r = S.buy(players, 'a4', C.spend, { badges: B, now: T0 });
  assert.deepStrictEqual(r, { ok: true, item: { id: 'a4', name: 'Approved', price: 70, artistId: 'art' } });
  const c = S.buy(players, 'c1', C.spend, { badges: B, now: T0 });
  assert.deepStrictEqual(c.item, { id: 'c1', name: 'Creator star', price: 100 }, 'no artistId on a creator badge');
  // a daily artist item that is not approved never takes a daily slot
  const D = { d1: { id: 'd1', name: 'D', price: 20, daily: true, artistId: 'art', status: 'pending' } };
  assert.strictEqual(S.dailyPicks(D, T0).size, 0);
  step('the shop lists an artist item only once approved; the others cannot be bought; creators see them as "review"');
}

// ---- a sale pays the artist ----
{
  const buyer = user('buyer'), art = user('art'), other = user('other');
  const B = {
    c1: { id: 'c1', name: 'Creator star', price: 100, image: 'i' },
    a1: { id: 'a1', name: 'Splash', price: 101, image: 'i', artistId: 'art', status: 'approved' },
    a2: { id: 'a2', name: 'Cheap', price: 1, image: 'i', artistId: 'art', status: 'approved' },
    a3: { id: 'a3', name: 'Orphan', price: 40, image: 'i', artistId: 'gone', status: 'approved' },
  };
  const db = { users: { buyer, art, other }, servers: {}, friendships: {}, emojis: {}, payments: {}, badges: B };
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h[h.length - 1]; }, post: (p, ...h) => { routes['POST ' + p] = h[h.length - 1]; } };
  const log = { save: 0, notify: [], changed: 0 };
  C.register(app, { auth: (_q, _r, n) => n(), ah: (f) => f, db: () => db, save: () => { log.save++; }, notify: (id, p) => log.notify.push([id, p]), userChanged: () => { log.changed++; } });
  const buy = routes['POST /api/credits/shop/:id/buy'];
  const res = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  for (const u of [buyer, art, other]) C.grant(u, 1000, 'quest', { now: T0 });

  let r = res(); buy({ user: buyer, params: { id: 'a1' } }, r);
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.strictEqual(C.acct(buyer).balance, 899, 'the buyer pays the full price');
  assert.strictEqual(C.acct(art).balance, 1050, 'the artist gets 50% of 101, rounded down');
  assert.deepStrictEqual([art.credits.ledger[0].reason, art.credits.ledger[0].amount, art.credits.ledger[0].note], ['artist', 50, 'Splash'], 'an "artist" line in their ledger');
  assert.deepStrictEqual(log.notify, [['buyer', { balance: 899, delta: -101, reason: 'shop' }], ['art', { balance: 1050, delta: 50, reason: 'artist' }]]);
  assert.strictEqual(log.save, 1, 'saved once, after both sides moved');
  assert.deepStrictEqual(buyer.badges, ['a1']);
  assert.strictEqual(r.body.shop.find((i) => i.id === 'a1').by, 'ART', 'the shop shows who made it');

  // a second purchase is refused and pays the artist nothing
  const before = C.acct(art).balance;
  r = res(); buy({ user: buyer, params: { id: 'a1' } }, r);
  assert.strictEqual(r.code, 409); assert.strictEqual(C.acct(art).balance, before);
  // too poor: refused, nobody paid
  const poor = user('poor'); db.users.poor = poor;
  r = res(); buy({ user: poor, params: { id: 'a1' } }, r);
  assert.strictEqual(r.code, 402); assert.strictEqual(C.acct(art).balance, before, 'a refused purchase pays nobody');
  step('route: the artist is paid their cut in the same step, once, and only for a real purchase');

  // the artist buying their own item: no cut comes back
  const mark = log.notify.length;
  const ownBefore = C.acct(art).balance;
  r = res(); buy({ user: art, params: { id: 'a1' } }, r);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(C.acct(art).balance, ownBefore - 101, 'buying your own item pays you nothing back');
  assert.strictEqual(log.notify.length, mark + 1, 'only the purchase was announced');

  // a price too small to split: nothing is granted (grant would throw on 0)
  const aBefore = C.acct(art).balance; const n = log.notify.length;
  r = res(); buy({ user: other, params: { id: 'a2' } }, r);
  assert.strictEqual(r.code, 200); assert.strictEqual(C.acct(art).balance, aBefore, 'a 1-credit item pays 0, so nothing is granted');
  assert.strictEqual(log.notify.length, n + 1);

  // the artist's account is gone: the sale still works
  r = res(); buy({ user: other, params: { id: 'a3' } }, r);
  assert.strictEqual(r.code, 200); assert.deepStrictEqual(other.badges, ['a2', 'a3']);

  // a creator's badge pays nobody
  const total = Object.values(db.users).reduce((s, u) => s + C.acct(u).balance, 0);
  r = res(); buy({ user: buyer, params: { id: 'c1' } }, r);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(Object.values(db.users).reduce((s, u) => s + C.acct(u).balance, 0), total - 100, 'the credits go out of the economy, nobody is paid');
  step('route: no cut for your own item, a price too small to split, a missing artist, or a creator badge');
}

// ---- badge or profile frame ----
{
  assert.deepStrictEqual(A.KINDS, ['badge', 'frame']);
  assert.strictEqual(A.cleanItem({ name: 'Ring', price: 50 }).out.kind, 'badge', 'no kind means a badge');
  assert.strictEqual(A.cleanItem({ name: 'Ring', price: 50, kind: 'frame' }).out.kind, 'frame');
  assert.ok(A.cleanItem({ name: 'Ring', price: 50, kind: 'hat' }).error, 'an unknown kind is refused');
  assert.strictEqual(A.cleanItem({ kind: 'frame' }, true).out.kind, undefined, 'an edit never changes the kind');
  assert.deepStrictEqual([A.kindOf({}), A.kindOf({ kind: 'frame' }), A.kindOf(null), A.isFrame({ kind: 'frame' }), A.isFrame({})], ['badge', 'frame', 'badge', true, false]);
  const it = { artistId: 'u1', kind: 'frame', status: 'draft', price: 50 };
  const e = A.editItem(it, { kind: 'badge', name: 'New' });
  assert.ok(e.ok); A.applyEdit(it, e.out);
  assert.strictEqual(it.kind, 'frame', 'the kind stays after an edit');
  assert.strictEqual(A.FRAME.side, 512); assert.strictEqual(A.FRAME.hole, 384); assert.strictEqual(A.FRAME.minSide, 128);
  step('an item is a badge or a frame, set once, and a frame picture has a fixed shape');
}

console.log('artists tests passed');
