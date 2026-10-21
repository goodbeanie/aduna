// Group chat rules and the group call roster. Pure: no database, no sockets. node server/groups-test.js
const assert = require('assert');
const g = require('./groups');
const calllog = require('./calllog');
const step = (m) => console.log('✓', m);
const w = (n = 'a') => ({ ciphertext: 'Y2lwaGVy' + n, iv: 'aXYxMjM0NTY3OA==', pk: 'pkfp' + n });

// ---- wraps and names ----
assert.deepStrictEqual(g.cleanWrap(w()), w());
assert.strictEqual(g.cleanWrap({ ...w(), extra: 1 }).extra, undefined, 'unknown fields are dropped');
for (const bad of [null, [], 'x', {}, { ciphertext: '', iv: 'aa' }, { ciphertext: 'a'.repeat(401), iv: 'aa' }, { ciphertext: 'aa', iv: 'a'.repeat(33) }, { ciphertext: 'a b', iv: 'aa' }, { ciphertext: 'aa', iv: 'bb', pk: 5 }, { ciphertext: '<script>', iv: 'bb' }])
  assert.strictEqual(g.cleanWrap(bad), null, 'rejects ' + JSON.stringify(bad));
step('a wrapped key has a fixed, safe shape');

const ids = ['u1', 'u2', 'u3'];
const good = { u1: w('1'), u2: w('2'), u3: w('3') };
assert.deepStrictEqual(Object.keys(g.checkWraps(good, ids)).sort(), ids);
assert.strictEqual(g.checkWraps({ u1: w(), u2: w() }, ids), null, 'a missing member');
assert.strictEqual(g.checkWraps({ ...good, u4: w() }, ids), null, 'an extra person');
assert.strictEqual(g.checkWraps({ ...good, u3: { ciphertext: 1 } }, ids), null, 'a broken wrap');
assert.strictEqual(g.checkWraps([w(), w(), w()], ids), null);
assert.strictEqual(g.checkWraps(good, ['u1', 'u1', 'u2']), null, 'duplicate ids');
assert.strictEqual(g.checkWraps(JSON.parse('{"__proto__":{"x":1},"u1":{"ciphertext":"aa","iv":"bb"},"u2":{"ciphertext":"aa","iv":"bb"},"u3":{"ciphertext":"aa","iv":"bb"}}'), ids), null, '__proto__ key');
step('wraps must cover exactly the member list');

assert.deepStrictEqual(g.cleanName({ ciphertext: 'bmFtZQ==', iv: 'aXY=', epoch: 99 }), { ciphertext: 'bmFtZQ==', iv: 'aXY=' }, 'the epoch comes from the server, not the request');
assert.strictEqual(g.cleanName({ ciphertext: 'My group', iv: 'aXY=' }), null, 'plain text is not base64');
assert.strictEqual(g.cleanName(null), null);
assert.strictEqual(g.idList(['a', 'b'], 5).length, 2);
assert.strictEqual(g.idList(['a', 'a'], 5), null);
assert.strictEqual(g.idList(['a', 'b', 'c'], 2), null);
assert.strictEqual(g.idList([1], 5), null);
assert.strictEqual(g.idList('a', 5), null);
step('names and id lists are checked');

// ---- epochs ----
const grp = g.createGroup({ id: 'G', ownerId: 'u1', others: ['u2', 'u3'], nameEnc: { ciphertext: 'bjE=', iv: 'aXY=' }, wraps: g.checkWraps(good, ids), byKey: 'PK1', at: 5 });
assert.deepStrictEqual(grp.members, ids); assert.strictEqual(grp.epoch, 1); assert.strictEqual(grp.nameEnc.epoch, 1);
let v = g.viewFor(grp, 'u2', (id) => ({ id, displayName: id }));
assert.deepStrictEqual(Object.keys(v.keys), ['1']); assert.deepStrictEqual(v.keys[1].wrap, w('2')); assert.strictEqual(v.keys[1].by, 'u1'); assert.strictEqual(v.keys[1].byKey, 'PK1');
assert.ok(!JSON.stringify(v).includes('"1"') || !JSON.stringify(v.keys).includes(w('3').ciphertext), 'a member never receives someone else\'s wrap');
assert.strictEqual(JSON.stringify(v).includes(w('1').ciphertext), false);
assert.strictEqual(g.viewFor(grp, 'nobody', (id) => ({ id })).keys[1], undefined, 'a stranger gets no keys');
step('a member sees only their own wrap');

// add u4: epoch 2 for four people. u4 has no epoch 1 wrap.
g.rotate(grp, { members: [...ids, 'u4'], nameEnc: { ciphertext: 'bjI=', iv: 'aXY=' }, wraps: g.checkWraps({ ...good, u4: w('4') }, [...ids, 'u4']), by: 'u2', byKey: 'PK2' });
assert.strictEqual(grp.epoch, 2); assert.strictEqual(grp.nameEnc.epoch, 2);
assert.deepStrictEqual(Object.keys(g.viewFor(grp, 'u4', (id) => ({ id })).keys), ['2'], 'a newcomer reads only from the epoch they joined');
assert.deepStrictEqual(Object.keys(g.viewFor(grp, 'u1', (id) => ({ id })).keys).sort(), ['1', '2'], 'old members keep their history');
// remove u2 (owner u1 kicks): epoch 3 without u2, and u2's wraps are removed from every epoch
g.rotate(grp, { members: ['u1', 'u3', 'u4'], nameEnc: { ciphertext: 'bjM=', iv: 'aXY=' }, wraps: g.checkWraps({ u1: w(), u3: w(), u4: w() }, ['u1', 'u3', 'u4']), by: 'u1', byKey: 'PK1' });
assert.strictEqual(grp.epoch, 3);
for (const k of Object.values(grp.keys)) assert.ok(!('u2' in k.wraps), 'the removed member has no wraps left in any epoch');
assert.deepStrictEqual(g.viewFor(grp, 'u2', (id) => ({ id })).keys, {});
// the owner leaves: the longest-standing member takes over
g.rotate(grp, { members: ['u3', 'u4'], nameEnc: { ciphertext: 'bjQ=', iv: 'aXY=' }, wraps: g.checkWraps({ u3: w(), u4: w() }, ['u3', 'u4']), by: 'u1', byKey: 'PK1' });
assert.strictEqual(grp.ownerId, 'u3');
step('epochs: newcomers cannot read old keys, removed people lose every wrap, ownership passes on');

// ---- call roster ----
let t = 1000, n = 0;
const r = g.createRoster({ now: () => t, id: () => 'call' + ++n });
let j = r.join('G', 'u1', 's1', true);
assert.ok(j.created && j.call.video && j.peers.length === 0 && !j.call.answeredAt);
t = 2000; j = r.join('G', 'u2', 's2', false);
assert.ok(!j.created && j.call.video, 'the first person decides voice or video');
assert.deepStrictEqual(j.peers, ['u1'], 'the joiner connects to the people already there');
assert.strictEqual(j.call.answeredAt, 2000, 'the call counts as answered when a second person joins');
assert.strictEqual(r.byUser('u2').groupId, 'G');
assert.strictEqual(r.join('H', 'u1', 's9', false).error, 'You are already on a call', 'one call at a time');
j = r.join('G', 'u1', 's1b', true);
assert.strictEqual(j.replaced, 's1', 'joining again from another tab moves the call there');
assert.strictEqual(r.leave('G', 'u1', 's1'), null, 'the old tab leaving changes nothing');
for (let i = 3; i <= g.MAX_CALL; i++) assert.ok(r.join('G', 'u' + i, 's' + i, false).call);
assert.match(r.join('G', 'u99', 's99', false).error, /full/, 'a call has a size limit');
t = 5000;
let l = r.leave('G', 'u2', 's2'); assert.ok(l && !l.ended && l.record === null);
for (let i = 3; i <= g.MAX_CALL; i++) r.leave('G', 'u' + i, 's' + i);
l = r.leave('G', 'u1', 's1b');
assert.ok(l.ended && r.of('G') === null);
assert.deepStrictEqual({ convo: l.record.convo, group: l.record.group, a: l.record.a, b: l.record.b, outcome: l.record.outcome, seconds: l.record.seconds, people: l.record.people, video: l.record.video },
  { convo: 'g:G', group: true, a: 'u1', b: null, outcome: 'completed', seconds: 3, people: g.MAX_CALL, video: true });
step('call roster: one call at a time, size limit, tab handover, a finished call becomes a record');

t = 9000;
r.join('G2', 'a', 'sa', false); t = 9500; const solo = r.leave('G2', 'a', 'sa');
assert.strictEqual(solo.record.outcome, 'missed'); assert.strictEqual(solo.record.seconds, 0); assert.strictEqual(solo.record.people, 1);
assert.deepStrictEqual(calllog.forConvo({ [solo.record.id]: solo.record }, 'g:G2').map((x) => x.id), [solo.record.id], 'group records live in the same history store');
step('a call nobody joined is logged as missed');
console.log('\nAll group checks passed.');
