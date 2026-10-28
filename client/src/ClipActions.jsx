import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';
import { Avatar } from './ui.jsx';
import { toast, askConfirm } from './Dialogs.jsx';
import ShareSheet from './ShareSheet.jsx';
import './clipactions.css';

// The buttons under a clip (feed card and /clips/<id> page): like, comments, share and a "..." menu with the exact numbers
// (views, likes, comments, shares) plus report / remove. Shown numbers are short (1.2K); the menu has the exact ones.
const REASONS = [['inappropriate', 'Inappropriate'], ['spam', 'Spam'], ['illegal', 'Illegal'], ['impersonation', 'Impersonation']];

export const exact = (n) => Number(n || 0).toLocaleString();
export const compact = (n) => {
  n = Number(n || 0);
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  return (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M';
};
const short = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
};

// Double-click (or double-tap) on the video: likes the clip. It only ever likes (a second double-click never un-likes), and a fast
// triple-click cannot send two toggles because a request is already in flight.
export function useDoubleLike(clip, onChange) {
  const busy = useRef(false);
  return async () => {
    if (busy.current || clip.liked) return;
    busy.current = true;
    try { const r = await api(`/clips/${clip.id}/like`, { method: 'POST' }); onChange({ ...clip, liked: r.liked, likes: r.likes }); }
    catch (e) { toast(e.message, 'error'); }
    finally { busy.current = false; }
  };
}

const HeartIcon = ({ on }) => <svg width="20" height="20" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.4C1.5 7.800 3.700 4.500 7 4.500c2 0 3.500 1.100 5 3 1.500-1.900 3-3 5-3 3.300 0 5.500 3.300 4.300 6.600-1.800 4.800-9.300 9.400-9.300 9.400z" /></svg>;
const CommentIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.600 7.100L4 20.500l1.500-4.700A8 8 0 1 1 21 12z" /></svg>;
const ShareIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" /><path d="M12 15V3" /><path d="M7.500 7.500 12 3l4.500 4.500" /></svg>;
const MoreIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.800" /><circle cx="12" cy="12" r="1.800" /><circle cx="19" cy="12" r="1.800" /></svg>;

function Comments({ clip, onTotal }) {
  const [rows, setRows] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api(`/clips/${clip.id}/comments`).then((r) => { if (live) { setRows(r.comments); onTotal(r.total); } }).catch(() => live && setRows([]));
    return () => { live = false; };
  }, [clip.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const r = await api(`/clips/${clip.id}/comments`, { method: 'POST', body: { text: t } });
      setRows(r.comments); onTotal(r.total); setText('');
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  const del = async (cm) => {
    if (!(await askConfirm({ title: 'Delete this comment?', body: 'It is removed for everyone.', confirmLabel: 'Delete', danger: true }))) return;
    try { const r = await api(`/clips/${clip.id}/comments/${cm.id}`, { method: 'DELETE' }); setRows(r.comments); onTotal(r.total); }
    catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div className="ca-comments">
      <div className="ca-list">
      {!rows && <p className="muted ca-note">Loading…</p>}
      {rows && !rows.length && <p className="muted ca-note">No comments yet. Be the first.</p>}
      {rows && rows.map((cm) => (
        <div key={cm.id} className="ca-comment">
          <Avatar user={{ ...cm.user, id: cm.user.id }} size={28} />
          <div className="ca-body">
            <div><b>{cm.user.username || 'Someone'}</b> <span className="muted">{short(cm.at)}</span></div>
            <p>{cm.text}</p>
          </div>
          {cm.canDelete && <button className="ca-del" title="Delete comment" aria-label="Delete comment" onClick={() => del(cm)}>✕</button>}
        </div>
      ))}
      </div>
      <div className="ca-write">
        <input value={text} maxLength={300} placeholder="Add a comment…" disabled={busy} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
        <button className="ca-send" disabled={busy || !text.trim()} onClick={send}>Post</button>
      </div>
    </div>
  );
}

// The comments open as a popup over the page (like Reels / Shorts): a card on a computer, a sheet from the bottom on a phone.
function CommentsSheet({ clip, onTotal, onClose }) {
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return createPortal(
    <div className="ss-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ss-panel cs-panel" role="dialog" aria-modal="true" aria-label="Comments">
        <div className="ss-head"><b>Comments{clip.comments ? ' · ' + compact(clip.comments) : ''}</b><button type="button" className="ss-x" onClick={onClose} aria-label="Close">✕</button></div>
        <Comments clip={clip} onTotal={onTotal} />
      </div>
    </div>,
    document.body,
  );
}

const OpenIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>;
const FlagIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></svg>;
const TrashIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" /><path d="M9 7V4h6v3" /></svg>;

// The "..." opens a popup like the comments do: the exact numbers, the creator's followers, Open clip page, and Report / Remove.
// Report asks for a reason on a second screen inside the same popup.
function MoreSheet({ clip, onClose, onReport, onRemove }) {
  const [view, setView] = useState('menu'); // 'menu' | 'report'
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') { if (view === 'report') setView('menu'); else onClose(); } };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, view]);
  const name = clip.owner.username || 'this creator';
  return createPortal(
    <div className="ss-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ss-panel ms-panel" role="dialog" aria-modal="true" aria-label="Clip details">
        {view === 'menu' ? (
          <>
            <div className="ss-head"><b>Clip details</b><button type="button" className="ss-x" onClick={onClose} aria-label="Close">✕</button></div>
            <div className="ms-stats">
              <div><b>{exact(clip.views)}</b><span>Views</span></div>
              <div><b>{exact(clip.likes)}</b><span>Likes</span></div>
              <div><b>{exact(clip.comments)}</b><span>Comments</span></div>
              <div><b>{exact(clip.shares)}</b><span>Shares</span></div>
            </div>
            <div className="ms-who">{exact(clip.owner.followers)} {clip.owner.followers === 1 ? 'follower' : 'followers'} · {name}</div>
            <div className="ms-list">
              <a className="ms-item" href={`/clips/${clip.id}`} target="_blank" rel="noopener"><OpenIcon />Open clip page</a>
              {clip.mine
                ? <button type="button" className="ms-item danger" onClick={onRemove}><TrashIcon />Remove clip</button>
                : <button type="button" className="ms-item" onClick={() => setView('report')}><FlagIcon />Report</button>}
            </div>
          </>
        ) : (
          <>
            <div className="ss-head"><b>Why are you reporting this?</b><button type="button" className="ss-x" onClick={() => setView('menu')} aria-label="Back">←</button></div>
            <div className="ms-list">
              {REASONS.map(([id, label]) => <button type="button" key={id} className="ms-item" onClick={() => onReport(id)}>{label}</button>)}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// Follow / Following next to the poster's name. Hidden on your own clips. Following someone puts their new clips in the Following tab.
export function FollowButton({ clip, onChange }) {
  const [busy, setBusy] = useState(false);
  if (clip.mine) return null;
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api(`/clips/follow/${clip.owner.id}`, { method: 'POST' });
      onChange({ ...clip, following: r.following, owner: { ...clip.owner, followers: r.followers } });
      toast(r.following ? 'Following ' + (clip.owner.username || 'this creator') : 'Unfollowed');
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  return <button className={'ca-follow' + (clip.following ? ' on' : '')} disabled={busy} onClick={toggle} aria-pressed={!!clip.following}>{clip.following ? 'Following' : 'Follow'}</button>;
}

const when = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};
const remains = (t) => {
  const s = (t - Date.now()) / 1000;
  if (s <= 0) return 'ending now';
  return s < 86400 ? Math.max(1, Math.round(s / 3600)) + 'h left' : Math.round(s / 86400) + 'd left';
};

// Creator, Follow, caption and the small print, drawn over the bottom-left of the video (VideoPlayer's `info`).
// `linked` false (the viewer over a chat): the name is plain text, so nothing takes you out of the chat.
export function ClipInfo({ clip, onChange, linked = true }) {
  const who = clip.owner.username || 'Someone';
  const href = `/clips/user/${clip.owner.id}`;
  const ava = <Avatar user={{ ...clip.owner, id: clip.owner.id }} size={36} />;
  return (
    <>
      <div className="vp-info-who">
        {linked ? <a className="vp-info-ava" href={href} aria-label={`${who}'s page`}>{ava}</a> : <span className="vp-info-ava">{ava}</span>}
        {linked ? <a className="vp-info-name" href={href}><b>{who}</b></a> : <span className="vp-info-name"><b>{who}</b></span>}
        <FollowButton clip={clip} onChange={onChange} />
      </div>
      {clip.caption && <p className="vp-info-cap">{clip.caption}</p>}
      <div className="vp-info-meta">{compact(clip.views)} {clip.views === 1 ? 'view' : 'views'} · {when(clip.createdAt)} · {remains(clip.expiresAt)}</div>
    </>
  );
}

// `overlay`: drawn in white over the bottom of the video (see VideoPlayer). Comments and Share open as popups (CommentsSheet, ShareSheet).
export default function ClipActions({ clip, onChange, onGone, overlay }) {
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const latest = useRef(clip);
  latest.current = clip;

  const like = async () => {
    try { const r = await api(`/clips/${clip.id}/like`, { method: 'POST' }); onChange({ ...clip, liked: r.liked, likes: r.likes }); }
    catch (e) { toast(e.message, 'error'); }
  };
  // Each time the share sheet sends the clip somewhere (a friend, a server, copy, the device's own menu) it counts as a share.
  const shared = () => api(`/clips/${clip.id}/share`, { method: 'POST' }).then((r) => onChange({ ...latest.current, shares: r.shares })).catch(() => {});
  const report = async (reason) => {
    setMenu(false);
    try { await api(`/clips/${clip.id}/report`, { method: 'POST', body: { reason } }); toast('Thanks, we will take a look'); }
    catch (e) { toast(e.message, 'error'); }
  };
  const remove = async () => {
    setMenu(false);
    if (!(await askConfirm({ title: 'Remove this clip?', body: 'The video is deleted. Its numbers stay.', confirmLabel: 'Remove', danger: true }))) return;
    try { await api(`/clips/${clip.id}`, { method: 'DELETE' }); onGone(clip.id); } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div className={'ca' + (overlay ? ' ca-overlay' : '')}>
      <div className="ca-bar">
        <button className={'ca-btn' + (clip.liked ? ' on' : '')} onClick={like} aria-pressed={clip.liked} aria-label="Like" title="Like"><HeartIcon on={clip.liked} /><span>{compact(clip.likes)}</span></button>
        <button className={'ca-btn' + (open ? ' open' : '')} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="Comments" title="Comments"><CommentIcon /><span>{compact(clip.comments)}</span></button>
        <button className="ca-btn" onClick={() => setSharing(true)} aria-label="Share" title="Share"><ShareIcon /><span>{compact(clip.shares)}</span></button>
        <span className="ca-views muted">{compact(clip.views)} views</span>
        <span className="ca-grow" />
        <div className="ca-more">
          <button className={'ca-btn ca-icon' + (menu ? ' open' : '')} onClick={() => setMenu(true)} aria-haspopup="dialog" aria-expanded={menu} aria-label="More" title="More"><MoreIcon /></button>
        </div>
      </div>
      {menu && <MoreSheet clip={clip} onClose={() => setMenu(false)} onReport={report} onRemove={remove} />}
      {open && <CommentsSheet clip={clip} onClose={() => setOpen(false)} onTotal={(n) => n !== latest.current.comments && onChange({ ...latest.current, comments: n })} />}
      {sharing && <ShareSheet clip={clip} onClose={() => setSharing(false)} onShared={shared} />}
    </div>
  );
}
