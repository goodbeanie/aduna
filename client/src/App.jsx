import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Auth from './Auth.jsx';
import Chat from './Chat.jsx';
import Friends from './Friends.jsx';
import { Avatar, Icon, ServerIcon, STATUS_LABEL } from './ui.jsx';
import { imageUrl } from './image.js';
import { setServerTheme } from './themes.js';
import { ServerSettings } from './ServerSettings.jsx';
import { ServerModal, ChannelModal, CategoryModal, InviteModal, NewDmModal, UserCard, ProfileEditor, SafetyModal } from './Modals.jsx';
import { api, connectSocket, emitAck, getToken, setToken } from './api.js';
import { SettingsScreen } from './Settings.jsx';
import { InviteContext, INVITE_CODE_RE } from './Invite.jsx';
import { EmojiProvider, useEmoji } from './Emoji.jsx';
import { CallUI, useCall } from './Call.jsx';
import { useVoice, VoiceAudio, VoicePanel } from './Voice.jsx';
import RulesView from './Rules.jsx';
import { layoutOf, moveChannel, moveCategory, saveLayout, sameLayout } from './layout.js';
import { loadKey, clearKeys, encryptFor, decryptFrom } from './crypto.js';

// DM plaintext is a small JSON envelope so text and attachment details are encrypted together.
// Older messages are plain strings.
const wrapDm = (text, attachments, invite) => JSON.stringify({ v: 1, t: text, a: attachments || [], ...(invite ? { i: invite } : {}) });
const unwrapDm = (s) => {
  try { const o = JSON.parse(s); if (o && o.v === 1 && typeof o.t === 'string') return { text: o.t, attachments: Array.isArray(o.a) ? o.a : [], invite: typeof o.i === 'string' && INVITE_CODE_RE.test(o.i) ? o.i : undefined }; } catch {}
  return { text: s, attachments: [] };
};

const mergeById = (a, b) => {
  const map = new Map();
  [...a, ...b].forEach((m) => map.set(m.id, { ...(map.get(m.id) || {}), ...m }));
  return [...map.values()].sort((x, y) => x.createdAt - y.createdAt);
};

const CHANNEL_ICON = { voice: 'speaker', rules: 'rules', announcements: 'megaphone' };

export default function App() {
  const [boot, setBoot] = useState('loading');
  const [me, setMe] = useState(null);
  const [privKey, setPrivKey] = useState(null);

  useEffect(() => {
    (async () => {
      if (!getToken()) return setBoot('auth');
      try {
        const { user } = await api('/me');
        const key = await loadKey(user.id);
        if (!key) { setToken(''); return setBoot('auth'); } // key lives on another device: sign in again to unlock it
        setMe(user); setPrivKey(key); setBoot('ready');
      } catch { setToken(''); setBoot('auth'); }
    })();
  }, []);

  if (boot === 'loading') return <div className="splash"><img src="/aduna-icon.png" alt="Aduna" /></div>;
  if (boot === 'auth') return <Auth onAuthed={(u, k) => { setMe(u); setPrivKey(k); setBoot('ready'); }} />;
  return <EmojiProvider><Main me={me} setMe={setMe} privKey={privKey} /></EmojiProvider>;
}

function Main({ me, setMe, privKey }) {
  const [servers, setServers] = useState([]);
  const [users, setUsers] = useState({ [me.id]: me });
  const [presence, setPresence] = useState({});
  const [view, setView] = useState(null);
  const [chan, setChan] = useState({});
  const [dmRaw, setDmRaw] = useState({});
  const [plain, setPlain] = useState({});
  const [convos, setConvos] = useState([]);
  const [fr, setFr] = useState({ friends: [], incoming: [], outgoing: [] });
  const [unread, setUnread] = useState({});
  const [typing, setTyping] = useState({});
  const [modal, setModal] = useState(null);
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState({}); // category id -> true while folded
  const [showList, setShowList] = useState(true); // phones: the channel / DM list is a screen of its own
  const [membersOpen, setMembersOpen] = useState(false); // narrow screens: the member list is a slide-over
  const [, tick] = useState(0);
  const { openManager } = useEmoji();
  const [gifEnabled, setGifEnabled] = useState(false);
  useEffect(() => { api('/gifs/config').then((r) => setGifEnabled(r.enabled)).catch(() => {}); }, []);

  const socketRef = useRef(null);
  const [toast, setToast] = useState(null); // an announcement banner: { key, serverId, channelId, title, body }
  const serversRef = useRef([]);
  const viewRef = useRef(view);
  const usersRef = useRef(users);
  const plainRef = useRef(plain);
  const pending = useRef(new Set());
  const lastChan = useRef({});
  const call = useCall({ socketRef, privKey, getUser: (id) => usersRef.current[id] });
  const callHandleRef = useRef(call.handle);
  callHandleRef.current = call.handle;
  viewRef.current = view;
  serversRef.current = servers;
  usersRef.current = users;
  plainRef.current = plain;

  const addUsers = useCallback((list) => {
    setUsers((prev) => {
      const next = { ...prev };
      list.forEach((u) => { next[u.id] = { ...(next[u.id] || {}), ...u }; });
      return next;
    });
  }, []);
  const loadFriends = useCallback(async () => {
    const r = await api('/friends');
    setFr(r);
    addUsers([...r.friends, ...r.incoming.map((x) => x.user), ...r.outgoing.map((x) => x.user)]);
  }, [addUsers]);
  const bump = (key) => setUnread((p) => ({ ...p, [key]: (p[key] || 0) + 1 }));
  const clearUnread = (key) => setUnread((p) => { if (!p[key]) return p; const n = { ...p }; delete n[key]; return n; });

  const logout = useCallback(async () => {
    socketRef.current?.disconnect();
    await clearKeys();
    setToken('');
    location.reload();
  }, []);

  // ---------- initial load ----------
  useEffect(() => {
    (async () => {
      const [{ servers: sv }, { presence: pr }, { conversations }] = await Promise.all([api('/servers'), api('/presence'), api('/dms')]);
      setServers(sv);
      setPresence(pr);
      addUsers(sv.flatMap((s) => s.members));
      addUsers(conversations.map((c) => c.user));
      setConvos(conversations.map((c) => c.user.id));
      const first = sv[0];
      if (first) setView({ kind: 'server', serverId: first.id, channelId: first.channels[0].id });
      else setView({ kind: 'dm', userId: null });
    })().catch((e) => { if (e.status === 401) logout(); });
  }, [addUsers, logout]);

  useEffect(() => { loadFriends().catch(() => {}); }, [loadFriends]);

  // ---------- decrypt DMs ----------
  const decryptMsg = useCallback(async (m) => {
    const partnerId = m.from === me.id ? m.to : m.from;
    let partner = usersRef.current[partnerId];
    if (!partner) { const { user } = await api('/users/' + partnerId); addUsers([user]); partner = user; }
    try { return unwrapDm(await decryptFrom(privKey, partner.publicKey, m.ciphertext, m.iv)); }
    catch { return { text: 'Could not decrypt this message', attachments: [] }; }
  }, [me.id, privKey, addUsers]);

  useEffect(() => {
    for (const list of Object.values(dmRaw)) {
      for (const m of list) {
        if (plainRef.current[m.id] !== undefined || pending.current.has(m.id)) continue;
        pending.current.add(m.id);
        decryptMsg(m).then((t) => setPlain((p) => ({ ...p, [m.id]: t })));
      }
    }
  }, [dmRaw, decryptMsg]);

  // ---------- socket ----------
  useEffect(() => {
    const s = connectSocket();
    socketRef.current = s;

    s.on('connect_error', (e) => { if (e.message === 'unauthorized') logout(); });

    s.on('message:new', (m) => {
      setChan((p) => ({ ...p, [m.channelId]: mergeById(p[m.channelId] || [], [m]) }));
      const v = viewRef.current;
      const watching = v?.kind === 'server' && v.channelId === m.channelId && !document.hidden;
      if (!watching && m.authorId !== me.id) bump('c:' + m.channelId);
      if (!usersRef.current[m.authorId]) api('/users/' + m.authorId).then((r) => addUsers([r.user])).catch(() => {});
    });

    s.on('dm:new', (m) => {
      const partner = m.from === me.id ? m.to : m.from;
      setDmRaw((p) => ({ ...p, [partner]: mergeById(p[partner] || [], [m]) }));
      setConvos((c) => [partner, ...c.filter((x) => x !== partner)]);
      const v = viewRef.current;
      const watching = v?.kind === 'dm' && v.userId === partner && !document.hidden;
      if (!watching && m.from !== me.id) bump('d:' + partner);
      if (!usersRef.current[partner]) api('/users/' + partner).then((r) => addUsers([r.user])).catch(() => {});
    });

    s.on('reaction:update', ({ kind, messageId, reactions }) => {
      const patch = (store) => {
        const next = {};
        for (const [k, list] of Object.entries(store)) next[k] = list.some((m) => m.id === messageId) ? list.map((m) => (m.id === messageId ? { ...m, reactions } : m)) : list;
        return next;
      };
      if (kind === 'channel') setChan(patch); else setDmRaw(patch);
    });

    s.on('message:edited', ({ kind, message: m }) => {
      if (kind === 'channel') setChan((p) => ({ ...p, [m.channelId]: (p[m.channelId] || []).map((x) => (x.id === m.id ? { ...x, ...m } : x)) }));
      else {
        const partner = m.from === me.id ? m.to : m.from;
        setPlain((p) => { const n = { ...p }; delete n[m.id]; return n; }); // re-decrypt the new ciphertext
        pending.current.delete(m.id);
        setDmRaw((p) => ({ ...p, [partner]: (p[partner] || []).map((x) => (x.id === m.id ? { ...x, ...m } : x)) }));
      }
    });

    s.on('message:deleted', ({ kind, messageId, channelId, from, to }) => {
      if (kind === 'channel') setChan((p) => ({ ...p, [channelId]: (p[channelId] || []).filter((x) => x.id !== messageId) }));
      else {
        const partner = from === me.id ? to : from;
        setDmRaw((p) => ({ ...p, [partner]: (p[partner] || []).filter((x) => x.id !== messageId) }));
      }
    });

    for (const ev of ['call:accepted', 'call:ended', 'call:handled', 'call:signal']) s.on(ev, (p) => callHandleRef.current(ev, p));
    s.on('call:incoming', async (p) => {
      if (!usersRef.current[p.from]) { try { const u = (await api('/users/' + p.from)).user; usersRef.current = { ...usersRef.current, [p.from]: u }; addUsers([u]); } catch { return; } }
      callHandleRef.current('call:incoming', p);
    });
    s.on('disconnect', () => callHandleRef.current('disconnect'));
    // An announcement notifies every member, whichever channel they are looking at.
    s.on('announcement:new', async ({ serverId, channelId, messageId, authorId }) => {
      if (authorId === me.id) return;
      const sv = serversRef.current.find((x) => x.id === serverId), ch = sv?.channels.find((c) => c.id === channelId);
      if (!sv || !ch) return;
      const v = viewRef.current;
      if (v?.kind === 'server' && v.channelId === channelId && !document.hidden) return; // already reading it
      const title = `${sv.name} · #${ch.name}`;
      let body = 'New announcement';
      try { const m = (await api(`/channels/${channelId}/messages`)).messages.find((x) => x.id === messageId); if (m?.content) body = m.content.slice(0, 140); } catch { /* keep the default */ }
      setToast({ key: messageId, serverId, channelId, title, body });
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try { const n = new Notification(title, { body, tag: 'aduna-announce-' + channelId, icon: '/aduna-icon.png' }); n.onclick = () => { window.focus(); n.close(); }; } catch { /* best effort */ }
      }
    });
    s.on('friends:changed', () => loadFriends().catch(() => {}));
    s.on('presence', ({ userId, status }) => setPresence((p) => ({ ...p, [userId]: status })));
    s.on('user:update', (u) => { addUsers([u]); if (u.id === me.id) setMe((m) => ({ ...m, ...u })); });
    s.on('server:update', (sv) => {
      setServers((prev) => (prev.some((x) => x.id === sv.id) ? prev.map((x) => (x.id === sv.id ? sv : x)) : [...prev, sv]));
      addUsers(sv.members);
    });
    s.on('typing', ({ channelId, dmWith, userId }) => {
      const key = channelId || 'dm:' + dmWith;
      setTyping((p) => ({ ...p, [key]: { ...(p[key] || {}), [userId]: Date.now() + 3500 } }));
    });

    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => { clearInterval(iv); s.disconnect(); };
  }, [me.id, setMe, addUsers, logout, loadFriends]);

  const voice = useVoice({ socketRef, ready: me.id });
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 8000); return () => clearTimeout(t); }, [toast]);

  // ---------- load history when the view changes ----------
  useEffect(() => {
    if (!view) return;
    if (view.kind === 'server') {
      clearUnread('c:' + view.channelId);
      api(`/channels/${view.channelId}/messages`).then((r) => setChan((p) => ({ ...p, [view.channelId]: mergeById(p[view.channelId] || [], r.messages) }))).catch(() => {});
    } else if (view.userId) {
      clearUnread('d:' + view.userId);
      api(`/dms/${view.userId}/messages`).then((r) => setDmRaw((p) => ({ ...p, [view.userId]: mergeById(p[view.userId] || [], r.messages) }))).catch(() => {});
    }
  }, [view?.kind, view?.channelId, view?.userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- derived ----------
  const server = view?.kind === 'server' ? servers.find((s) => s.id === view.serverId) : null;
  const channel = server?.channels.find((c) => c.id === view.channelId);
  const dmUser = view?.kind === 'dm' && view.userId ? users[view.userId] : null;

  // On a server page the app fades to that server's theme; anywhere else (DMs, friends) it fades back to yours.
  // While the owner is in server settings, that screen previews the draft theme itself, so leave it alone.
  const serverThemeKey = server?.theme ? JSON.stringify(server.theme) : '';
  const editingServer = modal?.type === 'serverSettings';
  useEffect(() => {
    if (!editingServer) setServerTheme(serverThemeKey ? JSON.parse(serverThemeKey) : null);
  }, [serverThemeKey, editingServer]);

  const messages = useMemo(() => {
    if (view?.kind === 'server') return chan[view.channelId] || [];
    if (dmUser) return (dmRaw[dmUser.id] || []).map((m) => ({ id: m.id, authorId: m.from, content: plain[m.id]?.text ?? '…', attachments: plain[m.id]?.attachments, invite: plain[m.id]?.invite, replyTo: m.replyTo, reactions: m.reactions, createdAt: m.createdAt, editedAt: m.editedAt }));
    return [];
  }, [view, chan, dmRaw, plain, dmUser]);

  const typingKey = view?.kind === 'server' ? view.channelId : dmUser ? 'dm:' + dmUser.id : null;
  const typingNames = Object.entries(typing[typingKey] || {}).filter(([uid, t]) => uid !== me.id && t > Date.now()).map(([uid]) => users[uid]?.displayName || 'Someone');

  const openServer = (s) => {
    const cid = lastChan.current[s.id] && s.channels.some((c) => c.id === lastChan.current[s.id]) ? lastChan.current[s.id] : s.channels[0].id;
    setView({ kind: 'server', serverId: s.id, channelId: cid });
    setShowList(true); setMembersOpen(false);
  };
  const openChannel = (c) => { lastChan.current[server.id] = c.id; setView({ kind: 'server', serverId: server.id, channelId: c.id }); setShowList(false); setMembersOpen(false); };
  const openDm = (u) => {
    addUsers([u]);
    setConvos((c) => (c.includes(u.id) ? c : [u.id, ...c]));
    setView({ kind: 'dm', userId: u.id });
    setShowList(false);
    setModal(null);
  };
  const showUser = async (id) => {
    if (!usersRef.current[id]) { try { addUsers([(await api('/users/' + id)).user]); } catch { return; } }
    setModal({ type: 'user', id });
  };

  // ---------- actions ----------
  const send = async (text, replyTo, atts = []) => {
    const s = socketRef.current;
    if (view.kind === 'server') return emitAck(s, 'message:send', { channelId: view.channelId, content: text, replyTo, attachments: atts });
    const enc = await encryptFor(privKey, dmUser.publicKey, wrapDm(text, atts));
    return emitAck(s, 'dm:send', { to: dmUser.id, ...enc, replyTo, files: atts.map((a) => a.id).filter(Boolean) });
  };
  const react = (messageId, emoji) =>
    emitAck(socketRef.current, 'reaction:toggle', { kind: view.kind === 'server' ? 'channel' : 'dm', messageId, emoji }).catch(() => {});
  const editMsg = async (messageId, text) => {
    const s = socketRef.current;
    if (view.kind === 'server') return emitAck(s, 'message:edit', { kind: 'channel', messageId, content: text });
    const enc = await encryptFor(privKey, dmUser.publicKey, wrapDm(text, plainRef.current[messageId]?.attachments, plainRef.current[messageId]?.invite));
    return emitAck(s, 'message:edit', { kind: 'dm', messageId, ...enc });
  };
  const deleteMsg = (messageId) => emitAck(socketRef.current, 'message:delete', { kind: view.kind === 'server' ? 'channel' : 'dm', messageId });
  const onTyping = () => socketRef.current?.emit('typing', view.kind === 'server' ? { channelId: view.channelId } : { to: dmUser.id });

  const requestFriend = async (username) => { const r = await api('/friends/request', { method: 'POST', body: { username } }); await loadFriends(); return r; };
  const acceptFriend = (id) => api(`/friends/${id}/accept`, { method: 'POST' }).then(loadFriends).catch((e) => alert(e.message));
  const removeFriend = (id) => api(`/friends/${id}`, { method: 'DELETE' }).then(loadFriends).catch((e) => alert(e.message));
  const relationOf = (id) => id === me.id ? 'self' : fr.friends.some((u) => u.id === id) ? 'friend'
    : fr.incoming.some((x) => x.user.id === id) ? 'incoming' : fr.outgoing.some((x) => x.user.id === id) ? 'outgoing' : 'none';

  const leaveServer = async () => {
    if (!confirm(`Leave ${server.name}?`)) return;
    try {
      await api(`/servers/${server.id}/leave`, { method: 'POST' });
      const rest = servers.filter((s) => s.id !== server.id);
      setServers(rest);
      rest[0] ? openServer(rest[0]) : (setView({ kind: 'dm', userId: null }), setShowList(true));
    } catch (e) { alert(e.message); }
  };

  // Direct invite: a normal end-to-end encrypted DM whose envelope carries the code; the receiver's client draws the card.
  const sendInvite = async (friend, code) => {
    const enc = await encryptFor(privKey, friend.publicKey, wrapDm('', [], code));
    await emitAck(socketRef.current, 'dm:send', { to: friend.id, ...enc, files: [] });
  };
  const onInviteJoined = (sv) => { setServers((p) => (p.some((x) => x.id === sv.id) ? p : [...p, sv])); addUsers(sv.members); openServer(sv); };
  const inviteCtx = { servers, onJoined: onInviteJoined, onOpen: openServer };

  const totalUnreadFor = (s) => s.channels.reduce((n, c) => n + (unread['c:' + c.id] || 0), 0);
  const dmUnread = Object.entries(unread).filter(([k]) => k.startsWith('d:')).reduce((n, [, v]) => n + v, 0);
  const myPresence = me.status === 'invisible' ? 'offline' : me.status;
  const statusOf = (id) => presence[id] || 'offline';

  const members = server ? [...server.members].sort((a, b) => a.displayName.localeCompare(b.displayName)) : [];
  const onlineMembers = members.filter((m) => statusOf(m.id) !== 'offline');
  const offlineMembers = members.filter((m) => statusOf(m.id) === 'offline');

  // ---------- drag and drop (owner): reorder channels and categories, move channels between categories ----------
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false); // while dragging, the ungrouped header always shows so channels can be dropped back into it
  const [mark, setMark] = useState(null); // { kind: 'chan' | 'cat', id, pos: 'before' | 'after' | 'into' | 'end' } drop indicator
  const applyLayout = async (next) => {
    if (!server) return;
    const before = server, cur = layoutOf(server);
    if (sameLayout(cur, next)) return;
    const byId = new Map(server.channels.map((c) => [c.id, c])), catById = new Map((server.categories || []).map((c) => [c.id, c]));
    const optimistic = { ...server, categories: next.cats.map((id) => catById.get(id)),
      channels: next.chans.map((x) => { const { categoryId, ...c } = byId.get(x.id); return x.categoryId ? { ...c, categoryId: x.categoryId } : c; }) };
    setServers((p) => p.map((x) => (x.id === server.id ? optimistic : x)));
    try { const { server: sv } = await saveLayout(api, server.id, next); setServers((p) => p.map((x) => (x.id === sv.id ? sv : x))); }
    catch (e) { setServers((p) => p.map((x) => (x.id === before.id ? before : x))); alert(e.message); }
  };
  const endDrag = () => { dragRef.current = null; setMark(null); setDragging(false); };
  const startDrag = (kind, id, e) => { dragRef.current = { kind, id }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); setTimeout(() => dragRef.current && setDragging(true), 0); };
  const halfOf = (e) => { const r = e.currentTarget.getBoundingClientRect(); return e.clientY - r.top < r.height / 2 ? 'before' : 'after'; };
  // The thing after `id` in the layout, when it is in the same group, else null (= end of the group)
  const nextInGroup = (lay, id) => { const i = lay.chans.findIndex((c) => c.id === id), me2 = lay.chans[i], nx = lay.chans[i + 1]; return nx && (nx.categoryId || null) === (me2.categoryId || null) ? nx.id : null; };
  const chanDnd = (c, isOwner) => !isOwner ? {} : {
    draggable: true,
    onDragStart: (e) => startDrag('chan', c.id, e),
    onDragEnd: endDrag,
    onDragOver: (e) => { if (dragRef.current?.kind !== 'chan') return; e.preventDefault(); const pos = halfOf(e); setMark((m) => (m && m.id === c.id && m.pos === pos ? m : { kind: 'chan', id: c.id, pos })); },
    onDrop: (e) => {
      const d = dragRef.current; if (d?.kind !== 'chan') return;
      e.preventDefault();
      const lay = layoutOf(server), cat = lay.chans.find((x) => x.id === c.id).categoryId, pos = halfOf(e);
      endDrag();
      applyLayout(moveChannel(lay, d.id, cat, pos === 'before' ? c.id : nextInGroup(lay, c.id) === d.id ? null : nextInGroup(lay, c.id)));
    },
  };
  // headers accept channels (drop = top of that group) and, for categories, other categories
  const headDnd = (cat, isOwner) => !isOwner ? {} : {
    ...(cat ? { draggable: true, onDragStart: (e) => startDrag('cat', cat.id, e), onDragEnd: endDrag } : {}),
    onDragOver: (e) => {
      const d = dragRef.current; if (!d) return;
      if (d.kind === 'cat' && !cat) return;
      e.preventDefault();
      const pos = d.kind === 'cat' ? halfOf(e) : 'into', id = cat ? cat.id : '_loose';
      setMark((m) => (m && m.id === id && m.pos === pos ? m : { kind: 'cat', id, pos }));
    },
    onDrop: (e) => {
      const d = dragRef.current; if (!d) return;
      e.preventDefault();
      const lay = layoutOf(server), catId = cat ? cat.id : null;
      if (d.kind === 'chan') {
        const first = lay.chans.find((x) => (x.categoryId || null) === catId && x.id !== d.id);
        endDrag(); applyLayout(moveChannel(lay, d.id, catId, first ? first.id : null));
      } else {
        const pos = halfOf(e), at = lay.cats.indexOf(cat.id);
        endDrag(); applyLayout(moveCategory(lay, d.id, pos === 'before' ? cat.id : lay.cats[at + 1] === d.id ? null : lay.cats[at + 1] || null));
      }
    },
  };
  const markClass = (kind, id) => (mark && mark.kind === kind && mark.id === id ? ' drop-' + mark.pos : '');

  // If the channel you are in was deleted (by the owner, on any device), move to the first one left
  useEffect(() => {
    if (view?.kind === 'server' && server && !channel) {
      const first = server.channels[0];
      if (first) setView({ kind: 'server', serverId: server.id, channelId: first.id });
    }
  }, [server, channel]); // eslint-disable-line react-hooks/exhaustive-deps

  const membersToggle = <button className="icon-btn members-toggle" title="Members" aria-label="Show members" onClick={() => setMembersOpen((o) => !o)}><Icon name="users" size={18} /></button>;

  if (!view) return <div className="splash"><img src="/aduna-icon.png" alt="Aduna" /></div>;

  const memberRow = (u) => (
    <button key={u.id} className={'member' + (statusOf(u.id) === 'offline' ? ' off' : '')} onClick={() => { setMembersOpen(false); showUser(u.id); }}>
      <Avatar user={users[u.id] || u} size={32} presence={statusOf(u.id)} />
      <span data-nc style={{ '--nc': (users[u.id] || u).accentColor }}>{(users[u.id] || u).displayName}</span>
      {server?.ownerId === u.id && <span className="owner" title="Server owner"><Icon name="crown" size={15} /></span>}
    </button>
  );

  return (
    <InviteContext.Provider value={inviteCtx}>
    <div className="app">
      {/* server bar (top) */}
      <nav className="rail">
        <button className={'rail-btn dm-home' + (view.kind === 'dm' ? ' on' : '')} title="Direct Messages" onClick={() => { setView({ kind: 'dm', userId: view.kind === 'dm' ? view.userId : null }); setShowList(true); setMembersOpen(false); }}>
          <img src="/aduna-icon.png" alt="" />{dmUnread + fr.incoming.length > 0 && <span className="badge">{dmUnread + fr.incoming.length}</span>}
        </button>
        <div className="rail-sep" />
        <div className="rail-list">
          {servers.map((s) => (
            <button key={s.id} className={'rail-btn' + (s.iconImage ? ' has-icon' : '') + (server?.id === s.id ? ' on' : '')} title={s.name} onClick={() => openServer(s)}>
              <ServerIcon server={s} fill />
              {totalUnreadFor(s) > 0 && <span className="badge">{totalUnreadFor(s)}</span>}
            </button>
          ))}
          <button className="rail-btn add" title="Create or join a server" onClick={() => setModal({ type: 'server' })}><Icon name="plus" size={22} /></button>
        </div>
      </nav>

      <div className={'body' + (call.call.phase !== 'idle' ? ' in-call' : '') + (showList ? ' list-open' : '')}>
      {/* sidebar */}
      <aside className="side">
        {server ? (
          <>
            <button className={'side-head' + (server.bannerImage ? ' has-banner' : '')} onClick={() => setMenu((m) => !m)}
              style={server.bannerImage ? { backgroundImage: `url("${imageUrl(server.bannerImage)}")` } : undefined}>
              <span className="side-name">{server.iconImage && <ServerIcon server={server} size={24} />}<span className="side-title">{server.name}</span></span>
              <Icon name={menu ? 'close' : 'chevron'} size={16} />
            </button>
            {menu && (
              <div className="menu" onMouseLeave={() => setMenu(false)}>
                <button onClick={() => { setMenu(false); setModal({ type: 'invite' }); }}>Invite people</button>
                {server.ownerId === me.id && <button onClick={() => { setMenu(false); setModal({ type: 'serverSettings' }); }}>Server settings</button>}
                <button className="danger-text" onClick={() => { setMenu(false); leaveServer(); }}>Leave server</button>
              </div>
            )}
            <div className="side-list">
              {(() => {
                const isOwner = server.ownerId === me.id;
                const cats = server.categories || [];
                const catIds = new Set(cats.map((c) => c.id));
                const loose = server.channels.filter((c) => !c.categoryId || !catIds.has(c.categoryId));
                const row = (c) => (
                  <React.Fragment key={c.id}>
                    <button className={'chan' + (c.id === view.channelId ? ' on' : '') + (unread['c:' + c.id] ? ' unread' : '') + markClass('chan', c.id)} onClick={() => openChannel(c)} {...chanDnd(c, isOwner)}>
                      <span className="hash">{CHANNEL_ICON[c.type] ? <Icon name={CHANNEL_ICON[c.type]} size={18} /> : '#'}</span>{c.name}{unread['c:' + c.id] > 0 && <span className="badge inline">{unread['c:' + c.id]}</span>}
                    </button>
                    {c.type === 'voice' && (voice.members[c.id] || []).map((id) => users[id] && (
                      <div key={id} className="voice-member"><Avatar user={users[id]} size={20} /><span>{users[id].displayName}</span>{id === me.id && voice.state.channelId === c.id && voice.state.muted && <Icon name="micoff" size={13} />}</div>
                    ))}
                  </React.Fragment>
                );
                return (
                  <>
                    {(loose.length > 0 || cats.length === 0 || (isOwner && dragging)) && (
                      <div className={'cat-head' + markClass('cat', '_loose')} {...headDnd(null, isOwner)}><span className="cat-name static">CHANNELS</span>
                        {isOwner && <button className="icon-btn cat-add" title="Create channel" aria-label="Create channel" onClick={() => setModal({ type: 'channel' })}><Icon name="plus" size={16} /></button>}
                      </div>
                    )}
                    {loose.map(row)}
                    {cats.map((cat) => {
                      const folded = !!collapsed[cat.id];
                      const items = server.channels.filter((c) => c.categoryId === cat.id);
                      const shown = folded ? items.filter((c) => c.id === view.channelId || unread['c:' + c.id]) : items; // a folded category still shows where you are and what is unread
                      return (
                        <div key={cat.id} className="cat">
                          <div className={'cat-head' + markClass('cat', cat.id)} {...headDnd(cat, isOwner)}>
                            <button className={'cat-name' + (folded ? ' folded' : '')} aria-expanded={!folded} onClick={() => setCollapsed((p) => ({ ...p, [cat.id]: !p[cat.id] }))}>
                              <Icon name="chevron" size={12} /><span>{cat.name.toUpperCase()}</span>
                            </button>
                            {isOwner && <button className="icon-btn cat-add" title={`Create channel in ${cat.name}`} aria-label={`Create channel in ${cat.name}`} onClick={() => setModal({ type: 'channel', categoryId: cat.id })}><Icon name="plus" size={16} /></button>}
                          </div>
                          {shown.map(row)}
                        </div>
                      );
                    })}
                    {isOwner && <button className="add-cat" onClick={() => setModal({ type: 'category' })}><Icon name="plus" size={15} /><span>Add category</span></button>}
                  </>
                );
              })()}
            </div>
          </>
        ) : (
          <>
            <div className="side-head static">Direct Messages
              <button className="icon-btn" title="New message" onClick={() => setModal({ type: 'dm' })}><Icon name="plus" size={17} /></button>
            </div>
            <div className="side-list">
              <button className={'chan' + (!view.userId ? ' on' : '')} onClick={() => { setView({ kind: 'dm', userId: null }); setShowList(false); }}>
                <span className="hash"><Icon name="users" size={20} /></span>Friends{fr.incoming.length > 0 && <span className="badge inline">{fr.incoming.length}</span>}
              </button>
              <div className="side-label">DIRECT MESSAGES</div>
              {convos.length === 0 && <p className="muted pad">No conversations yet. Message a friend from the Friends page.</p>}
              {convos.map((id) => users[id] && (
                <button key={id} className={'chan dm' + (id === view.userId ? ' on' : '')} onClick={() => { setView({ kind: 'dm', userId: id }); setShowList(false); }}>
                  <Avatar user={users[id]} size={32} presence={statusOf(id)} />
                  <span className="grow">{users[id].displayName}</span>
                  {unread['d:' + id] > 0 && <span className="badge inline">{unread['d:' + id]}</span>}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="user-panel">
          <button className="me" onClick={() => setModal({ type: 'user', id: me.id })}>
            <Avatar user={me} size={34} presence={myPresence} />
            <div><div className="me-name">{me.displayName}</div><div className="muted small">{STATUS_LABEL[myPresence]}</div></div>
          </button>
          <button className="icon-btn" title="Custom emoji" onClick={openManager}><Icon name="smile" size={18} /></button>
          <button className="icon-btn" title="Settings" onClick={() => setModal({ type: 'edit' })}><Icon name="gear" size={18} /></button>
        </div>
      </aside>

      {/* main */}
      {server && channel?.type === 'voice' && (
        <VoicePanel channel={channel} voice={voice} users={users} me={me} presence={presence} onBack={() => setShowList(true)} headerExtra={membersToggle} />
      )}
      {server && channel?.type === 'rules' && (
        <RulesView server={server} channel={channel} isOwner={server.ownerId === me.id} onBack={() => setShowList(true)} headerExtra={membersToggle}
          onChange={(sv) => setServers((p) => p.map((x) => (x.id === sv.id ? sv : x)))} />
      )}
      {server && channel && channel.type !== 'voice' && channel.type !== 'rules' && (
        <Chat title={channel.name} onBack={() => setShowList(true)} messages={messages} users={users} me={me} presence={presence}
          onSend={send} onReact={react} onEdit={editMsg} onDelete={deleteMsg} canModerate={server?.ownerId === me.id} onTyping={onTyping} typingNames={typingNames} onUser={showUser}
          files={{ scope: { kind: 'channel', target: channel.id }, dm: null }} gifEnabled={gifEnabled}
          placeholder={channel.type === 'announcements' ? `Announce to everyone in ${server.name}` : `Message #${channel.name}`}
          notice={channel.type === 'announcements' ? <><Icon name="megaphone" size={14} className="inline-icon" /> Everyone in this server is notified when the owner posts here.</> : null}
          readOnly={channel.type === 'announcements' && server.ownerId !== me.id ? 'Only the server owner can post in this channel.' : null}
          subtitle={CHANNEL_ICON[channel.type] ? <Icon name={CHANNEL_ICON[channel.type]} size={20} /> : '#'}
          headerExtra={membersToggle} />
      )}
      {dmUser && (
        <Chat title={dmUser.displayName} subtitle="@" onBack={() => setShowList(true)} messages={messages} users={users} me={me} presence={presence}
          onSend={send} onReact={react} onEdit={editMsg} onDelete={deleteMsg} canModerate={false} onTyping={onTyping} typingNames={typingNames} onUser={showUser}
          files={{ scope: relationOf(dmUser.id) === 'friend' ? { kind: 'dm', target: dmUser.id, privKey, theirPublic: dmUser.publicKey } : null, dm: { privKey, theirPublic: dmUser.publicKey } }} gifEnabled={gifEnabled}
          placeholder={`Message @${dmUser.displayName}`}
          headerExtra={<>
            <button className="icon-btn" title="Voice call" disabled={relationOf(dmUser.id) !== 'friend' || call.call.phase !== 'idle'} onClick={() => call.actions.startCall(dmUser.id, false)}><Icon name="phone" size={18} /></button>
            <button className="icon-btn" title="Video call" disabled={relationOf(dmUser.id) !== 'friend' || call.call.phase !== 'idle'} onClick={() => call.actions.startCall(dmUser.id, true)}><Icon name="video" size={18} /></button>
            <button className="btn small-btn" title="End-to-end encrypted" onClick={() => setModal({ type: 'safety' })}><Icon name="lock" size={14} className="inline-icon" /><span className="hide-sm"> End-to-end encrypted</span></button>
          </>}
          notice={<><Icon name="lock" size={14} className="inline-icon" /> Messages here are end-to-end encrypted. Only you and <b>{dmUser.displayName}</b> can read them.{relationOf(dmUser.id) !== 'friend' && <><br />You aren\u2019t friends with {dmUser.displayName}, so you can\u2019t send new messages until you are.</>}</>} />
      )}
      {view.kind === 'dm' && !dmUser && (
        <Friends onBack={() => setShowList(true)} fr={fr} statusOf={statusOf} onMessage={openDm} onUser={showUser} onRequest={requestFriend} onAccept={acceptFriend} onRemove={removeFriend} />
      )}

      {/* members */}
      {server && (
        <>
        {membersOpen && <div className="drawer-backdrop" onClick={() => setMembersOpen(false)} />}
        <aside className={'members' + (membersOpen ? ' open' : '')}>
          {onlineMembers.length > 0 && <div className="side-label">ONLINE — {onlineMembers.length}</div>}
          {onlineMembers.map(memberRow)}
          {offlineMembers.length > 0 && <div className="side-label">OFFLINE — {offlineMembers.length}</div>}
          {offlineMembers.map(memberRow)}
        </aside>
        </>
      )}
      <VoiceAudio voice={voice} />
      {voice.state.channelId && !(channel?.id === voice.state.channelId) && (() => {
        const sv = servers.find((x) => x.channels.some((c) => c.id === voice.state.channelId)); const ch = sv?.channels.find((c) => c.id === voice.state.channelId);
        return ch && <div className="voice-dock"><Icon name="speaker" size={16} /><button className="link-btn" onClick={() => { setView({ kind: 'server', serverId: sv.id, channelId: ch.id }); setShowList(false); }}>Voice connected · {ch.name}</button><button className="icon-btn" title={voice.state.muted ? 'Unmute' : 'Mute'} onClick={voice.actions.toggleMute}><Icon name={voice.state.muted ? 'micoff' : 'mic'} size={16} /></button><button className="icon-btn" title="Leave voice" onClick={voice.actions.leave}><Icon name="phone" size={16} /></button></div>;
      })()}
      {toast && <button className="toast" onClick={() => { const sv = servers.find((x) => x.id === toast.serverId); if (sv) { lastChan.current[sv.id] = toast.channelId; setView({ kind: 'server', serverId: sv.id, channelId: toast.channelId }); setShowList(false); } setToast(null); }}><Icon name="megaphone" size={18} /><span><b>{toast.title}</b><br />{toast.body}</span></button>}
      <CallUI call={call.call} actions={call.actions} users={users} me={me} />
      </div>

      {modal?.type === 'server' && <ServerModal onClose={() => setModal(null)} onDone={(s) => { setServers((p) => (p.some((x) => x.id === s.id) ? p : [...p, s])); addUsers(s.members); openServer(s); setModal(null); }} />}
      {modal?.type === 'channel' && server && <ChannelModal server={server} category={(server.categories || []).find((c) => c.id === modal.categoryId)} onClose={() => setModal(null)} onDone={(s) => { setServers((p) => p.map((x) => (x.id === s.id ? s : x))); setModal(null); }} />}
      {modal?.type === 'category' && server && <CategoryModal server={server} onClose={() => setModal(null)} onDone={(s) => { setServers((p) => p.map((x) => (x.id === s.id ? s : x))); setModal(null); }} />}
      {modal?.type === 'serverSettings' && server && server.ownerId === me.id && (
        <ServerSettings key={server.id} server={server} onClose={() => setModal(null)} onSaved={(sv) => setServers((p) => p.map((x) => (x.id === sv.id ? sv : x)))} />
      )}
      {modal?.type === 'invite' && server && <InviteModal server={server} friends={fr.friends} isOwner={server.ownerId === me.id} onSend={sendInvite} onClose={() => setModal(null)} />}
      {modal?.type === 'dm' && <NewDmModal friends={fr.friends} onClose={() => setModal(null)} onPick={openDm} />}
      {modal?.type === 'safety' && dmUser && <SafetyModal me={me} other={dmUser} onClose={() => setModal(null)} />}
      {modal?.type === 'user' && users[modal.id] && (
        <UserCard user={users[modal.id]} relation={relationOf(modal.id)} presence={statusOf(modal.id)} onClose={() => setModal(null)}
          onMessage={() => openDm(users[modal.id])} onEdit={() => setModal({ type: 'edit' })}
          onAddFriend={() => requestFriend(users[modal.id].username).catch((e) => alert(e.message))} onAccept={() => acceptFriend(modal.id)} />
      )}
      {modal?.type === 'edit' && <SettingsScreen me={me} onClose={() => setModal(null)} onSaved={(u) => { setMe(u); addUsers([u]); }} onLogout={logout} />}
    </div>
    </InviteContext.Provider>
  );
}
