// The yearly recap without a database: node server/recap-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./recap');
const step = (m) => console.log('✓', m);
const Y = 2026;
const at = (m, d, h = 12) => Date.UTC(Y, m - 1, d, h);

{
  const u = {};
  R.bump(u, 'credits', 40, at(3, 1));
  R.bump(u, 'credits', 2, at(3, 2));
  R.bump(u, 'credits', 5, Date.UTC(2027, 0, 1));
  R.atLeast(u, 'vcLongest', 600, at(3, 1)); R.atLeast(u, 'vcLongest', 300, at(3, 2)); R.atLeast(u, 'vcLongest', 900, at(3, 3));
  assert.strictEqual(R.counter(u, 2026, 'credits'), 42);
  assert.strictEqual(R.counter(u, 2027, 'credits'), 5, 'each year has its own counters');
  assert.strictEqual(R.counter(u, 2026, 'vcLongest'), 900);
  assert.strictEqual(R.counter(u, 2026, 'quests'), null, 'nothing counted is null, not zero');
  R.bump(u, 'quests', 0, at(3, 1)); R.bump(u, 'quests', -3, at(3, 1)); R.bump(null, 'quests', 1);
  assert.strictEqual(R.counter(u, 2026, 'quests'), null);
  step('counters: per year, never negative, empty stays empty');
}
{
  let t = 0;
  const meter = R.createVoiceMeter({ now: () => t });
  assert.deepStrictEqual(meter.tick(['a', 'b']), [], 'the first sighting only starts the clock');
  t = 30_000;
  assert.deepStrictEqual(meter.tick(['a', 'b']), [{ uid: 'a', add: 30, session: 30 }, { uid: 'b', add: 30, session: 30 }]);
  t = 60_000;
  assert.deepStrictEqual(meter.tick(['a']), [{ uid: 'a', add: 30, session: 60 }], 'b left');
  t = 90_000;
  meter.tick([]);
  t = 120_000;
  assert.deepStrictEqual(meter.tick(['b']), [], 'b is back: a new stay');
  t = 600_000;
  assert.strictEqual(meter.tick(['b'])[0].add, 60, 'a stalled timer cannot add more than two ticks');
  step('voice meter: time and longest stay, leaving ends the stay, stalls are capped');
}
{
  const rng = () => 0;
  const tie = new Map([['x', 2], ['y', 2], ['z', 1]]);
  assert.strictEqual(R.pickTop(tie, () => 0), 'x');
  assert.strictEqual(R.pickTop(tie, () => 0.99), 'y');
  assert.strictEqual(R.pickTop(new Map()), null);
  assert.strictEqual(R.pickTop(new Map([['a', 0]])), null);
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(R.pickTop(tie));
  assert.deepStrictEqual([...seen].sort(), ['x', 'y'], 'a tie goes either way and never to the smaller one');
  step('most-used picks: ties are settled at random');
  void rng;
}
{
  const top = R.percentiler([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.strictEqual(top(100), 10, 'the best of ten is top 10%');
  assert.strictEqual(top(10), 100);
  assert.strictEqual(top(0), null, 'no time at all has no rank');
  assert.strictEqual(R.percentiler([])(5), null);
  assert.strictEqual(R.percentiler([5, 5, 5, 5])(5), 25, 'a tie shares the best place');
  assert.strictEqual(R.titleFor(23, 50), 'Night Owl'); assert.strictEqual(R.titleFor(3, 50), 'Night Owl');
  assert.strictEqual(R.titleFor(6, 50), 'Early Bird'); assert.strictEqual(R.titleFor(14, 50), 'Daytimer');
  assert.strictEqual(R.titleFor(23, 5), 'Chatterbox', 'the top 5% for messages wins over the hour');
  assert.strictEqual(R.titleFor(null, null), null);
  step('percentiles and titles');
}

const world = () => ({
  users: {
    a: { id: 'a', createdAt: at(2, 1), badges: ['b1', 'b2'], song: { id: 's'.repeat(32), title: 'Low Tide' }, profileTheme: 'dusk', recap: { [Y]: { credits: 300, quests: 4, vcSeconds: 7200, vcLongest: 3600, badges: 2 } } },
    b: { id: 'b', createdAt: Date.UTC(2025, 5, 1), badges: [], song: { id: 't'.repeat(32), title: 'low tide ' }, profileTheme: 'dusk' },
    c: { id: 'c', createdAt: at(5, 5), badges: [], profileTheme: 'custom' },
    bot: { id: 'bot', bot: true, createdAt: at(1, 1) },
    gone: { id: 'gone', deleted: { at: 1 }, createdAt: at(1, 1) },
  },
  messages: {
    m1: { id: 'm1', authorId: 'a', createdAt: at(3, 14, 23), content: 'hi 😂😂 and 👍', attachments: [{}, {}] },
    m2: { id: 'm2', authorId: 'a', createdAt: at(3, 14, 23), content: 'again 😂', attachments: [] },
    m3: { id: 'm3', authorId: 'a', createdAt: at(3, 15, 9), content: 'x' },
    old: { id: 'old', authorId: 'a', createdAt: Date.UTC(2025, 11, 31, 23), content: '🔥🔥🔥🔥' },
    bm: { id: 'bm', authorId: 'bot', createdAt: at(3, 14), content: '🤖' },
    hook: { id: 'hook', authorId: 'hook:1', createdAt: at(3, 14), content: 'x' },
    m4: { id: 'm4', authorId: 'b', createdAt: at(3, 14, 23), content: 'yo' },
  },
  dms: { d1: { id: 'd1', from: 'a', to: 'b', createdAt: at(4, 1, 1), files: ['f1'] } },
  gmsgs: { g1: { id: 'g1', from: 'b', group: 'x', createdAt: at(4, 1, 1), files: [] } },
  calllog: {
    c1: { id: 'c1', a: 'a', b: 'b', outcome: 'completed', startedAt: at(6, 1), seconds: 1800 },
    c2: { id: 'c2', a: 'a', b: 'b', outcome: 'missed', startedAt: at(6, 2), seconds: 0 },
    c3: { id: 'c3', a: 'a', b: null, group: true, outcome: 'completed', startedAt: at(6, 3), seconds: 99999 },
  },
  friendships: { 'a:b': { from: 'a', to: 'b', status: 'friends', createdAt: Date.UTC(2025, 11, 30), acceptedAt: at(2, 2) }, 'a:c': { from: 'a', to: 'c', status: 'pending', createdAt: at(2, 2) } },
  clips: { k1: { id: 'k1', owner: 'a', state: 'live', createdAt: at(7, 1) }, k2: { id: 'k2', owner: 'a', state: 'rejected', createdAt: at(7, 1) } },
  servers: { s1: { id: 's1', createdAt: at(8, 1) }, s2: { id: 's2', createdAt: Date.UTC(2024, 1, 1) } },
  wordle: { a: { stats: { global: { won: 5, best: 3 }, s1: { won: 2, best: 4 } } } },
  contexto: { a: { stats: { global: { won: 1, best: 2 } } } },
  puzzle: { a: { stats: { global: { solved: 7, best: 6 } } } },
});

{
  const built = R.buildAll(world(), Y, () => 0);
  const a = built.users.a;
  assert.strictEqual(a.messages, 4, 'server, DM and group messages of this year only (a: 3 + 1 DM)');
  assert.strictEqual(a.files, 3, 'attachments and DM files');
  assert.strictEqual(a.topEmoji, '😂');
  assert.strictEqual(a.busiestDay, '2026-03-14');
  assert.strictEqual(a.favoriteHour, 23);
  assert.strictEqual(a.title, 'Night Owl');
  assert.strictEqual(a.vcHours, 3, 'counted server voice (2 h) plus the DM call (30 min)');
  assert.strictEqual(a.longestCallMin, 60, 'the longest stay beats the 30 minute call; group calls are ignored');
  assert.strictEqual(a.credits, 300); assert.strictEqual(a.quests, 4);
  assert.strictEqual(a.friends, 1, 'a pending request is not a friend');
  assert.strictEqual(a.clips, 1, 'a rejected clip is not shared');
  assert.strictEqual(a.badges, 2); assert.strictEqual(a.badgesHeld, 2);
  assert.deepStrictEqual([a.wordle, a.contexto, a.puzzle, a.bestStreak], [7, 1, 7, 6]);
  assert.deepStrictEqual(a.song, { id: 's'.repeat(32), title: 'Low Tide' });
  assert.ok(a.topPercent.vc >= 1 && a.topPercent.messages >= 1);
  step('one person: messages, files, emoji, busiest day, hour, title, voice, friends, clips, games');

  const b = built.users.b;
  assert.strictEqual(b.credits, null, 'nothing was counted for b');
  assert.strictEqual(b.badges, null);
  assert.strictEqual(b.messages, 2);
  assert.ok(!built.users.c, 'someone with nothing to show gets no recap');
  assert.ok(!built.users.bot && !built.users.gone && !built.users.bm && !built.users.hook, 'bots, webhooks and deleted accounts get no recap');
  step('no recap for bots, webhooks, deleted accounts or people with nothing to show; uncounted stays null');

  const g = built.global;
  assert.strictEqual(g.users, 3, 'a, b, c');
  assert.strictEqual(g.joinedThisYear, 2);
  assert.strictEqual(g.messages, 6);
  assert.strictEqual(g.topEmoji, '😂');
  assert.strictEqual(g.busiestDay, '2026-03-14');
  assert.strictEqual(g.busiestHour, 23);
  assert.strictEqual(g.credits, 300, 'only people who were counted add to it');
  assert.strictEqual(g.friendships, 1); assert.strictEqual(g.serversCreated, 1); assert.strictEqual(g.clips, 1);
  assert.strictEqual(g.topSong.title.trim().toLowerCase(), 'low tide', 'the same title with different spacing and case is one song');
  assert.strictEqual(g.topTheme, 'dusk', 'a custom gradient is not a theme to rank');
  assert.deepStrictEqual([g.wordle, g.contexto, g.puzzle], [7, 1, 7]);
  step('global: totals, busiest day and hour, most-used emoji, song and theme');

  const text = JSON.stringify(built);
  for (const leak of ['hi ', 'again', 'yo', 'a:b']) assert.ok(!text.includes(leak), 'no message text in the output: ' + leak);
  assert.strictEqual(typeof g.users, 'number', 'the global recap counts people and lists none');
  assert.ok(!/"userId"/.test(JSON.stringify(g)), 'and has no ids');
  step('nothing from message text and no people in the global recap');

  const none = R.buildAll({ users: { x: { id: 'x', createdAt: 1 } } }, Y);
  assert.deepStrictEqual(none.users, {}); assert.strictEqual(none.global.messages, 0); assert.strictEqual(none.global.credits, null); assert.strictEqual(none.global.topEmoji, null);
  step('an empty server builds an empty recap');
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-'));
  try {
    assert.strictEqual(R.latestYear(dir, at(1, 5)), null);
    assert.strictEqual(R.dueYear(dir, at(1, 5)), 2025, 'in January the year that just ended is due');
    assert.strictEqual(R.dueYear(dir, at(7, 5)), null, 'not in the middle of the year');
    const built = R.buildAll(world(), Y, () => 0);
    R.write(dir, Y, built);
    assert.strictEqual(R.dueYear(dir, Date.UTC(2027, 0, 1)), null, 'already built');
    assert.strictEqual(R.latestYear(dir, Date.UTC(2027, 0, 20)), 2026);
    assert.deepStrictEqual(R.read(dir, Y, 'a'), built.users.a);
    assert.deepStrictEqual(R.read(dir, Y), built.global);
    assert.strictEqual(R.read(dir, Y, 'nobody'), null);
    assert.strictEqual(R.read(dir, Y, '../global'), null, 'a path is not an id');
    assert.strictEqual(R.latestYear(dir, Date.UTC(2028, 5, 1)), null, 'a recap is not offered two years later');
    R.forget(dir, 'a');
    assert.strictEqual(R.read(dir, Y, 'a'), null, 'a deleted account takes its recap with it');
    assert.ok(R.read(dir, Y, 'b'), 'and nobody else');
    R.forget(dir, '../x'); R.forget(path.join(dir, 'missing'), 'a');
    step('files: written once, read back, a path is not an id, deleting an account removes its recap');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
console.log('\nAll recap checks passed.');
