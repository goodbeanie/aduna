// Call history lines in a DM. Pure (no React): client/scripts/callhistory-test.mjs tests it in Node.
// A finished call arrives from the server as a small record (see server/calllog.js):
//   { id, a (caller), b (callee), video, outcome: 'completed' | 'missed' | 'cancelled' | 'declined', startedAt, answeredAt, endedAt, seconds }
// and is shown in the conversation at the time it ended, worded from the point of view of whoever is reading.

export function durationLabel(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60), rest = s % 60;
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${h} h ${mm} min` : `${h} h`;
}

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// { icon, title, detail, bad } for one record. `bad` = a call you missed (drawn in the warning colour).
// A group call is one record for the whole call (rec.group, rec.a = who started it, rec.b = null, rec.people = how many were on it):
// `otherName` is then the name of whoever started it.
export function callSummary(rec, meId, otherName = 'them') {
  const iCalled = rec.a === meId;
  const word = rec.video ? 'video call' : 'voice call';
  const icon = rec.video ? 'video' : 'phone';
  if (rec.group) {
    const n = Math.max(1, Number(rec.people) || 1);
    if (rec.outcome === 'completed') return { icon, title: `Group ${word}`, detail: `${durationLabel(rec.seconds)} \u00b7 ${n} ${n === 1 ? 'person' : 'people'}`, bad: false };
    return iCalled
      ? { icon, title: 'No one joined', detail: `Group ${word}`, bad: false }
      : { icon, title: `Missed group ${word}`, detail: `${otherName} started a call`, bad: true };
  }
  switch (rec.outcome) {
    case 'completed': return { icon, title: cap(word), detail: durationLabel(rec.seconds), bad: false };
    case 'declined': return iCalled
      ? { icon, title: `${otherName} declined`, detail: `${cap(word)} to ${otherName}`, bad: false }
      : { icon, title: 'You declined', detail: `${cap(word)} from ${otherName}`, bad: false };
    case 'cancelled': return iCalled
      ? { icon, title: 'Call cancelled', detail: `${cap(word)} to ${otherName}`, bad: false }
      : { icon, title: `Missed ${word}`, detail: `${otherName} called you`, bad: true };
    default: return iCalled // 'missed': nobody picked up in time
      ? { icon, title: 'No answer', detail: `${cap(word)} to ${otherName}`, bad: false }
      : { icon, title: `Missed ${word}`, detail: `${otherName} called you`, bad: true };
  }
}

// Weaves call records into a list of chat messages by time. Both lists are oldest first; on a tie the message goes first.
export function withCalls(messages, records) {
  const entries = (records || []).map((rec) => ({ id: 'call:' + rec.id, system: 'call', call: rec, authorId: rec.a, createdAt: rec.endedAt }));
  if (!entries.length) return messages;
  const out = [];
  let i = 0;
  const sorted = [...entries].sort((x, y) => x.createdAt - y.createdAt);
  for (const m of messages) {
    while (i < sorted.length && sorted[i].createdAt < m.createdAt) out.push(sorted[i++]);
    out.push(m);
  }
  while (i < sorted.length) out.push(sorted[i++]);
  return out;
}

// Adds or replaces records by id (history loaded + live events can overlap).
export function mergeRecords(list, incoming) {
  const byId = new Map((list || []).map((r) => [r.id, r]));
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].sort((x, y) => x.endedAt - y.endedAt);
}
