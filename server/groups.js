'use strict';
// Encrypted group chats and group calls.
//
// KEYS. A group has a symmetric AES-256 key per "epoch" (1, 2, 3...). The key is made in a member's browser, never here. For every
// member the browser wraps it with the pairwise ECDH key it already shares with that member (the same one DMs use) and uploads the
// wraps. The server stores wraps it cannot open and hands each member only their own. Every time the member list changes (add, remove,
// leave) or a member's identity key changes, the person doing it makes a NEW epoch and wraps it for exactly the members that remain, so
// people who left cannot read new messages and people who joined cannot read old ones. Old epochs stay, so history stays readable for
// the people who were there. Messages carry the epoch they were sealed with. The group NAME is encrypted with the epoch key too.
//
// What the server knows: who is in a group, when messages were sent and by whom, sizes, and call timing. Not text, files, or the name.
//
// CALLS. A group call is a mesh of WebRTC connections (everyone to everyone, up to MAX_CALL people). The server only keeps the roster,
// rings the other members and relays signalling, which the browsers encrypt with their pairwise key (so the server cannot swap the
// DTLS fingerprints and sit in the middle).
const security = require('./security');
const calllog = require('./calllog');

const MAX_GROUP = 20;        // people in one group chat
const MIN_CREATE = 3;        // a group is you plus at least two others (with one other person, use a DM)
const MAX_CALL = 8;          // a mesh gets heavy beyond this
const MAX_GROUPS_PER_USER = 50;
const MAX_CIPHER = 12000;
const MAX_ATTACH = 4;
const RING_MS = () => Number(process.env.CALL_RING_MS) || 45_000;

// ---------- pure rules (groups-test.js) ----------
const isId = (x) => typeof x === 'string' && x.length > 0 && x.length <= 64;
const isB64ish = (x, max) => typeof x === 'string' && x.length > 0 && x.length <= max && /^[A-Za-z0-9+/=_-]+$/.test(x);

// A wrapped key: { ciphertext, iv, pk } (pk = short fingerprint of the public key it was wrapped for; the browsers use it to notice a changed key).
function cleanWrap(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  if (!isB64ish(w.ciphertext, 400) || !isB64ish(w.iv, 32)) return null;
  const pk = w.pk === undefined ? '' : w.pk;
  if (typeof pk !== 'string' || pk.length > 64 || !/^[A-Za-z0-9+/=_-]*$/.test(pk)) return null;
  return { ciphertext: w.ciphertext, iv: w.iv, pk };
}

// wraps must be an object with exactly one good wrap for every id in `ids` and nothing else. Returns a clean copy or null.
function checkWraps(wraps, ids) {
  if (!wraps || typeof wraps !== 'object' || Array.isArray(wraps)) return null;
  const keys = Object.keys(wraps);
  if (keys.length !== ids.length || new Set(ids).size !== ids.length) return null;
  const out = Object.create(null);
  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(wraps, id)) return null;
    const w = cleanWrap(wraps[id]);
    if (!w) return null;
    out[id] = w;
  }
  return out;
}

// The encrypted group name: { ciphertext, iv }. The epoch is set by the server, never taken from the request.
function cleanName(n) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
  if (!isB64ish(n.ciphertext, 600) || !isB64ish(n.iv, 32)) return null;
  return { ciphertext: n.ciphertext, iv: n.iv };
}

const idList = (x, max) => (Array.isArray(x) && x.length <= max && x.every(isId) && new Set(x).size === x.length ? x : null);

function createGroup({ id, ownerId, others, nameEnc, wraps, byKey, at }) {
  const members = [ownerId, ...others];
  return {
    id, ownerId, members, createdAt: at, epoch: 1,
    nameEnc: { ...nameEnc, epoch: 1 },
    keys: { 1: { by: ownerId, byKey, wraps } },
  };
}

// A new epoch for a new member list. Mutates the group.
function rotate(g, { members, nameEnc, wraps, by, byKey }) {
  g.epoch += 1;
  g.members = members;
  g.nameEnc = { ...nameEnc, epoch: g.epoch };
  g.keys[g.epoch] = { by, byKey, wraps };
  // wraps for people who are no longer members are useless and are dropped from every epoch
  for (const k of Object.values(g.keys)) for (const id of Object.keys(k.wraps)) if (!members.includes(id)) delete k.wraps[id];
  if (!members.includes(g.ownerId)) g.ownerId = members[0]; // the longest-standing remaining member takes over
  return g;
}

// What one member is allowed to see of a group. `pub` turns a user into the public profile.
function viewFor(g, uid, pub, extra = {}) {
  const keys = {};
  for (const [ep, k] of Object.entries(g.keys)) if (k.wraps[uid]) keys[ep] = { by: k.by, byKey: k.byKey, wrap: k.wraps[uid] };
  return {
    id: g.id, ownerId: g.ownerId, epoch: g.epoch, createdAt: g.createdAt, nameEnc: g.nameEnc,
    members: g.members.map(pub).filter((u) => u && u.id),
    keys, ...extra,
  };
}

// ---------- group call roster (pure; no sockets, no timers) ----------
// call: { id, groupId, video, startedBy, startedAt, answeredAt | null, parts: Map(uid -> socketId), everyone: Set(uid) }
function createRoster({ now = Date.now, id }) {
  const calls = new Map(); // groupId -> call
  const byUser = (uid) => { for (const c of calls.values()) if (c.parts.has(uid)) return c; return null; };
  return {
    calls,
    of: (groupId) => calls.get(groupId) || null,
    byUser,
    // { error } or { call, created, peers } (peers = people already in it, who the joiner connects to)
    join(groupId, uid, sid, video) {
      const other = byUser(uid);
      if (other && other.groupId !== groupId) return { error: 'You are already on a call' };
      let c = calls.get(groupId), created = false;
      if (!c) { c = { id: id(), groupId, video: !!video, startedBy: uid, startedAt: now(), answeredAt: null, parts: new Map(), everyone: new Set() }; calls.set(groupId, c); created = true; }
      if (!c.parts.has(uid) && c.parts.size >= MAX_CALL) return { error: `This call is full (${MAX_CALL} people)` };
      const peers = [...c.parts.keys()].filter((x) => x !== uid);
      const replaced = c.parts.get(uid) && c.parts.get(uid) !== sid ? c.parts.get(uid) : null; // joined again from another tab: that tab is moved here
      c.parts.set(uid, sid);
      c.everyone.add(uid);
      if (!c.answeredAt && c.everyone.size >= 2) c.answeredAt = now();
      return { call: c, created, peers, replaced };
    },
    // { call, ended, record } or null if uid was not in it (or sid is an old tab)
    leave(groupId, uid, sid) {
      const c = calls.get(groupId);
      if (!c || !c.parts.has(uid) || (sid && c.parts.get(uid) !== sid)) return null;
      c.parts.delete(uid);
      if (c.parts.size) return { call: c, ended: false, record: null };
      calls.delete(groupId);
      return { call: c, ended: true, record: calllog.makeGroupRecord(c, 'g:' + groupId, now()) };
    },
  };
}

// ---------- wiring ----------
function create(deps) {
  const { store, db, now, ah, auth, publicUser, areFriends, pushSafe, imgPath, isOnline } = deps;
  const io = { to: (...a) => deps.io.to(...a) }; // io is created after this module is; look it up when used
  const roster = createRoster({ now, id: () => store.id() });
  const groupOf = (id) => (typeof id === 'string' ? db().groups[id] : undefined);
  const memberOf = (id, uid) => { const g = groupOf(id); return g && g.members.includes(uid) ? g : null; };
  const rooms = (g, extraIds = []) => [...new Set([...g.members, ...extraIds])].map((m) => 'user:' + m);
  const toMembers = (g, extraIds) => { let t = io; for (const r of rooms(g, extraIds)) t = t.to(r); return t; };
  const callInfo = (g) => { const c = roster.of(g.id); return c ? { id: c.id, video: c.video, startedBy: c.startedBy, startedAt: c.startedAt, users: [...c.parts.keys()] } : null; };
  const lastAt = new Map();
  const touch = (gid, t) => { if ((lastAt.get(gid) || 0) < t) lastAt.set(gid, t); };
  let primed = false;
  const prime = () => { if (primed) return; primed = true; for (const m of Object.values(db().gmsgs)) touch(m.group, m.createdAt); };
  const view = (g, uid) => { prime(); return viewFor(g, uid, (id) => (db().users[id] ? publicUser(db().users[id]) : null), { lastAt: lastAt.get(g.id) || g.createdAt, call: callInfo(g) }); };
  const sendUpdate = (g) => { for (const m of g.members) io.to('user:' + m).emit('group:update', view(g, m)); };
  const createLimit = new security.RateWindow(20, 3600_000);
  const rekeyLimit = new security.RateWindow(30, 3600_000);

  function dropGroup(g, removedIds) {
    delete db().groups[g.id];
    const files = [];
    for (const m of Object.values(db().gmsgs)) if (m.group === g.id) { files.push(...(m.files || [])); delete db().gmsgs[m.id]; }
    for (const r of Object.values(db().calllog)) if (r.convo === 'g:' + g.id) delete db().calllog[r.id];
    lastAt.delete(g.id);
    store.save();
    store.deleteFiles(files).catch((e) => console.error(e));
    const c = roster.of(g.id);
    if (c) { roster.calls.delete(g.id); for (const m of removedIds) io.to('user:' + m).emit('gcall:ended', { groupId: g.id, callId: c.id, reason: 'deleted' }); }
    for (const m of removedIds) io.to('user:' + m).emit('group:removed', { groupId: g.id, reason: 'deleted' });
  }

  // a member list change: validate wraps against the new member list, rotate, tell everybody
  function change(req, res, g, { members, nameEnc, wraps, removed = [] }) {
    if (Number(req.body?.baseEpoch) !== g.epoch) return res.status(409).json({ error: 'This group just changed. Try again.', epoch: g.epoch });
    if (members.length < 2) { dropGroup(g, g.members); return res.json({ ok: true, deleted: true }); }
    const name = cleanName(nameEnc), w = checkWraps(wraps, members);
    if (!name || !w) return res.status(400).json({ error: 'Bad keys' });
    for (const id of members) if (!db().users[id]?.publicKey) return res.status(400).json({ error: 'Someone has not set up encryption yet' });
    rotate(g, { members, nameEnc: name, wraps: w, by: req.user.id, byKey: req.user.publicKey });
    // people who left are not on the call any more
    for (const id of removed) {
      const c = roster.of(g.id), sid = c && c.parts.get(id);
      if (sid) { const r = roster.leave(g.id, id, sid); if (r) afterLeave(g, id, sid, r, true); }
    }
    store.save();
    sendUpdate(g);
    for (const id of removed) io.to('user:' + id).emit('group:removed', { groupId: g.id, reason: 'left' });
    res.json({ group: view(g, req.user.id) });
  }

  function register(app) {
    app.post('/api/groups', auth, ah(async (req, res) => {
      const me = req.user;
      if (!createLimit.allow(me.id)) return res.status(429).json({ error: 'You are making groups too fast' });
      const others = idList(req.body?.members, MAX_GROUP - 1);
      if (!others || others.includes(me.id)) return res.status(400).json({ error: 'Choose the people to add' });
      if (others.length + 1 < MIN_CREATE) return res.status(400).json({ error: 'A group needs at least three people. For two, send a direct message.' });
      for (const id of others) {
        const u = db().users[id];
        if (!u || u.bot || !areFriends(me.id, id)) return res.status(400).json({ error: 'You can only add friends to a group' });
        if (!u.publicKey) return res.status(400).json({ error: `${u.displayName} has not set up encryption yet` });
      }
      if (Object.values(db().groups).filter((g) => g.members.includes(me.id)).length >= MAX_GROUPS_PER_USER) return res.status(400).json({ error: 'You are in too many groups' });
      const nameEnc = cleanName(req.body?.nameEnc), wraps = checkWraps(req.body?.wraps, [me.id, ...others]);
      if (!nameEnc || !wraps) return res.status(400).json({ error: 'Bad keys' });
      const g = createGroup({ id: store.id(), ownerId: me.id, others, nameEnc, wraps, byKey: me.publicKey, at: now() });
      db().groups[g.id] = g;
      store.save();
      sendUpdate(g);
      res.json({ group: view(g, me.id) });
    }));

    app.get('/api/groups', auth, (req, res) => {
      const mine = Object.values(db().groups).filter((g) => g.members.includes(req.user.id));
      res.json({ groups: mine.map((g) => view(g, req.user.id)) });
    });

    app.get('/api/groups/:id', auth, (req, res) => {
      const g = memberOf(req.params.id, req.user.id);
      if (!g) return res.status(404).json({ error: 'Not found' });
      res.json({ group: view(g, req.user.id) });
    });

    app.get('/api/groups/:id/messages', auth, (req, res) => {
      const g = memberOf(req.params.id, req.user.id);
      if (!g) return res.status(404).json({ error: 'Not found' });
      const list = Object.values(db().gmsgs).filter((m) => m.group === g.id).sort((a, b) => a.createdAt - b.createdAt).slice(-100);
      res.json({ messages: list });
    });

    app.get('/api/groups/:id/calls', auth, (req, res) => {
      const g = memberOf(req.params.id, req.user.id);
      if (!g) return res.status(404).json({ error: 'Not found' });
      res.json({ calls: calllog.forConvo(db().calllog, 'g:' + g.id) });
    });

    // rename: the new name is sealed with the CURRENT epoch key
    app.patch('/api/groups/:id', auth, (req, res) => {
      const g = memberOf(req.params.id, req.user.id);
      if (!g) return res.status(404).json({ error: 'Not found' });
      if (Number(req.body?.epoch) !== g.epoch) return res.status(409).json({ error: 'This group just changed. Try again.', epoch: g.epoch });
      const name = cleanName(req.body?.nameEnc);
      if (!name) return res.status(400).json({ error: 'Bad name' });
      g.nameEnc = { ...name, epoch: g.epoch };
      store.save();
      sendUpdate(g);
      res.json({ group: view(g, req.user.id) });
    });

    // add friends: a new epoch, so the newcomers cannot read what was said before they came
    app.post('/api/groups/:id/members', auth, (req, res) => {
      const g = memberOf(req.params.id, req.user.id);
      if (!g) return res.status(404).json({ error: 'Not found' });
      const add = idList(req.body?.add, MAX_GROUP);
      if (!add || !add.length || add.some((id) => g.members.includes(id))) return res.status(400).json({ error: 'Choose friends who are not in the group yet' });
      if (g.members.length + add.length > MAX_GROUP) return res.status(400).json({ error: `A group can have up to ${MAX_GROUP} people` });
      for (const id of add) {
        const u = db().users[id];
        if (!u || u.bot || !areFriends(req.user.id, id)) return res.status(400).json({ error: 'You can only add your friends' });
      }
      change(req, res, g, { members: [...g.members, ...add], nameEnc: req.body?.nameEnc, wraps: req.body?.wraps });
    });

    // the owner removes someone
    app.post('/api/groups/:id/kick', auth, (req, res) => {
      const g = memberOf(req.params.id, req.user.id);
      if (!g) return res.status(404).json({ error: 'Not found' });
      const target = req.body?.userId;
      if (g.ownerId !== req.user.id || !isId(target) || target === req.user.id || !g.members.includes(target)) return res.status(403).json({ error: 'Only the person who owns the group can remove someone' });
      change(req, res, g, { members: g.members.filter((x) => x !== target), nameEnc: req.body?.nameEnc, wraps: req.body?.wraps, removed: [target] });
    });

    app.post('/api/groups/:id/leave', auth, (req, res) => {
      const g = memberOf(req.params.id, req.user.id);
      if (!g) return res.status(404).json({ error: 'Not found' });
      change(req, res, g, { members: g.members.filter((x) => x !== req.user.id), nameEnc: req.body?.nameEnc, wraps: req.body?.wraps, removed: [req.user.id] });
    });

    // same people, fresh key: used when someone's identity key changed (they reset their account) so they can read new messages again
    app.post('/api/groups/:id/rekey', auth, (req, res) => {
      const g = memberOf(req.params.id, req.user.id);
      if (!g) return res.status(404).json({ error: 'Not found' });
      if (!rekeyLimit.allow(req.user.id)) return res.status(429).json({ error: 'Slow down' });
      change(req, res, g, { members: [...g.members], nameEnc: req.body?.nameEnc, wraps: req.body?.wraps });
    });

    app.delete('/api/groups/:id', auth, (req, res) => {
      const g = memberOf(req.params.id, req.user.id);
      if (!g) return res.status(404).json({ error: 'Not found' });
      if (g.ownerId !== req.user.id) return res.status(403).json({ error: 'Only the person who owns the group can delete it' });
      dropGroup(g, g.members);
      res.json({ ok: true });
    });
  }

  // ---------- calls ----------
  const sigBucket = new Map();
  const sigAllowed = (uid) => {
    const t = now(), arr = (sigBucket.get(uid) || []).filter((x) => t - x < 5000);
    if (arr.length >= 160) { sigBucket.set(uid, arr); return false; }
    arr.push(t); sigBucket.set(uid, arr); return true;
  };

  function broadcastState(g) {
    const info = callInfo(g);
    toMembers(g).emit('group:call', { groupId: g.id, call: info });
  }

  // `r` is what roster.leave returned
  function afterLeave(g, uid, sid, r, kicked = false) {
    const c = r.call;
    if (kicked) io.to('user:' + uid).emit('gcall:ended', { groupId: g.id, callId: c.id, reason: 'removed' });
    for (const psid of c.parts.values()) io.to(psid).emit('gcall:left', { groupId: g.id, callId: c.id, userId: uid });
    if (r.ended) {
      try {
        const rec = r.record;
        db().calllog[rec.id] = rec;
        for (const id of calllog.overflow(db().calllog, rec.convo)) delete db().calllog[id];
        store.save();
        toMembers(g, [uid]).emit('call:log', rec);
      } catch (e) { console.error('group call log failed:', e); }
      toMembers(g, [uid]).emit('gcall:ended', { groupId: g.id, callId: c.id, reason: 'hangup' });
    }
    broadcastState(g);
  }

  // user left the group's call (or their socket went away)
  function leaveCall(groupId, uid, sid) {
    const g = groupOf(groupId);
    const r = roster.leave(groupId, uid, sid);
    if (!r) return;
    if (g) afterLeave(g, uid, sid, r); else if (r.ended) { /* group deleted meanwhile: nothing to log */ }
  }

  // attachment ids for a group message: uploads by this person for this group that no message uses yet
  async function buildFiles(list, scope, uid) {
    if (!Array.isArray(list) || list.length > MAX_ATTACH || new Set(list).size !== list.length) return null;
    try {
      for (const fid of list) {
        const meta = typeof fid === 'string' && await store.fileMeta(fid);
        if (!meta || meta.owner !== uid || meta.scope !== scope || meta.attached) return null;
      }
      await store.markAttached(list);
      return list;
    } catch (e) { console.error(e); return null; }
  }

  function attachSocket(socket, ctx) {
    const { uid, allowed, validReply } = ctx;
    const reply = (ack) => (typeof ack === 'function' ? ack : () => {});

    socket.on('group:send', async (p, ack) => {
      const done = reply(ack);
      if (!allowed()) return done({ error: 'Slow down' });
      const g = memberOf(p?.groupId, uid);
      if (!g) return done({ error: 'Cannot send' });
      if (typeof p.ciphertext !== 'string' || typeof p.iv !== 'string' || !p.ciphertext || p.ciphertext.length > MAX_CIPHER || p.iv.length > 64) return done({ error: 'Bad payload' });
      if (Number(p.epoch) !== g.epoch) return done({ error: 'This group just changed. Try again.', epoch: g.epoch });
      let files = [];
      if (p.files !== undefined) {
        files = await buildFiles(p.files, 'group:' + g.id, uid);
        if (files === null) return done({ error: 'Bad attachment' });
      }
      const msg = {
        id: store.id(), group: g.id, from: uid, ciphertext: p.ciphertext, iv: p.iv, epoch: g.epoch, files,
        replyTo: validReply(db().gmsgs, p.replyTo, (m) => m.group === g.id),
        reactions: {}, createdAt: now(),
      };
      db().gmsgs[msg.id] = msg;
      touch(g.id, msg.createdAt);
      store.save();
      toMembers(g).emit('group:message', msg);
      const sender = db().users[uid];
      for (const m of g.members) {
        if (m === uid) continue;
        // the server cannot read the text or the group name, so the notification only says who wrote
        pushSafe(m, 'dm', { title: sender?.displayName || 'Someone', body: 'Sent a message in a group', url: `/app?n=g:${g.id}`, tag: 'm:' + msg.id, sender: sender?.displayName, icon: imgPath(sender?.avatarImage), msgId: msg.id, read: true });
      }
      done({ ok: true });
    });

    socket.on('gcall:join', (p, ack) => {
      const done = reply(ack);
      if (!allowed()) return done({ error: 'Slow down' });
      const g = memberOf(p?.groupId, uid);
      if (!g) return done({ error: 'Cannot join' });
      if (ctx.busy()) return done({ error: 'You are already on a call' });
      const r = roster.join(g.id, uid, socket.id, !!p.video);
      if (r.error) return done({ error: r.error });
      if (r.replaced) io.to(r.replaced).emit('gcall:ended', { groupId: g.id, callId: r.call.id, reason: 'other-window' });
      if (r.created) {
        const me = db().users[uid];
        for (const m of g.members) {
          if (m === uid) continue;
          io.to('user:' + m).emit('gcall:incoming', { groupId: g.id, callId: r.call.id, from: uid, video: r.call.video });
          if (!isOnline(m)) pushSafe(m, 'call', { title: `${me?.displayName || 'Someone'} started a group call`, body: `${r.call.video ? 'Video' : 'Voice'} call`, url: `/app?n=g:${g.id}`, tag: 'call', sender: me?.displayName, icon: imgPath(me?.avatarImage) });
        }
      }
      broadcastState(g);
      done({ ok: true, callId: r.call.id, peers: r.peers, video: r.call.video });
    });

    socket.on('gcall:leave', (p) => { if (isId(p?.groupId)) leaveCall(p.groupId, uid, socket.id); });

    socket.on('gcall:signal', (p) => {
      const c = roster.of(p?.groupId);
      if (!c || c.parts.get(uid) !== socket.id || !isId(p.to) || p.to === uid || !c.parts.has(p.to) || !sigAllowed(uid)) return;
      const d = p.data;
      if (!d || typeof d.ciphertext !== 'string' || typeof d.iv !== 'string' || d.ciphertext.length > 20000 || d.iv.length > 64) return;
      io.to(c.parts.get(p.to)).emit('gcall:signal', { groupId: c.groupId, callId: c.id, from: uid, data: { ciphertext: d.ciphertext, iv: d.iv } });
    });

    socket.on('group:typing', (p) => {
      const g = memberOf(p?.groupId, uid);
      if (g) socket.to(rooms(g).filter((r) => r !== 'user:' + uid)).emit('typing', { groupId: g.id, userId: uid });
    });

    // a device that connects while a call is still ringing hears about the calls it missed the start of
    for (const g of Object.values(db().groups)) {
      if (!g.members.includes(uid)) continue;
      const c = roster.of(g.id);
      if (!c) continue;
      if (c.parts.has(uid)) continue;
      if (now() - c.startedAt < RING_MS()) socket.emit('gcall:incoming', { groupId: g.id, callId: c.id, from: c.startedBy, video: c.video });
    }
    socket.on('disconnect', () => {
      for (const c of [...roster.calls.values()]) if (c.parts.get(uid) === socket.id) leaveCall(c.groupId, uid, socket.id);
    });
  }

  // ---------- message edits, deletes and reactions (called from the shared socket handlers) ----------
  const actions = {
    edit(uid, p) {
      const msg = typeof p?.messageId === 'string' ? db().gmsgs[p.messageId] : null;
      const g = msg && memberOf(msg.group, uid);
      if (!g || msg.from !== uid) return { error: 'Forbidden' };
      if (typeof p.ciphertext !== 'string' || typeof p.iv !== 'string' || !p.ciphertext || p.ciphertext.length > MAX_CIPHER || p.iv.length > 64) return { error: 'Bad payload' };
      if (Number(p.epoch) !== msg.epoch) return { error: 'Bad payload' }; // an edit stays under the key the message was written with
      msg.ciphertext = p.ciphertext; msg.iv = p.iv; msg.editedAt = now();
      store.save();
      toMembers(g).emit('message:edited', { kind: 'group', message: msg });
      return { ok: true };
    },
    delete(uid, p) {
      const msg = typeof p?.messageId === 'string' ? db().gmsgs[p.messageId] : null;
      const g = msg && memberOf(msg.group, uid);
      if (!g || msg.from !== uid) return { error: 'Forbidden' };
      delete db().gmsgs[msg.id];
      store.save();
      store.deleteFiles(msg.files).catch((e) => console.error(e));
      toMembers(g).emit('message:deleted', { kind: 'group', messageId: msg.id, groupId: g.id });
      return { ok: true };
    },
    // for reaction:toggle: { msg, emit } or { error }
    reactionTarget(uid, messageId) {
      const msg = typeof messageId === 'string' ? db().gmsgs[messageId] : null;
      const g = msg && memberOf(msg.group, uid);
      if (!g) return { error: 'Forbidden' };
      return { msg, rooms: rooms(g) };
    },
  };

  // a user's account is deleted / they are removed from everything
  const memberIdsOf = (uid) => { const out = new Set(); for (const g of Object.values(db().groups)) if (g.members.includes(uid)) g.members.forEach((m) => out.add(m)); out.delete(uid); return out; };
  const referencedFiles = () => Object.values(db().gmsgs).flatMap((m) => m.files || []);
  const callOfUser = (uid) => roster.byUser(uid);

  return { register, attachSocket, actions, memberOf, memberIdsOf, referencedFiles, callOfUser, roster, view, leaveCall };
}

module.exports = { create, createRoster, cleanWrap, checkWraps, cleanName, createGroup, rotate, viewFor, idList, MAX_GROUP, MIN_CREATE, MAX_CALL, MAX_CIPHER, MAX_ATTACH };
