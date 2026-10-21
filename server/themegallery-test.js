// Theme gallery rules (no database): node server/themegallery-test.js
const assert = require('assert');
const g = require('./themegallery');
const step = (m) => console.log('✓', m);
const WORDS = ['porn', 'nazi'];

(async () => {
  // the server's colour maths must match the client's, or the readability check would judge a different theme than people see
  const client = await import('../client/src/themes.js');
  for (const t of client.THEMES) {
    const seed = { dark: t.dark, bg: t.bg, accent: t.accent };
    const v = client.buildPalette(seed);
    assert.strictEqual(g.textOn(seed), v['--text'], t.id + ': text colour agrees with the client');
    assert.strictEqual(g.readabilityProblem(seed), null, t.id + ': every built-in theme passes the readability check');
  }
  step('the server computes the same text colour as the client, and every built-in theme is readable');

  assert.deepStrictEqual(g.cleanSeed({ dark: true, bg: '#ABCDEF', accent: '#112233' }), { dark: true, bg: '#abcdef', accent: '#112233' });
  for (const bad of [null, 'x', {}, { dark: 'yes', bg: '#000000', accent: '#ffffff' }, { dark: true, bg: 'red', accent: '#ffffff' }, { dark: true, bg: '#000', accent: '#ffffff' },
    { dark: true, bg: '#000000', accent: 'url(x)' }, { dark: true, bg: { a: 1 }, accent: '#ffffff' }]) assert.strictEqual(g.cleanSeed(bad), null, JSON.stringify(bad));
  step('only {dark, bg, accent} with six-digit colours is a theme; anything else (CSS, objects, short hex) is refused');

  // readability
  assert.ok(g.readabilityProblem({ dark: true, bg: '#ffffff', accent: '#000000' }), 'a dark flag on a white background: white text on white');
  assert.ok(g.readabilityProblem({ dark: false, bg: '#000000', accent: '#ffffff' }), 'a light flag on black');
  assert.ok(g.readabilityProblem({ dark: true, bg: '#1b1f2a', accent: '#1d2230' }), 'accent the same as the background');
  assert.ok(g.readabilityProblem({ dark: true, bg: '#777777', accent: '#ff0000' }), 'mid grey is unreadable either way');
  assert.strictEqual(g.readabilityProblem({ dark: true, bg: '#1b1f2a', accent: '#ff7a90' }), null);
  step('unreadable combinations are refused with a sentence that says what to change');

  // publish checks
  const ok = { name: '  Night   Owl ', description: 'Dark blue with a pink accent', seed: { dark: true, bg: '#1b1f2a', accent: '#ff7a90' } };
  const c = g.checkPublish(ok, WORDS);
  assert.deepStrictEqual(c.ok, { name: 'Night Owl', description: 'Dark blue with a pink accent', seed: ok.seed });
  assert.ok(g.checkPublish({ ...ok, name: 'a' }, WORDS).error, 'name too short');
  assert.ok(g.checkPublish({ ...ok, name: 'Porn pink' }, WORDS).error, 'blocked word in the name');
  assert.ok(g.checkPublish({ ...ok, description: 'get nazi stuff' }, WORDS).error, 'blocked word in the description');
  assert.ok(g.checkPublish({ ...ok, description: 'see https://evil.example' }, WORDS).error, 'links refused');
  assert.ok(g.checkPublish({ ...ok, name: 'visit evil.com' }, WORDS).error, 'links refused in the name');
  assert.ok(g.checkPublish({ ...ok, seed: { dark: true, bg: '#ffffff', accent: '#000000' } }, WORDS).error, 'unreadable refused');
  assert.ok(g.checkPublish({ ...ok, seed: 'nope' }, WORDS).error);
  assert.strictEqual(g.checkPublish({ ...ok, name: '<b>Bold</b>\u0000x' }, WORDS).ok.name, ' b Bold /b x'.trim().replace(/\s+/g, ' '), 'angle brackets and control characters are removed');
  assert.strictEqual(g.checkPublish({ ...ok, name: 'x'.repeat(200) }, WORDS).ok.name.length, g.THEME.nameMax, 'long names are cut');
  step('names and descriptions are cleaned, filtered for blocked words and links, and the colours must be readable');

  // limits
  const T = (o) => ({ id: Math.random().toString(16).slice(2), name: 'n', description: '', seed: { dark: true, bg: '#1b1f2a', accent: '#ff7a90' }, ownerId: 'u1', createdAt: 0, uses: 0, reports: [], hidden: false, ...o });
  const hour = 3600e3, now = 10 * hour;
  assert.strictEqual(g.publishLimit([], 'u1', ok.seed, now), null);
  assert.ok(g.publishLimit([T({})], 'u1', ok.seed, now), 'the same colours twice');
  assert.strictEqual(g.publishLimit([T({})], 'u2', ok.seed, now), null, 'another person may publish the same colours');
  const many = Array.from({ length: g.THEME.maxOwned }, (_, i) => T({ seed: { dark: true, bg: '#1b1f2a', accent: '#ff7a' + (10 + i) } }));
  assert.ok(g.publishLimit(many, 'u1', { dark: true, bg: '#1b1f2a', accent: '#00ff00' }, now), 'a cap per person');
  const fast = Array.from({ length: g.THEME.perHour }, (_, i) => T({ createdAt: now - 1000, seed: { dark: true, bg: '#1b1f2a', accent: '#ff7a' + (10 + i) } }));
  assert.ok(g.publishLimit(fast, 'u1', { dark: true, bg: '#1b1f2a', accent: '#00ff00' }, now), 'a cap per hour');
  assert.strictEqual(g.publishLimit([T({ hidden: true })], 'u1', ok.seed, now), null, 'a hidden theme does not block the same colours or count toward the cap');
  step('limits: 20 per person, 6 per hour, no duplicate colours from the same person');

  // reports hide a theme only when enough ESTABLISHED accounts agree
  const now2 = 100 * hour; // established = older than a day
  const users = { a: { createdAt: 0 }, b: { createdAt: 0 }, c: { createdAt: 0 }, n1: { createdAt: now2 - 1000 }, n2: { createdAt: now2 - 1000 }, n3: { createdAt: now2 - 1000 } };
  const t = T({});
  for (const u of ['n1', 'n2', 'n3']) g.addReport(t, u, now2);
  assert.strictEqual(g.shouldHide(t, users, now2), false, 'three brand-new accounts cannot hide a theme');
  g.addReport(t, 'a', now2); g.addReport(t, 'a', now2); g.addReport(t, 'b', now2);
  assert.strictEqual(t.reports.filter((r) => r.by === 'a').length, 1, 'one report per person');
  assert.strictEqual(g.shouldHide(t, users, now2), false, 'two established reports are not enough');
  g.addReport(t, 'c', now2);
  assert.strictEqual(g.shouldHide(t, users, now2), true, 'three established accounts hide it');
  step('reports: one per person, and only established accounts count toward hiding');

  // listing
  const us = { u1: { id: 'u1', displayName: 'Ann' }, u2: { id: 'u2', username: 'bob' } };
  const all = [T({ id: 'a', name: 'Sky', uses: 5, createdAt: 1, ownerId: 'u1', seed: { dark: false, bg: '#f3f8fb', accent: '#1f5f8b' } }),
    T({ id: 'b', name: 'Coal', uses: 9, createdAt: 2, ownerId: 'u2' }), T({ id: 'c', name: 'Mint', uses: 9, createdAt: 3, ownerId: 'u1', description: 'fresh' }), T({ id: 'd', name: 'Gone', hidden: true, uses: 99 })];
  assert.deepStrictEqual(g.list(all, us, {}).themes.map((x) => x.id), ['c', 'b', 'a'], 'popular first, newest breaks ties, hidden never listed');
  assert.deepStrictEqual(g.list(all, us, { sort: 'new' }).themes.map((x) => x.id), ['c', 'b', 'a']);
  assert.deepStrictEqual(g.list(all, us, { mode: 'light' }).themes.map((x) => x.id), ['a']);
  assert.deepStrictEqual(g.list(all, us, { q: 'ann' }).themes.map((x) => x.id), ['c', 'a'], 'search by author');
  assert.deepStrictEqual(g.list(all, us, { q: 'FRESH' }).themes.map((x) => x.id), ['c'], 'search by description');
  const p = g.list(all, us, { limit: 2 }); assert.strictEqual(p.themes.length, 2); assert.strictEqual(p.more, true);
  assert.strictEqual(g.list(all, us, { offset: 2, limit: 2 }).more, false);
  assert.strictEqual(g.list(all, us, { uid: 'u1' }).themes.find((x) => x.id === 'a').mine, true);
  assert.ok(!('ownerId' in g.list(all, us, {}).themes[0]) && !('reports' in g.list(all, us, {}).themes[0]), 'the public view hides who reported and the owner id field');
  step('listing: sort, light/dark filter, search, paging, hidden themes excluded, reports never exposed');
  console.log('\nthemegallery-test: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
