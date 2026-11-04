import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon } from './ui.jsx';

// "Search for a song" in the profile editor: type a title or an artist, hear a 30 second preview of any result, press Use on the one you want.
// The search runs on the server (GET /api/music/search, see server/music.js); the browser only keeps the track id it sends back when you save.
export default function SongPicker({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const [tracks, setTracks] = useState([]);
  const [state, setState] = useState('idle'); // idle | busy | done | error
  const [playing, setPlaying] = useState(0); // track id of the preview that is playing
  const audio = useRef(null);

  useEffect(() => () => { audio.current?.pause(); }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setTracks([]); setState('idle'); return undefined; }
    let live = true;
    setState('busy');
    const timer = setTimeout(async () => {
      try { const r = await api('/music/search?q=' + encodeURIComponent(term)); if (live) { setTracks(r.tracks || []); setState('done'); } }
      catch { if (live) setState('error'); }
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [q]);

  function preview(t) {
    const a = audio.current;
    if (!a) return;
    if (playing === t.tid) { a.pause(); setPlaying(0); return; }
    a.src = t.preview;
    a.play().then(() => setPlaying(t.tid)).catch(() => setPlaying(0));
  }
  function use(t) { audio.current?.pause(); setPlaying(0); onPick(t); }
  const close = () => { audio.current?.pause(); onClose(); };

  return (
    <div className="gp-box">
      <div className="gp-search">
        <Icon name="search" size={16} />
        <input value={q} maxLength={80} placeholder="Song or artist" aria-label="Search for a song" autoFocus autoCapitalize="none" autoCorrect="off" spellCheck={false}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } else if (e.key === 'Enter') e.preventDefault(); }} />
      </div>
      {tracks.length > 0 && (
        <ul className="gp-list" aria-label="Songs">
          {tracks.map((t) => (
            <li key={t.tid} className="sp-row">
              <span className="sp-cover">{t.art ? <img src={t.art} alt="" loading="lazy" draggable={false} /> : <Icon name="music" size={18} />}</span>
              <span className="sp-meta"><b>{t.title}</b><span>{t.artist}</span></span>
              <button type="button" className="psong-btn" aria-pressed={playing === t.tid} aria-label={(playing === t.tid ? 'Pause ' : 'Play ') + t.title} title={playing === t.tid ? 'Pause' : 'Play a preview'} onClick={() => preview(t)}>
                <Icon name={playing === t.tid ? 'pause' : 'play'} size={16} />
              </button>
              <button type="button" className="btn" onClick={() => use(t)}>Use</button>
            </li>
          ))}
        </ul>
      )}
      {state === 'busy' && <p className="gp-note muted" role="status">Searching...</p>}
      {state === 'error' && <p className="gp-note muted" role="status">Song search is not available right now. Try again in a moment.</p>}
      {state === 'done' && !tracks.length && <p className="gp-note muted" role="status">No songs found. Try the artist name too.</p>}
      {state === 'idle' && <p className="gp-note muted">Type at least two letters.</p>}
      <div className="gp-foot"><span className="muted small">Previews are 30 seconds.</span><button type="button" className="btn" onClick={close}>Cancel</button></div>
      <audio ref={audio} preload="none" onEnded={() => setPlaying(0)} onError={() => setPlaying(0)} />
    </div>
  );
}
