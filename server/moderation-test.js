// Warnings, mutes, timed suspensions and IP bans without a server: node server/moderation-test.js
const assert = require('assert');
const M = require('./moderation');
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const T = 1_700_000_000_000;
const step = (s) => console.log('ok -', s);

// warnings: they must be read, and they add up
const u = { id: 'u1' };
assert.deepStrictEqual(M.warn(u, { by: 'a', reason: '   ', now: T }), { error: 'Write what the warning is for' }, 'a warning needs a reason');
let r = M.warn(u, { by: 'a', reason: 'spamming\n the  lounge', now: T });
assert.strictEqual(r.warning.reason, 'spamming the lounge', 'line breaks and doubled spaces are tidied');
assert.deepStrictEqual([r.count, r.escalation], [1, null]);
assert.ok(M.sendBlock(u, T), 'an unread warning blocks sending');
assert.strictEqual(M.view(u, T).pending.length, 1);
assert.strictEqual(M.acknowledge(u, T + 1), 1);
assert.strictEqual(M.sendBlock(u, T + 1), null, 'after "I understand" they can send again');
assert.strictEqual(M.view(u, T + 1), null, 'nothing to show');
assert.strictEqual(M.acknowledge(u, T + 2), 0, 'pressing it twice changes nothing');
step('warnings must be read');

// escalation: 3 = 24h mute, 5 = 7 day suspension
r = M.warn(u, { by: 'a', reason: 'two', now: T + DAY });
assert.strictEqual(r.escalation, null);
r = M.warn(u, { by: 'a', reason: 'three', now: T + 2 * DAY });
assert.deepStrictEqual([r.count, r.escalation.type, r.escalation.hours], [3, 'mute', 24]);
r = M.warn(u, { by: 'a', reason: 'four', now: T + 3 * DAY });
assert.strictEqual(r.escalation, null, 'only the 3rd and 5th warning escalate, not every one after');
r = M.warn(u, { by: 'a', reason: 'five', now: T + 4 * DAY });
assert.deepStrictEqual([r.count, r.escalation.type, r.escalation.hours], [5, 'suspend', 168]);
step('escalation');

// warnings stop counting after 90 days, and an admin can take one back
const old = { id: 'u2' };
for (let i = 0; i < 2; i++) M.warn(old, { reason: 'old ' + i, now: T });
r = M.warn(old, { reason: 'new', now: T + 91 * DAY });
assert.deepStrictEqual([r.count, r.escalation], [1, null], 'the two old ones no longer count');
assert.strictEqual(M.adminView(old, T + 91 * DAY).warnings.filter((w) => w.counts).length, 1);
assert.ok(M.retractWarning(old, r.warning.id));
assert.ok(!M.retractWarning(old, 'nope'));
assert.strictEqual(M.warningsOf(old).length, 2);
const many = { id: 'u3' };
for (let i = 0; i < 80; i++) M.warn(many, { reason: 'x' + i, now: T + i });
assert.strictEqual(M.warningsOf(many).length, M.LIMITS.keep, 'the list is capped');
step('90 day window, retract, cap');

// mutes
const m = { id: 'm' };
assert.ok(M.setMute(m, { reason: '', hours: 1, now: T }).error, 'a mute needs a reason');
assert.ok(M.setMute(m, { reason: 'x', hours: 0, now: T }).error);
assert.ok(M.setMute(m, { reason: 'x', hours: -3, now: T }).error);
assert.ok(M.setMute(m, { reason: 'x', hours: 'abc', now: T }).error);
assert.ok(M.setMute(m, { reason: 'x', hours: 24 * 31, now: T }).error, 'a mute is at most 30 days');
assert.ok(M.setMute(m, { reason: 'flooding', hours: 3, now: T }).mute);
assert.ok(M.muted(m, T + 2 * HOUR) && !M.muted(m, T + 3 * HOUR), 'a mute ends exactly at its time');
assert.match(M.sendBlock(m, T), /muted for 3 hours: flooding/);
assert.match(M.sendBlock(m, T + 170 * 60_000), /muted for 10 minutes/);
assert.deepStrictEqual(M.view(m, T).mute, { reason: 'flooding', until: T + 3 * HOUR });
step('mutes');

// suspensions: timed or until lifted
const s = { id: 's' };
assert.ok(M.setSuspension(s, { reason: 'x', hours: 99999, now: T }).error);
M.setSuspension(s, { by: 'a', reason: 'rude', now: T });
assert.ok(M.suspendedNow(s, T + 400 * DAY), 'no hours = until an admin lifts it (as before)');
assert.strictEqual(s.suspended.until, undefined);
M.setSuspension(s, { by: 'a', reason: 'rude', hours: 48, now: T });
assert.ok(M.suspendedNow(s, T + 47 * HOUR) && !M.suspendedNow(s, T + 48 * HOUR));
assert.ok(M.suspendedNow({ suspended: { at: 1, reason: 'old record' } }, T), 'older records without `until` still count');
step('suspensions');

// what has run out
const users = {
  a: { id: 'a', mute: { until: T - 1 } }, b: { id: 'b', mute: { until: T + 1 } },
  c: { id: 'c', suspended: { until: T } }, d: { id: 'd', suspended: {} }, e: { id: 'e', suspended: { until: T + HOUR } }, f: { id: 'f' },
};
assert.deepStrictEqual(M.expired(users, T), { unmute: ['a'], unsuspend: ['c'] }, 'an indefinite suspension never runs out');
step('what has run out');

// IP rules
assert.strictEqual(M.parseRule('1.2.3.4').text, '1.2.3.4');
assert.strictEqual(M.parseRule('1.2.3.77/24').text, '1.2.3.0/24', 'a range is shown from its first address');
assert.strictEqual(M.parseRule('::ffff:9.9.9.9').text, '9.9.9.9', 'IPv4 inside IPv6 is IPv4');
assert.strictEqual(M.parseRule('2001:db8::1').kind, 'exact');
for (const bad of ['', 'abc', '1.2.3', '1.2.3.256', '1.2.3.4/33', '1.2.3.4/x', '1.2.3.4/8/8', '2001:db8::/32', '1.2.3.4 ; drop', null, undefined]) assert.strictEqual(M.parseRule(bad), null, 'refused: ' + bad);
step('rules');

// the ban list
const bans = M.createIpBans();
let b = bans.add({ rule: '10.0.0.0/24', reason: 'attack', by: 'a', now: T });
assert.strictEqual(b.ban.until, T + 30 * DAY, 'the default ban lasts 30 days');
assert.ok(bans.matches('10.0.0.77', T) && bans.matches('::ffff:10.0.0.1', T), 'inside the range, also when it arrives inside IPv6');
assert.ok(!bans.matches('10.0.1.77', T) && !bans.matches('9.255.255.255', T) && !bans.matches('', T) && !bans.matches('junk', T));
assert.ok(!bans.matches('10.0.0.77', T + 31 * DAY), 'a ban that ran out no longer blocks');
assert.strictEqual(bans.add({ rule: '5.5.5.5', reason: 'forever', hours: null, now: T }).ban.until, null);
assert.ok(bans.matches('5.5.5.5', T + 9999 * DAY));
assert.strictEqual(bans.add({ rule: '6.6.6.6', reason: 'x', hours: 2, now: T }).ban.until, T + 2 * HOUR);
assert.ok(bans.add({ rule: '6.6.6.7', reason: 'x', hours: 0, now: T }).error);
assert.ok(bans.add({ rule: '6.6.6.7', reason: '  ', now: T }).error, 'needs a reason');
assert.ok(bans.add({ rule: 'nonsense', reason: 'x', now: T }).error);
const wide = bans.add({ rule: '20.0.0.0/12', reason: 'x', now: T });
assert.strictEqual(wide.code, 'large_range', 'a wide range needs a second confirmation');
assert.ok(bans.add({ rule: '20.0.0.0/12', reason: 'x', now: T, confirmLarge: true }).ban);
assert.ok(bans.add({ rule: '30.0.0.0/7', reason: 'x', now: T, confirmLarge: true }).error, 'never wider than /8');
const own = bans.add({ rule: '7.7.7.0/24', reason: 'x', now: T, selfIp: '::ffff:7.7.7.9' });
assert.strictEqual(own.code, 'own_ip', 'an admin cannot ban their own connection');
assert.ok(bans.add({ rule: '2001:db8::5', reason: 'x', now: T }).ban && bans.matches('2001:DB8::5', T), 'exact IPv6');
step('the ban list');

// the same rule again replaces the old ban; lifting; saving and loading
const n = bans.active(T).length;
bans.add({ rule: '10.0.0.5/24', reason: 'second thoughts', hours: 1, now: T });
assert.strictEqual(bans.active(T).length, n, 'not a duplicate');
assert.strictEqual(bans.active(T).find((x) => x.rule === '10.0.0.0/24').reason, 'second thoughts');
const id = bans.active(T).find((x) => x.rule === '5.5.5.5').id;
assert.ok(bans.remove(id) && !bans.remove(id));
assert.ok(!bans.matches('5.5.5.5', T), 'lifted');
const again = M.createIpBans(JSON.parse(JSON.stringify(bans.snapshot())));
assert.deepStrictEqual(again.active(T), bans.active(T), 'what is saved comes back the same');
assert.ok(again.matches('10.0.0.200', T));
assert.strictEqual(M.createIpBans([{ id: 1, rule: '1.1.1.1' }, { id: 'x', rule: 'bad' }, null, 'str', { id: 'ok', rule: '2.2.2.2', reason: 'r' }]).snapshot().length, 1, 'damaged saved entries are dropped');
assert.ok(bans.prune(T + 40 * DAY) > 0 && bans.snapshot().every((x) => !x.until || x.until > T + 40 * DAY), 'expired bans are pruned');
step('replace, lift, save and load, prune');

// admin view
const av = M.adminView(u, T + 5 * DAY, (x) => 'name-' + x);
assert.strictEqual(av.activeWarnings, 5);
assert.strictEqual(av.warnings[0].reason, 'five');
assert.strictEqual(av.warnings[0].by, 'name-a');
step('admin view');

console.log('moderation: all good');
