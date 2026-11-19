'use strict';
// Spin the wheel on channel messages. Pure: no Express, no database (tested by wheels-test.js).
//
// A wheel lives on its message as `msg.wheel`:
//   { title, options: [text], spinAt: ms, spunAt: ms | null, winner: index | null }
// The poster picks the options and the time. The winner is not chosen until that time comes (spinDue), so nobody can see it early.
// Everyone in the channel sees the spin when the server announces it; people who open the channel later just see the result.

const LIMITS = { title: 200, option: 100, minOptions: 2, maxOptions: 500, minSecs: 5, maxDays: 30 };

// Turns what a client sent into a clean wheel, or { error }. Nothing from `input` is kept as-is.
function cleanWheel(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Bad wheel' };
  const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) return { error: 'A wheel needs a title' };
  if (title.length > LIMITS.title) return { error: `The title can be at most ${LIMITS.title} characters` };
  if (!Array.isArray(input.options) || input.options.length > LIMITS.maxOptions * 2) return { error: 'Bad wheel options' };
  const options = [];
  for (const o of input.options) {
    if (typeof o !== 'string') return { error: 'Bad wheel options' };
    const t = o.replace(/\s+/g, ' ').trim();
    if (!t) continue; // blank rows are ignored
    if (t.length > LIMITS.option) return { error: `Each option can be at most ${LIMITS.option} characters` };
    options.push(t);
  }
  if (options.length < LIMITS.minOptions) return { error: `A wheel needs at least ${LIMITS.minOptions} options` };
  if (options.length > LIMITS.maxOptions) return { error: `A wheel can have at most ${LIMITS.maxOptions} options` };
  const at = input.spinAt;
  if (typeof at !== 'number' || !Number.isFinite(at)) return { error: 'Pick a time for the spin' };
  if (at < now + LIMITS.minSecs * 1000) return { error: 'The spin time has to be in the future' };
  if (at > now + LIMITS.maxDays * 86400_000) return { error: `The spin can be at most ${LIMITS.maxDays} days away` };
  return { wheel: { title, options, spinAt: Math.round(at), spunAt: null, winner: null } };
}

const isWheel = (w) => !!w && typeof w === 'object' && Array.isArray(w.options) && typeof w.spinAt === 'number';
const isSpun = (w) => isWheel(w) && w.spunAt !== null;
const isDue = (w, now = Date.now()) => isWheel(w) && !isSpun(w) && w.spinAt <= now;

// Picks the winner when the time has come. `pick(n)` returns a whole number from 0 to n - 1 (crypto.randomInt in index.js).
// Returns true when this call did the spin.
function spinDue(w, pick, now = Date.now()) {
  if (!isDue(w, now) || w.options.length < 1) return false;
  const i = pick(w.options.length);
  if (!Number.isInteger(i) || i < 0 || i >= w.options.length) return false;
  w.winner = i;
  w.spunAt = now;
  return true;
}

// One line for notifications and reply previews.
const wheelPreview = (w) => (isWheel(w) ? 'Wheel: ' + w.title : '');

module.exports = { LIMITS, cleanWheel, isWheel, isSpun, isDue, spinDue, wheelPreview };
