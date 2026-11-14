// Per-server automod: banned words, link and invite filters, capitals, mention floods and repeat spam. A message that breaks a rule is
// refused, and rules set to "warn" add a strike that can climb to a timeout or a kick. Pure logic, no Express and no database
// (tested by automod-test.js): index.js does the saving and the pushing.
//
//   s.automod        = { enabled, words, rules, strikes: { expireDays, ladder }, exemptRoles, exemptChannels, logChannel }
//   s.automodStrikes = { userId: [{ id, at, rule, what }] }    strikes stop counting after expireDays
//   s.automodMutes   = { userId: until }                       server timeouts
//   s.automodLog     = [{ id, at, userId, channelId, rule, what, action, count, preview }]   newest last
// Strikes and timeouts belong to one server. The platform-wide warnings in moderation.js are a separate thing.
const crypto = require('crypto');

const MINUTE = 60_000, DAY = 86_400_000;
const LIMITS = { words: 300, wordLen: 40, allow: 50, ladder: 6, maxMinutes: 40_320, logKeep: 100, strikeKeep: 50, preview: 80 };
const ACTIONS = ['timeout', 'kick'];
const NON_TEXT = ['voice', 'rules', 'todo', 'goals'];

const defaultLadder = () => [
  { at: 3, action: 'timeout', minutes: 10 },
  { at: 5, action: 'timeout', minutes: 1440 },
  { at: 8, action: 'kick' },
];

const defaults = () => ({
  enabled: false,
  words: [],
  rules: {
    words: { on: true, warn: true },
    links: { on: false, warn: false, allow: [] },
    invites: { on: false, warn: true },
    caps: { on: false, warn: false, percent: 70, minLetters: 12 },
    mentions: { on: false, warn: true, max: 5 },
    repeat: { on: false, warn: false, times: 3, seconds: 30 },
  },
  strikes: { expireDays: 30, ladder: defaultLadder() },
  exemptRoles: [],
  exemptChannels: [],
  logChannel: null,
});

const newId = () => crypto.randomBytes(6).toString('hex');
const whole = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };

// "10 minutes", "2 hours", "3 days": for the messages people read
function left(ms) {
  const m = Math.max(1, Math.round(ms / MINUTE));
  if (m < 60) return m + (m === 1 ? ' minute' : ' minutes');
  const h = Math.round(m / 60);
  if (h < 48) return h + (h === 1 ? ' hour' : ' hours');
  return Math.round(h / 24) + ' days';
}

// ---------- saving settings ----------
function cleanWords(list) {
  if (!Array.isArray(list)) return { error: 'Banned words must be a list' };
  const out = [];
  for (const raw of list) {
    const w = String(raw == null ? '' : raw).toLowerCase().replace(/\s+/g, ' ').trim();
    if (!w) continue;
    if (w.length > LIMITS.wordLen) return { error: `A banned word can be at most ${LIMITS.wordLen} characters` };
    if (!/[\p{L}\p{N}]/u.test(w)) return { error: `"${w}" needs at least one letter or number` };
    if (!out.includes(w)) out.push(w);
  }
  if (out.length > LIMITS.words) return { error: `You can ban up to ${LIMITS.words} words` };
  return { value: out };
}

function cleanDomains(list) {
  if (list === undefined) return { value: [] };
  if (!Array.isArray(list)) return { error: 'Allowed sites must be a list' };
  const out = [];
  for (const raw of list) {
    const d = String(raw == null ? '' : raw).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
    if (!d) continue;
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,24}$/.test(d)) return { error: `"${d}" is not a site address (try example.com)` };
    if (!out.includes(d)) out.push(d);
  }
  if (out.length > LIMITS.allow) return { error: `You can allow up to ${LIMITS.allow} sites` };
  return { value: out };
}

function cleanLadder(list) {
  if (!Array.isArray(list)) return { error: 'The warning steps must be a list' };
  if (list.length > LIMITS.ladder) return { error: `Use at most ${LIMITS.ladder} warning steps` };
  const out = [];
  for (const s of list) {
    const at = whole(s && s.at, 1, 50);
    if (at === null) return { error: 'A warning step needs a warning count from 1 to 50' };
    if (!ACTIONS.includes(s.action)) return { error: 'A warning step is either a timeout or a kick' };
    if (out.some((x) => x.at === at)) return { error: `Two steps are set for ${at} warnings` };
    if (s.action === 'kick') { out.push({ at, action: 'kick' }); continue; }
    const minutes = whole(s.minutes, 1, LIMITS.maxMinutes);
    if (minutes === null) return { error: `A timeout is 1 to ${LIMITS.maxMinutes} minutes` };
    out.push({ at, action: 'timeout', minutes });
  }
  return { value: out.sort((a, b) => a.at - b.at) };
}

// body is what the settings screen sends; server is only used to drop roles and channels that no longer exist
function clean(body, server) {
  if (!body || typeof body !== 'object') return { error: 'Invalid automod settings' };
  const d = defaults();
  const r = body.rules && typeof body.rules === 'object' ? body.rules : {};
  const sub = (k) => (r[k] && typeof r[k] === 'object' ? r[k] : {});
  const number = (v, def, min, max, label) => {
    if (v === undefined) return { value: def };
    const n = whole(v, min, max);
    return n === null ? { error: `${label} must be a whole number from ${min} to ${max}` } : { value: n };
  };

  const words = cleanWords(body.words === undefined ? [] : body.words); if (words.error) return words;
  const allow = cleanDomains(sub('links').allow); if (allow.error) return allow;
  const percent = number(sub('caps').percent, d.rules.caps.percent, 40, 100, 'Capitals percent'); if (percent.error) return percent;
  const minLetters = number(sub('caps').minLetters, d.rules.caps.minLetters, 5, 200, 'Capitals minimum length'); if (minLetters.error) return minLetters;
  const max = number(sub('mentions').max, d.rules.mentions.max, 1, 50, 'Mentions limit'); if (max.error) return max;
  const times = number(sub('repeat').times, d.rules.repeat.times, 2, 10, 'Repeat count'); if (times.error) return times;
  const seconds = number(sub('repeat').seconds, d.rules.repeat.seconds, 5, 300, 'Repeat window'); if (seconds.error) return seconds;
  const st = body.strikes && typeof body.strikes === 'object' ? body.strikes : {};
  const expireDays = number(st.expireDays, d.strikes.expireDays, 1, 365, 'Warnings last'); if (expireDays.error) return expireDays;
  const ladder = st.ladder === undefined ? { value: d.strikes.ladder } : cleanLadder(st.ladder); if (ladder.error) return ladder;

  const roleIds = new Set((server.roles || []).map((x) => x.id));
  const channelIds = new Set((server.channels || []).map((x) => x.id));
  const ids = (list, known) => [...new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string' && known.has(x)) : [])];
  const on = (k) => sub(k).on === true, warn = (k) => sub(k).warn === true;
  const logChannel = (server.channels || []).find((c) => c.id === body.logChannel && !NON_TEXT.includes(c.type || 'text'));

  return {
    value: {
      enabled: body.enabled === true,
      words: words.value,
      rules: {
        words: { on: on('words'), warn: warn('words') },
        links: { on: on('links'), warn: warn('links'), allow: allow.value },
        invites: { on: on('invites'), warn: warn('invites') },
        caps: { on: on('caps'), warn: warn('caps'), percent: percent.value, minLetters: minLetters.value },
        mentions: { on: on('mentions'), warn: warn('mentions'), max: max.value },
        repeat: { on: on('repeat'), warn: warn('repeat'), times: times.value, seconds: seconds.value },
      },
      strikes: { expireDays: expireDays.value, ladder: ladder.value },
      exemptRoles: ids(body.exemptRoles, roleIds),
      exemptChannels: ids(body.exemptChannels, channelIds),
      logChannel: logChannel ? logChannel.id : null,
    },
  };
}

// ---------- reading messages ----------
const strip = (s) => String(s).toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
const leet = (s) => s.replace(/[013457@$]/g, (c) => LEET[c]);
const squeeze = (t) => t.replace(/(.)\1{2,}/gu, '$1'); // "fuuuck" -> "fuck"

// "f u c k" and "f.u.c.k" arrive as single-letter tokens: three or more in a row are read as one word
function joinLetters(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length;) {
    let j = i;
    while (j < tokens.length && [...tokens[j]].length === 1) j++;
    if (j - i >= 3) { out.push(tokens.slice(i, j).join('')); i = j; } else { out.push(tokens[i]); i++; }
  }
  return out;
}
const tokensPlain = (text) => joinLetters(strip(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
const tokensLeet = (text) => joinLetters(leet(strip(text)).split(/[^\p{L}]+/u).filter(Boolean));

// An entry is one or more words; a * at either end of a word matches any start or end ("spam*", "*tard")
function compileEntry(entry, spelled) {
  const parts = strip(entry).split(/[^\p{L}\p{N}*]+/u).filter(Boolean).map((p) => {
    const pre = p.startsWith('*'), post = p.endsWith('*');
    const text = p.replace(/\*/g, '');
    return { text: spelled ? leet(text) : text, pre, post };
  }).filter((p) => p.text);
  return { entry, parts };
}
const compiled = new WeakMap();
function compiledWords(list) {
  let c = compiled.get(list);
  if (!c) { c = { plain: list.map((w) => compileEntry(w, false)), spelled: list.map((w) => compileEntry(w, true)) }; compiled.set(list, c); }
  return c;
}

function partMatches(p, token) {
  const t = squeeze(token);
  const one = (x) => (p.pre && p.post ? x.includes(p.text) : p.pre ? x.endsWith(p.text) : p.post ? x.startsWith(p.text) : x === p.text || x === p.text + 's');
  return one(token) || one(t);
}
function entryHits(e, tokens) {
  if (!e.parts.length) return false;
  const run = e.parts.length;
  for (let i = 0; i + run <= tokens.length; i++) if (e.parts.every((p, j) => partMatches(p, tokens[i + j]))) return true;
  if (run > 1) { // "kill yourself" typed as "killyourself"
    const joined = { text: e.parts.map((p) => p.text).join(''), pre: false, post: false };
    if (tokens.some((t) => partMatches(joined, t))) return true;
  }
  return false;
}
function bannedWord(words, text) {
  if (!words.length) return null;
  const c = compiledWords(words);
  const plain = tokensPlain(text), spelled = tokensLeet(text);
  for (let i = 0; i < words.length; i++) if (entryHits(c.plain[i], plain) || entryHits(c.spelled[i], spelled)) return words[i];
  return null;
}

const TLDS = 'com|net|org|io|gg|me|ly|co|xyz|ru|cn|tk|ml|app|link|club|top|info|to|dev|tv|us|uk|de|fr|ca|gl|sh|cc|ws|vip|shop|site|online|live|fun|store|tech|pw|ink|click|cf|ga|gq';
const URL_RE = new RegExp(`\\bhttps?:\\/\\/[^\\s<>]+|\\bwww\\.[^\\s<>]+|\\b(?:[a-z0-9-]+\\.)+(?:${TLDS})\\b(?:\\/[^\\s<>]*)?`, 'gi');
function urlsIn(text) {
  const out = [];
  for (const m of String(text).matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?)\]}'"]+$/, '');
    const rest = raw.replace(/^https?:\/\//i, '').replace(/^[^/@]*@/, '');
    const host = rest.split(/[/?#:]/)[0].toLowerCase().replace(/^www\./, '');
    const path = rest.slice(rest.split(/[/?#]/)[0].length);
    if (host) out.push({ host, path });
  }
  return out;
}
function inviteCodeOf(u) {
  if (u.host === 'discord.gg') { const m = /^\/([a-z0-9_-]{2,32})/i.exec(u.path); return m ? m[1].toLowerCase() : null; }
  const m = /^\/invite\/([a-z0-9_-]{3,32})/i.exec(u.path);
  return m ? m[1].toLowerCase() : null;
}
const hostAllowed = (host, allow) => allow.some((a) => host === a || host.endsWith('.' + a));

const recent = new Map(); // "serverId:userId" -> [{ norm, at }], kept in memory only
function repeated(key, text, rule, now) {
  const norm = strip(text).replace(/\s+/g, ' ').trim();
  if (norm.length < 3) return false;
  const since = now - rule.seconds * 1000;
  const list = (recent.get(key) || []).filter((x) => x.at > since);
  const same = list.filter((x) => x.norm === norm).length;
  if (same + 1 >= rule.times) { recent.set(key, list); return true; }
  list.push({ norm, at: now });
  recent.set(key, list.slice(-20));
  if (recent.size > 5000) for (const [k, v] of recent) if (!v.length || v[v.length - 1].at < now - 300_000) recent.delete(k);
  return false;
}

const REASON = {
  words: 'it has a word that is not allowed in this server',
  links: 'links are not allowed here',
  invites: 'invite links to other servers are not allowed',
  caps: 'it has too many capital letters',
  mentions: 'it has too many mentions',
  repeat: 'you are repeating the same message',
  names: 'a file name has a word that is not allowed in this server',
};

// null when the message is fine, else { rule, what, reason, warn }. ctx = { inviteCode, key, now }
function screen(cfg, text, ctx = {}) {
  if (!cfg || !cfg.enabled) return null;
  const content = String(text || '');
  if (!content.trim()) return null;
  const R = cfg.rules;
  const hit = (rule, what) => ({ rule, what: String(what).slice(0, 60), reason: REASON[rule], warn: !!R[rule].warn });

  if (R.words.on) { const w = bannedWord(cfg.words || [], content); if (w) return hit('words', w); }

  if (R.invites.on || R.links.on) {
    for (const u of urlsIn(content)) {
      const code = inviteCodeOf(u);
      const own = code && code === String(ctx.inviteCode || '').toLowerCase();
      if (code && !own && R.invites.on) return hit('invites', code);
      if (!own && R.links.on && !hostAllowed(u.host, R.links.allow || [])) return hit('links', u.host);
    }
  }

  if (R.mentions.on) {
    const n = (content.match(/<@[0-9a-f]{16}>/g) || []).length + (content.match(/(?<![\w<@])@(?:everyone|here)(?![\w])/g) || []).length;
    if (n > R.mentions.max) return hit('mentions', n);
  }

  if (R.caps.on) {
    const letters = [...content].filter((c) => c.toLowerCase() !== c.toUpperCase());
    if (letters.length >= R.caps.minLetters) {
      const upper = letters.filter((c) => c === c.toUpperCase()).length;
      const pct = Math.round((upper / letters.length) * 100);
      if (pct >= R.caps.percent) return hit('caps', pct + '%');
    }
  }

  if (R.repeat.on && ctx.key && repeated(ctx.key, content, R.repeat, ctx.now || Date.now())) return hit('repeat', R.repeat.times + ' times');
  return null;
}

// Attachment file names (and GIF titles) go through the banned words too. Same result shape as screen.
function screenNames(cfg, names) {
  if (!cfg || !cfg.enabled || !cfg.rules.words.on) return null;
  for (const name of names || []) {
    const w = bannedWord(cfg.words || [], String(name));
    if (w) return { rule: 'words', what: w.slice(0, 60), reason: REASON.names, warn: !!cfg.rules.words.warn };
  }
  return null;
}

// ---------- strikes, timeouts and the log ----------
// Adds a strike. Returns { count, step, next }: step is the ladder step this strike lands on (or null), next the one after it.
function strike(s, uid, hit, now) {
  const cfg = s.automod;
  const all = s.automodStrikes = s.automodStrikes || {};
  const keep = now - cfg.strikes.expireDays * DAY;
  const list = (all[uid] || []).filter((x) => x.at > keep);
  list.push({ id: newId(), at: now, rule: hit.rule, what: hit.what });
  all[uid] = list.slice(-LIMITS.strikeKeep);
  const count = all[uid].length;
  const ladder = cfg.strikes.ladder;
  return { count, step: ladder.find((l) => l.at === count) || null, next: ladder.find((l) => l.at > count) || null };
}
const activeStrikes = (s, uid, now) => {
  const days = s.automod ? s.automod.strikes.expireDays : 30;
  return ((s.automodStrikes || {})[uid] || []).filter((x) => x.at > now - days * DAY);
};

function timeoutUser(s, uid, minutes, now) {
  s.automodMutes = s.automodMutes || {};
  s.automodMutes[uid] = now + minutes * MINUTE;
}
// milliseconds left on a timeout, 0 when there is none; a finished one is dropped
function timeoutLeft(s, uid, now) {
  const until = s.automodMutes && s.automodMutes[uid];
  if (!until) return 0;
  if (until <= now) { delete s.automodMutes[uid]; return 0; }
  return until - now;
}
function forgive(s, uid) {
  if (s.automodStrikes) delete s.automodStrikes[uid];
  if (s.automodMutes) delete s.automodMutes[uid];
}

function record(s, entry) {
  s.automodLog = [...(s.automodLog || []), { id: newId(), ...entry, preview: String(entry.preview || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.preview) }].slice(-LIMITS.logKeep);
}

// What the person who sent the message is told
function notice(hit, r) {
  const base = `Message not sent: ${hit.reason}.`;
  if (!r) return base;
  if (r.step && r.step.action === 'kick') return `${base} You have been removed from this server.`;
  if (r.step) return `${base} You are timed out for ${left(r.step.minutes * MINUTE)}.`;
  const more = r.next ? ` At ${r.next.at} warnings you will be ${r.next.action === 'kick' ? 'removed from the server' : 'timed out for ' + left(r.next.minutes * MINUTE)}.` : '';
  return `${base} Warning ${r.count}.${more}`;
}
const timeoutNotice = (ms) => `You are timed out in this server for ${left(ms)}`;

// The line posted in the log channel. step is the ladder step the warning landed on, if any.
function logText(entry, who, channelName, step) {
  const where = `#${channelName} (${entry.rule}: ${entry.what})`;
  if (entry.action === 'blocked') return `${who} had a message blocked in ${where}.`;
  if (entry.action === 'kick') return `${who} was removed from the server after ${entry.count} warnings, in ${where}.`;
  if (entry.action === 'timeout') return `${who} was timed out for ${left((step ? step.minutes : 0) * MINUTE)} in ${where}. Warning ${entry.count}.`;
  return `${who} was warned in ${where}. Warning ${entry.count}.`;
}

// What the settings screen gets (managers only: the word list is not shown to everyone)
function view(s, now, nameOf = (x) => x) {
  const ids = new Set([...Object.keys(s.automodStrikes || {}), ...Object.keys(s.automodMutes || {})]);
  const strikes = [...ids].map((userId) => ({ userId, count: activeStrikes(s, userId, now).length, until: (s.automodMutes || {})[userId] > now ? s.automodMutes[userId] : null }))
    .filter((x) => x.count > 0 || x.until);
  return {
    config: s.automod || defaults(),
    strikes: strikes.sort((a, b) => b.count - a.count).slice(0, 100),
    log: (s.automodLog || []).slice(-50).reverse().map((l) => ({ ...l, user: nameOf(l.userId) })),
  };
}

module.exports = { LIMITS, defaults, clean, screen, screenNames, logText, strike, activeStrikes, timeoutUser, timeoutLeft, forgive, record, notice, timeoutNotice, view, left };
