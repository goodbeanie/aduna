import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Avatar } from './ui.jsx';
import { compact } from './ClipActions.jsx';
import './clipsearch.css';

// The search on the Clips website: a full-screen panel opened by the magnifier in the top bar. Type a name or a few words of a caption;
// creators and clips that match are listed as you type. A creator opens their page, a clip opens its own page.
export const SearchIcon = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.800-3.800" />
  </svg>
);

export default function ClipSearch({ onClose }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null); // null until something has been searched; then { creators, clips }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const input = useRef(null);
  const seq = useRef(0);

  useEffect(() => {
    if (input.current) input.current.focus();
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  // search a moment after typing stops; an answer for an older word is thrown away
  useEffect(() => {
    const t = q.trim();
    const n = ++seq.current;
    if (!t) { setRes(null); setBusy(false); setErr(''); return undefined; }
    setBusy(true);
    const timer = setTimeout(() => {
      api('/clips/search?q=' + encodeURIComponent(t))
        .then((r) => { if (n === seq.current) { setRes(r); setErr(''); setBusy(false); } })
        .catch((e) => { if (n === seq.current) { setErr(e.message || 'Search did not work. Try again.'); setBusy(false); } });
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  const none = res && !res.creators.length && !res.clips.length;
  return (
    <div className="sp" role="dialog" aria-modal="true" aria-label="Search Clips">
      <div className="sp-bar">
        <button type="button" className="sp-back" onClick={onClose} aria-label="Close search">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <label className="sp-field">
          <SearchIcon size={18} />
          <input ref={input} type="search" value={q} maxLength={60} placeholder="Search creators and clips" enterKeyHint="search" autoComplete="off" autoCorrect="off" spellCheck="false" onChange={(e) => setQ(e.target.value)} />
          {q && <button type="button" className="sp-clear" onClick={() => { setQ(''); if (input.current) input.current.focus(); }} aria-label="Clear">✕</button>}
        </label>
      </div>

      <div className="sp-body">
        {err && <p className="sp-note sp-err" role="alert">{err}</p>}
        {!err && !res && <p className="sp-note">{busy ? 'Searching…' : 'Find creators by name, and clips by what is in their caption.'}</p>}
        {!err && none && !busy && <p className="sp-note">Nothing matches “{q.trim()}”.</p>}

        {!err && res && res.creators.length > 0 && (
          <section className="sp-sec">
            <h2>Creators</h2>
            <div className="sp-people">
              {res.creators.map((u) => (
                <a key={u.id} className="sp-person" href={`/clips/user/${u.id}`}>
                  <Avatar user={{ id: u.id, username: u.username, avatarImage: u.avatarImage }} size={48} />
                  <span className="sp-person-text">
                    <b>{u.username || 'Someone'}{u.mine ? ' (you)' : ''}</b>
                    <span>{compact(u.followers)} {u.followers === 1 ? 'follower' : 'followers'} · {u.clips} {u.clips === 1 ? 'clip' : 'clips'}</span>
                  </span>
                  {u.following && <span className="sp-tag">Following</span>}
                </a>
              ))}
            </div>
          </section>
        )}

        {!err && res && res.clips.length > 0 && (
          <section className="sp-sec">
            <h2>Clips</h2>
            <div className="sp-grid">
              {res.clips.map((c) => (
                <a key={c.id} className="sp-clip" href={`/clips/${c.id}`}>
                  <img src={c.poster} alt="" loading="lazy" draggable="false" />
                  <span className="sp-clip-info">
                    {c.caption && <span className="sp-clip-cap">{c.caption}</span>}
                    <span className="sp-clip-by">{c.owner.username || 'Someone'} · {compact(c.views)} {c.views === 1 ? 'view' : 'views'}</span>
                  </span>
                </a>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
