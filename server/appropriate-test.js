// The appropriateness checker without a server: node server/appropriate-test.js
const assert = require('assert');
const A = require('./appropriate');
const DAY = 24 * 3600 * 1000;
const step = (s) => console.log('ok -', s);

// names
assert.ok(A.flagged('hitler_fan', 'name'));
assert.ok(A.flagged('xXfuckerXx', 'name'), 'hidden inside another word');
assert.ok(A.flagged('n1gg3r', 'name'), 'look-alike characters');
assert.ok(A.flagged('Free Porn', 'name'));
assert.strictEqual(A.flagged('Scunthorpe_FC', 'name'), null);
assert.strictEqual(A.flagged('peacock', 'name'), null, 'a short word only matches whole');
assert.strictEqual(A.flagged('Dickens', 'name'), null);
assert.strictEqual(A.flagged('cucumber', 'name'), null);
assert.strictEqual(A.flagged('Maya', 'name'), null);
step('names');

// free text
assert.strictEqual(A.flagged('I am a therapist from Scunthorpe', 'text'), null);
assert.ok(A.flagged('please kill yourself', 'text'));
assert.strictEqual(A.problem('Maya', 'username'), null);
assert.ok(/username/.test(A.problem('nazi_boy', 'username')));
assert.ok(/channel name/.test(A.problem('porn-chat', 'channel')));
step('text and messages');

// scan
const user = (o) => ({ id: 'u', username: 'maya', displayName: 'maya', bio: '', createdAt: 1, ...o });
assert.deepStrictEqual(A.scan(user({})), []);
assert.deepStrictEqual(A.scan(user({ username: 'nazi_boy', displayName: 'nazi_boy' })).map((i) => i.field), ['username'], 'a display name equal to the username is not listed twice');
assert.deepStrictEqual(A.scan(user({ displayName: 'Hitler Fan', bio: 'porn' })).map((i) => i.field), ['displayName', 'bio']);
assert.deepStrictEqual(A.scan(user({}), [{ id: 's1', name: 'Rape Zone' }, { id: 's2', name: 'Fun' }]).map((i) => i.serverId), ['s1']);
assert.deepStrictEqual(A.scan(user({ bot: true, username: 'nazi' })), [], 'bots are never flagged');
assert.deepStrictEqual(A.scan(user({ deleted: { at: 1 }, username: 'nazi' })), []);
assert.deepStrictEqual(A.scan(user({ displayName: 'Dick', nameOk: ['displayName:Dick'] })), [], 'an admin said this value is fine');
assert.strictEqual(A.scan(user({ displayName: 'Dick', nameOk: ['displayName:Dick'] }), []).length, 0);
assert.strictEqual(A.scan(user({ displayName: 'Dick Fan', nameOk: ['displayName:Dick'] })).length, 1, 'a changed value is checked again');
step('scan');

// plan: warn, then the 3 days start when the warning is SEEN
const T = 1_000_000 * DAY;
const users = {
  ok: user({ id: 'ok' }),
  bad: user({ id: 'bad', username: 'nazi_boy', displayName: 'nazi_boy' }),
  unseen: user({ id: 'unseen', username: 'porn_fan', displayName: 'x', nameWarning: { at: T - 10 * DAY } }),
  waiting: user({ id: 'waiting', username: 'porn_fan2', nameWarning: { at: T - 5 * DAY, seenAt: T - 2 * DAY } }),
  late: user({ id: 'late', username: 'porn_fan3', nameWarning: { at: T - 9 * DAY, seenAt: T - 4 * DAY } }),
  fixed: user({ id: 'fixed', nameWarning: { at: T - 4 * DAY, seenAt: T - 4 * DAY } }),
  admin: user({ id: 'admin', username: 'porn_admin', nameWarning: { at: T - 9 * DAY, seenAt: T - 9 * DAY } }),
  bot: user({ id: 'bot', bot: true, username: 'nazi' }),
};
const p = A.plan(users, () => [], T, (u) => u.id === 'admin');
assert.deepStrictEqual(p.warn, ['bad'], 'a new flag starts a warning, not a deletion');
assert.deepStrictEqual(p.remove, ['late'], 'only seen warnings whose 3 days are over');
assert.deepStrictEqual(p.clear.sort(), ['admin', 'fixed'], 'fixed or exempt: the warning goes');
assert.ok(!p.remove.includes('unseen'), 'a warning nobody has seen never runs out');
step('plan');

// view
const v = A.view(users.waiting, [], T);
assert.strictEqual(v.daysLeft, 1);
assert.strictEqual(A.view(users.unseen, [], T).daysLeft, 3, 'the clock has not started yet');
assert.strictEqual(A.view(users.fixed, [], T), null);
assert.strictEqual(A.view(users.ok, [], T), null);
assert.strictEqual(A.deadlineOf(users.waiting.nameWarning), T + DAY);
step('view');
console.log('\nappropriate: all passed');
