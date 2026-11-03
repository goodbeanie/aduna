// Ads rules without a database: node server/ads-logic-test.js
const assert = require('assert');
const A = require('./ads');
const C = require('./credits');

const step = (m) => console.log('ok -', m);
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);
const env = { ADS_JSON: JSON.stringify([
  { id: 'acme', sponsor: 'Acme Games', title: 'Try Acme Quest', body: 'A free co-op game.', image: 'https://example.com/a.png', url: 'https://example.com/acme' },
  { id: 'bolt', sponsor: 'Bolt', title: 'Bolt Radio', url: 'https://example.com/bolt' },
]) };
const user = () => ({ id: 'u1', createdAt: 0 });

// --- the catalog ---
assert.deepStrictEqual(A.catalog({}), [], 'no ADS_JSON means no ads');
assert.deepStrictEqual(A.catalog({ ADS_JSON: 'not json' }), [], 'broken config means no ads, not a crash');
assert.deepStrictEqual(A.catalog({ ADS_JSON: '{"a":1}' }), [], 'must be an array');
const messy = A.catalog({ ADS_JSON: JSON.stringify([
  { id: 'ok', sponsor: 'S', title: 'T', url: 'https://example.com' },
  { id: 'ok', sponsor: 'S', title: 'dup id', url: 'https://example.com' },
  { id: 'http', sponsor: 'S', title: 'T', url: 'http://example.com' },
  { id: 'js', sponsor: 'S', title: 'T', url: 'javascript:alert(1)' },
  { id: 'badimg', sponsor: 'S', title: 'T', url: 'https://example.com', image: 'http://x.test/a.png' },
  { id: 'Bad Id!', sponsor: 'S', title: 'T', url: 'https://example.com' },
  { id: 'notitle', sponsor: 'S', url: 'https://example.com' },
]) });
assert.deepStrictEqual(messy.map((a) => a.id), ['ok'], 'only well-formed https sponsors survive');
step('catalog: off without config, drops anything malformed (http, javascript:, duplicate ids, missing fields)');

// --- the view ---
assert.deepStrictEqual(A.view(user(), { now: T0, env: {} }), { enabled: false });
const v = A.view(user(), { now: T0, env });
assert.deepStrictEqual([v.enabled, v.reward, v.dailyMax, v.left, v.seconds, v.locked], [true, 8, 5, 5, 15, false]);
assert.ok(v.sponsored && v.sponsored.url.startsWith('https://'));
assert.strictEqual(A.view(user(), { now: T0, env, unlocksAt: T0 + 1000 }).locked, true, 'a new account sees it locked');
assert.deepStrictEqual(A.view(user(), { now: T0, env }).sponsored, A.view(user(), { now: T0 + 3_600_000, env }).sponsored, 'the quiet card is stable through the day');
step('view: hidden without sponsors, shows reward, cap and a stable sponsored card');

// --- the feature switches: a feature that is off for this person shows nothing ---
assert.deepStrictEqual(A.view(user(), { now: T0, env, rewarded: false, sponsored: false }), { enabled: false }, 'both switches off: nothing at all');
const onlyReward = A.view(user(), { now: T0, env, rewarded: true, sponsored: false });
assert.ok(onlyReward.enabled && onlyReward.rewarded && onlyReward.sponsored === null, 'only the sponsor button');
const onlyCard = A.view(user(), { now: T0, env, rewarded: false, sponsored: true });
assert.ok(onlyCard.enabled && !onlyCard.rewarded && onlyCard.sponsored && onlyCard.sponsored.url, 'only the quiet card');
const cv = (features) => C.view(user(), { users: {}, friendships: {}, servers: {}, emojis: {} }, { purchases: false, now: T0, features }).ads;
process.env.ADS_JSON = env.ADS_JSON;
assert.deepStrictEqual(cv(undefined), { enabled: false }, 'credits view: no feature switches means no ads');
assert.strictEqual(cv({ rewarded: true }).rewarded, true, 'credits view: rewarded-ads on shows the button');
assert.strictEqual(cv({ sponsored: true }).rewarded, false, 'credits view: sponsored-card alone has no button');
delete process.env.ADS_JSON;
step('feature switches: rewarded-ads and sponsored-card each turn their own part on, and neither means nothing shows');

// --- a full rewarded view ---
const u = user();
const s = A.start(u, { now: T0, env });
assert.ok(s.ok && s.token.length === 32 && s.seconds === 15);
let r = A.complete(u, s.token, { grant: C.grant, now: T0 + 5_000, env });
assert.deepStrictEqual([r.status, r.error], [425, 'Keep watching a little longer'], 'too early pays nothing');
assert.ok(!u.credits || u.credits.balance === 0);
r = A.complete(u, 'f'.repeat(32), { grant: C.grant, now: T0 + 16_000, env });
assert.strictEqual(r.status, 400, 'a made-up token pays nothing');
r = A.complete(u, s.token, { grant: C.grant, now: T0 + 16_000, env });
assert.deepStrictEqual([r.ok, r.amount], [true, 8]);
assert.strictEqual(u.credits.balance, 8);
assert.strictEqual(u.credits.ledger[0].reason, 'ad');
r = A.complete(u, s.token, { grant: C.grant, now: T0 + 17_000, env });
assert.strictEqual(r.status, 400, 'one view pays once');
assert.strictEqual(u.credits.balance, 8);
step('rewarded view: too early and fake tokens pay nothing, a real one pays 8 once');

// --- cooldown and daily cap ---
assert.strictEqual(A.start(u, { now: T0 + 20_000, env }).status, 429, 'cooldown between views');
let now = T0 + 16_000;
for (let i = 2; i <= 5; i++) {
  now += 61_000;
  const st = A.start(u, { now, env });
  assert.ok(st.ok, 'view ' + i + ' starts');
  assert.ok(A.complete(u, st.token, { grant: C.grant, now: now + 15_000, env }).ok);
  now += 15_000;
}
assert.strictEqual(u.credits.balance, 40, 'five views = 40 credits');
assert.strictEqual(A.start(u, { now: now + 61_000, env }).status, 429, 'daily cap holds');
assert.strictEqual(A.view(u, { now: now + 61_000, env }).left, 0);
const next = A.start(u, { now: Date.UTC(2026, 10, 4, 0, 5), env });
assert.ok(next.ok, 'the cap resets at midnight UTC');
step('cooldown and the daily cap of 5 (40 credits) hold, and reset at midnight UTC');

// --- stale and locked ---
const w = user();
const sw = A.start(w, { now: T0, env });
assert.strictEqual(A.complete(w, sw.token, { grant: C.grant, now: T0 + 11 * 60_000, env }).status, 410, 'a view left open too long is thrown away');
assert.strictEqual(A.complete(w, sw.token, { grant: C.grant, now: T0 + 11 * 60_000 + 1, env }).status, 400);
assert.strictEqual(A.start(user(), { now: T0, env, unlocksAt: T0 + 1000 }).status, 403, 'new accounts wait 30 minutes');
assert.strictEqual(A.start(user(), { now: T0, env: {} }).status, 404, 'no sponsors, no rewarded views');
step('stale views expire, new accounts wait, nothing happens without sponsors');

console.log('\nAll ads logic checks passed.');
