// Bot records: validation, code checks, views and search (no Express, no database: tested by bots-logic-test.js).
//
// A bot is a small JavaScript program a developer writes and Aduna runs in a sandbox (the runtime is NOT in this file; see HANDOFF.md).
// bots[id] = { id, ownerId, name, description, tags, visibility: 'private'|'public', code, createdAt, updatedAt, installs: [serverId],
//              reports: [...], listingHold }
// "private" = only its developer can install it; "public" = listed on the Bots tab in the explorer and anyone can add it to a server
// they manage.
const vm = require('vm');
const listing = require('./listing');

const LIMITS = { perDeveloper: 5, name: 32, description: 200, code: 32 * 1024, tags: 5, page: 24 };
const VISIBILITY = ['private', 'public'];
const TAG = /^[a-z0-9][a-z0-9-]{0,18}[a-z0-9]$/;

// Compiles the code without running it, to give the developer a clear error before it is saved. The wrapper is the shape the runtime
// will use: the code is the body of a function that receives `bot`. Compiling executes nothing.
function syntaxProblem(code) {
  try { new vm.Script('(function (bot) {\n' + code + '\n})', { filename: 'bot.js' }); return null; }
  catch (e) {
    const line = /bot\.js:(\d+)/.exec(String(e.stack || ''));
    return `Syntax error${line ? ` near line ${Math.max(1, Number(line[1]) - 1)}` : ''}: ${String(e.message).slice(0, 160)}`;
  }
}

const cleanName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name);
function cleanTagList(v) {
  if (!Array.isArray(v)) return 'Tags must be a list';
  const out = [];
  for (const raw of v) {
    const t = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '-').replace(/^#/, '');
    if (!TAG.test(t)) return `"${String(raw).slice(0, 24)}" is not a valid tag. Use 2 to 20 letters, numbers or dashes.`;
    if (!out.includes(t)) out.push(t);
  }
  return out.length > LIMITS.tags ? `You can use up to ${LIMITS.tags} tags` : out;
}

// Validates a create (full = true) or an edit (only the fields present). Returns { error } or { value: {fields to set} }.
// Public bots go through the same text checks as public servers (blocked words, no links) because strangers see them.
function checkBot(input, { current = null, words = [] } = {}) {
  const b = input || {}, full = !current, v = {};
  if (full || b.name !== undefined) { v.name = cleanName(b.name); if (!v.name) return { error: 'Give your bot a name' }; }
  if (full || b.description !== undefined) { v.description = String(b.description ?? '').trim().slice(0, LIMITS.description); }
  if (b.tags !== undefined) { const t = cleanTagList(b.tags); if (typeof t === 'string') return { error: t }; v.tags = t; }
  if (full || b.visibility !== undefined) {
    v.visibility = b.visibility === undefined ? 'private' : b.visibility;
    if (!VISIBILITY.includes(v.visibility)) return { error: 'Visibility must be private or public' };
  }
  if (full || b.code !== undefined) {
    const code = String(b.code ?? '');
    if (!code.trim()) return { error: 'Write some code for your bot' };
    if (Buffer.byteLength(code) > LIMITS.code) return { error: `The code is too long (max ${LIMITS.code / 1024} KB)` };
    const bad = syntaxProblem(code); if (bad) return { error: bad };
    v.code = code;
  }
  const after = { ...(current || {}), ...v };
  if (after.visibility === 'public') {
    if (!String(after.description || '').trim()) return { error: 'Write a short description so people know what your public bot does' };
    const problem = listing.listingProblem({ name: after.name, description: after.description, tags: after.tags || [] }, words);
    if (problem) return { error: problem.replace('server name', 'bot name').replace('public listing', 'public bot listing') };
  }
  return { value: v };
}

// What other people may see. The code is private to its developer (and the sandbox).
function botView(b, viewerId, users = {}) {
  const o = users[b.ownerId];
  const view = {
    id: b.id, name: b.name, description: b.description || '', tags: b.tags || [], visibility: b.visibility,
    developer: o ? { id: o.id, username: o.username, displayName: o.displayName } : null,
    installs: (b.installs || []).length, createdAt: b.createdAt, mine: b.ownerId === viewerId,
  };
  if (b.ownerId === viewerId) { view.code = b.code; view.review = b.listingHold ? b.listingHold.state : null; }
  return view;
}

// Search: every word must match something; tag 6 / name 5-3 / description 1, like the server explorer.
function score(b, tokens) {
  const name = b.name.toLowerCase(), desc = (b.description || '').toLowerCase(), tags = b.tags || [];
  let total = 0;
  for (const t of tokens) {
    let sc = 0;
    if (tags.includes(t)) sc = 6; else if (tags.some((g) => g.includes(t))) sc = 4;
    if (name.startsWith(t)) sc = Math.max(sc, 5); else if (name.includes(t)) sc = Math.max(sc, 3);
    if (desc.includes(t)) sc = Math.max(sc, 1);
    if (!sc) return 0;
    total += sc;
  }
  return total;
}
function exploreBots(bots, { q = '', sort = 'popular', offset = 0, words = [] } = {}) {
  const tokens = String(q).toLowerCase().replace(/^#/, '').trim().split(/\s+/).filter(Boolean).slice(0, 6).map((t) => t.replace(/^#/, ''));
  const byName = (a, b) => a.b.name.localeCompare(b.b.name, undefined, { sensitivity: 'base' });
  let list = bots.filter((b) => b.visibility === 'public' && !b.listingHold && !listing.listingProblem({ name: b.name, description: b.description, tags: b.tags }, words))
    .map((b) => ({ b, score: tokens.length ? score(b, tokens) : 1 })).filter((x) => x.score > 0);
  if (sort === 'az') list.sort(byName); else if (sort === 'za') list.sort((a, b) => byName(b, a));
  else if (sort === 'new') list.sort((a, b) => b.b.createdAt - a.b.createdAt);
  else list.sort((a, b) => b.score - a.score || (b.b.installs || []).length - (a.b.installs || []).length || byName(a, b));
  return { total: list.length, page: list.slice(offset, offset + LIMITS.page).map((x) => x.b), next: offset + LIMITS.page < list.length ? offset + LIMITS.page : null };
}

module.exports = { LIMITS, checkBot, botView, exploreBots, syntaxProblem, cleanTagList };
