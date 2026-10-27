import React, { useEffect, useRef, useState } from 'react';
import './videoplayer.css';

// The clip player. There are no browser controls: tap (or click) the video to pause and play, a thin bar along the bottom shows the
// position (drag it to skip), and a small button mutes. `children` are drawn over the bottom of the video (the like / comment / share row).
// It never just spins forever: "Loading…" while the file starts, and if the file errors or nothing arrives within 20 seconds it says so
// and offers Try again (which asks for the file again).
const PlayGlyph = () => <svg width="28" height="28" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l11-6.5a1 1 0 0 0 0-1.7l-11-6.5A1 1 0 0 0 8 5.5z" /></svg>;
const SoundGlyph = ({ off }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 9.500v5h3.500L12 18.500v-13L7.500 9.500H4z" fill="#fff" />
    {off ? <path d="M16 9.500l5 5M21 9.500l-5 5" /> : <><path d="M15.500 9a4 4 0 0 1 0 6" /><path d="M18 6.500a8 8 0 0 1 0 11" /></>}
  </svg>
);

// autoPlay: start as soon as the video is ready (a clip's own page). inView: play while it is on screen and pause when it scrolls away (the feed).
export function VideoPlayer({ src, poster, ratio = 9 / 16, autoPlay, inView, onPlay, children }) {
  const box = useRef(null);
  const vid = useRef(null);
  const bar = useRef(null);
  const drag = useRef(false);
  const autoTried = useRef(false);
  const [status, setStatus] = useState(src ? 'loading' : 'error'); // 'loading' | 'ready' | 'error'
  const [tries, setTries] = useState(0);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [pos, setPos] = useState(0);

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
      <button type="button" className="vp-tap" onClick={toggle} aria-label={paused ? 'Play video' : 'Pause video'} />
      {paused && status === 'ready' && <span className="vp-big" aria-hidden="true"><PlayGlyph /></span>}
      <div className="vp-shade" aria-hidden="true" />
      <button type="button" className="vp-mute" onClick={() => { const v = vid.current; if (v) v.muted = !v.muted; }} aria-label={muted ? 'Turn sound on' : 'Turn sound off'} title={muted ? 'Sound off' : 'Sound on'}><SoundGlyph off={muted} /></button>
      {children && <div className="vp-bottom">{children}</div>}
      <div
        className="vp-seek" ref={bar} role="slider" aria-label="Position in the video" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pos * 100)}
        onPointerDown={(e) => { drag.current = true; e.currentTarget.setPointerCapture(e.pointerId); seekTo(e); }}
        onPointerMove={(e) => { if (drag.current) seekTo(e); }}
        onPointerUp={() => { drag.current = false; }} onPointerCancel={() => { drag.current = false; }}
      ><i style={{ width: pos * 100 + '%' }} /></div>
      {status === 'loading' && <div className="vp-msg" role="status"><span>Loading…</span></div>}
      {status === 'error' && (
        <div className="vp-msg vp-err" role="alert">
          <span>This video could not be loaded.</span>
          <button type="button" className="btn" onClick={() => setTries((n) => n + 1)}>Try again</button>
        </div>
      )}
    </div>
  );
}

export default VideoPlayer;
