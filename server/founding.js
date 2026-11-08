// Founding members: the first 1,000 people to join Aduna get the Founding Member badge, and the sign-up page shows a bar of how many have joined.
//
// Like events.js this file has no Express / database imports: the rules are plain functions over the users object (db().users), so
// server/founding-test.js can run them without a server. index.js wires them in (the "founding" lines: newUserFromSignup, allBadgeViews,
// GET /api/founding, and a backfill at start-up).
//
// What is stored, per user:
//   u.founding = N      the person's number, 1..GOAL. Set once, when the account is made, and never changed. No number = not a founding member.
//
// Rules:
//   * Only people count. Bots (u.bot) neither take a number nor count towards the bar.
//   * Numbers are given in order of joining. If an account with a number is deleted, its number is free again and the next person to join gets it,
//     so there are never more than GOAL badges.
//   * The badge is a normal worn badge (it can be hidden under Settings > Profile like any other, id 'founding'); its picture is a fixed file in
//     client/public/badges, so the view carries `src` instead of an uploaded image id.

const GOAL = 1000;
const BADGE_ID = 'founding';
const BADGE_SRC = '/badges/founding-member.png';

const humans = (users) => Object.values(users || {}).filter((u) => u && !u.bot);
const hasNumber = (u, goal = GOAL) => Number.isInteger(u.founding) && u.founding >= 1 && u.founding <= goal;

// The number a person joining right now would get, or null when all GOAL are taken. Call it BEFORE the new account is added.
function nextFree(users, goal = GOAL) {
  const used = new Set(humans(users).filter((u) => hasNumber(u, goal)).map((u) => u.founding));
  for (let n = 1; n <= goal; n++) if (!used.has(n)) return n;
  return null;
}

// For the account record being made: { founding: N } or {} when the first GOAL are gone. Spread it into the record.
function claimFor(users, goal = GOAL) {
  const n = nextFree(users, goal);
  return n === null ? {} : { founding: n };
}

// Gives numbers to people who joined before this feature existed (or whose number was lost): earliest accounts first, up to GOAL.
// Safe to run over and over; returns how many accounts it changed so the caller knows whether to save.
function backfill(users, goal = GOAL) {
  const people = humans(users);
  const used = new Set(people.filter((u) => hasNumber(u, goal)).map((u) => u.founding));
  const waiting = people.filter((u) => !hasNumber(u, goal)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)));
  let n = 1, changed = 0;
  for (const u of waiting) {
    while (used.has(n)) n++;
    if (n > goal) break;
    u.founding = n; used.add(n); changed++;
  }
  return changed;
}

// The badge in the same shape as the other badges (see allBadgeViews in index.js). Not `builtin`: the client draws builtin badges with the Creator picture.
function badgeViews(u, goal = GOAL) {
  if (!u || u.bot || !hasNumber(u, goal)) return [];
  return [{ id: BADGE_ID, name: 'Founding Member #' + u.founding, src: BADGE_SRC, image: null, emoji: '', color: '', number: u.founding }];
}

// What the sign-up bar shows. Public: it is only a head count.
function progress(users, goal = GOAL) {
  const count = humans(users).length;
  return { count, goal, left: Math.max(0, goal - count), full: count >= goal };
}

module.exports = { GOAL, BADGE_ID, BADGE_SRC, nextFree, claimFor, backfill, badgeViews, progress };
