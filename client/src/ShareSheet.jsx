import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, connectSocket, emitAck } from './api.js';
import { Avatar, ServerIcon } from './ui.jsx';
import { loadKey, encryptFor } from './crypto.js';
import { toast } from './Dialogs.jsx';
import './sharesheet.css';

// "Share" on a clip. Send it to a friend (an end-to-end encrypted DM, exactly like inside Aduna: the key is kept on this device) or to a
// server (its first text channel), copy the link, or open the device's own share menu. `onShared` runs after each successful share.
const wrapDm = (text) => JSON.stringify({ v: 1, t: text, a: [] }); // the envelope Aduna's DMs use
const firstText = (s) => (s.channels || []).find((c) => (c.type || 'text') === 'text');
const nameOf = (u) => u.displayName || u.username || 'Someone';

const LinkIcon = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 14a4.500 4.500 0 0 0 6.400.4l3-3a4.500 4.500 0 0 0-6.400-6.400l-1.100 1.100" /><path d="M14 10a4.500 4.500 0 0 0-6.400-.4l-3 3a4.500 4.500 0 0 0 6.400 6.400l1.100-1.100" /></svg>;
const MoreIcon = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.900" /><circle cx="12" cy="12" r="1.900" /><circle cx="19" cy="12" r="1.900" /></svg>;

export default function ShareSheet({ clip, onClose, onShared }) {
  const link = `${location.origin}/clips/${clip.id}`;
  const [friends, setFriends] = useState(null);
  const [servers, setServers] = useState(null);
  const [q, setQ] = useState('');
  const [done, setDone] = useState({}); // id -> 'sending' | 'sent'
  const key = useRef(null);
  const sock = useRef(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try { const { user } = await api('/me'); key.current = await loadKey(user.id); } catch { /* a friend send will explain */ }
    })();
    api('/friends').then((r) => live && setFriends(r.friends || [])).catch(() => live && setFriends([]));
    api('/servers').then((r) => live && setServers((r.servers || []).filter(firstText))).catch(() => live && setServers([]));
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => { live = false; document.removeEventListener('keydown', esc); if (sock.current) sock.current.disconnect(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const mark = (id, v) => setDone((d) => ({ ...d, [id]: v }));
  const socket = () => { if (!sock.current) sock.current = connectSocket(); return sock.current; };

  const toFriend = async (f) => {
    if (done[f.id]) return;
    mark(f.id, 'sending');
    try {
      if (!key.current) throw new Error('Open Aduna once on this device to send messages from here.');
      if (!f.publicKey) throw new Error(nameOf(f) + ' has not set up messages yet.');
      const enc = await encryptFor(key.current, f.publicKey, wrapDm(link));
      await emitAck(socket(), 'dm:send', { to: f.id, ...enc, files: [] });
      mark(f.id, 'sent'); onShared();
    } catch (e) { mark(f.id, ''); toast(e.message || 'Could not send', 'error'); }
  };
  const toServer = async (s) => {
    if (done[s.id]) return;
    mark(s.id, 'sending');
    try {
      const ch = firstText(s);
      await emitAck(socket(), 'message:send', { channelId: ch.id, content: link });
      mark(s.id, 'sent'); onShared();
      toast(`Sent to ${s.name} #${ch.name || 'channel'}`);
    } catch (e) { mark(s.id, ''); toast(e.message || 'Could not send', 'error'); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); toast('Link copied'); onShared(); }
    catch { window.prompt('Copy this link', link); }
  };
  const more = async () => {
    if (!navigator.share) return copy();
    try { await navigator.share({ url: link, title: clip.caption || 'A clip on Aduna' }); onShared(); }
    catch { /* closed without sharing */ }
  };

  const ql = q.trim().toLowerCase();
  const fl = (friends || []).filter((f) => !ql || (nameOf(f) + ' ' + (f.username || '')).toLowerCase().includes(ql));
  const sl = (servers || []).filter((s) => !ql || String(s.name).toLowerCase().includes(ql));
  const many = (friends || []).length + (servers || []).length > 8;

  const tile = (id, label, avatar, onClick) => (
    <button key={id} type="button" className={'ss-tile' + (done[id] === 'sent' ? ' sent' : '')} onClick={onClick} disabled={done[id] === 'sending'} aria-label={(done[id] === 'sent' ? 'Sent to ' : 'Send to ') + label}>
      <span className="ss-ava">{avatar}{done[id] === 'sent' && <i className="ss-check" aria-hidden="true">✓</i>}{done[id] === 'sending' && <i className="ss-check ss-wait" aria-hidden="true">…</i>}</span>
      <span className="ss-name">{label}</span>
    </button>
  );

  return createPortal(
    <div className="ss-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ss-panel" role="dialog" aria-modal="true" aria-label="Share this clip">
        <div className="ss-head"><b>Share</b><button type="button" className="ss-x" onClick={onClose} aria-label="Close">✕</button></div>
        {many && <input className="ss-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search friends and servers" aria-label="Search friends and servers" />}

        <div className="ss-label">Friends</div>
        {!friends && <p className="ss-note">Loading…</p>}
        {friends && !fl.length && <p className="ss-note">{friends.length ? 'No friends match.' : 'Add friends in Aduna to send clips to them.'}</p>}
        {friends && fl.length > 0 && <div className="ss-row">{fl.map((f) => tile(f.id, nameOf(f), <Avatar user={f} size={52} />, () => toFriend(f)))}</div>}

        <div className="ss-label">Servers</div>
        {!servers && <p className="ss-note">Loading…</p>}
        {servers && !sl.length && <p className="ss-note">{servers.length ? 'No servers match.' : 'You are not in any server with a text channel.'}</p>}
        {servers && sl.length > 0 && <div className="ss-row">{sl.map((s) => tile(s.id, s.name, <ServerIcon server={s} size={52} />, () => toServer(s)))}</div>}

        <div className="ss-acts">
          <button type="button" className="ss-act" onClick={copy}><span className="ss-circle"><LinkIcon /></span><span>Copy link</span></button>
          <button type="button" className="ss-act" onClick={more}><span className="ss-circle"><MoreIcon /></span><span>More</span></button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
