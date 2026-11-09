// Incoming webhooks and the GitHub integration (no Express, no database: tested by webhooks-test.js).
//
// A webhook is a web address a server manager pastes into another service. When that service sends it something, Aduna posts a message in a
// channel, or hands the data to one of the server's bots as a 'webhook' event. Stored on the server:
//   s.webhooks = [{ id, name, kind: 'generic' | 'github', channelId, botId, tokenHash, secret (github only), userId, by, createdAt, lastUsedAt, uses }]
//  * The address is /api/hooks/<server id>/<webhook id>/<token>. The token is 32 random bytes (256 bits); only its hash is kept, so it is shown once.
//  * generic: JSON like { "content": "Hello" } (or "text") becomes a message. The sender's own formatting is kept, but pings are defused.
//  * github: GitHub's events, verified with the X-Hub-Signature-256 header (HMAC-SHA256 of the RAW body with the webhook's secret, which the
//    server keeps because it has to recompute it; server records are sealed in the database like everything else) and turned into short messages.
//  * Everything a stranger controls (issue titles, commit messages, comments, branch names) is cleaned by line()/esc() before it is shown:
//    control and bidi characters out, markdown and <@mention> / <stk:> tokens escaped, length capped. Addresses are only shown from https URLs,
//    wrapped in <...> so they do not turn into big preview cards.
const crypto = require('crypto');

const LIMITS = { perServer: 10, name: 32, text: 2000, perMin: 30, jsonBytes: 30_000, commits: 5, line: 100, quote: 200 };
const KINDS = ['generic', 'github'];
const ID_RE = /^[0-9a-f]{16}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// ---------- the secret address ----------
const newToken = () => crypto.randomBytes(32).toString('base64url');
const newSecret = () => crypto.randomBytes(24).toString('base64url');
const tokenHash = (t) => crypto.createHash('sha256').update('aduna-webhook:' + t).digest('hex');
const validToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);
function tokenMatches(hook, token) {
  if (!hook || typeof hook.tokenHash !== 'string' || !validToken(token)) return false;
  const a = Buffer.from(tokenHash(token), 'hex'), b = Buffer.from(hook.tokenHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// GitHub signs the exact bytes it sends: "sha256=" + hex HMAC-SHA256(secret, rawBody)
function verifyGithubSignature(raw, header, secret) {
  if (!Buffer.isBuffer(raw) || typeof secret !== 'string' || !secret) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header || ''));
  if (!m) return false;
  const want = crypto.createHmac('sha256', secret).update(raw).digest();
  const got = Buffer.from(m[1], 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---------- cleaning text from strangers ----------
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g; // everything but tab and line break; bidi overrides too
const flat = (s) => String(s ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
const clipTo = (s, n) => { const c = Array.from(String(s)); return c.length > n ? c.slice(0, n - 1).join('').trimEnd() + '\u2026' : String(s); };
// the characters Markdown.jsx treats as formatting or as tokens (\* _ ~ ` | < > and @), each escaped with a backslash it understands
const esc = (s) => String(s).replace(/[\\*_~`|<>@]/g, '\\$&');
const line = (s, n = LIMITS.line) => esc(clipTo(flat(s), n));
const code = (s, n = 60) => '`' + clipTo(flat(s), n).replace(/`/g, "'") + '`';
function href(u) {
  try { const x = new URL(String(u)); return x.protocol === 'https:' && x.hostname ? x.href : ''; } catch { return ''; }
}
const link = (u) => { const h = href(u); return h ? `<${h}>` : ''; };
const plain = (s, n) => clipTo(flat(s), n); // for the data a bot receives: clean, but not escaped (the bot decides how to show it)
const finish = (t) => clipTo(t, LIMITS.text).replace(/\\$/, '');

// ---------- GitHub events ----------
const HEX = /^[0-9a-f]{7,64}$/i;
const who = (p) => (p && p.sender && typeof p.sender.login === 'string' ? flat(p.sender.login).slice(0, 40) : '') || 'Someone';
const repoOf = (p) => (p && p.repository ? flat(p.repository.full_name || p.repository.name) : '').slice(0, 100) || 'a repository';
const num = (x) => (Number.isInteger(x) && x > 0 ? x : null);

// Returns { text, summary } for an event Aduna shows, or null for the rest (the caller then answers "ignored").
// summary is what a bot receives: plain strings and numbers only, never the raw payload (GitHub's can be megabytes).
function githubEvent(event, p) {
  if (!p || typeof p !== 'object') return null;
  const s = { event, action: typeof p.action === 'string' ? plain(p.action, 30) : '', repo: repoOf(p), sender: who(p), number: null, title: '', url: '', branch: '', commits: [] };
  const R = `**${esc(s.repo)}**`, U = `**${esc(s.sender)}**`;
  let text = null;

  if (event === 'ping') {
    text = `\u{1F514} GitHub is now connected to ${R}.`;
  } else if (event === 'push') {
    const ref = String(p.ref || ''), isTag = ref.startsWith('refs/tags/');
    s.branch = plain(ref.replace(/^refs\/(heads|tags)\//, ''), 100);
    const list = Array.isArray(p.commits) ? p.commits : [];
    s.commits = list.slice(0, 10).map((c) => ({
      id: c && HEX.test(String(c.id)) ? String(c.id).slice(0, 7).toLowerCase() : '', message: plain(String((c && c.message) || '').split('\n')[0], 120),
      author: plain(c && c.author && (c.author.username || c.author.name), 40),
    }));
    s.url = href(p.compare);
    const what = isTag ? 'tag' : 'branch';
    if (p.deleted) text = `${U} deleted ${what} ${code(s.branch)} in ${R}`;
    else if (!list.length) text = p.created ? `${U} created ${what} ${code(s.branch)} in ${R}` : null;
    else {
      const n = list.length >= 20 ? '20+' : String(list.length);
      const head = `${U} pushed ${n} commit${list.length === 1 ? '' : 's'} to ${code(s.branch)} in ${R}${p.forced ? ' (force push)' : ''}`;
      const rows = s.commits.slice(0, LIMITS.commits).map((c) => `- ${c.id ? code(c.id) + ' ' : ''}${line(c.message)}${c.author ? ' \u2014 ' + line(c.author, 40) : ''}`);
      const more = list.length > rows.length ? `\u2026and ${list.length >= 20 ? 'more' : list.length - rows.length + ' more'}` : '';
      text = [head, ...rows, more, link(p.compare)].filter(Boolean).join('\n');
    }
  } else if (event === 'pull_request' && p.pull_request) {
    const pr = p.pull_request;
    s.number = num(pr.number) || num(p.number); s.title = plain(pr.title, 150); s.url = href(pr.html_url);
    s.branch = plain(pr.head && pr.head.ref, 100);
    let verb = { opened: 'opened', reopened: 'reopened', ready_for_review: 'marked ready for review', converted_to_draft: 'converted to draft' }[p.action] || null;
    if (p.action === 'closed') verb = pr.merged ? 'merged' : 'closed';
    if (verb) text = [`${U} ${verb} pull request #${s.number} in ${R}: ${line(s.title, 150)}`, p.action === 'opened' && pr.head && pr.base ? `${code(pr.head.ref)} \u2192 ${code(pr.base.ref)}` : '', link(pr.html_url)].filter(Boolean).join('\n');
  } else if (event === 'issues' && p.issue) {
    const i = p.issue;
    s.number = num(i.number); s.title = plain(i.title, 150); s.url = href(i.html_url);
    const verb = { opened: 'opened', closed: 'closed', reopened: 'reopened' }[p.action] || null;
    if (verb) text = [`${U} ${verb} issue #${s.number} in ${R}: ${line(s.title, 150)}`, link(i.html_url)].filter(Boolean).join('\n');
  } else if (event === 'issue_comment' && p.issue && p.comment && p.action === 'created') {
    const i = p.issue, c = p.comment;
    s.number = num(i.number); s.title = plain(i.title, 150); s.url = link(c.html_url) ? String(new URL(String(c.html_url)).href) : '';
    const body = flat(c.body);
    text = [`${U} commented on #${s.number} in ${R}: ${line(s.title, 100)}`, body ? `> ${line(body, LIMITS.quote)}` : '', link(c.html_url)].filter(Boolean).join('\n');
  } else if (event === 'pull_request_review' && p.pull_request && p.review && p.action === 'submitted') {
    const pr = p.pull_request, r = p.review;
    s.number = num(pr.number); s.title = plain(pr.title, 150); s.url = link(r.html_url) ? String(new URL(String(r.html_url)).href) : '';
    const verb = { approved: 'approved', changes_requested: 'requested changes on', commented: 'reviewed' }[String(r.state || '').toLowerCase()] || null;
    if (verb) { const body = flat(r.body); text = [`${U} ${verb} pull request #${s.number} in ${R}: ${line(s.title, 100)}`, body ? `> ${line(body, LIMITS.quote)}` : '', link(r.html_url)].filter(Boolean).join('\n'); }
  } else if (event === 'release' && p.release && p.action === 'published') {
    const r = p.release;
    s.title = plain(r.name || r.tag_name, 100); s.branch = plain(r.tag_name, 60); s.url = link(r.html_url) ? String(new URL(String(r.html_url)).href) : '';
    text = [`\u{1F680} ${R} ${r.prerelease ? 'pre-released' : 'released'} ${code(r.tag_name)}${r.name && r.name !== r.tag_name ? ' \u2014 ' + line(r.name, 80) : ''}`, link(r.html_url)].filter(Boolean).join('\n');
  } else if (event === 'star' && p.action === 'created') {
    const n = p.repository && Number.isInteger(p.repository.stargazers_count) ? p.repository.stargazers_count : null;
    text = `\u2B50 ${U} starred ${R}${n !== null ? ` (${n} star${n === 1 ? '' : 's'})` : ''}`;
  } else if (event === 'fork' && p.forkee) {
    s.title = plain(p.forkee.full_name, 100); s.url = link(p.forkee.html_url) ? String(new URL(String(p.forkee.html_url)).href) : '';
    text = [`\u{1F374} ${U} forked ${R}`, link(p.forkee.html_url)].filter(Boolean).join('\n');
  } else if (event === 'workflow_run' && p.workflow_run && p.action === 'completed') {
    const w = p.workflow_run, c = String(w.conclusion || '');
    s.title = plain(w.name, 100); s.branch = plain(w.head_branch, 100); s.url = link(w.html_url) ? String(new URL(String(w.html_url)).href) : '';
    const shown = { success: ['\u2705', 'succeeded'], failure: ['\u274C', 'failed'], timed_out: ['\u274C', 'timed out'], cancelled: ['\u26AA', 'was cancelled'] }[c];
    if (shown) text = [`${shown[0]} Workflow **${line(s.title, 80)}** ${shown[1]} on ${code(s.branch)} in ${R}`, link(w.html_url)].filter(Boolean).join('\n');
  }
  if (!text) return null;
  return { text: finish(text), summary: { ...s, text: finish(text) } };
}

// ---------- generic webhooks ----------
// { text } or { error }. The sender's own Markdown is kept (it is their own integration); only pings and tokens are defused.
function genericText(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send a JSON object like {"content": "Hello"}' };
  const raw = ['content', 'text', 'message'].map((k) => body[k]).find((v) => typeof v === 'string');
  if (raw === undefined) return { error: 'Send a JSON object with a "content" (or "text") field' };
  let t = String(raw).replace(/\r\n?/g, '\n').replace(CONTROL, ' ').replace(/<@/g, '<\u200b@').replace(/<stk:/gi, '<\u200bstk:').replace(/@(everyone|here)\b/gi, '@\u200b$1').trim();
  if (!t) return { error: 'The message is empty' };
  return { text: clipTo(t, LIMITS.text) };
}
// what a bot receives for a generic webhook: the JSON as sent, if it is small enough, and the message text when there is one
function genericData(body) {
  let json = null;
  try { const j = JSON.stringify(body); if (j !== undefined && Buffer.byteLength(j) <= LIMITS.jsonBytes) json = JSON.parse(j); } catch { /* not data */ }
  const t = genericText(body);
  return { source: 'webhook', json, text: t.text || '' };
}

// remembers the last deliveries so a redelivery (GitHub retries, or someone pressing "Redeliver") does not post twice
class RecentIds {
  constructor(max = 500) { this.max = max; this.set = new Set(); }
  has(k) { return this.set.has(k); }
  add(k) { this.set.delete(k); this.set.add(k); while (this.set.size > this.max) this.set.delete(this.set.values().next().value); }
}

// One delivery, judged. Returns { status, error } to refuse, { status: 200, ignored } to accept and do nothing, or { status: 200, text, data } to act.
// text = the message to post; data = what a bot receives. The caller does the posting and applies the rate limit before calling this.
function receive(hook, { headers = {}, rawBody, body, seen, toBot = false } = {}) {
  const head = (k) => { const v = headers[k]; return String(Array.isArray(v) ? v[0] : v || ''); };
  if (hook.kind === 'github') {
    if (!hook.secret) return { status: 500, error: 'This webhook has no secret. Make a new one.' };
    if (!verifyGithubSignature(rawBody, head('x-hub-signature-256'), hook.secret)) return { status: 401, error: 'The signature does not match. Check that the Secret in GitHub is the one Aduna showed, and that the content type is application/json.' };
    const event = head('x-github-event').toLowerCase();
    if (!/^[a-z_]{1,40}$/.test(event)) return { status: 400, error: 'Missing X-GitHub-Event header' };
    const delivery = head('x-github-delivery').slice(0, 80), key = hook.id + ':' + delivery;
    if (delivery && seen && seen.has(key)) return { status: 200, ignored: 'duplicate delivery' };
    const g = githubEvent(event, body);
    if (!g) return { status: 200, ignored: `${event} events are not shown` };
    if (delivery && seen) seen.add(key);
    return { status: 200, text: g.text, data: { source: 'github', ...g.summary } };
  }
  const t = genericText(body);
  // a bot decides for itself what to do with the data, so any JSON object is fine for it: it does not need a "content" field
  if (t.error && toBot && body && typeof body === 'object' && !Array.isArray(body)) return { status: 200, text: '', data: genericData(body) };
  if (t.error) return { status: 400, error: t.error };
  return { status: 200, text: t.text, data: genericData(body) };
}

// ---------- records ----------
// Validates a create (full) or an edit (only the fields present). Returns { error } or { value: {fields to set} }.
// server: the server record (its channels); botIds: ids of the bots installed in it.
function checkHook(input, { server, current = null, botIds = [] } = {}) {
  const b = input || {}, full = !current, v = {};
  if (full || b.name !== undefined) {
    v.name = String(b.name ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name);
    if (!v.name) return { error: 'Give the webhook a name' };
  }
  if (full) { v.kind = b.kind === undefined ? 'generic' : b.kind; if (!KINDS.includes(v.kind)) return { error: 'Kind must be generic or github' }; }
  else if (b.kind !== undefined && b.kind !== current.kind) return { error: 'The kind cannot be changed. Make a new webhook instead.' };
  const orNull = (x) => (x === undefined || x === null || x === '' ? null : String(x));
  if (full || b.botId !== undefined) {
    const id = orNull(b.botId);
    if (id && !botIds.includes(id)) return { error: 'That bot is not in this server' };
    v.botId = id;
  }
  if (full || b.channelId !== undefined) {
    const id = orNull(b.channelId);
    if (id) { const c = ((server && server.channels) || []).find((x) => x.id === id); if (!c || ((c && c.type) || 'text') !== 'text') return { error: 'Pick a text channel of this server' }; }
    v.channelId = id;
  }
  const after = { ...(current || {}), ...v };
  if (!after.botId && !after.channelId) return { error: 'Pick the channel the messages should go to' };
  return { value: v };
}

// What the people who manage the server see. Never the token or the secret.
function hookView(h, server) {
  const c = h.channelId ? ((server && server.channels) || []).find((x) => x.id === h.channelId) : null;
  return {
    id: h.id, name: h.name, kind: h.kind, channelId: h.channelId || null, channelName: c ? c.name : null, botId: h.botId || null,
    broken: !h.botId && !c, createdAt: h.createdAt || null, lastUsedAt: h.lastUsedAt || null, uses: h.uses || 0,
  };
}

module.exports = { LIMITS, KINDS, ID_RE, newToken, newSecret, tokenHash, validToken, tokenMatches, verifyGithubSignature, esc, line, githubEvent, genericText, genericData, RecentIds, receive, checkHook, hookView };
