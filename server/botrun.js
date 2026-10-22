// What a bot may DO once the sandbox has run its code, and the limits that stop one bot hogging the server.
// No Express, no database, no sandbox in here (tested by botrun-test.js without any of them).
//
// The sandbox (sandbox.js) only COLLECTS what a bot asked for: [{ channelId, text, replyTo }]. This file decides which of those are allowed:
//  - only channels of the server the event happened in, and only plain text channels (never voice, rules or announcements);
//  - only channels the server admin allowed for that bot (install.channels, null = every text channel);
//  - a bot cannot ping anyone except the person whose message or join it is answering, and never @everyone;
//  - replies only point at messages of the same channel.
//  - reactions go only on messages of a channel the install may read, with an emoji that exists (the host's emojiOk);
//  - outside requests (fetch) are only passed on if botfetch.js accepts the address; the answer comes back later as a 'fetch' event.
// And the Guard keeps the budget: events per minute per bot per server, messages, reactions and fetches per minute, CPU time per bot, and a pause after
// repeated timeouts (each timeout costs the host a worker restart, so a bot that keeps timing out is switched off for a while).

const LIMITS = {
  perServer: 10,            // bots in one server
  eventsPerMin: 30,         // events delivered to one bot in one server per minute
  messagesPerMin: 20,       // messages one bot may post in one server per minute
  reactionsPerMin: 30,      // reactions one bot may add in one server per minute
  fetchesPerMin: 10,        // outside requests one bot may start in one server per minute
  cpuMsPerMin: 3000,        // sandbox time one bot may use per minute, across all servers
  timeoutStrikes: 3,        // timeouts / out-of-memory runs in a row before the bot is paused
  pauseMs: 5 * 60_000,      // how long the pause lasts (saving the code lifts it)
  logKeep: 100,             // log entries kept per bot (memory only)
  channelsInPayload: 30,
};

const typeOf = (c) => (c && c.type) || 'text';
// A bot reads and writes only plain text channels, and only the ones its install allows.
const channelAllowed = (install, channel) => !!channel && typeOf(channel) === 'text' && (!Array.isArray(install?.channels) || install.channels.includes(channel.id));

const MENTION_TOKEN = /<@([0-9a-f]{16})>/g;

// ---------- event payloads: the same shapes for real events and for the developer's test run ----------
const person = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, bot: !!u.bot });
// message = { id, channelId, serverId, text, mentions: [userId], mentionsBot, author: { id, username, displayName, bot }, createdAt }
function messagePayload({ msg, author, botUserId }) {
  const mentions = Array.isArray(msg.mentions) ? msg.mentions.slice(0, 50) : [];
  return {
    id: msg.id, channelId: msg.channelId, serverId: msg.serverId, text: String(msg.content || '').slice(0, 4000),
    mentions, mentionsBot: !!botUserId && mentions.includes(botUserId), attachments: Array.isArray(msg.attachments) ? msg.attachments.length : 0,
    replyTo: msg.replyTo || null, author: person(author), createdAt: msg.createdAt,
  };
}
// memberJoin = { serverId, user: { id, username, displayName, bot }, channels: [{ id, name }] }  (the text channels this bot may write in)
function joinPayload({ server, user, install }) {
  return { serverId: server.id, user: person(user), channels: writableChannels(server, install) };
}

// messageEdit: the same shape as a message, plus when it was edited (an edit never pings and the bot may answer it like any message)
function editPayload({ msg, author, botUserId }) { return { ...messagePayload({ msg, author, botUserId }), editedAt: msg.editedAt || null }; }
// memberLeave: reason is 'left' or 'kicked'. The person is already out of the server; mention tokens for them no longer ping.
function leavePayload({ server, user, install, reason }) {
  return { serverId: server.id, user: person(user), reason: reason === 'kicked' ? 'kicked' : 'left', channels: writableChannels(server, install) };
}
// install: the bot was just added to this server (by: the person who added it)
function installPayload({ server, install, by }) {
  return { serverId: server.id, serverName: String(server.name || ''), by: by ? person(by) : null, channels: writableChannels(server, install) };
}
// timer: data is whatever JSON the bot attached when it asked for the timer
function timerPayload({ server, install, timer, firedAt }) {
  let data = null; if (typeof timer.data === 'string') { try { data = JSON.parse(timer.data); } catch { data = null; } }
  return { serverId: server.id, name: timer.name, kind: timer.kind, data, firedAt, channels: writableChannels(server, install) };
}
// fetch: the answer to bot.fetch(url, name). result is what botfetch.js returned; json is null when the body was not JSON or was too big.
function fetchPayload({ server, install, request, result }) {
  const r = result || {};
  return {
    serverId: server.id, name: request.name || 'fetch', url: request.url, ok: !!r.ok, status: Number(r.status) || 0,
    text: typeof r.text === 'string' ? r.text : '', json: r.json === undefined ? null : r.json, truncated: !!r.truncated, error: r.error || null,
    channels: writableChannels(server, install),
  };
}
const writableChannels = (server, install) => (server.channels || []).filter((c) => channelAllowed(install, c)).slice(0, LIMITS.channelsInPayload).map((c) => ({ id: c.id, name: c.name }));

// ---------- what a bot's actions may do ----------
// actions: what the sandbox collected. replyOk(channelId, messageId) -> messageId | null.
// Returns { send: [{ channel, text, replyTo, mentions }], dropped: [reason] }.
function planActions({ actions, server, install, mentionUserId, replyOk, maxText = 2000 }) {
  const send = [], dropped = [];
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || typeof a.channelId !== 'string' || typeof a.text !== 'string') { dropped.push('malformed action'); continue; } // the sandbox already sends strings; this does not rely on it
    const channel = (server.channels || []).find((c) => c.id === a.channelId);
    if (!channel) { dropped.push('unknown channel'); continue; }
    if (typeOf(channel) !== 'text') { dropped.push(`#${channel.name} is not a text channel`); continue; }
    if (!channelAllowed(install, channel)) { dropped.push(`not allowed in #${channel.name}`); continue; }
    const text = String(a.text || '').slice(0, maxText);
    if (!text.trim()) { dropped.push('empty message'); continue; }
    const replyTo = a.replyTo && replyOk ? replyOk(channel.id, a.replyTo) : null;
    // the only person a bot may ping is the one it is answering (and only if they are still in the server)
    const mentions = mentionUserId && server.members.includes(mentionUserId) && text.includes(`<@${mentionUserId}>`) ? [mentionUserId] : [];
    send.push({ channel, text, replyTo, mentions });
  }
  return { send, dropped };
}

// Reactions: [{ messageId, emoji }] -> { react: [{ msg, emoji }], dropped }. messageOf(id) -> message | null; emojiOk(emoji) -> bool.
// A bot reacts only to messages in a text channel of THIS server that its install may read (so not to DMs, other servers or hidden channels).
function planReactions({ actions, server, install, messageOf, emojiOk }) {
  const react = [], dropped = [], seen = new Set();
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || typeof a.messageId !== 'string' || typeof a.emoji !== 'string') { dropped.push('malformed reaction'); continue; }
    const msg = messageOf(a.messageId);
    const channel = msg && (server.channels || []).find((c) => c.id === msg.channelId);
    if (!msg || !channel || msg.serverId !== server.id) { dropped.push('reaction: unknown message'); continue; }
    if (!channelAllowed(install, channel)) { dropped.push(`reaction: not allowed in #${channel.name}`); continue; }
    if (!emojiOk(a.emoji)) { dropped.push(`reaction: "${String(a.emoji).slice(0, 12)}" is not an emoji`); continue; }
    const key = msg.id + '|' + a.emoji;
    if (seen.has(key)) continue; seen.add(key);
    react.push({ msg, emoji: a.emoji });
  }
  return { react, dropped };
}

// Fetches: [{ url, name }] -> { fetch: [{ url, name }], dropped }. check(url) is botfetch's checkUrl: { url } or { error }. The first
// `perRun` are kept (botfetch.LIMITS.perRun), the name must look like a timer name so the answer can be told apart.
const FETCH_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,31}$/;
function planFetches({ actions, check, perRun = 3 }) {
  const out = [], dropped = [];
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || typeof a.url !== 'string') { dropped.push('malformed fetch'); continue; }
    if (out.length >= perRun) { dropped.push(`fetch: more than ${perRun} in one event`); continue; }
    const name = typeof a.name === 'string' && a.name ? a.name : 'fetch';
    if (!FETCH_NAME.test(name)) { dropped.push('fetch: bad name (1 to 32 letters, numbers, _ . : -)'); continue; }
    const c = check(a.url);
    if (c.error) { dropped.push('fetch: ' + c.error); continue; }
    out.push({ url: c.url, name });
  }
  return { fetch: out, dropped };
}

// ---------- limits ----------
class Guard {
  constructor({ now = Date.now, limits = {} } = {}) {
    this.now = now; this.L = { ...LIMITS, ...limits };
    this.events = new Map();   // `${botId}:${serverId}` -> [timestamps]
    this.sent = new Map();     // `${botId}:${serverId}` -> [timestamps]
    this.reacted = new Map();  // same, for reactions
    this.fetched = new Map();  // same, for outside requests
    this.cpu = new Map();      // botId -> [{ t, ms }]
    this.strikes = new Map();  // botId -> consecutive timeouts
    this.paused = new Map();   // botId -> until
    this.journal = new Map();  // botId -> [entry]
  }
  #recent(map, key, span = 60_000) {
    const t = this.now(), list = (map.get(key) || []).filter((x) => t - (x.t ?? x) < span);
    if (list.length) map.set(key, list); else map.delete(key);
    return list;
  }
  pausedUntil(botId) { const u = this.paused.get(botId); if (u && u <= this.now()) { this.paused.delete(botId); this.strikes.delete(botId); return 0; } return u || 0; }
  // May this event be delivered? { ok: true } or { ok: false, reason }
  admit(botId, serverId) {
    if (this.pausedUntil(botId)) return { ok: false, reason: 'paused after repeated timeouts' };
    const used = this.#recent(this.cpu, botId).reduce((n, x) => n + x.ms, 0);
    if (used >= this.L.cpuMsPerMin) return { ok: false, reason: 'over its CPU budget for this minute' };
    const key = botId + ':' + serverId, list = this.#recent(this.events, key);
    if (list.length >= this.L.eventsPerMin) return { ok: false, reason: 'too many events for this minute' };
    list.push(this.now()); this.events.set(key, list);
    return { ok: true };
  }
  // The run finished: count its CPU time, and a timeout or an out-of-memory as a strike.
  record(botId, result) {
    const ms = Math.max(1, Math.min(10_000, Number(result && result.ms) || 0));
    const list = this.#recent(this.cpu, botId); list.push({ t: this.now(), ms }); this.cpu.set(botId, list);
    if (result && (result.timedOut || /too much memory|sandbox crashed/i.test(result.error || ''))) {
      const n = (this.strikes.get(botId) || 0) + 1; this.strikes.set(botId, n);
      if (n >= this.L.timeoutStrikes) { this.paused.set(botId, this.now() + this.L.pauseMs); return { paused: true }; }
    } else this.strikes.delete(botId);
    return { paused: false };
  }
  // How many of `n` things may this bot do in this server right now? Counts what it takes.
  #take(map, cap, botId, serverId, n) {
    const key = botId + ':' + serverId, list = this.#recent(map, key);
    const room = Math.max(0, Math.min(n, cap - list.length));
    const t = this.now(); for (let i = 0; i < room; i++) list.push(t);
    if (list.length) map.set(key, list);
    return room;
  }
  takeMessages(botId, serverId, n) { return this.#take(this.sent, this.L.messagesPerMin, botId, serverId, n); }
  takeReactions(botId, serverId, n) { return this.#take(this.reacted, this.L.reactionsPerMin, botId, serverId, n); }
  takeFetches(botId, serverId, n) { return this.#take(this.fetched, this.L.fetchesPerMin, botId, serverId, n); }
  resume(botId) { this.paused.delete(botId); this.strikes.delete(botId); this.cpu.delete(botId); }
  // The developer's run history (memory only; a restart empties it).
  log(botId, entry) {
    const list = this.journal.get(botId) || [];
    list.push({ at: this.now(), ...entry });
    if (list.length > this.L.logKeep) list.splice(0, list.length - this.L.logKeep);
    this.journal.set(botId, list);
  }
  logs(botId) { return (this.journal.get(botId) || []).slice().reverse(); }
  forget(botId) {
    for (const m of [this.cpu, this.strikes, this.paused, this.journal]) m.delete(botId);
    for (const m of [this.events, this.sent, this.reacted, this.fetched]) for (const k of [...m.keys()]) if (k.startsWith(botId + ':')) m.delete(k);
  }
}

module.exports = { LIMITS, Guard, channelAllowed, messagePayload, editPayload, joinPayload, leavePayload, installPayload, timerPayload, fetchPayload, planActions, planReactions, planFetches, MENTION_TOKEN };
