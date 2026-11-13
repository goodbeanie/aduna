// The appropriateness checker for things other people see: usernames, display names, bios and server names (no Express, no database:
// tested by appropriate-test.js). index.js uses it in two ways:
//   1. when something is typed or saved, a bad value is refused with a sentence for the person (problem / nameProblem);
//   2. a sweep looks at what already exists: anyone with a flagged name gets a warning (u.nameWarning). The 3 days start when they SEE the
//      warning (seenAt, set when their app shows it), and if a flagged name is still there when they run out, the account is deleted.
// `plan` decides what the sweep does and touches nothing, so it can be tested without a server.

const listing = require('./listing');

const WARN_DAYS = 3;
const WARN_MS = WARN_DAYS * 24 * 3600 * 1000;

// Short words only match a whole word, longer ones (5+ letters) match anywhere inside a name. Extend with NAME_BLOCKED_WORDS=a,b,c
// (EMOJI_BLOCKED_WORDS keeps working too: one list for emoji, names and listings).
const BASE = ['nazi', 'hitler', 'heil', 'swastika', 'kkk', 'porn', 'nsfw', 'hentai', 'rape', 'rapist', 'nude', 'nudes', 'cum', 'dick', 'cock', 'pussy', 'whore', 'slut', 'fag', 'faggot', 'nigger', 'nigga', 'retard', 'kys', 'killyourself', 'suicide'];
const EXTRA = ['fuck', 'fucker', 'fucking', 'motherfucker', 'shit', 'bitch', 'cunt', 'twat', 'asshole', 'dildo', 'penis', 'vagina', 'blowjob', 'handjob', 'cumshot', 'orgasm', 'bukkake', 'milf', 'boobs', 'titties',
  'incest', 'pedo', 'paedo', 'pedophile', 'paedophile', 'molest', 'raping', 'kike', 'chink', 'spic', 'gook', 'tranny', 'dyke', 'wetback', 'beaner', 'whitepower', 'gaschambers', 'killallniggers'];
const fromEnv = (v) => String(v || '').toLowerCase().split(',').map((w) => w.trim()).filter(Boolean);
const WORDS = [...new Set([...BASE, ...EXTRA, ...fromEnv(process.env.EMOJI_BLOCKED_WORDS), ...fromEnv(process.env.NAME_BLOCKED_WORDS)])];

// Four-letter words that are rude on their own and never part of an ordinary word, so a name may not hide them inside another word
// ("xXfuckerXx"). Words that sit inside ordinary words (cock: peacock, dick: Dickens) stay whole-word only.
const STRICT4 = ['fuck', 'shit', 'cunt', 'twat'];
const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/0/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/7/g, 't');
const INNOCENT4 = ['shiitake', 'scunthorpe'];

// 'name' = short text with no sentences (usernames, display names, server names): separators are ignored, longer words match anywhere.
// 'text' = free text (a bio): whole words and short runs only, so ordinary sentences are not caught by accident.
function flagged(value, kind = 'name') {
  const text = String(value || '');
  if (!text.trim()) return null;
  const hit = listing.blockedWord(text, WORDS, { compact: kind === 'name' });
  if (hit) return hit;
  if (kind === 'name') {
    let joined = fold(text).replace(/[^a-z0-9]+/g, '');
    for (const w of INNOCENT4) joined = joined.split(w).join('');
    for (const w of STRICT4) if (joined.includes(w)) return w;
  }
  return null;
}

const LABEL = { username: 'username', displayName: 'display name', bio: 'bio', server: 'server name', serverTag: 'server tag', channel: 'channel name', category: 'category name', role: 'role name' };
// null when fine, else a sentence for the person. `what` is one of the LABEL keys.
function problem(value, what = 'displayName') {
  const kind = what === 'bio' ? 'text' : 'name';
  return flagged(value, kind) ? `That ${LABEL[what] || 'name'} is not allowed on Aduna. Please choose something else.` : null;
}

// What is wrong with one account right now: [{ field, value, serverId? }]. Bots and deleted shells are never flagged. `servers` are the
// servers this person owns.
function scan(user, servers = []) {
  if (!user || user.bot || user.deleted) return [];
  const out = [];
  if (flagged(user.username, 'name')) out.push({ field: 'username', value: user.username });
  if (user.displayName && user.displayName !== user.username && flagged(user.displayName, 'name')) out.push({ field: 'displayName', value: user.displayName });
  if (flagged(user.bio, 'text')) out.push({ field: 'bio', value: user.bio });
  for (const s of servers) if (flagged(s.name, 'name')) out.push({ field: 'server', value: s.name, serverId: s.id });
  // an admin looked at these exact values and said they are fine (a real surname, say): they are not flagged again until the value changes
  const ok = new Set(Array.isArray(user.nameOk) ? user.nameOk : []);
  return out.filter((i) => !ok.has(i.field + ':' + i.value));
}

const deadlineOf = (w) => (w && w.seenAt ? w.seenAt + WARN_MS : null);
const due = (w, now) => { const d = deadlineOf(w); return d !== null && now >= d; };

// What the sweep should do. `users` is the user table, `serversOf(uid)` the servers someone owns, `exempt(u)` says who is never touched
// (bots, admins, the owner of the official server). Returns { warn: [id], clear: [id], remove: [id] }:
//   warn   = flagged and not warned yet (the warning starts; the 3 days start when they see it)
//   clear  = has a warning but nothing is flagged any more (they fixed it)
//   remove = flagged, has seen the warning, and the 3 days are over
function plan(users, serversOf, now, exempt = () => false) {
  const out = { warn: [], clear: [], remove: [] };
  for (const u of Object.values(users)) {
    if (!u || u.bot || u.deleted) continue;
    if (exempt(u)) { if (u.nameWarning) out.clear.push(u.id); continue; }
    const items = scan(u, serversOf(u.id));
    if (!items.length) { if (u.nameWarning) out.clear.push(u.id); continue; }
    if (!u.nameWarning) { out.warn.push(u.id); continue; }
    if (due(u.nameWarning, now)) out.remove.push(u.id);
  }
  return out;
}

// What the person's own app is told: nothing (null) when there is no warning.
function view(user, servers, now) {
  const w = user && user.nameWarning;
  if (!w) return null;
  const items = scan(user, servers);
  if (!items.length) return null;
  const deadline = deadlineOf(w);
  return { items: items.map((i) => ({ ...i, label: LABEL[i.field] })), seenAt: w.seenAt || null, deadline, daysLeft: deadline ? Math.max(0, Math.ceil((deadline - now) / 86400000)) : WARN_DAYS, days: WARN_DAYS };
}

module.exports = { WORDS, WARN_DAYS, WARN_MS, flagged, problem, scan, plan, view, deadlineOf, due };
