'use strict';
// Polls on channel messages. Pure: no Express, no database (tested by polls-test.js).
//
// A poll lives on its message as `msg.poll`:
//   { question, multi, options: [{ id: 'o0', text, votes: [userId] }], closesAt: ms | null, closed: bool, closedAt?, closedBy? }
// Votes are visible to members (the client shows counts, and who voted on hover), like reactions are.

const LIMITS = { question: 300, option: 100, minOptions: 2, maxOptions: 10, maxHours: 24 * 30 };

// Turns what a client sent into a clean poll, or { error }. Nothing from `input` is kept as-is.
function cleanPoll(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Bad poll' };
  const question = typeof input.question === 'string' ? input.question.replace(/\s+/g, ' ').trim() : '';
  if (!question) return { error: 'A poll needs a question' };
  if (question.length > LIMITS.question) return { error: `The question can be at most ${LIMITS.question} characters` };
  if (!Array.isArray(input.options) || input.options.length > 50) return { error: 'Bad poll options' };
  const texts = [];
  for (const o of input.options) {
    if (typeof o !== 'string') return { error: 'Bad poll options' };
    const t = o.replace(/\s+/g, ' ').trim();
    if (!t) continue; // blank rows are ignored
    if (t.length > LIMITS.option) return { error: `Each option can be at most ${LIMITS.option} characters` };
    texts.push(t);
  }
  if (texts.length < LIMITS.minOptions) return { error: `A poll needs at least ${LIMITS.minOptions} options` };
  if (texts.length > LIMITS.maxOptions) return { error: `A poll can have at most ${LIMITS.maxOptions} options` };
  if (new Set(texts.map((t) => t.toLowerCase())).size !== texts.length) return { error: 'Every option must be different' };
  let closesAt = null;
  if (input.hours !== undefined && input.hours !== null) {
    const h = input.hours;
    if (typeof h !== 'number' || !Number.isFinite(h) || h < 1 || h > LIMITS.maxHours) return { error: `A poll can run for 1 hour up to ${LIMITS.maxHours / 24} days` };
    closesAt = now + Math.round(h * 3600_000);
  }
  return { poll: { question, multi: input.multi === true, options: texts.map((text, i) => ({ id: 'o' + i, text, votes: [] })), closesAt, closed: false } };
}

const isEnded = (poll, now = Date.now()) => !!poll && (poll.closed === true || (typeof poll.closesAt === 'number' && poll.closesAt <= now));

// Sets `uid`'s choice to exactly `optionIds` (an empty list takes the vote back). A single-choice poll takes at most one.
function castVote(poll, uid, optionIds, now = Date.now()) {
  if (!poll || !Array.isArray(poll.options)) return { error: 'This message has no poll' };
  if (isEnded(poll, now)) return { error: 'This poll has ended' };
  if (!Array.isArray(optionIds) || optionIds.length > LIMITS.maxOptions || optionIds.some((x) => typeof x !== 'string')) return { error: 'Bad vote' };
  const ids = [...new Set(optionIds)];
  if (ids.some((id) => !poll.options.some((o) => o.id === id))) return { error: 'Unknown option' };
  if (!poll.multi && ids.length > 1) return { error: 'Pick one option' };
  for (const o of poll.options) {
    o.votes = o.votes.filter((v) => v !== uid);
    if (ids.includes(o.id)) o.votes.push(uid);
  }
  return { ok: true };
}

function closePoll(poll, by, now = Date.now()) {
  if (!poll || !Array.isArray(poll.options)) return { error: 'This message has no poll' };
  if (isEnded(poll, now)) return { error: 'This poll has already ended' };
  poll.closed = true; poll.closedAt = now; poll.closedBy = by;
  return { ok: true };
}

// One line for notifications and reply previews.
const pollPreview = (poll) => (poll ? 'Poll: ' + poll.question : '');

module.exports = { LIMITS, cleanPoll, isEnded, castVote, closePoll, pollPreview };
