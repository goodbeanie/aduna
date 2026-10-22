// The host side of bots: takes an event, runs the bot in the sandbox, and applies what the bot ASKED for. Everything it needs from the rest
// of the server is passed in (createBotHost), so botrun-style tests can drive it with a fake database and a fake socket server
// (bothost-test.js) without Postgres or Express.
//
// What happens for one event, in order:
//  1. the bot's saved data and timers in THIS server are read into a snapshot and handed to the sandbox with the event;
//  2. the sandbox returns lists: store changes, timer requests, messages, reactions, fetches (it did none of them);
//  3. they are applied here, in that order, each one re-checked: storage and timers (botstate.js), messages and reactions (botrun.js plan*),
//     fetches (botfetch.js); every kind has its own per-minute budget (botrun.Guard);
//  4. a fetch is answered later, as a 'fetch' event for the same bot in the same server.
// Events for one bot in one server run one after the other (serial), so a counter read in one event always sees the write of the one before.
// Timers: every few seconds tick() looks for due timers in installed bots and sends them as 'timer' events.
const botrun = require('./botrun');
const botstate = require('./botstate');

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const installOf = (s, botId) => (s.installedBots || []).find((i) => i.botId === botId);
const runnable = (b) => !!b && !(b.listingHold && b.listingHold.state === 'removed');
const clip = (s, n) => String(s ?? '').slice(0, n);
const MAX_TIMERS_PER_TICK = 20;
const MAX_REACTION_KINDS = 20; // the same cap people have on one message

function createBotHost({ db, store, io, sandbox, fetcher, postMessage, emojiOk, maxMsg = 2000, now = Date.now, guard = new botrun.Guard({ now }), tickMs = 5000 }) {
  // ---- one event at a time per bot per server ----
  const chains = new Map();
  function serial(key, fn) {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(fn);
    const tail = next.catch(() => {});
    chains.set(key, tail);
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return next;
  }

  function addReaction(msg, emoji, userId) {
    if (!msg.reactions || typeof msg.reactions !== 'object') msg.reactions = {};
    const has = own(msg.reactions, emoji);
    const list = has ? msg.reactions[emoji] : [];
    if (list.includes(userId)) return false;
    if (!has && Object.keys(msg.reactions).length >= MAX_REACTION_KINDS) return false;
    if (!has) msg.reactions[emoji] = list;
    list.push(userId);
    io.to('channel:' + msg.channelId).emit('reaction:update', { kind: 'channel', messageId: msg.id, reactions: msg.reactions });
    return true;
  }

  const log = (b, s, event, extra) => guard.log(b.id, { serverId: s.id, server: s.name, event, logs: [], dropped: [], ...extra });

  // Applies the result of one run. `live` is the install record in the CURRENT server (the server, the install or the bot may have
  // changed while the code was running, so this is looked up again by the caller).
  function apply({ r, cur, live, bot, mentionUserId, entry }) {
    let changed = false;
    if (r.store.length) { live.kv = live.kv && typeof live.kv === 'object' ? live.kv : {}; entry.dropped.push(...botstate.applyStoreOps(live.kv, r.store).dropped); entry.stored = r.store.length; changed = true; }
    if (r.timers.length) { entry.dropped.push(...botstate.applyTimers(live, r.timers, now()).dropped); entry.timers = r.timers.length; changed = true; }
    if (changed) store.save(); // saved before anything is posted: a crash cannot leave a counter behind its own message

    const botUser = db().users[live.userId];
    const plan = botrun.planActions({
      actions: r.actions, server: cur, install: live, mentionUserId, maxText: maxMsg,
      replyOk: (cid, mid) => { const m = own(db().messages, mid) ? db().messages[mid] : null; return m && m.channelId === cid ? mid : null; },
    });
    entry.dropped.push(...plan.dropped);
    const room = guard.takeMessages(bot.id, cur.id, plan.send.length);
    if (room < plan.send.length) entry.dropped.push(`${plan.send.length - room} message(s) over the limit of ${botrun.LIMITS.messagesPerMin} per minute`);
    for (const a of plan.send.slice(0, room)) { postMessage(cur, a.channel, botUser, a); entry.sent++; }

    if (r.reactions.length) {
      const rp = botrun.planReactions({ actions: r.reactions, server: cur, install: live, messageOf: (id) => (own(db().messages, id) ? db().messages[id] : null), emojiOk });
      entry.dropped.push(...rp.dropped);
      const rr = guard.takeReactions(bot.id, cur.id, rp.react.length);
      if (rr < rp.react.length) entry.dropped.push(`${rp.react.length - rr} reaction(s) over the limit of ${botrun.LIMITS.reactionsPerMin} per minute`);
      let added = 0;
      for (const x of rp.react.slice(0, rr)) if (addReaction(x.msg, x.emoji, botUser.id)) added++;
      if (added) { store.save(); entry.reacted = added; }
    }

    if (r.fetches.length) {
      const fp = botrun.planFetches({ actions: r.fetches, check: fetcher.check });
      entry.dropped.push(...fp.dropped);
      const fr = guard.takeFetches(bot.id, cur.id, fp.fetch.length);
      if (fr < fp.fetch.length) entry.dropped.push(`${fp.fetch.length - fr} fetch(es) over the limit of ${botrun.LIMITS.fetchesPerMin} per minute`);
      for (const req of fp.fetch.slice(0, fr)) startFetch(cur.id, bot.id, req, mentionUserId);
      entry.fetches = fr;
    }
  }

  function runBotEvent(s, inst, b, event, payload, { mentionUserId = null } = {}) {
    return serial(b.id + ':' + s.id, async () => {
      const bot0 = db().bots[b.id], cur0 = db().servers[s.id], live0 = cur0 && installOf(cur0, b.id);
      if (!live0 || !runnable(bot0)) return; // removed while it waited in line
      const r = await sandbox.run({ code: bot0.code, event, payload, state: botstate.snapshotFor(live0) });
      guard.record(b.id, r);
      const entry = { serverId: s.id, server: s.name, event, ok: r.ok, ms: r.ms, error: r.error || null, timedOut: !!r.timedOut, logs: r.logs || [], sent: 0, dropped: [] };
      const cur = db().servers[s.id], live = cur && installOf(cur, b.id), bot = db().bots[b.id];
      if (live && runnable(bot)) apply({ r, cur, live, bot, mentionUserId, entry });
      guard.log(b.id, entry);
    });
  }

  // ---- fetch answers ----
  function startFetch(serverId, botId, req, mentionUserId) {
    fetcher.get(req.url).then((result) => {
      const s = db().servers[serverId], inst = s && installOf(s, botId), b = db().bots[botId];
      if (!inst || !runnable(b)) return null;
      const admit = guard.admit(botId, serverId);
      if (!admit.ok) { log(b, s, 'fetch', { ok: false, skipped: admit.reason }); return null; }
      return runBotEvent(s, inst, b, 'fetch', botrun.fetchPayload({ server: s, install: inst, request: req, result }), { mentionUserId });
    }).catch((e) => {
      const s = db().servers[serverId], b = db().bots[botId];
      if (s && b) log(b, s, 'fetch', { ok: false, error: clip(e && e.message, 200) });
    });
  }

  // ---- events from the rest of the server ----
  // The payload a bot gets for an event, or null when this bot must not see it. Bots never receive events caused by bots (no loops), and
  // channels the install does not allow stay unseen.
  function payloadFor(s, inst, event, a) {
    const { channel, msg, author, user, reason, by } = a;
    if (event === 'message' || event === 'messageEdit') {
      if (!author || author.bot || !botrun.channelAllowed(inst, channel)) return null;
      const args = { msg, author, botUserId: inst.userId };
      return { payload: event === 'message' ? botrun.messagePayload(args) : botrun.editPayload(args), trigger: author.id };
    }
    if (event === 'memberJoin') return !user || user.bot ? null : { payload: botrun.joinPayload({ server: s, user, install: inst }), trigger: user.id };
    if (event === 'memberLeave') return !user || user.bot ? null : { payload: botrun.leavePayload({ server: s, user, install: inst, reason }), trigger: null };
    if (event === 'install') return { payload: botrun.installPayload({ server: s, install: inst, by }), trigger: by && !by.bot ? by.id : null };
    return null;
  }
  function dispatchTo(s, inst, event, a) {
    const b = db().bots[inst.botId];
    if (!runnable(b) || !sandbox.available()) return;
    const p = payloadFor(s, inst, event, a);
    if (!p) return;
    const admit = guard.admit(b.id, s.id);
    if (!admit.ok) { log(b, s, event, { ok: false, skipped: admit.reason }); return; }
    runBotEvent(s, inst, b, event, p.payload, { mentionUserId: p.trigger })
      .catch((e) => log(b, s, event, { ok: false, error: clip(e && e.message, 200) }));
  }
  // Hands an event to every bot in the server that may see it. Never blocks the caller; a failing bot only fills its own log.
  function dispatch(s, event, a) {
    if (!(s.installedBots || []).length || !sandbox.available()) return;
    for (const inst of s.installedBots.slice()) dispatchTo(s, inst, event, a);
  }

  // ---- timers ----
  function tick() {
    if (!sandbox.available()) return;
    const t = now();
    let started = 0, changed = false;
    for (const s of Object.values(db().servers)) {
      for (const inst of s.installedBots || []) {
        if (!Array.isArray(inst.timers) || !inst.timers.length) continue;
        const b = db().bots[inst.botId];
        if (!runnable(b)) continue;
        for (const tm of botstate.dueTimers(inst, t)) {
          if (started >= MAX_TIMERS_PER_TICK) { if (changed) store.save(); return; }
          const admit = guard.admit(b.id, s.id);
          if (!admit.ok) { tm.at = t + 60_000; changed = true; log(b, s, 'timer', { ok: false, skipped: admit.reason }); continue; } // over budget or paused: try again in a minute
          const payload = botrun.timerPayload({ server: s, install: inst, timer: tm, firedAt: t });
          botstate.advance(inst, tm, t); // before the run, so a slow bot cannot make the same timer fire twice
          changed = true; started++;
          runBotEvent(s, inst, b, 'timer', payload)
            .catch((e) => log(b, s, 'timer', { ok: false, error: clip(e && e.message, 200) }));
        }
      }
    }
    if (changed) store.save();
  }
  let handle = null;
  const startTimers = () => { if (!handle) { handle = setInterval(tick, tickMs); if (handle.unref) handle.unref(); } };
  const stopTimers = () => { clearInterval(handle); handle = null; };

  return { guard, runBotEvent, dispatch, dispatchTo, tick, startTimers, stopTimers, addReaction, installOf, runnable };
}

module.exports = { createBotHost, installOf, runnable };
