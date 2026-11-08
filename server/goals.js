// Server goals: a channel type ('goals') where the owner (or anyone with Manage server) writes the goals and keeps them up to date by hand,
// and every member sees them. Pure functions, so server/goals-test.js can run them without a server; index.js wires them in.
//   channel = { id, name, type: 'goals', goals: [ { id, title, target, progress, done, at } ] }
//
//   target > 0   a goal with a progress bar: progress counts up to the target, and it is done when it gets there.
//   target = 0   a checkbox goal: done is ticked by hand.

const LIMITS = { goals: 20, title: 80, target: 1000000 };

const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const whole = (v) => typeof v === 'number' && Number.isInteger(v);

// the target: a whole number from 1 up for a progress bar, or 0/missing/null for a checkbox goal
function cleanTarget(v) {
  if (v === undefined || v === null || v === '' || v === 0) return { value: 0 };
  if (!whole(v) || v < 1 || v > LIMITS.target) return { error: `The target must be a whole number from 1 to ${LIMITS.target.toLocaleString('en-US')}, or left empty for a checkbox goal` };
  return { value: v };
}

// a new goal: { title, target? }
function cleanNew(input, at) {
  const title = clean(input && input.title, LIMITS.title);
  if (!title) return { error: 'Write the goal first' };
  const t = cleanTarget(input.target);
  if (t.error) return { error: t.error };
  return { value: { title, target: t.value, progress: 0, done: false, at } };
}

// a change to a goal (any of title, target, progress, done): returns the goal it becomes, leaving the old one untouched
function applyChange(goal, input) {
  if (!input || typeof input !== 'object') return { error: 'Nothing to change' };
  const next = { ...goal };
  let touched = false;
  if (input.title !== undefined) {
    const title = clean(input.title, LIMITS.title);
    if (!title) return { error: 'The goal cannot be empty' };
    next.title = title; touched = true;
  }
  if (input.target !== undefined) {
    const t = cleanTarget(input.target);
    if (t.error) return { error: t.error };
    next.target = t.value; touched = true;
  }
  if (input.progress !== undefined) {
    if (!whole(input.progress) || input.progress < 0 || input.progress > LIMITS.target) return { error: 'Progress must be a whole number, 0 or more' };
    if (next.target === 0) return { error: 'This goal has no target. Tick it instead' };
    next.progress = input.progress; touched = true;
  }
  if (input.done !== undefined) {
    if (typeof input.done !== 'boolean') return { error: 'done must be true or false' };
    next.done = input.done; touched = true;
    if (next.target > 0) next.progress = input.done ? next.target : Math.min(next.progress, next.target - 1); // ticking a bar fills it; unticking leaves it just short
  }
  if (!touched) return { error: 'Nothing to change' };
  if (next.target > 0) {
    next.progress = Math.min(next.progress, next.target); // a lowered target pulls progress down with it
    if (input.done === undefined) next.done = next.progress >= next.target; // the bar decides, unless the person ticked it themselves just now
  } else {
    next.progress = 0;
  }
  return { value: next };
}

const percent = (g) => (g.target > 0 ? Math.min(100, Math.floor((g.progress / g.target) * 100)) : g.done ? 100 : 0);

module.exports = { LIMITS, cleanNew, applyChange, percent };
