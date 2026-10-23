// Halloween / Christmas quests, the Advent calendar and the developer test mode, without a server: node server/events-test.js
const assert = require('assert');
const E = require('./events');
const C = require('./credits');

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const HALLOWEEN = Date.UTC(2026, 9, 23, 12);   // 23 Oct 2026
const XMAS = Date.UTC(2026, 11, 10, 12);       // 10 Dec 2026
const MIN_AGE = C.EARN.minAccountAgeMs;
const user = (id, extra = {}) => ({ id, createdAt: HALLOWEEN - 10 * DAY, ...extra });
const friends = (n) => Array.from({ length: n }, (_, i) => user('f' + i));
const grant = (u, amount, reason, o) => C.grant(u, amount, reason, o);
const opts = (now, extra = {}) => ({ now, grant, minAgeMs: MIN_AGE, unlocksAt: 0, ...extra });
const step = (m) => console.log('✓', m);

// ---- windows ----
{
  assert.strictEqual(E.eventAt(Date.UTC(2026, 9, 16, 23, 59)), null);
  assert.strictEqual(E.eventAt(Date.UTC(2026, 9, 17)).ev.id, 'halloween');
  assert.strictEqual(E.eventAt(Date.UTC(2026, 10, 7, 23, 59)).ev.id, 'halloween', 'the last day is inside the window');
  assert.strictEqual(E.eventAt(Date.UTC(2026, 10, 8)), null);
  assert.strictEqual(E.eventAt(Date.UTC(2026, 10, 30)), null);
  assert.strictEqual(E.eventAt(Date.UTC(2026, 11, 1)).ev.id, 'christmas', 'Christmas opens on 1 December');
  const jan = E.eventAt(Date.UTC(2027, 0, 1, 20));
  assert.strictEqual(jan.ev.id, 'christmas'); assert.strictEqual(jan.year, 2026, 'January still belongs to last December\'s event');
  assert.strictEqual(E.eventAt(Date.UTC(2027, 0, 2)), null);
  step('windows: Halloween 17 Oct - 7 Nov, Christmas 1 Dec - 1 Jan (across New Year)');
}

// ---- no event, nothing to see or claim ----
{
  const u = user('u1'), off = Date.UTC(2026, 8, 1);
  assert.strictEqual(E.view(u, { now: off }), null);
  assert.strictEqual(E.claim(u, 'trick', opts(off)).status, 404);
  assert.strictEqual(E.openDoor(u, 1, opts(off)).status, 404);
  assert.strictEqual(E.noteDm(u, user('f0'), 'trick', opts(off)), false);
  assert.strictEqual(E.noteReaction(u, '🎃', 'm1', 'f0', opts(off)), false);
  step('outside an event: no quests, no doors, nothing counts');
}

// ---- Trick or Treat: 5 DIFFERENT friends, 50 credits, once ----
{
  const u = user('u1'), fs = friends(6);
  const now = HALLOWEEN;
  for (let i = 0; i < 4; i++) assert.strictEqual(E.noteDm(u, fs[i], 'trick', opts(now)), true);
  assert.strictEqual(E.noteDm(u, fs[0], 'trick', opts(now)), false, 'the same friend twice is still one friend');
  assert.strictEqual(E.noteDm(u, fs[0], 'trick', opts(now)), false);
  let q = E.view(u, { now }).quests.find((x) => x.id === 'trick');
  assert.deepStrictEqual([q.have, q.need, q.done, q.reward], [4, 5, false, 50]);
  assert.strictEqual(E.claim(u, 'trick', opts(now)).status, 400, 'not finished yet');
  assert.strictEqual(u.credits, undefined, 'a refused claim pays nothing');
  assert.strictEqual(E.noteDm(u, fs[4], 'trick', opts(now)), true);
  const r = E.claim(u, 'trick', opts(now));
  assert.deepStrictEqual([r.ok, r.amount, r.test], [true, 50, false]);
  assert.strictEqual(r.badge, 'Trick or Treater');
  assert.strictEqual(u.credits.balance, 50);
  assert.strictEqual(u.credits.ledger[0].note, 'Halloween: Trick or Treat');
  assert.strictEqual(E.claim(u, 'trick', opts(now)).status, 409, 'only once');
  assert.strictEqual(u.credits.balance, 50);
  assert(E.badgeViews(u).some((b) => b.id === 'trick-or-treater' && b.emoji === '🎃' && !b.builtin));
  step('Trick or Treat: 5 different friends, +50 credits once, and the Trick or Treater badge');
}

// ---- the hint is only a hint: what else must hold ----
{
  const now = HALLOWEEN;
  const u = user('u1');
  assert.strictEqual(E.noteDm(u, user('f0'), 'gif', opts(now)), false, 'a GIF does nothing during Halloween');
  assert.strictEqual(E.noteDm(u, u, 'trick', opts(now)), false, 'not yourself');
  assert.strictEqual(E.noteDm(u, user('b1', { bot: true }), 'trick', opts(now)), false, 'not a bot');
  assert.strictEqual(E.noteDm(u, user('new1', { createdAt: now - 5 * MIN }), 'trick', opts(now)), false, 'the friend\'s account must be 30 minutes old');
  assert.strictEqual(E.noteDm(user('u2', { createdAt: now - 5 * MIN }), user('f0'), 'trick', opts(now)), false, 'and so must yours');
  assert.strictEqual(E.noteDm(u, user('f0'), 'treat', opts(now)), false, 'unknown hints are ignored');
  assert.strictEqual(E.noteDm(u, null, 'trick', opts(now)), false);
  // more than the list limit is not stored
  for (let i = 0; i < 80; i++) E.noteDm(u, user('x' + i), 'trick', opts(now));
  assert(E.current(u, { now }).state.trick.length <= 50);
  step('hint checks: right event, other person, not a bot, both accounts 30 minutes old, bounded list');
}

// ---- Pumpkin patch / Holiday cheer: real reactions ----
{
  const u = user('u1'), now = HALLOWEEN;
  assert.strictEqual(E.noteReaction(u, '🎃', 'm1', 'f0', opts(now)), true);
  assert.strictEqual(E.noteReaction(u, '🕷️', 'm2', 'f0', opts(now)), true, 'with the picture selector');
  assert.strictEqual(E.noteReaction(u, '🕷', 'm3', 'f0', opts(now)), true, 'and without it');
  assert.strictEqual(E.noteReaction(u, '🎃', 'm1', 'f0', opts(now)), false, 'the same message once');
  assert.strictEqual(E.noteReaction(u, '👍', 'm4', 'f0', opts(now)), false, 'only spooky emoji');
  assert.strictEqual(E.noteReaction(u, '🎄', 'm5', 'f0', opts(now)), false, 'not festive ones in Halloween');
  assert.strictEqual(E.noteReaction(u, '🎃', 'm6', 'u1', opts(now)), false, 'not your own message');
  const r = E.claim(u, 'pumpkin', opts(now));
  assert.deepStrictEqual([r.ok, r.amount], [true, 20]);
  assert.strictEqual(E.noteReaction(user('n', { createdAt: now - MIN }), '🎃', 'm1', 'f0', opts(now)), false, 'new accounts count nothing');

  const c = user('u3'), xm = XMAS;
  for (const [i, e] of ['🎄', '🎅', '🎁'].entries()) assert.strictEqual(E.noteReaction(c, e, 'm' + i, 'f0', opts(xm)), true);
  const cr = E.claim(c, 'cheer', opts(xm));
  assert.deepStrictEqual([cr.ok, cr.amount], [true, 20]);
  step('Pumpkin patch and Holiday cheer: 3 different messages from others, +20 each');
}

// ---- Daily treat ----
{
  const u = user('u1');
  const a = E.claim(u, 'treat', opts(HALLOWEEN));
  assert.deepStrictEqual([a.ok, a.amount], [true, 5]);
  assert.strictEqual(E.claim(u, 'treat', opts(HALLOWEEN + HOUR)).status, 409, 'once a day');
  assert.strictEqual(E.view(u, { now: HALLOWEEN + HOUR }).quests.find((x) => x.id === 'treat').claimed, true);
  const b = E.claim(u, 'treat', opts(HALLOWEEN + DAY));
  assert.strictEqual(b.ok, true, 'and again the next day');
  assert.strictEqual(E.view(u, { now: HALLOWEEN + DAY }).quests.find((x) => x.id === 'treat').claimed, true);
  assert.strictEqual(u.credits.balance, 10);
  step('Daily treat: 5 credits once per UTC day');
}

// ---- Gift of GIFs ----
{
  const u = user('u1'), fs = friends(5), now = XMAS;
  for (const f of fs) assert.strictEqual(E.noteDm(u, f, 'gif', opts(now)), true);
  assert.strictEqual(E.noteDm(u, user('f9'), 'trick', opts(now)), false, 'Trick or Treat does nothing at Christmas');
  const r = E.claim(u, 'gifs', opts(now));
  assert.deepStrictEqual([r.ok, r.amount], [true, 50]);
  assert.strictEqual(u.credits.ledger[0].note, 'Christmas: Gift of GIFs');
  assert.strictEqual(E.claim(u, 'gifs', opts(now)).status, 409);
  step('Gift of GIFs: a GIF to 5 different friends, +50 credits once');
}

// ---- last year's claims do not carry over ----
{
  const u = user('u1');
  for (const f of friends(5)) E.noteDm(u, f, 'trick', opts(HALLOWEEN));
  assert.strictEqual(E.claim(u, 'trick', opts(HALLOWEEN)).ok, true);
  const next = Date.UTC(2027, 9, 23, 12);
  assert.strictEqual(E.view(u, { now: next }).quests.find((x) => x.id === 'trick').have, 0, 'a new year starts from nothing');
  step('each year is its own event: progress and claims start fresh');
}

// ---- new accounts wait 30 minutes to claim ----
{
  const u = user('u1', { createdAt: HALLOWEEN - 10 * MIN });
  const r = E.claim(u, 'treat', opts(HALLOWEEN, { unlocksAt: u.createdAt + MIN_AGE }));
  assert.strictEqual(r.status, 403);
  assert.strictEqual(u.credits, undefined);
  assert.strictEqual(E.openDoor(u, 1, opts(XMAS, { unlocksAt: XMAS + MIN })).status, 403);
  step('rewards wait until the account is 30 minutes old');
}

// ---- Advent calendar ----
{
  const u = user('u1'), now = XMAS; // 10 December
  const v = E.view(u, { now }).advent;
  assert.strictEqual(v.doors.length, 24);
  assert.deepStrictEqual(v.doors.slice(0, 11).map((d) => d.state), Array(10).fill('ready').concat('locked'), 'doors 1-10 are open, 11 is not yet');
  assert.strictEqual(v.doors[23].reward, 60);
  assert.strictEqual(E.openDoor(u, 11, opts(now)).status, 403, 'a door cannot be opened before its day');
  assert.strictEqual(E.openDoor(u, 25, opts(now)).status, 404);
  assert.strictEqual(E.openDoor(u, 0, opts(now)).status, 404);
  assert.strictEqual(E.openDoor(u, 'x', opts(now)).status, 404);
  assert.strictEqual(u.credits, undefined, 'a refused door pays nothing');
  const r = E.openDoor(u, 3, opts(now));
  assert.deepStrictEqual([r.ok, r.amount, r.all], [true, 10, false]);
  assert.strictEqual(E.openDoor(u, 3, opts(now)).status, 409, 'a door opens once');
  assert.strictEqual(u.credits.balance, 10);
  assert.strictEqual(u.credits.ledger[0].note, 'Advent calendar: door 3');
  assert.strictEqual(E.openDoor(u, 1, opts(now)).ok, true, 'a missed door can be opened later');
  assert.strictEqual(E.view(u, { now }).advent.opened, 2);
  step('Advent calendar: door N opens on N December, once each, missed doors can be opened later');
}
{
  const u = user('u1'), end = Date.UTC(2027, 0, 1, 10); // 1 January: every door is open and the last chance
  let total = 0, last;
  for (let d = 1; d <= 24; d++) { last = E.openDoor(u, d, opts(end)); assert.strictEqual(last.ok, true); total += last.amount; }
  assert.strictEqual(total, E.ADVENT_CREDITS.reduce((a, b) => a + b, 0));
  assert.strictEqual(u.credits.balance, total);
  assert.strictEqual(last.all, true); assert.strictEqual(last.badge, 'Santa\u2019s Helper');
  assert(E.badgeViews(u).some((b) => b.id === 'santas-helper'));
  assert.strictEqual(E.openDoor(u, 5, opts(Date.UTC(2027, 0, 2))).status, 404, 'after the event the calendar is gone');
  step('opening all 24 doors pays the total and gives the Santa\u2019s Helper badge');
}
{
  const u = user('u1');
  assert.strictEqual(E.openDoor(u, 1, opts(HALLOWEEN)).status, 404, 'no calendar at Halloween');
  assert.strictEqual(E.view(u, { now: HALLOWEEN }).advent, null);
  step('the calendar belongs to Christmas only');
}

// ---- developer test mode ----
{
  const u = user('dev1'), now = Date.UTC(2026, 8, 1); // September: no real event
  E.setTest(u, 'christmas');
  assert.strictEqual(E.view(u, { now, dev: false }), null, 'without a developer account the test mode is ignored');
  const v = E.view(u, { now, dev: true });
  assert.strictEqual(v.id, 'christmas'); assert.strictEqual(v.test, true); assert.strictEqual(v.until, null);
  assert(v.advent.doors.every((d) => d.state === 'ready'), 'every door can be tried in test mode');
  const r = E.openDoor(u, 24, opts(now, { dev: true }));
  assert.deepStrictEqual([r.ok, r.amount, r.test], [true, 60, true]);
  assert.strictEqual(u.credits, undefined, 'a test claim pays no credits');
  assert.strictEqual(u.seasonBadges, undefined, 'and gives no badge');
  assert.strictEqual(E.openDoor(u, 24, opts(now, { dev: true })).status, 409);
  for (const f of friends(5)) assert.strictEqual(E.noteDm(u, f, 'gif', opts(now, { dev: true, minAgeMs: 10 ** 12 })), true, 'test mode skips the account age check');
  assert.strictEqual(E.claim(u, 'gifs', opts(now, { dev: true })).test, true);
  assert.strictEqual(E.claim(u, 'gifs', opts(now, { dev: true })).status, 409);
  assert.strictEqual(E.testMode(u, true), 'christmas'); assert.strictEqual(E.testMode(u, false), null);

  E.resetTest(u);
  assert.strictEqual(E.view(u, { now, dev: true }).advent.opened, 0, 'reset starts the test over');
  assert.strictEqual(E.openDoor(u, 24, opts(now, { dev: true })).ok, true);
  E.setTest(u, 'christmas');
  assert.strictEqual(E.view(u, { now, dev: true }).advent.opened, 1, 'choosing the same event again keeps the test progress');
  E.setTest(u, 'halloween');
  assert.strictEqual(E.view(u, { now, dev: true }).id, 'halloween');
  assert.strictEqual(E.view(u, { now, dev: true }).quests.find((q) => q.id === 'trick').have, 0, 'another event starts clean');
  assert.throws(() => E.setTest(u, 'easter'), /Unknown event/);
  E.setTest(u, null);
  assert.strictEqual(E.view(u, { now, dev: true }), null); assert.strictEqual(u.seasonTest, undefined);
  step('test mode: only for developers, any event any time, every door open, dry-run claims, reset, switch, off');
}
{
  // test progress and real progress are separate records
  const u = user('dev1'), now = HALLOWEEN;
  E.noteDm(u, user('f0'), 'trick', opts(now, { dev: true }));
  E.setTest(u, 'halloween');
  assert.strictEqual(E.view(u, { now, dev: true }).quests.find((q) => q.id === 'trick').have, 0, 'test mode starts empty');
  E.noteDm(u, user('f1'), 'trick', opts(now, { dev: true }));
  E.setTest(u, null);
  assert.strictEqual(E.view(u, { now, dev: true }).quests.find((q) => q.id === 'trick').have, 1, 'real progress was kept apart');
  step('test progress never mixes with real progress');
}

// ---- routes, with a tiny fake app ----
{
  const routes = {}, pushed = [];
  let saved = 0, me, devFlag = false;
  const app = { get: (p, ...h) => (routes['GET ' + p] = h), post: (p, ...h) => (routes['POST ' + p] = h) };
  const db = { users: {}, friendships: {}, servers: {}, emojis: {} };
  C.register(app, { auth: (req, _res, next) => { req.user = me; next(); }, ah: (fn) => fn, db: () => db, save: () => saved++, notify: (id, p) => pushed.push([id, p]), isDev: () => devFlag });
  const call = (key, { params = {}, body = {} } = {}) => {
    const h = routes[key]; assert(h, 'no route ' + key);
    const out = { status: 200, body: null };
    const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
    let i = 1; const req = { params, body, user: null };
    h[0](req, res, () => {}); // auth
    h[1](req, res, () => { i++; });
    return out;
  };

  // an ordinary account cannot use test mode
  me = user('plain'); devFlag = false;
  let r = call('POST /api/credits/season/test', { body: { mode: 'christmas' } });
  assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'not_developer'); assert.strictEqual(me.seasonTest, undefined);
  assert.strictEqual(call('POST /api/credits/season/test/reset').status, 403);
  step('routes: test mode is refused for accounts that are not developers');

  // a developer turns it on, tries a door: dry run, nothing paid, nothing pushed
  me = user('dev'); devFlag = true;
  r = call('POST /api/credits/season/test', { body: { mode: 'christmas' } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.seasonTest, 'christmas'); assert.strictEqual(r.body.credits.event.test, true);
  assert.strictEqual(call('POST /api/credits/season/test', { body: { mode: 'easter' } }).status, 400);
  const before = pushed.length, balance = me.credits ? me.credits.balance : 0;
  r = call('POST /api/credits/season/advent/:day/open', { params: { day: '24' } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.test, true); assert.strictEqual(r.body.amount, 60);
  assert.strictEqual(pushed.length, before, 'a test claim does not tell the browser the balance changed');
  assert.strictEqual(C.acct(me).balance, balance);
  assert.strictEqual(call('POST /api/credits/season/advent/:day/open', { params: { day: '24' } }).status, 409);
  r = call('POST /api/credits/season/test/reset'); assert.strictEqual(r.body.credits.event.advent.opened, 0);
  r = call('POST /api/credits/season/test', { body: { mode: null } }); assert.strictEqual(r.body.seasonTest, null);
  step('routes: a developer\u2019s test claims are dry runs; reset and off work');

  // a real person, real window
  me = user('real'); devFlag = false;
  const real = Date.now;
  Date.now = () => XMAS;
  try {
    r = call('POST /api/credits/season/advent/:day/open', { params: { day: '2' } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.test, false); assert.strictEqual(r.body.balance, 5);
    assert.deepStrictEqual(pushed.at(-1), ['real', { balance: 5, delta: 5, reason: 'quest' }]);
    r = call('POST /api/credits/season/advent/:day/open', { params: { day: '20' } });
    assert.strictEqual(r.status, 403, 'door 20 is not open on 10 December');
    r = call('POST /api/credits/season/quests/:id/claim', { params: { id: 'gifs' } });
    assert.strictEqual(r.status, 400, 'not finished');
    assert.strictEqual(call('GET /api/credits').body.event.id, 'christmas');
  } finally { Date.now = real; }
  step('routes: real claims pay, notify the browser, and refuse early doors and unfinished quests');
}

// ---- credits view carries the event ----
{
  const u = user('u1');
  C._reset && C._reset();
  const v = C.view(u, { users: {}, friendships: {}, servers: {}, emojis: {} }, { purchases: false, now: HALLOWEEN });
  assert.strictEqual(v.event.id, 'halloween'); assert(v.event.quests.length === 3);
  const none = C.view(u, { users: {}, friendships: {}, servers: {}, emojis: {} }, { purchases: false, now: Date.UTC(2026, 8, 1) });
  assert.strictEqual(none.event, null);
  step('the credits page data includes the current event, or null');
}

console.log('\nAll event checks passed.');
