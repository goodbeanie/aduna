// Call history records without a database: node server/calllog-test.js
const assert = require('assert');
const C = require('./calllog');
const step = (m) => console.log('✓', m);
const call = (o = {}) => ({ id: 'c1', a: 'alice', b: 'bob', video: false, startedAt: 1000, ...o });

{
  let r = C.makeRecord(call({ answeredAt: 5000 }), 'hangup', 'alice:bob', 65_400);
  assert.deepStrictEqual(r, { id: 'c1', convo: 'alice:bob', a: 'alice', b: 'bob', video: false, outcome: 'completed', startedAt: 1000, answeredAt: 5000, endedAt: 65_400, seconds: 60 });
  assert.strictEqual(C.makeRecord(call({ answeredAt: 5000, video: true }), 'dropped', 'x', 5000).outcome, 'completed', 'a connection that drops mid-call is still a call that happened');
  assert.strictEqual(C.makeRecord(call({ answeredAt: 5000 }), 'hangup', 'x', 5000).seconds, 0);
  assert.strictEqual(C.makeRecord(call({ answeredAt: 9000 }), 'hangup', 'x', 8000).seconds, 0, 'never negative');
  assert.strictEqual(C.makeRecord(call({ video: 1 }), 'missed', 'x', 2).video, true, 'video is a boolean');
  step('an answered call: completed with its length in seconds, however it ended');
}
{
  const o = (reason) => C.makeRecord(call(), reason, 'x', 50_000);
  assert.strictEqual(o('missed').outcome, 'missed'); assert.strictEqual(o('declined').outcome, 'declined'); assert.strictEqual(o('cancelled').outcome, 'cancelled');
  assert.strictEqual(o('dropped').outcome, 'cancelled', 'the caller lost connection while it rang');
  assert.strictEqual(o('whatever').outcome, 'missed'); assert.strictEqual(o(undefined).outcome, 'missed');
  for (const r of ['missed', 'declined', 'cancelled']) { assert.strictEqual(o(r).seconds, 0); assert.strictEqual(o(r).answeredAt, null); }
  assert.ok(C.OUTCOMES.includes(o('missed').outcome));
  assert.strictEqual(C.makeRecord({ id: 'c', a: 'a', b: 'b' }, 'missed', 'x', 77).startedAt, 77, 'a call without a start time still gets a sane record');
  step('unanswered calls: missed, declined, cancelled, zero length; unknown reasons count as missed');
}
{
  const log = {};
  for (let i = 0; i < 5; i++) log['c' + i] = C.makeRecord(call({ id: 'c' + i }), 'missed', 'alice:bob', 1000 * (5 - i)); // inserted newest first on purpose
  log.other = C.makeRecord(call({ id: 'other' }), 'missed', 'alice:carol', 9000);
  assert.deepStrictEqual(C.forConvo(log, 'alice:bob').map((r) => r.id), ['c4', 'c3', 'c2', 'c1', 'c0'], 'oldest first, by when they ended');
  assert.deepStrictEqual(C.forConvo(log, 'alice:bob', 2).map((r) => r.id), ['c1', 'c0'], 'the newest N');
  assert.deepStrictEqual(C.forConvo(log, 'alice:carol').map((r) => r.id), ['other'], 'only this conversation');
  assert.deepStrictEqual(C.forConvo(log, 'nobody:here'), []);
  assert.deepStrictEqual(C.overflow(log, 'alice:bob', 3), ['c4', 'c3'], 'the oldest go first');
  assert.deepStrictEqual(C.overflow(log, 'alice:bob', 10), []); assert.deepStrictEqual(C.overflow(log, 'alice:carol', 1), []);
  assert.strictEqual(C.KEEP_PER_CONVO, 200);
  step('history for one conversation: ordered, limited, pruned oldest-first, other conversations untouched');
}
console.log('\nAll call-history checks passed.');
