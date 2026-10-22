// Call history wording and ordering: node client/scripts/callhistory-test.mjs
import assert from 'assert';
import { durationLabel, callSummary, withCalls, mergeRecords } from '../src/callhistory.js';
const ok = (m) => console.log('✓', m);

assert.deepStrictEqual([0, 1, 59, 60, 61, 125, 3599, 3600, 3660, 7325].map(durationLabel),
  ['0 s', '1 s', '59 s', '1 min', '1 min 1 s', '2 min 5 s', '59 min 59 s', '1 h', '1 h 1 min', '2 h 2 min']);
assert.strictEqual(durationLabel(-5), '0 s'); assert.strictEqual(durationLabel(undefined), '0 s'); assert.strictEqual(durationLabel('x'), '0 s'); assert.strictEqual(durationLabel(59.6), '1 min');
ok('durations read naturally and never go negative or NaN');

const rec = (o) => ({ id: 'c1', a: 'me', b: 'pat', video: false, outcome: 'completed', startedAt: 0, answeredAt: 1, endedAt: 2, seconds: 252, ...o });
let s = callSummary(rec({}), 'me', 'Pat');
assert.deepStrictEqual(s, { icon: 'phone', title: 'Voice call', detail: '4 min 12 s', bad: false });
s = callSummary(rec({ video: true }), 'pat', 'Me2'); assert.deepStrictEqual([s.icon, s.title, s.detail], ['video', 'Video call', '4 min 12 s']);
assert.deepStrictEqual(callSummary(rec({ outcome: 'completed' }), 'me', 'Pat'), callSummary(rec({ outcome: 'completed' }), 'pat', 'Me'), 'a finished call reads the same for both');
ok('an answered call: kind and length');

const miss = rec({ outcome: 'missed', seconds: 0, answeredAt: null });
s = callSummary(miss, 'pat', 'Alex'); assert.deepStrictEqual(s, { icon: 'phone', title: 'Missed voice call', detail: 'Alex called you', bad: true });
s = callSummary({ ...miss, video: true }, 'pat', 'Alex'); assert.strictEqual(s.title, 'Missed video call'); assert.ok(s.bad);
s = callSummary(miss, 'me', 'Pat'); assert.deepStrictEqual([s.title, s.detail, s.bad], ['No answer', 'Voice call to Pat', false]);
s = callSummary({ ...miss, outcome: 'cancelled' }, 'pat', 'Alex'); assert.deepStrictEqual([s.title, s.bad], ['Missed voice call', true], 'the person who was rung sees a missed call when the caller gave up');
s = callSummary({ ...miss, outcome: 'cancelled' }, 'me', 'Pat'); assert.deepStrictEqual([s.title, s.bad], ['Call cancelled', false]);
s = callSummary({ ...miss, outcome: 'declined' }, 'me', 'Pat'); assert.deepStrictEqual([s.title, s.detail, s.bad], ['Pat declined', 'Voice call to Pat', false]);
s = callSummary({ ...miss, outcome: 'declined', video: true }, 'pat', 'Alex'); assert.deepStrictEqual([s.title, s.detail, s.bad], ['You declined', 'Video call from Alex', false]);
assert.strictEqual(callSummary({ ...miss, outcome: 'something-new' }, 'me', 'Pat').title, 'No answer', 'an outcome from a newer server still draws something sensible');
assert.strictEqual(callSummary(miss, 'pat').detail, 'them called you', 'works without a name');
ok('unanswered calls are worded for whoever is reading; only a call you missed is flagged');

const msgs = [{ id: 'm1', createdAt: 10 }, { id: 'm2', createdAt: 30 }, { id: 'm3', createdAt: 50 }];
const recs = [rec({ id: 'late', endedAt: 60 }), rec({ id: 'early', endedAt: 5 }), rec({ id: 'mid', endedAt: 40 }), rec({ id: 'tie', endedAt: 30 })];
const out = withCalls(msgs, recs);
assert.deepStrictEqual(out.map((x) => x.id), ['call:early', 'm1', 'm2', 'call:tie', 'call:mid', 'm3', 'call:late'], 'by time; on a tie the message comes first');
assert.deepStrictEqual(out.filter((x) => x.system).map((x) => [x.system, x.createdAt]), [['call', 5], ['call', 30], ['call', 40], ['call', 60]]);
assert.strictEqual(out.find((x) => x.id === 'call:mid').call.id, 'mid'); assert.strictEqual(out.find((x) => x.id === 'call:mid').authorId, 'me');
assert.deepStrictEqual(msgs.map((m) => m.id), ['m1', 'm2', 'm3'], 'the input list is not changed');
assert.strictEqual(withCalls(msgs, []), msgs); assert.strictEqual(withCalls(msgs, undefined), msgs);
assert.deepStrictEqual(withCalls([], [rec({ id: 'only', endedAt: 1 })]).map((x) => x.id), ['call:only'], 'a chat with calls and no messages');
ok('calls are woven into the messages by the time they ended');

const merged = mergeRecords([rec({ id: 'a', endedAt: 20 }), rec({ id: 'b', endedAt: 10 })], [rec({ id: 'a', endedAt: 20, seconds: 9 }), rec({ id: 'c', endedAt: 15 })]);
assert.deepStrictEqual(merged.map((r) => r.id), ['b', 'c', 'a']); assert.strictEqual(merged.find((r) => r.id === 'a').seconds, 9, 'a repeated record replaces itself');
assert.deepStrictEqual(mergeRecords(undefined, [rec({ id: 'x' })]).map((r) => r.id), ['x']);
ok('loaded history and live events merge without duplicates');
console.log('\nAll call-history display checks passed.');
