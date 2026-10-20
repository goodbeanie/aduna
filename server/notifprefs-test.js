// Notification settings rules: node server/notifprefs-test.js (no database)
const assert = require('assert');
const np = require('./notifprefs');

const T = 1_000_000;
const H = 3600 * 1000;
const step = (m) => console.log('✓', m);

// ---- muteActive / cleanMute ----
assert.strictEqual(np.muteActive({ until: null }, T), true, 'forever');
assert.strictEqual(np.muteActive({ until: T + 1 }, T), true);
assert.strictEqual(np.muteActive({ until: T }, T), false, 'expires exactly at until');
assert.strictEqual(np.muteActive({ until: 'x' }, T), false);
assert.strictEqual(np.muteActive(undefined, T), false);
assert.deepStrictEqual(np.cleanMute({ until: null }, T), { until: null });
assert.deepStrictEqual(np.cleanMute({ until: T + H }, T), { until: T + H });
assert.strictEqual(np.cleanMute({ until: T - 1 }, T), undefined, 'a time in the past is no mute');
assert.deepStrictEqual(np.cleanMute({ until: T + 10 * 366 * 24 * H }, T), { until: null }, 'far future = forever');
assert.strictEqual(np.cleanMute({ until: NaN }, T), undefined);
assert.strictEqual(np.cleanMute({ until: Infinity }, T), undefined);
assert.strictEqual(np.cleanMute('yes', T), undefined);
assert.strictEqual(np.cleanMute(null, T), undefined);
step('mute parsing and expiry');

// ---- cleanServerPrefs ----
const chans = ['c1', 'c2'];
assert.deepStrictEqual(np.cleanServerPrefs({}, chans, T), {}, 'empty = defaults');
assert.deepStrictEqual(np.cleanServerPrefs({ level: 'all' }, chans, T), {}, 'default level is not stored');
assert.deepStrictEqual(np.cleanServerPrefs({ level: 'mentions', noEveryone: true, noAnnouncements: false }, chans, T), { level: 'mentions', noEveryone: true });
assert.deepStrictEqual(np.cleanServerPrefs({ mute: { until: null } }, chans, T), { mute: { until: null } });
assert.deepStrictEqual(np.cleanServerPrefs({ mute: null }, chans, T), {}, 'null unmutes');
assert.deepStrictEqual(np.cleanServerPrefs({ channels: { c1: { level: 'default' } } }, chans, T), {}, 'default channel entries vanish');
assert.deepStrictEqual(np.cleanServerPrefs({ channels: { c1: { level: 'nothing', mute: { until: T + H } }, c2: {} } }, chans, T), { channels: { c1: { level: 'nothing', mute: { until: T + H } } } });
for (const bad of [null, [], 'x', 5, { level: 'loud' }, { level: 5 }, { noEveryone: 'yes' }, { mute: 'x' }, { channels: [] }, { channels: { nope: { level: 'all' } } }, { channels: { c1: 'x' } }, { channels: { c1: { level: 'shout' } } }, { channels: { c1: { mute: 3 } } }, { channels: null }]) {
  assert.strictEqual(np.cleanServerPrefs(bad, chans, T), null, 'rejects ' + JSON.stringify(bad));
}
const hostile = JSON.parse('{"__proto__":{"level":"nothing"},"channels":{"__proto__":{"level":"all"}}}');
assert.strictEqual(np.cleanServerPrefs(hostile, chans, T), null, 'a channels entry named __proto__ is an unknown channel');
assert.deepStrictEqual(np.cleanServerPrefs(JSON.parse('{"__proto__":{"level":"nothing"}}'), chans, T), {}, 'a __proto__ key is ignored, not applied');
assert.strictEqual(({}).level, undefined, 'prototype was not polluted');
assert.strictEqual(np.effective({ channels: JSON.parse('{"__proto__":{"level":"nothing"}}') }, '__proto__', T).level, 'all', 'reading a stored __proto__ key does not leak');
step('validation (types, unknown channels, defaults dropped, hostile keys)');

// ---- effective ----
assert.deepStrictEqual(np.effective(undefined, 'c1', T), { muted: false, serverMuted: false, channelMuted: false, level: 'all' });
let sp = { level: 'mentions', channels: { c1: { level: 'all' }, c2: { mute: { until: T + H } } } };
assert.strictEqual(np.effective(sp, 'c1', T).level, 'all', 'channel level beats server level');
assert.strictEqual(np.effective(sp, 'c3', T).level, 'mentions', 'unlisted channel follows the server');
assert.strictEqual(np.effective(sp, 'c2', T).muted, true);
assert.strictEqual(np.effective(sp, 'c2', T + 2 * H).muted, false, 'timed mute ends by itself');
assert.strictEqual(np.effective({ mute: { until: null } }, 'c9', T).muted, true, 'server mute covers every channel');
step('effective settings: channel overrides server, mutes expire');

// ---- decide ----
const d = (s, kind) => np.decide(s, 'c1', kind, T);
assert.deepStrictEqual(d(undefined, 'message'), { count: true, alert: false }, 'ordinary message: counted, never alerts');
assert.deepStrictEqual(d(undefined, 'mention'), { count: true, alert: true });
assert.deepStrictEqual(d(undefined, 'everyone'), { count: true, alert: true });
assert.deepStrictEqual(d(undefined, 'announcement'), { count: true, alert: true });
const muted = { mute: { until: null } };
assert.deepStrictEqual(d(muted, 'message'), { count: false, alert: false }, 'muted: no unread number');
assert.deepStrictEqual(d(muted, 'mention'), { count: true, alert: false }, 'muted: a direct mention is still counted, silently');
assert.deepStrictEqual(d(muted, 'everyone'), { count: true, alert: false });
assert.deepStrictEqual(d(muted, 'announcement'), { count: false, alert: false });
const mo = { level: 'mentions' };
assert.deepStrictEqual(d(mo, 'message'), { count: false, alert: false }, 'mentions only: ordinary messages are not counted');
assert.deepStrictEqual(d(mo, 'mention'), { count: true, alert: true });
assert.deepStrictEqual(d(mo, 'announcement'), { count: false, alert: true }, 'announcements still alert unless switched off');
const none = { level: 'nothing' };
for (const k of ['message', 'mention', 'everyone', 'announcement']) assert.deepStrictEqual(d(none, k), { count: false, alert: false }, 'nothing: ' + k);
assert.deepStrictEqual(d({ noEveryone: true }, 'everyone'), { count: false, alert: false }, '@everyone off');
assert.deepStrictEqual(d({ noEveryone: true }, 'mention'), { count: true, alert: true }, 'direct mention unaffected by @everyone off');
assert.deepStrictEqual(d({ noAnnouncements: true }, 'announcement'), { count: true, alert: false }, 'announcement alerts off');
assert.deepStrictEqual(np.decide({ level: 'nothing', channels: { c1: { level: 'all' } } }, 'c1', 'mention', T), { count: true, alert: true }, 'channel can opt back in');
step('decisions for message / mention / @everyone / announcement under every setting');

// ---- countChannel ----
const msgs = [
  { createdAt: 10, authorId: 'u2' },                                   // before the read position
  { createdAt: 101, authorId: 'u2' },
  { createdAt: 102, authorId: 'u2', mentions: ['me'] },
  { createdAt: 103, authorId: 'u3', everyone: true },
  { createdAt: 104, authorId: 'me' },                                  // my own: never counts
  { createdAt: 105, authorId: 'u2', mentions: ['someone-else'] },
];
let c = np.countChannel(undefined, 'c1', msgs, 100, 'me', T);
assert.deepStrictEqual(c, { unread: 2, mentions: 2 }, 'defaults: 2 plain, 1 direct + 1 @everyone');
c = np.countChannel({ noEveryone: true }, 'c1', msgs, 100, 'me', T);
assert.deepStrictEqual(c, { unread: 3, mentions: 1 }, '@everyone off: it is just another unread message');
c = np.countChannel({ level: 'mentions' }, 'c1', msgs, 100, 'me', T);
assert.deepStrictEqual(c, { unread: 0, mentions: 2 }, 'mentions only');
c = np.countChannel(muted, 'c1', msgs, 100, 'me', T);
assert.deepStrictEqual(c, { unread: 0, mentions: 2 }, 'muted keeps the @ count');
c = np.countChannel(none, 'c1', msgs, 100, 'me', T);
assert.deepStrictEqual(c, { unread: 0, mentions: 0 }, 'nothing');
c = np.countChannel(undefined, 'c1', msgs, 200, 'me', T);
assert.deepStrictEqual(c, { unread: 0, mentions: 0 }, 'read position past everything');
const many = Array.from({ length: 500 }, (_, i) => ({ createdAt: 1000 + i, authorId: 'u2', mentions: ['me'] }));
assert.deepStrictEqual(np.countChannel(undefined, 'c1', many, 0, 'me', T), { unread: 0, mentions: np.MAX_COUNT }, 'counts are capped');
step('counting unread and mentions after a read position');

// ---- readPosition ----
assert.strictEqual(np.readPosition({ reads: { c1: 50 }, readsFloor: 10 }, 'c1', 20), 50, 'saved position wins');
assert.strictEqual(np.readPosition({ readsFloor: 10 }, 'c1', 20), 20, 'else the later of floor and join time');
assert.strictEqual(np.readPosition({ readsFloor: 30 }, 'c1', 20), 30);
assert.strictEqual(np.readPosition({}, 'c1', undefined), 0);
assert.strictEqual(np.readPosition({ reads: { c1: 0 } }, 'c1', 20), 0, 'a saved 0 is a saved position');
step('read positions and fallbacks');

// ---- prune ----
const store = { s1: { mute: { until: T - 1 }, channels: { c1: { mute: { until: T - 1 } }, c2: { level: 'mentions' } } }, s2: { mute: { until: T - 5 } }, s3: { level: 'nothing' } };
assert.strictEqual(np.prune(store, T), true);
assert.deepStrictEqual(store, { s1: { channels: { c2: { level: 'mentions' } } }, s3: { level: 'nothing' } }, 'expired mutes and empty entries are removed');
assert.strictEqual(np.prune(store, T), false, 'nothing left to do');
step('pruning expired mutes');

console.log('\nnotifprefs: all passed');
