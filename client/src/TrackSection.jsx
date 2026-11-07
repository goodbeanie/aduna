import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './ui.jsx';

// Profile editor: for a song picked from the search, the person chooses which part of its 30 second preview plays on their card.
// Drag the box over the bar (or drag either edge to make it shorter), or use the two sliders; "Listen" plays just that part.
// The part is { start, end } in seconds. A part of 3 seconds or more, inside the preview (server/music.js cleanSection checks it again).
// The preview comes from Apple, which does not let a page read the sound itself, so there is no wave to draw: only the bar.
export const PREVIEW_SECS = 30;
const MIN = 3;
const fmt = (s) => s.toFixed(1) + 's';
const round = (n) => Math.round(n * 10) / 10;

export default function TrackSection({ url, start, end, onChange }) {
  const audio = useRef(null);
  const box = useRef(null);
  const drag = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [head, setHead] = useState(null); // seconds into the preview while the part plays
  const [failed, setFailed] = useState(false);
  const dur = PREVIEW_SECS;

  useEffect(() => {
    setPlaying(false); setHead(null); setFailed(false);
    const a = audio.current;
    return () => { if (a) a.pause(); };
  }, [url]);

  const stop = () => { const a = audio.current; if (a) a.pause(); setPlaying(false); setHead(null); };
  function listen() {
    const a = audio.current;
    if (!a) return;
    if (playing) { stop(); return; }
    a.currentTime = start;
    a.play().then(() => setPlaying(true)).catch(() => setFailed(true));
  }
  const tick = (e) => {
    const a = e.currentTarget;
    if (a.paused) return;
    if (a.currentTime >= end) stop(); else setHead(a.currentTime);
  };

  const secAt = (e) => { const r = box.current.getBoundingClientRect(); return Math.max(0, Math.min(dur, ((e.clientX - r.left) / r.width) * dur)); };
  const down = (e) => {
    stop();
    const t = secAt(e), r = box.current.getBoundingClientRect(), grab = (dur / r.width) * 14; // a 14 px zone around each edge
    let mode = 'move', off = t - start;
    if (Math.abs(t - start) <= grab) mode = 'a';
    else if (Math.abs(t - end) <= grab) mode = 'b';
    else if (t < start || t > end) { // a click outside the box puts the box there
      const len = end - start, a = Math.max(0, Math.min(dur - len, t - len / 2));
      onChange({ start: round(a), end: round(a + len) }); off = len / 2;
    }
    drag.current = { mode, off };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const t = secAt(e);
    if (d.mode === 'move') { const len = end - start, a = Math.max(0, Math.min(dur - len, t - d.off)); onChange({ start: round(a), end: round(a + len) }); }
    else if (d.mode === 'a') onChange({ start: round(Math.max(0, Math.min(t, end - MIN))), end });
    else onChange({ start, end: round(Math.min(dur, Math.max(t, start + MIN))) });
  };
  const up = () => { drag.current = null; };

  const pct = (s) => (s / dur) * 100 + '%';
  const whole = start <= 0.05 && end >= dur - 0.05;
  return (
    <div className="sb-trim">
      <p className="small">Choose the part of the preview that plays on your profile: drag the box, or drag its edges to make it shorter (at least {MIN} seconds).</p>
      <div className="sb-trim-wave slim" ref={box} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="sb-trim-dim" style={{ left: 0, width: pct(start) }} />
        <div className="sb-trim-dim" style={{ left: pct(end), right: 0 }} />
        <div className="sb-trim-win" style={{ left: pct(start), width: pct(end - start) }}><i className="sb-trim-h l" /><i className="sb-trim-h r" /></div>
        {head !== null && <div className="sb-trim-head" style={{ left: pct(head) }} />}
      </div>
      <div className="sb-trim-info small">
        <span>{fmt(start)} to {fmt(end)}</span>
        <b>{fmt(end - start)}</b>
      </div>
      <label className="sb-trim-slide small muted">Start
        <input type="range" min="0" max={round(end - MIN)} step="0.1" value={start} aria-label="Where the part starts" onChange={(e) => { stop(); onChange({ start: Number(e.target.value), end }); }} />
      </label>
      <label className="sb-trim-slide small muted">End
        <input type="range" min={round(start + MIN)} max={dur} step="0.1" value={end} aria-label="Where the part ends" onChange={(e) => { stop(); onChange({ start, end: Number(e.target.value) }); }} />
      </label>
      <div className="sb-trim-actions">
        <button type="button" className="btn" disabled={failed} onClick={listen}><Icon name={playing ? 'pause' : 'play'} size={16} /> {playing ? 'Stop' : 'Listen'}</button>
        {!whole && <button type="button" className="btn ghost" onClick={() => { stop(); onChange({ start: 0, end: dur }); }}>Whole preview</button>}
      </div>
      {failed && <div className="error" role="alert">This song could not be played</div>}
      <audio ref={audio} src={url} preload="none" onTimeUpdate={tick} onEnded={stop} onError={() => setFailed(true)} />
    </div>
  );
}
