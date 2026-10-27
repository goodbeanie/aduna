import React, { useEffect, useRef, useState } from 'react';
import './videoplayer.css';

// The clip player. There are no browser controls: tap (or click) the video to pause and play, double-tap to like (`onDoubleLike`), a thin
// bar along the bottom shows the position (drag it to skip), and a small button mutes.
//  - `children` are drawn over the bottom of the video (the like / comment / share row; on a wide screen it moves to a column beside it).
//  - `info` is the creator and caption, drawn over the bottom-left of the video on a wide screen.
//  - autoPlay: start as soon as the video is ready (a clip's own page). inView: play while it is on screen and pause when it scrolls away (the feed).
// It never just spins forever: "Loading…" while the file starts, and if the file errors or nothing arrives within 20 seconds it says so
// and offers Try again (which asks for the file again).
const PlayGlyph = () => <svg width="28" height="28" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l11-6.5a1 1 0 0 0 0-1.7l-11-6.5A1 1 0 0 0 8 5.5z" /></svg>;
const SoundGlyph = ({ off }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="#fff" />
    {off ? <path d="M16 9.5l5 5M21 9.5l-5 5" /> : <><path d="M15.5 9a4 4 0 0 1 0 6" /><path d="M18 6.5a8 8 0 0 1 0 11" /></>}
  </svg>
);
const BurstHeart = () => <svg width="96" height="96" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.4C1.5 7.8 3.7 4.5 7 4.5c2 0 3.5 1.1 5 3 1.5-1.9 3-3 5-3 3.3 0 5.5 3.3 4.3 6.6-1.8 4.8-9.3 9.4-9.3 9.4z" /></svg>;

export function VideoPlayer({ src, poster, ratio = 9 / 16, autoPlay, inView, onPlay, onDoubleLike, info, children }) {
  const box = useRef(null);
  const inner = useRef(null);
  const vid = useRef(null);
  const bar = useRef(null);
  const drag = useRef(false);
  const autoTried = useRef(false);
  const tap = useRef(0);
  const [status, setStatus] = useState(src ? 'loading' : 'error'); // 'loading' | 'ready' | 'error'
  const [tries, setTries] = useState(0);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [pos, setPos] = useState(0);
  const [burst, setBurst] = useState(null); // the heart that pops up where you double-tapped

  useEffect(() => {
    autoTried.current = false;
    if (!src) { setStatus('error'); return undefined; }
    setStatus('loading');
    const t = setTimeout(() => setStatus((s) => (s === 'loading' ? 'error' : s)), 20000);
    return () => clearTimeout(t);
  }, [src, tries]);
  const url = src && tries ? src + (src.includes('?') ? '&' : '?') + 'r=' + tries : src;

  useEffect(() => {
    if (!inView || !box.current || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(([en]) => {
      const v = vid.current;
      if (!v) return;
      if (en.isIntersecting && en.intersectionRatio >= 0.6) v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
      else v.pause();
    }, { threshold: [0, 0.6] });
    io.observe(box.current);
    return () => io.disconnect();
  }, [inView]);

  useEffect(() => () => clearTimeout(tap.current), []);
  useEffect(() => {
    if (!burst) return undefined;
    const t = setTimeout(() => setBurst(null), 800);
    return () => clearTimeout(t);
  }, [burst]);

  const ready = () => setStatus('ready');
  // Autoplay: try with sound first; browsers sometimes refuse, then it plays muted (the sound button turns it on).
  const startAuto = () => {
    const v = vid.current;
    if (!v || !autoPlay || autoTried.current) return;
    autoTried.current = true;
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  };
  const toggle = () => {
    const v = vid.current;
    if (!v || status === 'error') return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };
  // One click pauses / plays (after a short wait, to see whether a second click follows); two clicks in a row like the clip instead.
  const onTap = (e) => {
    if (!onDoubleLike) return toggle();
    if (tap.current) {
      clearTimeout(tap.current); tap.current = 0;
      const r = inner.current.getBoundingClientRect();
      setBurst({ x: e.clientX - r.left, y: e.clientY - r.top, id: Date.now() });
      onDoubleLike();
      return undefined;
    }
    tap.current = setTimeout(() => { tap.current = 0; toggle(); }, 250);
    return undefined;
  };
  const seekTo = (e) => {
    const v = vid.current, el = bar.current;
    if (!v || !el || !v.duration) return;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    v.currentTime = f * v.duration;
    setPos(f);
  };

  return (
    <div className="vp" ref={box} style={{ '--ratio': String(ratio) }}>
      <div className="vp-inner" ref={inner}>
        <video
          key={tries} ref={vid} className="vp-video" src={url} poster={poster} loop playsInline preload="metadata"
          onLoadedMetadata={ready} onCanPlay={ready} onPlaying={ready}
          onLoadedData={() => { ready(); startAuto(); }}
          onPlay={(e) => { setPaused(false); if (onPlay) onPlay(e); }}
          onPause={() => setPaused(true)}
          onTimeUpdate={(e) => { const v = e.currentTarget; if (!drag.current && v.duration) setPos(v.currentTime / v.duration); }}
          onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
          onError={() => setStatus('error')}
        />
        <button type="button" className="vp-tap" onClick={onTap} aria-label={paused ? 'Play video' : 'Pause video'} />
        {paused && status === 'ready' && <span className="vp-bigplay" aria-hidden="true"><PlayGlyph /></span>}
        <div className="vp-shade" aria-hidden="true" />
        <button type="button" className="vp-mute" onClick={() => { const v = vid.current; if (v) v.muted = !v.muted; }} aria-label={muted ? 'Turn sound on' : 'Turn sound off'} title={muted ? 'Sound off' : 'Sound on'}><SoundGlyph off={muted} /></button>
        {info && <div className="vp-info">{info}</div>}
        <div
          className="vp-seek" ref={bar} role="slider" aria-label="Position in the video" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pos * 100)}
          onPointerDown={(e) => { drag.current = true; e.currentTarget.setPointerCapture(e.pointerId); seekTo(e); }}
          onPointerMove={(e) => { if (drag.current) seekTo(e); }}
          onPointerUp={() => { drag.current = false; }} onPointerCancel={() => { drag.current = false; }}
        ><i style={{ width: pos * 100 + '%' }} /></div>
        {burst && <span key={burst.id} className="vp-burst" style={{ left: burst.x, top: burst.y }} aria-hidden="true"><BurstHeart /></span>}
        {status === 'loading' && <div className="vp-msg" role="status"><span>Loading…</span></div>}
        {status === 'error' && (
          <div className="vp-msg vp-err" role="alert">
            <span>This video could not be loaded.</span>
            <button type="button" className="btn" onClick={() => setTries((n) => n + 1)}>Try again</button>
          </div>
        )}
      </div>
      {children && <div className="vp-bottom">{children}</div>}
    </div>
  );
}

export default VideoPlayer;
