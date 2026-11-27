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
  servers: {
    s1: { id: 's1', name: 'Chess Club', iconImage: 'c'.repeat(32), createdAt: at(8, 1), visibility: 'public', members: ['a', 'b', 'c', 'bot', 'gone'], joinedAt: { a: at(2, 3), b: at(3, 3), c: Date.UTC(2025, 1, 1), bot: at(2, 3), gone: at(2, 3) } },
    s2: { id: 's2', name: 'Hidden', createdAt: Date.UTC(2024, 1, 1), visibility: 'private', members: ['a'], joinedAt: { a: at(5, 1) } },
    s3: { id: 's3', name: 'Aduna', createdAt: Date.UTC(2024, 1, 1), visibility: 'public', members: ['a', 'b', 'c'], joinedAt: { a: at(1, 5), b: at(1, 6), c: at(1, 7) } },
    s4: { id: 's4', name: 'Held', createdAt: Date.UTC(2024, 1, 1), visibility: 'public', listingHold: { state: 'hidden' }, members: ['a'], joinedAt: { a: at(5, 1) } },
    s5: { id: 's5', name: 'Art Room', createdAt: Date.UTC(2024, 1, 1), visibility: 'public', members: ['c', 'a'], joinedAt: { c: at(4, 4), a: Date.UTC(2025, 3, 4) } },
  },
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

  const withTrack = world();
  withTrack.users.a.song = { kind: 'track', tid: 111, title: 'Midnight City', artist: 'M83', art: '', preview: 'https://audio-ssl.itunes.apple.com/a/b.m4a', link: '', start: 4, end: 20 };
  const t = R.buildAll(withTrack, Y, () => 0).users.a.song;
  assert.deepStrictEqual([t.kind, t.title, t.url], ['track', 'Midnight City', 'https://audio-ssl.itunes.apple.com/a/b.m4a']);
  withTrack.users.a.song.preview = 'https://example.com/x.m4a';
  assert.strictEqual(R.buildAll(withTrack, Y, () => 0).users.a.song, null, 'a preview from outside Apple is not kept');
  step('a song picked from the search keeps its preview address');

  const two = world();
  two.users.c.song = { id: 'u'.repeat(32), title: 'Other One' };
  const both = R.buildAll(two, Y, () => 0).global;
  assert.deepStrictEqual(both.topSongs.map((s) => s.title), ['Low Tide', 'Other One'], 'the two most used songs, the most used first');
  assert.strictEqual(both.topSong.title, 'Low Tide');
  assert.strictEqual(g.topSongs.length, 1, 'one song in use is one song');
  assert.deepStrictEqual(R.pickTopN(new Map([['a', 3], ['b', 2], ['c', 2]]), 2, () => 0), ['a', 'b']);
  assert.deepStrictEqual(R.pickTopN(new Map([['a', 3]]), 2), ['a']);
  assert.deepStrictEqual(R.pickTopN(new Map(), 2), []);
  step('the top two songs');

  const grown = R.buildAll(world(), Y, () => 0, { skipServer: 's3' }).global.topServers;
  assert.deepStrictEqual(grown, [{ name: 'Chess Club', icon: 'c'.repeat(32), gained: 2 }, { name: 'Art Room', icon: null, gained: 1 }], 'people who joined this year and are still in, public and not held, without the official server, with the picture the server has');
  assert.ok(!R.buildAll(world(), Y, () => 0, { skipServer: 's3' }).global.topServers.some((s) => ['Hidden', 'Held', 'Aduna'].includes(s.name)));
  assert.deepStrictEqual(R.buildAll(world(), Y, () => 0, { skipServer: 's3', listed: (s) => s.name === 'Art Room' }).global.topServers, [{ name: 'Art Room', icon: null, gained: 1 }], 'the caller can narrow what is named');
  const many = world();
  for (const k of ['x1', 'x2', 'x3', 'x4', 'x5', 'x6']) many.servers[k] = { id: k, name: 'Extra ' + k, visibility: 'public', members: ['a'], joinedAt: { a: at(6, 6) } };
  assert.strictEqual(R.buildAll(many, Y, () => 0, { skipServer: 's3' }).global.topServers.length, 5, 'five at most');
  assert.deepStrictEqual(R.buildAll({ users: { x: { id: 'x', createdAt: 1 } } }, Y).global.topServers, []);
  step('the five public servers that grew the most, with their pictures and without the official one');

  const backed = world();
  Object.assign(backed.users.a, { username: 'amy', avatarImage: 'e'.repeat(32), storagePayments: [{ id: 'p0', at: Date.UTC(2025, 5, 1), plan: 'premium' }, { id: 'p1', at: at(3, 1), plan: 'spark' }, { id: 'p2', at: at(4, 1), plan: 'plus' }] });
  Object.assign(backed.users.b, { username: 'ben', storagePayments: [{ id: 'q1', at: at(5, 1) }] });
  Object.assign(backed.users.c, { username: 'cy', supporter: { rank: 'spark', until: at(9, 1) } });
  Object.assign(backed.users.bot, { username: 'robo', storagePayments: [{ id: 'r1', at: at(5, 1), plan: 'premium' }] });
  Object.assign(backed.users.gone, { username: 'gone', storagePayments: [{ id: 'g1', at: at(5, 1), plan: 'premium' }] });
  backed.users.d = { id: 'd', username: 'dee', createdAt: 1, storagePayments: [{ id: 'd1', at: Date.UTC(2025, 11, 31), plan: 'premium' }] };
  assert.deepStrictEqual(R.buildAll(backed, Y, () => 0).global.supporters, [
    { name: 'amy', tier: 'plus', icon: 'e'.repeat(32) },
    { name: 'ben', tier: 'plus', icon: null },
    { name: 'cy', tier: 'spark', icon: null },
  ], 'a payment in the year counts at its plan (none is Plus), the highest of the year wins, and bots, deleted accounts and other years do not');
  backed.users.b.storagePayments[0].plan = 'premium';
  assert.deepStrictEqual(R.buildAll(backed, Y, () => 0).global.supporters.map((x) => x.name + ':' + x.tier), ['ben:premium', 'amy:plus', 'cy:spark'], 'a higher rank comes first');
  backed.users.c.supporter = { rank: 'premium', until: Date.UTC(2027, 1, 1) };
  const gift = (now, year = Y) => R.buildAll(backed, year, () => 0, { now }).global.supporters.map((x) => x.name);
  assert.ok(gift(at(12, 1)).includes('cy'), 'a gift that is still running counts in the current year');
  assert.ok(!gift(Date.UTC(2027, 0, 20)).includes('cy'), 'but not when the recap is built for the year before');
  assert.deepStrictEqual(R.buildAll({ users: { x: { id: 'x', createdAt: 1 } } }, Y).global.supporters, []);
  const crowd = { users: {} };
  for (let i = 0; i < 305; i++) crowd.users['u' + i] = { id: 'u' + i, username: 'user' + i, createdAt: 1, supporter: { rank: 'spark', until: at(9, 1) } };
  assert.strictEqual(R.buildAll(crowd, Y, () => 0).global.supporters.length, 300, 'three hundred at most');
  step('supporters of the year: highest rank first, payments and gifts, no bots, deleted accounts or other years');

  const text = JSON.stringify(built);
  for (const leak of ['hi ', 'again', 'yo', 'a:b']) assert.ok(!text.includes(leak), 'no message text in the output: ' + leak);
  assert.strictEqual(typeof g.users, 'number', 'the global recap counts people');
  assert.ok(!/"userId"/.test(JSON.stringify(g)), 'and has no ids');
  assert.deepStrictEqual(g.supporters, [], 'nobody is named unless they supported Aduna');
  step('nothing from message text, and no people but the supporters');

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
