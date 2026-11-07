import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './ui.jsx';
import { SOUND } from './soundboard.js';
import { decodeSound, peaksOf, clipToWav } from './soundtrim.js';

// Shown in Server settings > Soundboard when the chosen audio is longer than a sound can be (or too heavy). The person sees the wave, moves a window of
// up to SOUND.secs seconds over it (drag the middle, or either edge to make it shorter), listens to just that part, and "Use this part" hands a small
// WAV of it back to the form (soundtrim.js does the cutting). Nothing is uploaded here.
const MIN = 0.1;
const fmt = (s) => s.toFixed(1) + 's';

export function SoundTrim({ file, onUse, onCancel, onWhole, maxSecs = SOUND.secs, maxBytes = SOUND.bytes, noun = 'sound' }) {
  const [buf, setBuf] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState({ a: 0, b: 0 });
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [head, setHead] = useState(null); // seconds into the sound while the selection plays
  const peaks = useRef(null);
  const box = useRef(null);
  const canvas = useRef(null);
  const play = useRef(null); // { ctx, src, raf } while playing
  const drag = useRef(null);

  useEffect(() => {
    let dead = false;
    decodeSound(file).then((b) => {
      if (dead) return;
      peaks.current = peaksOf(b);
      setSel({ a: 0, b: Math.min(b.duration, maxSecs) });
      setBuf(b);
    }).catch((e) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, [file]);

  useEffect(() => {
    const c = canvas.current;
    if (!buf || !c) return undefined;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      const g = c.getContext('2d');
      g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
      g.fillStyle = getComputedStyle(c).color;
      const p = peaks.current;
      let max = 0.01; for (let i = 0; i < p.length; i++) if (p[i] > max) max = p[i];
      const bw = w / p.length;
      for (let i = 0; i < p.length; i++) { const bh = Math.max(1, (p[i] / max) * (h - 6)); g.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 1), bh); }
    };
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [buf]);

  const stop = () => {
    const p = play.current; play.current = null;
    if (!p) return;
    cancelAnimationFrame(p.raf); p.src.onended = null;
    try { p.src.stop(); } catch { /* already stopped */ }
    try { p.ctx.close(); } catch { /* already closed */ }
    setPlaying(false); setHead(null);
  };
  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () => {
    stop();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !buf) return;
    const ctx = new Ctx(), src = ctx.createBufferSource(), len = sel.b - sel.a, t0 = ctx.currentTime;
    src.buffer = buf; src.connect(ctx.destination);
    const p = (play.current = { ctx, src, raf: 0 });
    src.onended = () => { if (play.current === p) stop(); };
    src.start(0, sel.a, len);
    const tick = () => { if (play.current !== p) return; const t = ctx.currentTime - t0; if (t >= len) { stop(); return; } setHead(sel.a + t); p.raf = requestAnimationFrame(tick); };
    p.raf = requestAnimationFrame(tick);
    setPlaying(true);
  };

  const secAt = (e) => { const r = box.current.getBoundingClientRect(); return Math.max(0, Math.min(buf.duration, ((e.clientX - r.left) / r.width) * buf.duration)); };
  const down = (e) => {
    if (!buf || busy) return;
    stop();
    const t = secAt(e), r = box.current.getBoundingClientRect(), grab = (buf.duration / r.width) * 14; // a 14 px zone around each edge
    let mode = 'move', off = t - sel.a;
    if (Math.abs(t - sel.a) <= grab) mode = 'a';
    else if (Math.abs(t - sel.b) <= grab) mode = 'b';
    else if (t < sel.a || t > sel.b) { // a click outside the window puts the window there
      const len = sel.b - sel.a, a = Math.max(0, Math.min(buf.duration - len, t - len / 2));
      setSel({ a, b: a + len }); off = len / 2;
    }
    drag.current = { mode, off };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d || !buf) return;
    const t = secAt(e), dur = buf.duration;
    setSel((s) => {
      if (d.mode === 'move') { const len = s.b - s.a, a = Math.max(0, Math.min(dur - len, t - d.off)); return { a, b: a + len }; }
      if (d.mode === 'a') return { a: Math.max(s.b - maxSecs, Math.max(0, Math.min(t, s.b - MIN))), b: s.b };
      return { a: s.a, b: Math.min(s.a + maxSecs, Math.max(s.a + MIN, Math.min(t, dur))) };
    });
  };
  const up = () => { drag.current = null; };

  const slide = (v) => { stop(); setSel((s) => { const len = s.b - s.a, a = Math.max(0, Math.min(buf.duration - len, v)); return { a, b: a + len }; }); };

  async function use() {
    stop(); setBusy(true); setErr('');
    try { onUse(await clipToWav(buf, sel.a, sel.b, file.name, { maxSecs, maxBytes })); }
    catch { setErr('Could not cut that part. Try another file.'); setBusy(false); }
  }

  if (err && !buf) return <div className="sb-trim"><div className="error" role="alert">{err}</div>{onWhole && <button type="button" className="btn" onClick={onWhole}>Use all of it</button>} <button type="button" className="btn" onClick={onCancel}>Cancel</button></div>;
  if (!buf) return <div className="sb-trim"><p className="muted small">Reading the audio…</p></div>;

  const dur = buf.duration, len = sel.b - sel.a, pct = (s) => (s / dur) * 100 + '%';
  return (
    <div className="sb-trim">
      <p className="small">
        {dur > maxSecs + 0.5
          ? <>This {noun} is {fmt(dur)} long, and a {noun} can be up to {maxSecs} seconds. Choose the part to use: drag the box, or drag its edges to make it shorter.</>
          : onWhole
            ? <>Choose the part of this {noun} to use: drag the box, or drag its edges to make it shorter. Or keep all of it.</>
            : <>This file is too big as it is, so it will be made smaller. You can also cut it shorter: drag the edges of the box.</>}
      </p>
      <div className="sb-trim-wave" ref={box} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <canvas ref={canvas} className="sb-trim-canvas" aria-hidden="true" />
        <div className="sb-trim-dim" style={{ left: 0, width: pct(sel.a) }} />
        <div className="sb-trim-dim" style={{ left: pct(sel.b), right: 0 }} />
        <div className="sb-trim-win" style={{ left: pct(sel.a), width: pct(len) }}><i className="sb-trim-h l" /><i className="sb-trim-h r" /></div>
        {head !== null && <div className="sb-trim-head" style={{ left: pct(head) }} />}
      </div>
      <div className="sb-trim-info small">
        <span>{fmt(sel.a)} to {fmt(sel.b)}</span>
        <b>{fmt(len)}</b>
      </div>
      {dur > len + 0.05 && (
        <label className="sb-trim-slide small muted">Start
          <input type="range" min="0" max={Math.max(0, dur - len)} step="0.05" value={sel.a} onChange={(e) => slide(Number(e.target.value))} aria-label="Where the part starts" />
        </label>
      )}
      <div className="sb-trim-actions">
        <button type="button" className="btn" disabled={busy} onClick={playing ? stop : start}><Icon name={playing ? 'pause' : 'play'} size={16} /> {playing ? 'Stop' : 'Listen'}</button>
        <button type="button" className="btn primary" disabled={busy} onClick={use}>{busy ? 'Cutting…' : 'Use this part'}</button>
        {onWhole && <button type="button" className="btn" disabled={busy} onClick={() => { stop(); onWhole(); }}>Use all of it</button>}
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {err && <div className="error" role="alert">{err}</div>}
    </div>
  );
}
