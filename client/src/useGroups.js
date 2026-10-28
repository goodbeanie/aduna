// Group chats on the client: the list, the opened epoch keys, messages (decrypted here), call history, and every action.
// The server side is server/groups.js; the key rules are in groupkeys.js. The server never sees text, files or the group's name.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, emitAck } from './api.js';
import { encryptWithKey, decryptWithKey } from './crypto.js';
import { makeEpoch, openKeys, openName, sealName, staleRoster, titleOf } from './groupkeys.js';
import { wrapDm, unwrapDm } from './envelope.js';
import { mergeRecords, withCalls } from './callhistory.js';

const mergeById = (a, b) => {
  const map = new Map();
  [...a, ...b].forEach((m) => map.set(m.id, { ...(map.get(m.id) || {}), ...m }));
  return [...map.values()].sort((x, y) => x.createdAt - y.createdAt);
};

const REKEY_EVERY = 60_000; // a group is never re-keyed automatically more often than this

// One hook owns everything about group chats. App.jsx calls `attach(socket)` once the socket exists and reads the rest.
//   users: the people we know (App's `users`), for their current identity keys
//   onIncoming(msg, group, read): a message from somebody else arrived; `read()` decrypts it (for a notification)
//   onRemoved(groupId, reason): we are not in this group any more ('left' | 'deleted')
export function useGroups({ me, privKey, socketRef, users, addUsers, onIncoming, onRemoved }) {
  const [groups, setGroups] = useState({});   // id -> the server's view + { name, nameRoster, canRead }
  const [raw, setRaw] = useState({});         // id -> messages as stored (ciphertext)
  const [plain, setPlain] = useState({});     // message id -> { text, attachments, invite } | { locked: true }
  const [calls, setCalls] = useState({});     // id -> finished call records
  const [ready, setReady] = useState(false);  // the list has come back at least once
  const [keyRev, setKeyRev] = useState(0);    // goes up whenever more epoch keys were opened
  const keys = useRef({});                    // id -> Map(epoch -> CryptoKey)
  const groupsRef = useRef(groups); groupsRef.current = groups;
  const rawRef = useRef(raw); rawRef.current = raw;
  const plainRef = useRef(plain); plainRef.current = plain;
  const usersRef = useRef(users); usersRef.current = users;
  const cb = useRef({}); cb.current = { onIncoming, onRemoved };
  const chains = useRef({});                  // id -> promise: views of one group are processed one after the other
  const pending = useRef(new Set());          // message ids being decrypted
  const rekeyedAt = useRef({});               // id -> when we last made a fresh epoch on our own
  const rosterSeen = useRef({});              // id -> the roster string last checked
  const privRef = useRef(privKey); privRef.current = privKey;

  // the people of a group with the identity keys we know NOW (a person who reset their account has a new key)
  const withKeys = useCallback((list) => list.map((m) => ({ ...m, publicKey: usersRef.current[m.id]?.publicKey || m.publicKey })), []);

  // ---------- views from the server ----------
  const ingestNow = useCallback(async (view) => {
    const have = groupsRef.current[view.id];
    if (have && view.epoch < have.epoch) return have; // an older answer that arrived late
    addUsers(view.members);
    const map = await openKeys(privRef.current, view, keys.current[view.id]);
    keys.current[view.id] = map;
    const cur = map.get(view.epoch);
    const nm = cur ? await openName(cur, view.nameEnc) : null;
    const g = { ...view, name: nm?.n ?? '', nameRoster: nm?.r ?? '', canRead: !!cur };
    groupsRef.current = { ...groupsRef.current, [view.id]: g };
    setGroups(groupsRef.current);
    setKeyRev((n) => n + 1);
    return g;
  }, [addUsers]);
  const ingest = useCallback((view) => {
    const run = (chains.current[view.id] || Promise.resolve()).then(() => ingestNow(view)).catch((e) => { console.warn('group view failed', e); return groupsRef.current[view.id]; });
    chains.current[view.id] = run;
    return run;
  }, [ingestNow]);

  const drop = useCallback((id, reason) => {
    delete keys.current[id]; delete chains.current[id];
    const gone = rawRef.current[id] || [];
    groupsRef.current = Object.fromEntries(Object.entries(groupsRef.current).filter(([k]) => k !== id));
    setGroups(groupsRef.current);
    setRaw((p) => { const n = { ...p }; delete n[id]; return n; });
    setCalls((p) => { const n = { ...p }; delete n[id]; return n; });
    setPlain((p) => { const n = { ...p }; for (const m of gone) delete n[m.id]; return n; });
    cb.current.onRemoved?.(id, reason);
  }, []);

  const loadAll = useCallback(async () => {
    const { groups: list } = await api('/groups');
    const ids = new Set(list.map((v) => v.id));
    for (const id of Object.keys(groupsRef.current)) if (!ids.has(id)) drop(id, 'left'); // removed while we were offline
    await Promise.all(list.map(ingest));
    setReady(true);
  }, [ingest, drop]);
  useEffect(() => { loadAll().catch(() => setReady(true)); }, [loadAll]);

  const loadMessages = useCallback(async (id) => {
    const [m, c] = await Promise.all([api(`/groups/${id}/messages`), api(`/groups/${id}/calls`).catch(() => ({ calls: [] }))]);
    setRaw((p) => ({ ...p, [id]: mergeById(p[id] || [], m.messages) }));
    setCalls((p) => ({ ...p, [id]: mergeRecords(p[id], c.calls) }));
  }, []);

  // ---------- decrypting messages ----------
  const decryptOne = useCallback(async (m) => {
    const key = keys.current[m.group]?.get(m.epoch);
    if (!key) return null;
    try { return unwrapDm(await decryptWithKey(key, m.ciphertext, m.iv)); } catch { return { text: 'Could not decrypt this message', attachments: [], failed: true }; }
  }, []);
  useEffect(() => {
    for (const [gid, list] of Object.entries(raw)) {
      for (const m of list) {
        const cur = plainRef.current[m.id];
        if ((cur && !cur.locked) || pending.current.has(m.id)) continue;
        if (!keys.current[gid]?.get(m.epoch)) { if (!cur) setPlain((p) => (p[m.id] ? p : { ...p, [m.id]: { locked: true } })); continue; }
        pending.current.add(m.id);
        decryptOne(m).then((t) => { pending.current.delete(m.id); if (t) setPlain((p) => ({ ...p, [m.id]: t })); });
      }
    }
  }, [raw, keyRev, decryptOne]);

  // ---------- changes to members and keys ----------
  // Runs `build(group)` on the server's current view of the group (a person who reset their account has a new identity key, and the keys
  // we wrap for must be the ones the server has); when the group changed under us (409) it fetches again and tries once more.
  const change = useCallback(async (id, build) => {
    for (let attempt = 0; ; attempt++) {
      if (!groupsRef.current[id]) throw new Error('This group no longer exists');
      await ingest((await api('/groups/' + id)).group);
      const g = groupsRef.current[id];
      if (!g) throw new Error('This group no longer exists');
      try { return await build(g); } catch (e) {
        if (e.status === 409 && attempt === 0) continue;
        throw e;
      }
    }
  }, [ingest]);

  const body = (g, e) => ({ baseEpoch: g.epoch, nameEnc: { ciphertext: e.nameEnc.ciphertext, iv: e.nameEnc.iv }, wraps: e.wraps });

  const create = useCallback(async (friends, name) => {
    const people = withKeys([me, ...friends]);
    const e = await makeEpoch({ privKey: privRef.current, members: people, name });
    const r = await api('/groups', { method: 'POST', body: { members: friends.map((f) => f.id), nameEnc: { ciphertext: e.nameEnc.ciphertext, iv: e.nameEnc.iv }, wraps: e.wraps } });
    return ingest(r.group);
  }, [me, withKeys, ingest]);

  const addMembers = useCallback((id, people) => change(id, async (g) => {
    const e = await makeEpoch({ privKey: privRef.current, members: [...g.members, ...people], name: g.name });
    const r = await api(`/groups/${id}/members`, { method: 'POST', body: { ...body(g, e), add: people.map((u) => u.id) } });
    return ingest(r.group);
  }), [change, ingest]);

  const kick = useCallback((id, userId) => change(id, async (g) => {
    const e = await makeEpoch({ privKey: privRef.current, members: g.members.filter((m) => m.id !== userId), name: g.name });
    const r = await api(`/groups/${id}/kick`, { method: 'POST', body: { ...body(g, e), userId } });
    return ingest(r.group);
  }), [change, ingest]);

  const leave = useCallback((id) => change(id, async (g) => {
    const rest = g.members.filter((m) => m.id !== me.id);
    // with fewer than two people left the server deletes the group and needs no keys
    const req = rest.length < 2 ? { baseEpoch: g.epoch } : body(g, await makeEpoch({ privKey: privRef.current, members: rest, name: g.name }));
    await api(`/groups/${id}/leave`, { method: 'POST', body: req });
    drop(id, 'left');
  }), [change, me.id, drop]);

  const rekey = useCallback((id) => change(id, async (g) => {
    const e = await makeEpoch({ privKey: privRef.current, members: g.members, name: g.name });
    const r = await api(`/groups/${id}/rekey`, { method: 'POST', body: body(g, e) });
    return ingest(r.group);
  }), [change, ingest]);

  const rename = useCallback((id, name) => change(id, async (g) => {
    const key = keys.current[id]?.get(g.epoch);
    if (!key) throw new Error('You cannot read this group right now');
    const nameEnc = await sealName(key, name, g.members, g.nameRoster);
    const r = await api(`/groups/${id}`, { method: 'PATCH', body: { epoch: g.epoch, nameEnc } });
    return ingest(r.group);
  }), [change, ingest]);

  const destroy = useCallback(async (id) => { await api(`/groups/${id}`, { method: 'DELETE' }); drop(id, 'deleted'); }, [drop]);

  // A member's identity key changed (they reset their account) since the epoch was made: any member who can read the epoch makes a fresh
  // one so that person can read new messages again. Checked against the server's own list before doing anything, and never more than once a minute.
  useEffect(() => {
    let live = true;
    (async () => {
      for (const g of Object.values(groupsRef.current)) {
        if (!g.canRead || !g.nameRoster) continue;
        const sig = withKeys(g.members).map((m) => m.id + ':' + m.publicKey).sort().join('|') + '@' + g.epoch;
        if (rosterSeen.current[g.id] === sig) continue;
        rosterSeen.current[g.id] = sig;
        if (!(await staleRoster({ ...g, members: withKeys(g.members) }, { r: g.nameRoster }))) continue;
        if (Date.now() - (rekeyedAt.current[g.id] || 0) < REKEY_EVERY) continue;
        await new Promise((r) => setTimeout(r, Math.random() * 2500)); // members race to do it: the first one wins, the rest see a newer epoch
        if (!live) return;
        try {
          const fresh = (await api('/groups/' + g.id)).group;
          const cur = await ingest(fresh);
          if (!cur?.canRead || !(await staleRoster(cur, { r: cur.nameRoster }))) continue; // somebody else already did it
          rekeyedAt.current[g.id] = Date.now();
          await rekey(g.id);
        } catch { /* not now; the next change of keys checks again */ }
      }
    })();
    return () => { live = false; };
  }, [groups, users, withKeys, ingest, rekey]);

  // ---------- messages ----------
  const send = useCallback(async (id, text, atts = [], replyTo) => {
    for (let attempt = 0; ; attempt++) {
      const g = groupsRef.current[id];
      const key = g && keys.current[id]?.get(g.epoch);
      if (!key) throw new Error('You cannot read this group right now. Another member has to refresh its keys.');
      const enc = await encryptWithKey(key, wrapDm(text, atts));
      try { return await emitAck(socketRef.current, 'group:send', { groupId: id, epoch: g.epoch, ...enc, replyTo, files: atts.map((a) => a.id).filter(Boolean) }); }
      catch (e) {
        if (attempt === 0 && e.data?.epoch && e.data.epoch !== g.epoch) { await ingest((await api('/groups/' + id)).group); continue; } // the members changed while we typed
        throw e;
      }
    }
  }, [socketRef, ingest]);

  const edit = useCallback(async (messageId, text) => {
    const m = Object.values(rawRef.current).flat().find((x) => x.id === messageId);
    const key = m && keys.current[m.group]?.get(m.epoch);
    if (!key) throw new Error('You cannot edit this message');
    const p = plainRef.current[messageId];
    const enc = await encryptWithKey(key, wrapDm(text, p?.attachments, p?.invite));
    return emitAck(socketRef.current, 'message:edit', { kind: 'group', messageId, epoch: m.epoch, ...enc }); // an edit stays under the key the message was written with
  }, [socketRef]);
  const remove = useCallback((messageId) => emitAck(socketRef.current, 'message:delete', { kind: 'group', messageId }), [socketRef]);
  const react = useCallback((messageId, emoji) => emitAck(socketRef.current, 'reaction:toggle', { kind: 'group', messageId, emoji }).catch(() => {}), [socketRef]);
  const typing = useCallback((id) => socketRef.current?.emit('group:typing', { groupId: id }), [socketRef]);

  // ---------- socket ----------
  const attach = useCallback((s) => {
    const on = (ev, fn) => s.on(ev, fn);
    on('group:update', (view) => { ingest(view); });
    on('group:removed', ({ groupId, reason }) => drop(groupId, reason));
    on('group:call', ({ groupId, call }) => {
      if (!groupsRef.current[groupId]) return;
      groupsRef.current = { ...groupsRef.current, [groupId]: { ...groupsRef.current[groupId], call } };
      setGroups(groupsRef.current);
    });
    on('group:message', (m) => {
      setRaw((p) => ({ ...p, [m.group]: mergeById(p[m.group] || [], [m]) }));
      if (!usersRef.current[m.from]) api('/users/' + m.from).then((r) => addUsers([r.user])).catch(() => {});
      if (m.from !== me.id) {
        const g = groupsRef.current[m.group];
        cb.current.onIncoming?.(m, g, async () => {
          for (let i = 0; i < 20 && !keys.current[m.group]?.get(m.epoch); i++) await new Promise((r) => setTimeout(r, 150)); // the new epoch's view may still be on its way
          return (await decryptOne(m)) || { text: 'Sent a message in a group', attachments: [] };
        });
      }
    });
    on('message:edited', ({ kind, message: m }) => {
      if (kind !== 'group') return;
      pending.current.delete(m.id);
      setPlain((p) => { const n = { ...p }; delete n[m.id]; return n; }); // read the new ciphertext
      setRaw((p) => ({ ...p, [m.group]: (p[m.group] || []).map((x) => (x.id === m.id ? { ...x, ...m } : x)) }));
    });
    on('message:deleted', ({ kind, messageId, groupId }) => {
      if (kind !== 'group') return;
      setRaw((p) => ({ ...p, [groupId]: (p[groupId] || []).filter((x) => x.id !== messageId) }));
    });
    on('reaction:update', ({ kind, messageId, reactions }) => {
      if (kind !== 'group') return;
      setRaw((p) => {
        const n = {};
        for (const [k, list] of Object.entries(p)) n[k] = list.some((m) => m.id === messageId) ? list.map((m) => (m.id === messageId ? { ...m, reactions } : m)) : list;
        return n;
      });
    });
    on('call:log', (rec) => {
      if (!rec.group || !String(rec.convo).startsWith('g:')) return;
      const id = rec.convo.slice(2);
      setCalls((p) => ({ ...p, [id]: mergeRecords(p[id], [rec]) }));
    });
    let connectedBefore = false; // after a dropped connection, whatever happened meanwhile is fetched again
    on('connect', () => {
      if (connectedBefore) { loadAll().catch(() => {}); for (const id of Object.keys(rawRef.current)) loadMessages(id).catch(() => {}); }
      connectedBefore = true;
    });
  }, [ingest, drop, addUsers, me.id, decryptOne, loadAll, loadMessages]);

  // ---------- what the screens read ----------
  const list = useMemo(() => {
    const last = (g) => Math.max(g.lastAt || g.createdAt || 0, ...(raw[g.id] || []).slice(-1).map((m) => m.createdAt), ...(calls[g.id] || []).slice(-1).map((c) => c.endedAt));
    return Object.values(groups).sort((a, b) => last(b) - last(a));
  }, [groups, raw, calls]);

  const messagesFor = useCallback((id) => {
    const g = groups[id];
    const held = keys.current[id] ? [...keys.current[id].keys()] : [];
    const lowest = held.length ? Math.min(...held) : null; // the oldest epoch we hold a key for: anything older was sent before we joined
    const texts = (raw[id] || []).map((m) => {
      const p = plain[m.id];
      const locked = !p || p.locked;
      const content = !p ? '\u2026' : p.locked ? (lowest !== null && m.epoch < lowest ? 'This message was sent before you joined, so you cannot read it.' : 'This message cannot be read on this device.') : p.text;
      return { id: m.id, authorId: m.from, content, attachments: locked ? undefined : p.attachments, invite: locked ? undefined : p.invite, replyTo: m.replyTo, reactions: m.reactions, createdAt: m.createdAt, editedAt: m.editedAt, locked };
    });
    return g ? withCalls(texts, calls[id]) : texts;
  }, [groups, raw, plain, calls, keyRev]); // eslint-disable-line react-hooks/exhaustive-deps

  const keyFor = useCallback((id) => async (epoch) => keys.current[id]?.get(Number(epoch)) || null, []);
  const currentKey = useCallback((id) => { const g = groupsRef.current[id]; return g ? keys.current[id]?.get(g.epoch) || null : null; }, []);
  const titleFor = useCallback((id) => (groups[id] ? titleOf(groups[id], me.id) : 'Group'), [groups, me.id]);

  return {
    byId: groups, list, ready, raw, calls,
    attach, loadMessages, messagesFor, keyFor, currentKey, titleFor,
    create, addMembers, kick, leave, rekey, rename, destroy,
    send, edit, remove, react, typing,
  };
}
