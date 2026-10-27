import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Avatar } from './ui.jsx';
import { toast, askConfirm } from './Dialogs.jsx';
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
      <div className="ca-write">
        <input value={text} maxLength={300} placeholder="Add a comment…" disabled={busy} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
        <button className="ca-send" disabled={busy || !text.trim()} onClick={send}>Post</button>
      </div>
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

export default function ClipActions({ clip, onChange, onGone }) {
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    if (!menu) return undefined;
    const off = (e) => { if (box.current && !box.current.contains(e.target)) setMenu(false); };
    const esc = (e) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', off); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [menu]);

  const like = async () => {
    try { const r = await api(`/clips/${clip.id}/like`, { method: 'POST' }); onChange({ ...clip, liked: r.liked, likes: r.likes }); }
    catch (e) { toast(e.message, 'error'); }
  };
  const share = async () => {
    const link = `${location.origin}/clips/${clip.id}`;
    let sent = false;
    try {
      if (navigator.share) { await navigator.share({ url: link, title: clip.caption || 'A clip on Aduna' }); sent = true; }
      else { await navigator.clipboard.writeText(link); toast('Link copied'); sent = true; }
    } catch (e) { if (e && e.name !== 'AbortError') { toast(link); sent = true; } }
    if (sent) api(`/clips/${clip.id}/share`, { method: 'POST' }).then((r) => onChange({ ...clip, shares: r.shares })).catch(() => {});
  };
  const report = async (reason) => {
    setReporting(false);
    try { await api(`/clips/${clip.id}/report`, { method: 'POST', body: { reason } }); toast('Thanks, we will take a look'); }
    catch (e) { toast(e.message, 'error'); }
  };
  const remove = async () => {
    setMenu(false);
    if (!(await askConfirm({ title: 'Remove this clip?', body: 'The video is deleted. Its numbers stay.', confirmLabel: 'Remove', danger: true }))) return;
    try { await api(`/clips/${clip.id}`, { method: 'DELETE' }); onGone(clip.id); } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div className="ca">
      <div className="ca-bar">
        <button className={'ca-btn' + (clip.liked ? ' on' : '')} onClick={like} aria-pressed={clip.liked} aria-label="Like" title="Like"><HeartIcon on={clip.liked} /><span>{compact(clip.likes)}</span></button>
        <button className={'ca-btn' + (open ? ' open' : '')} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="Comments" title="Comments"><CommentIcon /><span>{compact(clip.comments)}</span></button>
        <button className="ca-btn" onClick={share} aria-label="Share" title="Share"><ShareIcon /><span>{compact(clip.shares)}</span></button>
        <span className="ca-views muted">{compact(clip.views)} views</span>
        <span className="ca-grow" />
        <div className="ca-more" ref={box}>
          <button className="ca-btn ca-icon" onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu} aria-label="More" title="More"><MoreIcon /></button>
          {menu && (
            <div className="ca-menu" role="menu">
              <div className="ca-stats">
                <div><b>{exact(clip.views)}</b><span>Views</span></div>
                <div><b>{exact(clip.likes)}</b><span>Likes</span></div>
                <div><b>{exact(clip.comments)}</b><span>Comments</span></div>
                <div><b>{exact(clip.shares)}</b><span>Shares</span></div>
              </div>
              <div className="ca-followers muted">{exact(clip.owner.followers)} {clip.owner.followers === 1 ? 'follower' : 'followers'} · {clip.owner.username || 'this creator'}</div>
              <a role="menuitem" className="ca-item" href={`/clips/${clip.id}`} target="_blank" rel="noopener">Open clip page</a>
              {clip.mine
                ? <button role="menuitem" className="ca-item danger" onClick={remove}>Remove clip</button>
                : <button role="menuitem" className="ca-item" onClick={() => { setMenu(false); setReporting(true); }}>Report</button>}
            </div>
          )}
        </div>
      </div>
      {reporting && (
        <div className="ca-report">
          <span className="muted">Why are you reporting this?</span>
          {REASONS.map(([id, label]) => <button key={id} className="ca-pill" onClick={() => report(id)}>{label}</button>)}
          <button className="ca-pill" onClick={() => setReporting(false)}>Cancel</button>
        </div>
      )}
      {open && <Comments clip={clip} onTotal={(n) => n !== clip.comments && onChange({ ...clip, comments: n })} />}
    </div>
  );
}
