'use strict';
// The call history shown inside a DM ("Voice call, 4 min", "Missed video call"). Pure: no Express, no database (calllog-test.js).
//
// DM text is end-to-end encrypted and the server cannot write into it, so a finished call is NOT a chat message: it is a small
// record kept next to the DMs holding only what the server already knows from ringing the call: who called whom, voice or video,
// when, how it ended and for how long. Nothing that was said or shown. Both people get it live (`call:log`) and when they open the chat.
//
// record: { id, convo, a (caller), b (callee), video, outcome, startedAt, answeredAt | null, endedAt, seconds }
// outcome: 'completed' (it was answered) | 'missed' (nobody picked up in time) | 'cancelled' (the caller gave up while it rang) | 'declined'
const OUTCOMES = ['completed', 'missed', 'cancelled', 'declined'];
const KEEP_PER_CONVO = 200;

function outcomeOf(call, reason) {
  if (call.answeredAt) return 'completed'; // however it ended: hang up, connection dropped...
  if (reason === 'declined') return 'declined';
  if (reason === 'cancelled' || reason === 'dropped') return 'cancelled'; // the caller left (or lost connection) while it rang
  return 'missed'; // ring timeout
}

function makeRecord(call, reason, convo, endedAt = Date.now()) {
  const answeredAt = call.answeredAt || null;
  return {
    id: call.id, convo, a: call.a, b: call.b, video: !!call.video,
    outcome: outcomeOf(call, reason),
    startedAt: call.startedAt || endedAt, answeredAt, endedAt,
    seconds: answeredAt ? Math.max(0, Math.round((endedAt - answeredAt) / 1000)) : 0,
  };
}

// A finished group call: one record for the whole call. `a` is who started it, `b` is null, `people` is how many different people were on it.
// 'completed' if at least two people were on it together, otherwise 'missed' (nobody joined the one who started it).
function makeGroupRecord(call, convo, endedAt = Date.now()) {
  const answeredAt = call.answeredAt || null;
  return {
    id: call.id, convo, group: true, a: call.startedBy, b: null, video: !!call.video,
    outcome: answeredAt ? 'completed' : 'missed',
    startedAt: call.startedAt || endedAt, answeredAt, endedAt,
    seconds: answeredAt ? Math.max(0, Math.round((endedAt - answeredAt) / 1000)) : 0,
    people: call.everyone ? call.everyone.size : 1,
  };
}

// Newest `limit` records of one conversation, oldest first.
const forConvo = (log, convo, limit = 100) =>
  Object.values(log).filter((r) => r.convo === convo).sort((x, y) => x.endedAt - y.endedAt).slice(-limit);

// Ids to delete so a conversation keeps only its newest `keep` records.
function overflow(log, convo, keep = KEEP_PER_CONVO) {
  const all = Object.values(log).filter((r) => r.convo === convo).sort((x, y) => x.endedAt - y.endedAt);
  return all.slice(0, Math.max(0, all.length - keep)).map((r) => r.id);
}

module.exports = { OUTCOMES, KEEP_PER_CONVO, outcomeOf, makeRecord, makeGroupRecord, forConvo, overflow };
