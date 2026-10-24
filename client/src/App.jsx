import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Auth from './Auth.jsx';
import VerifyEmail from './VerifyEmail.jsx';
import ResetPassword, { resetTokenFromLocation } from './ResetPassword.jsx';
import Chat from './Chat.jsx';
import Friends from './Friends.jsx';
import { Avatar, BadgeIcons, Icon, ServerIcon, STATUS_LABEL } from './ui.jsx';
import { imageUrl } from './image.js';
import { applyTheme, loadTheme, setServerTheme } from './themes.js';
import { forceSeason, forcedSeason } from './ringtones.js';
import { ServerSettings } from './ServerSettings.jsx';
import { ServerModal, ChannelModal, CategoryModal, InviteModal, NewDmModal, UserCard, ProfileEditor, SafetyModal } from './Modals.jsx';
import { api, connectSocket, emitAck, markSignedIn, endSession, adoptLegacyToken } from './api.js';
import { SettingsScreen } from './Settings.jsx';
import { BotTag } from './Bots.jsx';
import { InviteContext, INVITE_CODE_RE, InvitePage } from './Invite.jsx';
import * as np from './notifprefs.js';
import { ServerNotifications } from './ServerNotifications.jsx';
import { can, canManageAny, roleColorOf } from './perms.js';
import { EmojiProvider, useEmoji } from './Emoji.jsx';
import { CallUI, CallStage, CallDock, inCall, useCall } from './Call.jsx';
import { useVoice, VoiceAudio, VoicePanel } from './Voice.jsx';
import RulesView from './Rules.jsx';
import { mentionPreview } from './Mentions.jsx';
import Explorer from './Explorer.jsx';
import Credits from './Credits.jsx';
import { OnboardingFlow } from './Onboarding.jsx';
import Setup from './Setup.jsx';
import { setLang, useLang } from './i18n.js';
import { layoutOf, moveChannel, moveCategory, saveLayout, sameLayout } from './layout.js';
import { loadKey, clearKeys, encryptFor, decryptFrom } from './crypto.js';
import * as notify from './notify.js';
import { NotifyPrompt } from './NotifyPrompt.jsx';
import { UpdatePrompt, SiteUpdateNotice } from './UpdatePrompt.jsx';
import { RailUpdateChip } from './RailUpdate.jsx';
import { WhatsNewPopup } from './WhatsNew.jsx';
import { withCalls, mergeRecords } from './callhistory.js';
import { clearDrafts, hasDraft, useDrafts } from './drafts.js';
import { clearSeen } from './seen.js';

// DM plaintext is a small JSON envelope so text and attachment details are encrypted together.
// Older messages are plain strings.
// Direct messages are end-to-end encrypted, so the server cannot read them. For the Halloween ("Trick or Treat") and Christmas (a GIF)
// quests the browser says what the message was; the server only counts it after its own checks (see server/events.js).
const TRICK_RE = /\btrick[\s-]*(?:or|n|and|&)[\s-]*treat(?:ing)?\b/i;
const questHint = (text, atts) => (TRICK_RE.test(String(text || '')) ? 'trick' : (atts || []).some((a) => a && a.gif) ? 'gif' : undefined);
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

const INVITE_PATH = /^\/invite\/([a-z0-9_-]{3,32})\/?$/i;

function BootSplash() {
  // The page's own splash (index.html) has been animating since load; pick the animation up at the same point so it does not restart.
  const d = { '--boot-d': `-${((typeof performance !== 'undefined' ? performance.now() : 0) / 1000 % 3.6).toFixed(2)}s` };
  return (
    <div className="boot resume" role="status" aria-label="Loading Aduna" style={d}>
      <div className="boot-wrap"><span className="boot-ring" /><span className="boot-ring b" /><span className="boot-mark" /><span className="boot-word" /></div>
      <div className="boot-bar"><i /></div>
    </div>
  );
}

// The loading screen stays up for at least this long from the moment the page opened, even if the app is ready sooner.
// The desktop and Android apps load this same page, so they get it too.
const MIN_SPLASH_MS = 5000;

export default function App() {
  const { t: tr } = useLang(); // redraws the whole app when the language changes
  const [splashDone, setSplashDone] = useState(() => typeof performance === 'undefined' || performance.now() >= MIN_SPLASH_MS);
  useEffect(() => {
    if (splashDone) return undefined;
    const id = setTimeout(() => setSplashDone(true), Math.max(0, MIN_SPLASH_MS - performance.now()));
    return () => clearTimeout(id);
  }, [splashDone]);
  const [boot, setBoot] = useState('loading');
  const [me, setMe] = useState(null);
  const [privKey, setPrivKey] = useState(null);
  // opened from an invite link (/invite/<code>): show the join box page first
  const [invite, setInvite] = useState(() => (INVITE_PATH.exec(location.pathname)?.[1] || '').toLowerCase() || null);
  const [signingIn, setSigningIn] = useState(false); // a signed-out visitor pressed Join
  const [openId, setOpenId] = useState(null); // server to open once the app loads
  // opened from an emailed reset link (/reset#<token>): that page stands alone, it never looks up or changes the current session until the reset is done
  const [resetToken] = useState(() => resetTokenFromLocation());

  // the language saved on the account follows you to every device
  useEffect(() => { if (me?.lang) setLang(me.lang); }, [me?.lang]);

  useEffect(() => {
    if (resetToken !== null) return undefined;
    (async () => {
      await adoptLegacyToken(); // logged in before cookies existed: trade the old token for the cookie
      try {
        const { user } = await api('/me'); // the cookie says who we are (401 when nobody is signed in)
        const key = await loadKey(user.id);
        if (!key) { await endSession(); return setBoot('auth'); } // key lives on another device: sign in again to unlock it
        markSignedIn(true);
        setMe(user); setPrivKey(key); setBoot('ready');
      } catch (e) { if (e.status === 401) markSignedIn(false); setBoot('auth'); }
    })();
    return undefined;
  }, [resetToken]);

  // the server refused a request because the email is not verified (e.g. they just changed it)
  useEffect(() => {
    const h = () => setMe((m) => (m ? { ...m, emailVerified: false } : m));
    window.addEventListener('aduna:unverified', h);
    return () => window.removeEventListener('aduna:unverified', h);
  }, []);

  const leaveInvite = () => { history.replaceState(null, '', '/app'); setInvite(null); setSigningIn(false); };

  if (resetToken !== null) return <ResetPassword token={resetToken} />;
  if (boot === 'loading' || !splashDone) return <BootSplash />;
  if (boot === 'auth' && invite && !signingIn) return <InvitePage code={invite} signedIn={false} onNeedAuth={() => setSigningIn(true)} />;
  if (boot === 'auth') {
    return <Auth onAuthed={async (u, k) => {
      setMe(u); setPrivKey(k);
      if (invite) { // they pressed Join: finish it as soon as they are signed in
        try { const { server } = await api('/servers/join', { method: 'POST', body: { code: invite } }); setOpenId(server.id); leaveInvite(); }
        catch { setSigningIn(false); } // e.g. a private server: the invite page shows why
      }
      setBoot('ready');
    }} />;
  }
  if (me?.needsSetup) { // first time in: language, and whether to join the Aduna server
    return <Setup onDone={(u) => setMe((m) => ({ ...m, ...u }))} onLogout={async () => { await endSession(); setMe(null); setPrivKey(null); setBoot('auth'); }} />;
  }
  if (me?.emailVerified === false) {
    return <VerifyEmail me={me} onUpdate={(u) => setMe((m) => ({ ...m, ...u }))} onLogout={async () => { await endSession(); setMe(null); setPrivKey(null); setBoot('auth'); }} />;
  }
  if (invite) return <InvitePage code={invite} signedIn onJoined={(sv) => { setOpenId(sv.id); leaveInvite(); }} onClose={leaveInvite} />;
  return <EmojiProvider><Main me={me} setMe={setMe} privKey={privKey} openServerId={openId} /></EmojiProvider>;
}

function Main({ me, setMe, privKey, openServerId }) {
  const { t: tr } = useLang(); // the main screen is its own component, so it needs its own copy
  const firstOpen = useRef(openServerId); // an invite link just joined this server: start there
  // Developer test mode (Settings > Developer): look as if Halloween or Christmas were on, on every device signed in to this account.
  useEffect(() => {
    if ((forcedSeason() || null) === (me.seasonTest || null)) return;
    forceSeason(me.seasonTest || null);
    applyTheme(loadTheme());
  }, [me.seasonTest]);
  useEffect(() => () => { forceSeason(null); applyTheme(loadTheme()); }, []);
  const [servers, setServers] = useState([]);
  const [users, setUsers] = useState({ [me.id]: me });
  const [presence, setPresence] = useState({});
  const [view, setView] = useState(null);
  const [chan, setChan] = useState({});
  const [dmRaw, setDmRaw] = useState({});
  const [callsRaw, setCallsRaw] = useState({}); // partner userId -> finished calls with them (server/calllog.js), woven into that DM by time
  const [plain, setPlain] = useState({});
  const [convos, setConvos] = useState([]);
  const [fr, setFr] = useState({ friends: [], incoming: [], outgoing: [] });
  const [unread, setUnread] = useState({});
  useDrafts(); // re-render when a draft is saved or cleared, so the DM list can show its "Draft" tag
  const [mentions, setMentions] = useState({}); // 'c:<channelId>' -> unread messages that mention you (kept in memory like unread)
  const [notePrefs, setNotePrefs] = useState({}); // serverId -> your notification settings for it (mute, level, ...); saved on your account
  const [typing, setTyping] = useState({});
  const [modal, setModal] = useState(null);
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState({}); // category id -> true while folded
  const [showList, setShowList] = useState(true); // phones: the channel / DM list is a screen of its own
  const [membersOpen, setMembersOpen] = useState(false); // narrow screens: the member list is a slide-over
  const [, tick] = useState(0);
  const { openManager } = useEmoji();
  const [gifEnabled, setGifEnabled] = useState(false);
  const [balance, setBalance] = useState(null);   // your credits (private; arrives from /api/credits and the credits:update event)
  const [creditsRev, setCreditsRev] = useState(0); // goes up when the balance changes so the Credits page refreshes
  const [gain, setGain] = useState(null);         // the little "+2" after a rewarded message
  const [justPaid, setJustPaid] = useState(false); // we just came back from Stripe Checkout
  const [loaded, setLoaded] = useState(false); // servers, presence and DMs have been fetched
  const payReturn = useRef(new URLSearchParams(location.search).get('credits')); // 'paid' | 'paypal' | 'cancelled' | null
  const payToken = useRef(new URLSearchParams(location.search).get('token')); // PayPal's order id, sent back with ?credits=paypal
  const [paypalOrder, setPaypalOrder] = useState(null); // an order to capture once the Credits page is open
  useEffect(() => { api('/credits').then((r) => setBalance(r.balance)).catch(() => {}); }, []);
  useEffect(() => { if (!gain) return undefined; const t = setTimeout(() => setGain(null), 2400); return () => clearTimeout(t); }, [gain]);
  useEffect(() => { api('/gifs/config').then((r) => setGifEnabled(r.enabled)).catch(() => {}); }, []);

  const socketRef = useRef(null);
  const [toast, setToast] = useState(null); // an announcement banner: { key, serverId, channelId, title, body }
  const serversRef = useRef([]);
  const viewRef = useRef(view);
  const meRef = useRef(me);
  const notePrefsRef = useRef(notePrefs);
  notePrefsRef.current = notePrefs;
  const prefsOf = () => meRef.current.notifPrefs || {}; // which notifications you want (Settings > Notifications); undefined = on
  const pendingNav = useRef(new URLSearchParams(location.search).get('n')); // a tapped notification opened the app on a chat
  const pendingFocus = useRef(new URLSearchParams(location.search).get('focus') === '1'); // ...from its Reply button: put the cursor in the message box
  const openTargetRef = useRef(() => {});
  const frIncoming = useRef(null);
  const usersRef = useRef(users);
  const plainRef = useRef(plain);
  const pending = useRef(new Set());
  const lastChan = useRef({});
  const call = useCall({ socketRef, privKey, getUser: (id) => usersRef.current[id] });
  const callHandleRef = useRef(call.handle);
  callHandleRef.current = call.handle;
  viewRef.current = view;
  meRef.current = me;
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
    const ids = new Set(r.incoming.map((x) => x.user.id));
    if (frIncoming.current) { // not the first load: anything new is a fresh request
      for (const x of r.incoming) {
        if (!frIncoming.current.has(x.user.id) && notify.away() && meRef.current.notifPrefs?.friends !== false) notify.show({ title: x.user.displayName, body: 'sent you a friend request', tag: 'friend:' + x.user.id, target: 'f', kind: 'friend', sender: x.user.displayName, icon: imageUrl(x.user.avatarImage) || undefined });
      }
    }
    frIncoming.current = ids;
    addUsers([...r.friends, ...r.incoming.map((x) => x.user), ...r.outgoing.map((x) => x.user)]);
  }, [addUsers]);
  const bump = (key) => setUnread((p) => ({ ...p, [key]: (p[key] || 0) + 1 }));
  const clearUnread = (key) => {
    setUnread((p) => { if (!p[key]) return p; const n = { ...p }; delete n[key]; return n; });
    setMentions((p) => { if (!p[key]) return p; const n = { ...p }; delete n[key]; return n; });
  };
  const bumpMention = (key) => setMentions((p) => ({ ...p, [key]: (p[key] || 0) + 1 }));

  // ---------- server notification settings and saved unread / @ counts ----------
  // The server remembers where you stopped reading each channel, so a reload keeps the numbers. The rules for what
  // counts and what alerts are in notifprefs.js (the same file the server uses).
  const readTimers = useRef({});
  const markRead = (channelId) => { // told to the server a moment later; it uses its own clock, so no message you have seen is left unread
    clearTimeout(readTimers.current[channelId]);
    readTimers.current[channelId] = setTimeout(() => { api(`/channels/${channelId}/read`, { method: 'POST', body: {} }).catch(() => {}); }, 600);
  };
  const watchedKey = () => { const v = viewRef.current; return v?.kind === 'server' && !document.hidden ? 'c:' + v.channelId : null; };
  // Replace the saved numbers: for every channel (keys === null) or only for the given channel keys.
  const applyCounts = (counts, keys) => {
    const watch = watchedKey();
    const inScope = (k) => k.startsWith('c:') && (!keys || keys.has(k));
    const pick = (field) => (p) => {
      const n = {};
      for (const [k, x] of Object.entries(p)) if (!inScope(k)) n[k] = x;
      for (const [k, x] of Object.entries(counts)) if (inScope(k) && k !== watch && x[field]) n[k] = x[field];
      return n;
    };
    setUnread(pick('unread'));
    setMentions(pick('mentions'));
  };
  const loadNotes = useCallback(async () => {
    const r = await api('/notif-state');
    setNotePrefs(r.prefs || {});
    applyCounts(r.counts || {}, null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const saveNotes = async (serverId, next) => {
    const sv = serversRef.current.find((x) => x.id === serverId);
    const keep = new Set((sv?.channels || []).map((c) => c.id));
    const body = { ...next };
    if (body.channels) body.channels = Object.fromEntries(Object.entries(body.channels).filter(([id]) => keep.has(id)));
    const before = notePrefsRef.current[serverId];
    const put = (v) => setNotePrefs((p) => { const n = { ...p }; if (v && Object.keys(v).length) n[serverId] = v; else delete n[serverId]; return n; });
    put(body); // show the change at once
    try {
      const r = await api(`/servers/${serverId}/notifprefs`, { method: 'PUT', body });
      put(r.prefs);
      applyCounts(r.counts || {}, new Set((sv?.channels || []).map((c) => 'c:' + c.id)));
    } catch (e) { put(before); alert(e.message || 'Could not save that. Try again.'); }
  };
  const markServerRead = async (sv) => {
    try { await api(`/servers/${sv.id}/read`, { method: 'POST', body: {} }); applyCounts({}, new Set(sv.channels.map((c) => 'c:' + c.id))); }
    catch (e) { alert(e.message); }
  };
  useEffect(() => { if (loaded) loadNotes().catch(() => {}); }, [loaded, loadNotes]);

  const logout = useCallback(async () => {
    socketRef.current?.disconnect();
    await Promise.race([notify.unsubscribe(), new Promise((r) => setTimeout(r, 2500))]); // stop pushes to this device before the token goes
    await clearKeys();
    clearDrafts(); clearSeen(); // unsent messages and read positions never outlive the session
    await endSession();
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
      const first = sv.find((x) => x.id === firstOpen.current) || sv[0];
      if (first) setView({ kind: 'server', serverId: first.id, channelId: first.channels[0].id });
      else setView({ kind: 'dm', userId: null });
      if (payReturn.current) { // back from Stripe or PayPal checkout: show the Shop (where credits are bought)
        setView({ kind: 'dm', userId: null, shop: true }); setShowList(false);
        if (payReturn.current === 'paid') setJustPaid(true);
        if (payReturn.current === 'paypal' && payToken.current) setPaypalOrder(payToken.current);
        history.replaceState(null, '', '/app');
        payReturn.current = null; payToken.current = null;
      }
      setLoaded(true);
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
    s.on('session:revoked', () => logout()); // "log out everywhere" was used on another device

    s.on('message:new', (m) => {
      setChan((p) => ({ ...p, [m.channelId]: mergeById(p[m.channelId] || [], [m]) }));
      const v = viewRef.current;
      const watching = v?.kind === 'server' && v.channelId === m.channelId && !document.hidden;
      if (watching) markRead(m.channelId); // reading it now: the saved position follows
      // The server decides who a message mentions (members only; @everyone only from the owner). Your own settings for the
      // server decide whether it counts and whether it may alert you.
      const sv = serversRef.current.find((x) => x.id === m.serverId), ch = sv?.channels.find((c) => c.id === m.channelId);
      const sp = notePrefsRef.current[m.serverId];
      const kind = np.kindOf(sp, m, me.id);
      const d = m.authorId === me.id ? { count: false, alert: false } : np.decide(sp, m.channelId, kind === 'message' && ch?.type === 'announcements' ? 'announcement' : kind, Date.now());
      if (!watching && d.count) (kind === 'message' ? bump : bumpMention)('c:' + m.channelId);
      if (d.alert && kind !== 'message' && notify.away() && prefsOf().mentions !== false) {
        const who = usersRef.current[m.authorId]?.displayName || 'Someone';
        notify.show({
          title: who,
          body: `${sv?.name || 'a server'}${ch ? ' \u00b7 #' + ch.name : ''} \u00b7 ${kind === 'everyone' ? '@everyone' : 'mentioned you'}\n${mentionPreview(m.content, usersRef.current).slice(0, 140) || 'Sent an attachment'}`,
          tag: 'm:' + m.id, target: `c:${m.serverId}:${m.channelId}`, kind: 'mention',
          sender: who, icon: imageUrl(sv?.iconImage) || imageUrl(usersRef.current[m.authorId]?.avatarImage) || undefined, theme: sv?.theme || undefined,
          serverId: m.serverId, channelId: m.channelId, msgId: m.id, read: true, reply: ch?.type === 'announcements' ? undefined : 'inline',
        });
      }
      if (!usersRef.current[m.authorId]) api('/users/' + m.authorId).then((r) => addUsers([r.user])).catch(() => {});
    });

    s.on('dm:new', (m) => {
      const partner = m.from === me.id ? m.to : m.from;
      setDmRaw((p) => ({ ...p, [partner]: mergeById(p[partner] || [], [m]) }));
      setConvos((c) => [partner, ...c.filter((x) => x !== partner)]);
      const v = viewRef.current;
      const watching = v?.kind === 'dm' && v.userId === partner && !document.hidden;
      if (!watching && m.from !== me.id) bump('d:' + partner);
      if (m.from !== me.id && notify.away() && prefsOf().dm !== false) {
        // DMs are encrypted: this device decrypts the text for the notification, the server never sees it
        (async () => {
          const [t, who] = await Promise.all([decryptMsg(m), usersRef.current[partner] || api('/users/' + partner).then((r) => r.user).catch(() => null)]);
          notify.show({ title: who?.displayName || 'New message', body: t.invite ? 'Sent you a server invite' : t.text?.slice(0, 140) || (t.attachments?.length ? 'Sent an attachment' : 'Sent you a message'), tag: 'm:' + m.id, target: 'd:' + partner, kind: 'dm',
            sender: who?.displayName, icon: imageUrl(who?.avatarImage) || undefined, peerId: partner, msgId: m.id, reply: 'open', read: true });
        })().catch(() => {});
      }
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

    // A poll's tallies changed (someone voted, or it ended). The server sends the whole poll, so replace it as it is.
    s.on('poll:update', ({ channelId, messageId, poll }) => {
      setChan((p) => (p[channelId] && p[channelId].some((x) => x.id === messageId) ? { ...p, [channelId]: p[channelId].map((x) => (x.id === messageId ? { ...x, poll } : x)) } : p));
    });
    // A call with someone has finished: it becomes a line in that DM ("Voice call · 4 min", "Missed video call").
    s.on('call:log', (rec) => {
      const partner = rec.a === me.id ? rec.b : rec.a;
      setCallsRaw((p) => ({ ...p, [partner]: mergeRecords(p[partner], [rec]) }));
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
      if (!np.decide(notePrefsRef.current[serverId], channelId, 'announcement', Date.now()).alert) return; // muted, "nothing", or announcements switched off for this server
      const v = viewRef.current;
      if (v?.kind === 'server' && v.channelId === channelId && !document.hidden) return; // already reading it
      const title = `${sv.name} · #${ch.name}`;
      let body = 'New announcement';
      try { const m = (await api(`/channels/${channelId}/messages`)).messages.find((x) => x.id === messageId); if (m?.content) body = m.content.slice(0, 140); } catch { /* keep the default */ }
      setToast({ key: messageId, serverId, channelId, title, body });
      if (notify.away() && prefsOf().announcements !== false) notify.show({ title: usersRef.current[authorId]?.displayName || sv.name, body: `${title} \u00b7 announcement\n${body}`, tag: 'm:' + messageId, target: `c:${serverId}:${channelId}`, kind: 'announcement', sender: usersRef.current[authorId]?.displayName || sv.name, icon: imageUrl(sv.iconImage) || undefined, theme: sv.theme || undefined, serverId, channelId, msgId: messageId, read: true });
    });
    s.on('credits:update', ({ balance: b, delta, reason }) => {
      setBalance(b); setCreditsRev((n) => n + 1);
      if (delta > 0 && (reason === 'message' || reason === 'purchase')) setGain({ key: Date.now(), delta });
    });
    s.on('friends:changed', () => loadFriends().catch(() => {}));
    // your other devices: a change of settings, or a channel read there
    s.on('notif:prefs', ({ serverId, prefs, counts }) => {
      setNotePrefs((p) => { const n = { ...p }; if (prefs && Object.keys(prefs).length) n[serverId] = prefs; else delete n[serverId]; return n; });
      const sv = serversRef.current.find((x) => x.id === serverId);
      if (sv) applyCounts(counts || {}, new Set(sv.channels.map((c) => 'c:' + c.id)));
    });
    s.on('notif:read', ({ channelIds }) => {
      const keys = new Set((channelIds || []).map((id) => 'c:' + id));
      const drop = (p) => { const n = {}; let hit = false; for (const [k, x] of Object.entries(p)) { if (keys.has(k)) hit = true; else n[k] = x; } return hit ? n : p; };
      setUnread(drop); setMentions(drop);
    });
    let connectedBefore = false; // after a dropped connection, messages that arrived meanwhile are counted again from the server
    s.on('connect', () => { if (connectedBefore) loadNotes().catch(() => {}); connectedBefore = true; });
    s.on('presence', ({ userId, status }) => setPresence((p) => ({ ...p, [userId]: status })));
    s.on('user:update', (u) => { addUsers([u]); if (u.id === me.id) setMe((m) => ({ ...m, ...u })); });
    s.on('server:update', (sv) => {
      setServers((prev) => (prev.some((x) => x.id === sv.id) ? prev.map((x) => (x.id === sv.id ? sv : x)) : [...prev, sv]));
      addUsers(sv.members);
    });
    s.on('bot:update', (b) => window.dispatchEvent(new CustomEvent('aduna:bot', { detail: b }))); // Settings > Developer listens
    s.on('server:removed', ({ serverId, reason, name }) => { // you were kicked, or the owner deleted the server
      setServers((prev) => prev.filter((x) => x.id !== serverId));
      setModal((m) => (m && ['serverSettings', 'invite', 'notes', 'onboarding', 'channel', 'category'].includes(m.type) ? null : m));
      if (reason === 'deleted') setTimeout(() => alert(`${name || 'A server'} was deleted by its owner.`), 0);
      setView((v) => (v?.kind === 'server' && v.serverId === serverId ? { kind: 'dm', userId: null } : v));
      setShowList(true);
    });
    s.on('typing', ({ channelId, dmWith, userId }) => {
      const key = channelId || 'dm:' + dmWith;
      setTyping((p) => ({ ...p, [key]: { ...(p[key] || {}), [userId]: Date.now() + 3500 } }));
    });

    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => { clearInterval(iv); s.disconnect(); };
  }, [me.id, setMe, addUsers, logout, loadFriends, loadNotes]);

  const voice = useVoice({ socketRef, ready: me.id });
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 8000); return () => clearTimeout(t); }, [toast]);

  // ---------- load history when the view changes ----------
  useEffect(() => {
    if (!view) return;
    if (view.kind === 'server') {
      clearUnread('c:' + view.channelId); markRead(view.channelId);
      api(`/channels/${view.channelId}/messages`).then((r) => setChan((p) => ({ ...p, [view.channelId]: mergeById(p[view.channelId] || [], r.messages) }))).catch(() => {});
    } else if (view.userId) {
      clearUnread('d:' + view.userId);
      api(`/dms/${view.userId}/messages`).then((r) => setDmRaw((p) => ({ ...p, [view.userId]: mergeById(p[view.userId] || [], r.messages) }))).catch(() => {});
      api(`/dms/${view.userId}/calls`).then((r) => setCallsRaw((p) => ({ ...p, [view.userId]: mergeRecords(p[view.userId], r.calls) }))).catch(() => {});
    }
  }, [view?.kind, view?.channelId, view?.userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Coming back to the tab counts as reading whatever channel / DM is open (messages that arrived while it was hidden were badged).
  useEffect(() => {
    const seen = () => {
      if (document.hidden) return;
      const v = viewRef.current;
      if (v?.kind === 'server') { clearUnread('c:' + v.channelId); markRead(v.channelId); }
      else if (v?.kind === 'dm' && v.userId) clearUnread('d:' + v.userId);
    };
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- notifications: tapping one opens that chat; the app icon shows a count ----------
  // targets: 'c:<serverId>:<channelId>' (a channel), 'd:<userId>' (a DM), 'f' (friend requests)
  const focusComposer = () => { // the Reply button of a notification: open the chat with the keyboard ready (the box is the last textarea on the page)
    for (const ms of [250, 700]) setTimeout(() => { const all = document.querySelectorAll('textarea.composer'); all[all.length - 1]?.focus(); }, ms);
  };
  const openTarget = async (t, { focus = false } = {}) => {
    if (focus) focusComposer();
    const [kind, a, b] = String(t || '').split(':');
    if (kind === 'c') {
      const sv = serversRef.current.find((x) => x.id === a);
      if (!sv || !sv.channels.some((c) => c.id === b)) return;
      lastChan.current[sv.id] = b;
      setView({ kind: 'server', serverId: sv.id, channelId: b }); setShowList(false); setMembersOpen(false);
    } else if (kind === 'd' && /^[0-9a-f]{16}$/.test(a || '')) {
      let u = usersRef.current[a];
      if (!u) { try { u = (await api('/users/' + a)).user; } catch { return; } }
      openDm(u);
    } else if (kind === 'f') { setView({ kind: 'dm', userId: null }); setShowList(false); }
    else if (kind === 'ai' && window.adunaDesktop?.ai) setModal({ type: 'edit', tab: 'developer', ai: Date.now() }); // desktop app: AI Coder (tray, title bar, menu, "your bot is ready")
  };
  openTargetRef.current = openTarget;
  useEffect(() => { // the app was opened by tapping a notification (/app?n=...)
    if (!loaded || !pendingNav.current) return;
    const t = pendingNav.current; pendingNav.current = null;
    const focus = pendingFocus.current; pendingFocus.current = false;
    history.replaceState(null, '', '/app');
    openTargetRef.current(t, { focus });
  }, [loaded]);
  useEffect(() => { // Android app: a notification tapped while the app was closed (it fired before this page was ready)
    if (!loaded) return;
    const t = notify.takePendingOpen();
    if (t) openTargetRef.current(t);
  }, [loaded]);
  useEffect(() => { // ...or was already open: the service worker / desktop app / page tells it where to go
    const fromSw = (e) => {
      if (e.data?.type === 'aduna:open') openTargetRef.current(e.data.target, { focus: !!e.data.focus });
      // "Mark as read" on a notification: a DM's unread count lives only in this page (DMs are end-to-end encrypted), channels are told by the server (notif:read)
      else if (e.data?.type === 'aduna:read' && /^d:[0-9a-f]{16}$/.test(e.data.target || '')) clearUnread(e.data.target);
    };
    const fromPage = (e) => { notify.takePendingOpen(); openTargetRef.current(e.detail); };
    navigator.serviceWorker?.addEventListener('message', fromSw);
    window.addEventListener('aduna:open', fromPage);
    const off = window.adunaDesktop?.onClick?.((t) => openTargetRef.current(t));
    return () => { navigator.serviceWorker?.removeEventListener('message', fromSw); window.removeEventListener('aduna:open', fromPage); off?.(); };
  }, []);
  useEffect(() => { // keep this device's push subscription fresh (browsers rotate them now and then)
    if (notify.pushSupported() && notify.permission() === 'granted') notify.subscribe().catch(() => {});
  }, []);
  const badgeCount = Object.values(mentions).reduce((n, x) => n + x, 0) + Object.entries(unread).reduce((n, [k, x]) => n + (k.startsWith('d:') ? x : 0), 0) + fr.incoming.length;
  useEffect(() => { notify.setBadge(badgeCount); }, [badgeCount]);

  // ---------- derived ----------
  const server = view?.kind === 'server' ? servers.find((s) => s.id === view.serverId) : null;
  // Server onboarding: ask the questions when you open a server that has them on and you have not answered (once per visit if you may skip).
  const onbAsked = useRef(new Set());
  const onbOn = !!server?.onboarding?.enabled;
  useEffect(() => {
    if (!server || !onbOn) return undefined;
    let live = true;
    api(`/servers/${server.id}/onboarding`).then((st) => {
      if (!live || st.done) return;
      if (server.ownerId === me.id) return; // the owner wrote the questions; they can open them from the server menu
      if (st.blocking || !onbAsked.current.has(server.id)) {
        onbAsked.current.add(server.id);
        // never replace a screen the person is already using (for example Server settings while an admin edits the questions)
        setModal((m) => (m && !(st.blocking && m.type !== 'serverSettings') ? m : { type: 'onboarding', serverId: server.id, state: st }));
      }
    }).catch(() => {});
    return () => { live = false; };
  }, [server?.id, onbOn]); // eslint-disable-line react-hooks/exhaustive-deps
  const openOnboarding = () => api(`/servers/${server.id}/onboarding`).then((st) => setModal({ type: 'onboarding', serverId: server.id, state: st })).catch((e) => alert(e.message));
  const channel = server?.channels.find((c) => c.id === view.channelId);
  const dmUser = view?.kind === 'dm' && view.userId ? users[view.userId] : null;
  const stageHere = !!dmUser && inCall(call.call) && call.call.peerId === dmUser.id; // the call is drawn in this conversation
  const goToCall = (peerId) => { setView({ kind: 'dm', userId: peerId }); setShowList(false); setMembersOpen(false); };

  // On a server page the app fades to that server's theme; anywhere else (DMs, friends) it fades back to yours.
  // While the owner is in server settings, that screen previews the draft theme itself, so leave it alone.
  const serverThemeKey = server?.theme ? JSON.stringify(server.theme) : '';
  const editingServer = modal?.type === 'serverSettings';
  useEffect(() => {
    if (!editingServer) setServerTheme(serverThemeKey ? JSON.parse(serverThemeKey) : null);
  }, [serverThemeKey, editingServer]);

  const messages = useMemo(() => {
    if (view?.kind === 'server') return chan[view.channelId] || [];
    if (dmUser) {
      const texts = (dmRaw[dmUser.id] || []).map((m) => ({ id: m.id, authorId: m.from, content: plain[m.id]?.text ?? '…', attachments: plain[m.id]?.attachments, invite: plain[m.id]?.invite, replyTo: m.replyTo, reactions: m.reactions, createdAt: m.createdAt, editedAt: m.editedAt }));
      return withCalls(texts, callsRaw[dmUser.id]); // finished calls sit between the messages, by the time they ended
    }
    return [];
  }, [view, chan, dmRaw, callsRaw, plain, dmUser]);

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
  const send = async (text, replyTo, atts = [], typing) => {
    const s = socketRef.current;
    if (view.kind === 'server') return emitAck(s, 'message:send', { channelId: view.channelId, content: text, replyTo, attachments: atts, typing });
    const enc = await encryptFor(privKey, dmUser.publicKey, wrapDm(text, atts));
    return emitAck(s, 'dm:send', { to: dmUser.id, ...enc, replyTo, files: atts.map((a) => a.id).filter(Boolean), quest: questHint(text, atts) });
  };
  // A poll is a channel message with no text; the server cleans it (polls.js) and sends it back to everyone through message:new.
  const sendPoll = (poll) => emitAck(socketRef.current, 'message:send', { channelId: view.channelId, content: '', poll });
  const votePoll = (messageId, options) => emitAck(socketRef.current, 'poll:vote', { messageId, options });
  const closePoll = (messageId) => emitAck(socketRef.current, 'poll:close', { messageId });
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
    const iOwn = server.ownerId === me.id;
    if (iOwn && server.members.length > 1) { // the owner must hand the server over (or delete it) first
      alert('You own this server. Transfer ownership to another member, or delete the server, before you leave.');
      setModal({ type: 'serverSettings', tab: 'ownership' });
      return;
    }
    if (!confirm(iOwn ? `You are the only member, so leaving deletes ${server.name}. Continue?` : `Leave ${server.name}?`)) return;
    try {
      await api(`/servers/${server.id}/leave`, { method: 'POST' });
      const rest = servers.filter((s) => s.id !== server.id);
      setServers(rest);
      rest[0] ? openServer(rest[0]) : (setView({ kind: 'dm', userId: null }), setShowList(true));
    } catch (e) { alert(e.message); }
  };

  // Direct invite: a normal end-to-end encrypted DM containing the invite link; the receiver's client draws the join box.
  const sendInvite = async (friend, link) => {
    const enc = await encryptFor(privKey, friend.publicKey, wrapDm(link, [], undefined));
    await emitAck(socketRef.current, 'dm:send', { to: friend.id, ...enc, files: [] });
  };
  const onInviteJoined = (sv) => { setServers((p) => (p.some((x) => x.id === sv.id) ? p : [...p, sv])); addUsers(sv.members); openServer(sv); };
  const inviteCtx = { servers, onJoined: onInviteJoined, onOpen: openServer };

  const fmtN = (n) => (n >= np.MAX_COUNT ? np.MAX_COUNT + '+' : n); // badges stop at 99+
  const totalUnreadFor = (s) => s.channels.reduce((n, c) => n + (unread['c:' + c.id] || 0), 0);
  const unreadCountsAll = (sv, ch) => { const e = np.effective(notePrefs[sv.id], ch.id, Date.now()); return e.level === 'all' && !e.muted; }; // the unread number counts every message only then
  const totalMentionsFor = (s) => s.channels.reduce((n, c) => n + (mentions['c:' + c.id] || 0), 0);
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

  if (!view) return <BootSplash />;

  const roleColors = server ? Object.fromEntries(server.members.map((m) => [m.id, roleColorOf(server, m.id)]).filter(([, c]) => c)) : {};
  const memberRow = (u) => (
    <button key={u.id} className={'member' + (statusOf(u.id) === 'offline' ? ' off' : '')} onClick={() => { setMembersOpen(false); showUser(u.id); }}>
      <Avatar user={users[u.id] || u} size={32} presence={statusOf(u.id)} />
      <span data-nc style={{ '--nc': (server && roleColorOf(server, u.id)) || (users[u.id] || u).accentColor }}>{(users[u.id] || u).displayName}</span>
      <BadgeIcons user={users[u.id] || u} size={16} />
      {(users[u.id] || u).bot && <BotTag />}
      {server?.ownerId === u.id && <span className="owner" title="Server owner"><Icon name="crown" size={15} /></span>}
    </button>
  );

  return (
    <InviteContext.Provider value={inviteCtx}>
    <div className="app">
      {/* server bar (top) */}
      <nav className="rail">
        <button className={'rail-btn dm-home' + (view.kind === 'dm' ? ' on' : '')} title={tr('dms')} onClick={() => { setView({ kind: 'dm', userId: view.kind === 'dm' ? view.userId : null, explore: view.kind === 'dm' && !!view.explore, shop: view.kind === 'dm' && !!view.shop, quests: view.kind === 'dm' && !!view.quests }); setShowList(true); setMembersOpen(false); }}>
          <img src="/aduna-icon.png" alt="" />{dmUnread + fr.incoming.length > 0 && <span className="badge">{dmUnread + fr.incoming.length}</span>}
        </button>
        <div className="rail-sep" />
        <div className="rail-list">
          {servers.map((s) => (
            <button key={s.id} className={'rail-btn' + (s.iconImage ? ' has-icon' : '') + (server?.id === s.id ? ' on' : '') + (np.muteActive(notePrefs[s.id]?.mute, Date.now()) ? ' muted' : '')} title={s.name + (np.muteActive(notePrefs[s.id]?.mute, Date.now()) ? ' (muted)' : '')} onClick={() => openServer(s)}>
              <ServerIcon server={s} fill />
              {totalUnreadFor(s) > 0 && <span className="badge">{fmtN(totalUnreadFor(s))}</span>}
              {totalMentionsFor(s) > 0 && <span className="badge at" title={totalMentionsFor(s) + ' mention' + (totalMentionsFor(s) > 1 ? 's' : '')}>@{fmtN(totalMentionsFor(s))}</span>}
            </button>
          ))}
          <button className="rail-btn add" title="Create or join a server" onClick={() => setModal({ type: 'server' })}><Icon name="plus" size={22} /></button>
        </div>
        <RailUpdateChip />
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
                <div className="menu-sep" role="separator" />
                <div className="menu-label">Notifications</div>
                {np.muteActive(notePrefs[server.id]?.mute, Date.now())
                  ? <button onClick={() => { setMenu(false); const { mute, ...rest } = notePrefs[server.id]; saveNotes(server.id, rest); }}>Unmute server</button>
                  : <button onClick={() => { setMenu(false); setModal({ type: 'notes' }); }}>Mute server…</button>}
                <button onClick={() => { setMenu(false); setModal({ type: 'notes' }); }}>Notification settings</button>
                <button onClick={() => { setMenu(false); markServerRead(server); }}>Mark all as read</button>
                <div className="menu-sep" role="separator" />
                {onbOn && <button onClick={() => { setMenu(false); openOnboarding(); }}>Server questions</button>}
                {canManageAny(server, me.id) && <button onClick={() => { setMenu(false); setModal({ type: 'serverSettings' }); }}>Server settings</button>}
                <button className="danger-text" onClick={() => { setMenu(false); leaveServer(); }}>Leave server</button>
              </div>
            )}
            <div className="side-list">
              {(() => {
                const isOwner = can(server, me.id, 'manageChannels'); // may arrange channels
                const cats = server.categories || [];
                const catIds = new Set(cats.map((c) => c.id));
                const loose = server.channels.filter((c) => !c.categoryId || !catIds.has(c.categoryId));
                const row = (c) => (
                  <React.Fragment key={c.id}>
                    <button className={'chan' + (c.id === view.channelId ? ' on' : '') + (unread['c:' + c.id] || mentions['c:' + c.id] ? ' unread' : '') + (np.effective(notePrefs[server.id], c.id, Date.now()).muted ? ' muted' : '') + markClass('chan', c.id)} onClick={() => openChannel(c)} onContextMenu={(e) => { e.preventDefault(); setModal({ type: 'notes', channelId: c.id }); }} title={np.effective(notePrefs[server.id], c.id, Date.now()).muted ? 'Muted \u00b7 right-click for notification settings' : undefined} {...chanDnd(c, isOwner)}>
                      <span className="hash">{CHANNEL_ICON[c.type] ? <Icon name={CHANNEL_ICON[c.type]} size={18} /> : '#'}</span>{c.name}{mentions['c:' + c.id] > 0 && <span className="badge inline at" title="You were mentioned">@{fmtN(mentions['c:' + c.id])}</span>}{unread['c:' + c.id] > 0 && <span className={'badge inline' + (mentions['c:' + c.id] ? ' after-at' : '')}>{fmtN(unread['c:' + c.id])}</span>}
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
            <div className="side-head static">{tr('dms')}
              <button className="icon-btn" title={tr('newMessage')} onClick={() => setModal({ type: 'dm' })}><Icon name="plus" size={17} /></button>
            </div>
            <div className="side-list">
              <button className={'chan' + (view.explore ? ' on' : '')} onClick={() => { setView({ kind: 'dm', userId: null, explore: true }); setShowList(false); }}>
                <span className="hash"><Icon name="globe" size={20} /></span>{tr('serverExplorer')}
              </button>
              <button className={'chan' + (view.shop ? ' on' : '')} onClick={() => { setView({ kind: 'dm', userId: null, shop: true }); setShowList(false); }}>
                <span className="hash"><Icon name="bag" size={20} /></span>{tr('shopTab')}{balance !== null && <span className="credit-count">{balance.toLocaleString()}</span>}
              </button>
              <button className={'chan' + (view.quests ? ' on' : '')} onClick={() => { setView({ kind: 'dm', userId: null, quests: true }); setShowList(false); }}>
                <span className="hash"><Icon name="flag" size={20} /></span>{tr('questsTab')}
              </button>
              <button className={'chan' + (!view.userId && !view.explore && !view.shop && !view.quests ? ' on' : '')} onClick={() => { setView({ kind: 'dm', userId: null }); setShowList(false); }}>
                <span className="hash"><Icon name="users" size={20} /></span>{tr('friends')}{fr.incoming.length > 0 && <span className="badge inline">{fr.incoming.length}</span>}
              </button>
              <div className="side-label">{tr('lblDMs')}</div>
              {convos.length === 0 && <p className="muted pad">{tr('noConvos')}</p>}
              {convos.map((id) => users[id] && (
                <button key={id} className={'chan dm' + (id === view.userId ? ' on' : '')} onClick={() => { setView({ kind: 'dm', userId: id }); setShowList(false); }}>
                  <Avatar user={users[id]} size={32} presence={statusOf(id)} />
                  <span className="grow">{users[id].displayName}<BadgeIcons user={users[id]} size={16} /></span>
                  {id !== view.userId && hasDraft('d:' + id) && <span className="muted small" title="You have an unsent message here">Draft</span>}
                  {unread['d:' + id] > 0 && <span className="badge inline">{unread['d:' + id]}</span>}
                </button>
              ))}
            </div>
          </>
        )}
        <CallDock call={call.call} actions={call.actions} users={users} onOpen={goToCall} />
        <div className="user-panel">
          <button className="me" onClick={() => setModal({ type: 'user', id: me.id })}>
            <Avatar user={me} size={34} presence={myPresence} />
            <div><div className="me-name">{me.displayName}<BadgeIcons user={me} size={16} /></div><div className="muted small">{STATUS_LABEL[myPresence]}</div></div>
          </button>
          <button className="credit-chip" title={tr('shopTab')} onClick={() => { setView({ kind: 'dm', userId: null, shop: true }); setShowList(false); setMembersOpen(false); }}><Icon name="coin" size={16} />{balance !== null ? balance.toLocaleString() : ''}</button>
          <button className="icon-btn" title={tr('customEmoji')} onClick={openManager}><Icon name="smile" size={18} /></button>
          <button className="icon-btn" title={tr('settings')} onClick={() => setModal({ type: 'edit' })}><Icon name="gear" size={18} /></button>
        </div>
      </aside>

      {/* main */}
      {server && channel?.type === 'voice' && (
        <VoicePanel channel={channel} voice={voice} users={users} me={me} presence={presence} onBack={() => setShowList(true)} headerExtra={membersToggle} />
      )}
      {server && channel?.type === 'rules' && (
        <RulesView server={server} channel={channel} isOwner={can(server, me.id, 'manageChannels')} onBack={() => setShowList(true)} headerExtra={membersToggle}
          onChange={(sv) => setServers((p) => p.map((x) => (x.id === sv.id ? sv : x)))} />
      )}
      {server && channel && channel.type !== 'voice' && channel.type !== 'rules' && (
        <Chat title={channel.name} draftKey={'c:' + channel.id} unreadCount={unread['c:' + channel.id] || 0} unreadExact={unreadCountsAll(server, channel)} onBack={() => setShowList(true)} messages={messages} users={users} me={me} presence={presence}
          onSend={send} onPoll={!channel.type || channel.type === 'text' || channel.type === 'announcements' ? sendPoll : undefined} onVote={votePoll} onClosePoll={closePoll}
          onReact={react} onEdit={editMsg} onDelete={deleteMsg} canModerate={can(server, me.id, 'manageMessages')} roleColors={roleColors} onTyping={onTyping} typingNames={typingNames} onUser={showUser}
          files={{ scope: { kind: 'channel', target: channel.id }, dm: null }} gifEnabled={gifEnabled}
          mentionables={server.members} canEveryone={can(server, me.id, 'mentionEveryone') && channel.type !== 'announcements'}
          placeholder={channel.type === 'announcements' ? `Announce to everyone in ${server.name}` : `Message #${channel.name}`}
          notice={channel.type === 'announcements' ? <><Icon name="megaphone" size={14} className="inline-icon" /> Everyone in this server is notified when the owner posts here.</> : null}
          readOnly={channel.type === 'announcements' && !can(server, me.id, 'postAnnouncements') ? 'You do not have permission to post in this channel.' : null}
          subtitle={CHANNEL_ICON[channel.type] ? <Icon name={CHANNEL_ICON[channel.type]} size={20} /> : '#'}
          headerExtra={membersToggle} />
      )}
      {dmUser && (
        <Chat title={dmUser.displayName} draftKey={'d:' + dmUser.id} unreadCount={unread['d:' + dmUser.id] || 0} unreadExact subtitle="@" onBack={() => setShowList(true)} messages={messages} users={users} me={me} presence={presence}
          onSend={send} onReact={react} onEdit={editMsg} onDelete={deleteMsg} canModerate={false} onTyping={onTyping} typingNames={typingNames} onUser={showUser}
          files={{ scope: relationOf(dmUser.id) === 'friend' ? { kind: 'dm', target: dmUser.id, privKey, theirPublic: dmUser.publicKey } : null, dm: { privKey, theirPublic: dmUser.publicKey } }} gifEnabled={gifEnabled}
          placeholder={`Message @${dmUser.displayName}`} mentionables={[me, dmUser]}
          stage={stageHere ? <CallStage call={call.call} actions={call.actions} users={users} me={me} /> : null}
          headerExtra={<>
            <button className="icon-btn" title="Voice call" disabled={relationOf(dmUser.id) !== 'friend' || call.call.phase !== 'idle'} onClick={() => call.actions.startCall(dmUser.id, false)}><Icon name="phone" size={18} /></button>
            <button className="icon-btn" title="Video call" disabled={relationOf(dmUser.id) !== 'friend' || call.call.phase !== 'idle'} onClick={() => call.actions.startCall(dmUser.id, true)}><Icon name="video" size={18} /></button>
            <button className="btn small-btn" title="End-to-end encrypted" onClick={() => setModal({ type: 'safety' })}><Icon name="lock" size={14} className="inline-icon" /><span className="hide-sm"> End-to-end encrypted</span></button>
          </>}
          notice={<><Icon name="lock" size={14} className="inline-icon" /> Messages here are end-to-end encrypted. Only you and <b>{dmUser.displayName}</b> can read them.{relationOf(dmUser.id) !== 'friend' && <><br />You aren’t friends with {dmUser.displayName}, so you can’t send new messages until you are.</>}</>} />
      )}
      {view.kind === 'dm' && !dmUser && view.explore && <Explorer onBack={() => setShowList(true)} servers={servers} me={me} onServerUpdate={(sv) => { setServers((p) => p.map((x) => (x.id === sv.id ? sv : x))); addUsers(sv.members); }} />}
      {view.kind === 'dm' && !dmUser && (view.shop || view.quests) && <Credits page={view.shop ? 'shop' : 'quests'} onBack={() => setShowList(true)} rev={creditsRev} justPaid={justPaid} paypalOrder={paypalOrder} creator={!!me.creator} />}
      {view.kind === 'dm' && !dmUser && !view.explore && !view.shop && !view.quests && (
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
      <NotifyPrompt />
      <UpdatePrompt />
      <SiteUpdateNotice />
      <WhatsNewPopup />
      {gain && <div className="credit-gain" key={gain.key} aria-live="polite"><Icon name="coin" size={16} />+{gain.delta} credits</div>}
      <CallUI call={call.call} actions={call.actions} users={users} onOpen={goToCall} showStrip={!stageHere} />
      </div>

      {modal?.type === 'server' && <ServerModal onClose={() => setModal(null)} onDone={(s) => { setServers((p) => (p.some((x) => x.id === s.id) ? p : [...p, s])); addUsers(s.members); openServer(s); setModal(null); }} />}
      {modal?.type === 'channel' && server && <ChannelModal server={server} category={(server.categories || []).find((c) => c.id === modal.categoryId)} onClose={() => setModal(null)} onDone={(s) => { setServers((p) => p.map((x) => (x.id === s.id ? s : x))); setModal(null); }} />}
      {modal?.type === 'category' && server && <CategoryModal server={server} onClose={() => setModal(null)} onDone={(s) => { setServers((p) => p.map((x) => (x.id === s.id ? s : x))); setModal(null); }} />}
      {modal?.type === 'serverSettings' && server && canManageAny(server, me.id) && (
        <ServerSettings key={server.id} server={server} me={me} startTab={modal.tab} onClose={() => setModal(null)} onSaved={(sv) => setServers((p) => p.map((x) => (x.id === sv.id ? sv : x)))} />
      )}
      {modal?.type === 'onboarding' && server && server.id === modal.serverId && server.onboarding?.enabled && (
        <OnboardingFlow key={server.id} server={server} state={modal.state} onClose={() => setModal(null)}
          onDone={(r) => { if (r.server) setServers((p) => p.map((x) => (x.id === r.server.id ? r.server : x))); setModal(null); }} />
      )}
      {modal?.type === 'notes' && server && <ServerNotifications server={server} prefs={notePrefs[server.id]} focusChannel={modal.channelId} onSave={(next) => saveNotes(server.id, next)} onMarkRead={() => markServerRead(server)} onClose={() => setModal(null)} />}
      {modal?.type === 'invite' && server && <InviteModal server={server} friends={fr.friends} isOwner={can(server, me.id, 'manageServer')} onSend={sendInvite} onClose={() => setModal(null)} />}
      {modal?.type === 'dm' && <NewDmModal friends={fr.friends} onClose={() => setModal(null)} onPick={openDm} />}
      {modal?.type === 'safety' && dmUser && <SafetyModal me={me} other={dmUser} onClose={() => setModal(null)} />}
      {modal?.type === 'user' && users[modal.id] && (
        <UserCard user={users[modal.id]} relation={relationOf(modal.id)} presence={statusOf(modal.id)} onClose={() => setModal(null)}
          onMessage={() => openDm(users[modal.id])} onEdit={() => setModal({ type: 'edit' })}
          onAddFriend={() => requestFriend(users[modal.id].username).catch((e) => alert(e.message))} onAccept={() => acceptFriend(modal.id)} />
      )}
      {modal?.type === 'edit' && <SettingsScreen key={modal.ai || 0} initialTab={modal.tab} aiFocus={modal.ai} me={me} onClose={() => setModal(null)} onSaved={(u) => { setMe((m) => ({ ...m, ...u })); addUsers([u]); }} onPrefs={(p) => setMe((m) => ({ ...m, notifPrefs: p }))} onLogout={logout} getSocketId={() => socketRef.current?.id} />}
    </div>
    </InviteContext.Provider>
  );
}
