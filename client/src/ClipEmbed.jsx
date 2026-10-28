import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';
import { Avatar, Icon } from './ui.jsx';
import ClipActions, { ClipInfo, useDoubleLike } from './ClipActions.jsx';
import { VideoPlayer } from './VideoPlayer.jsx';
import './clipembed.css';

// A clip link shared in a chat (https://<this site>/clips/<id>) is drawn as a card: the video's cover picture with a play button.
// Clicking it opens the video right here in the same tab, over the chat, with a Back to chat button; the chat is untouched underneath.
const LINK_RE = /https?:\/\/([^\s/<>]+)\/clips\/([a-f0-9]{16})(?![A-Za-z0-9_-])/gi;

// Clip ids in a piece of message text (at most 3), only for links to this site, so each can be drawn as a card.
export function clipIdsIn(text) {
  const out = [];
  if (!text) return out;
  const hosts = new Set([location.host.toLowerCase(), 'aduna.onrender.com']);
  for (const m of String(text).matchAll(LINK_RE)) {
    if (!hosts.has(m[1].toLowerCase())) continue;
    const id = m[2].toLowerCase();
    if (!out.includes(id)) out.push(id);
    if (out.length >= 3) break;
  }
  return out;
}

// True when the message is nothing but one clip link: the card says it all, so the bare link is not repeated above it.
export function isOnlyClipLink(text) {
  const t = String(text || '').trim();
  const ids = clipIdsIn(t);
  return ids.length === 1 && t.replace(LINK_RE, '').trim() === '';
}

const cache = new Map(); // id -> clip, or null when it is gone

const PlayBadge = () => (
  <span className="ce-play" aria-hidden="true">
    <svg width="34" height="34" viewBox="0 0 24 24" fill="#fff" stroke="#fff" strokeWidth="2" strokeLinejoin="round"><path d="M6.5 5.5v13L17.5 12z" /></svg>
  </span>
);

export function ClipEmbed({ id }) {
  const [clip, setClip] = useState(() => cache.get(id));
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (cache.has(id)) { setClip(cache.get(id)); return undefined; }
    let live = true;
    api('/clips/' + encodeURIComponent(id))
      .then((r) => { cache.set(id, r.clip); if (live) setClip(r.clip); })
      .catch((e) => { if (e.status === 404) { cache.set(id, null); if (live) setClip(null); } });
    return () => { live = false; };
  }, [id]);

  if (clip === null) return <div className="clip-embed gone"><div className="ce-gone"><b>Clip</b><span className="muted">This clip is gone. Clips are removed after a few days.</span></div></div>;
  if (!clip) return <div className="clip-embed loading" aria-busy="true"><div className="ce-thumb" /></div>;

  const ratio = clip.width && clip.height ? clip.width / clip.height : 9 / 16;
  const who = clip.owner.username || 'Someone';
  return (
    <>
      <button type="button" className="clip-embed" onClick={() => setOpen(true)} aria-label={`Play clip by ${who}`}>
        <span className="ce-thumb" style={{ '--ratio': String(ratio) }}>
          {clip.poster && <img src={clip.poster} alt="" loading="lazy" draggable="false" />}
          <PlayBadge />
        </span>
        <span className="ce-meta">
          <Avatar user={{ ...clip.owner, id: clip.owner.id }} size={22} />
          <span className="ce-text"><b>{who}</b>{clip.caption && <span className="ce-cap">{clip.caption}</span>}</span>
        </span>
      </button>
      {open && <ClipViewer clip={clip} onClose={() => setOpen(false)} onChange={(c) => { cache.set(id, c); setClip(c); }} />}
    </>
  );
}

// The video over the chat. Same player as everywhere else (tap to pause, double-tap to like, like / comment / share on the right).
function ClipViewer({ clip, onChange, onClose }) {
  const counted = useRef(false);
  const doubleLike = useDoubleLike(clip, onChange);
  const back = useRef(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const was = document.activeElement;
    back.current?.focus();
    const esc = (e) => { if (e.key === 'Escape' && !document.querySelector('.ss-back')) onClose(); };
    document.addEventListener('keydown', esc);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', esc); document.body.style.overflow = overflow; if (was && was.focus) was.focus(); };
  }, [onClose]);

  const play = () => {
    if (counted.current) return;
    counted.current = true;
    api(`/clips/${clip.id}/view`, { method: 'POST' }).then((r) => onChange({ ...clip, views: r.views })).catch(() => {});
  };
  const ratio = clip.width && clip.height ? clip.width / clip.height : 9 / 16;

  return createPortal(
    <div className="cv-back" role="dialog" aria-modal="true" aria-label="Clip" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <button ref={back} type="button" className="cv-exit" onClick={onClose}><Icon name="back" size={18} /> Back to chat</button>
      <div className="cv-stage">
        {gone
          ? <div className="cv-gone"><b>This clip is gone</b><span>It was removed.</span><button type="button" className="btn" onClick={onClose}>Back to chat</button></div>
          : (
            <VideoPlayer ratio={ratio} src={clip.url} poster={clip.poster} autoPlay onPlay={play} onDoubleLike={doubleLike} info={<ClipInfo clip={clip} onChange={onChange} linked={false} />}>
              <ClipActions overlay clip={clip} onChange={onChange} onGone={() => setGone(true)} />
            </VideoPlayer>
          )}
      </div>
    </div>,
    document.body,
  );
}

export default ClipEmbed;
