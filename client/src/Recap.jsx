import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon } from './ui.jsx';
import { useLang } from './i18n.js';
import { useProfileThemes, userTheme, findProfileTheme, lightness } from './profilethemes.js';
import { songUrl } from './ProfileSong.jsx';
import ShareSheet from './ShareSheet.jsx';
import { tossfaceUrl } from './tossface.js';
import { TOTAL_MS, buildScenes, countText, shareText } from './recap.js';

// Settings > Year in review. Two versions with the same six scenes: the global one (same for everyone, painted with the most popular
// profile theme and played over the most popular song) and the person's own (their theme, their profile song). What goes into the scenes,
// and which stat is picked, is in recap.js. The numbers come from GET /api/recap and are counts only.

const DEFAULT_LOOK = { colors: ['#1c1812', '#3b342a', '#c9953a'], angle: 135 };
const BG_POS = ['0% 0%', '100% 0%', '100% 100%', '0% 100%', '50% 50%', '0% 50%']; // the gradient drifts to a new corner each scene
const FADE_IN_MS = 1500, FADE_OUT_MS = 2500;
const gainAt = (t) => Math.max(0, Math.min(1, t / FADE_IN_MS, (TOTAL_MS - t) / FADE_OUT_MS));

// undefined while the request is out, then the whole { year, global, mine } (or null if it failed)
export function useRecap() {
  const [data, setData] = useState(undefined);
  useEffect(() => {
    let live = true;
    api('/recap').then((d) => { if (live) setData(d); }).catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, []);
  return data;
}

const toRgb = (hex) => {
  const n = parseInt(String(hex).slice(1, 7), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [201, 149, 58];
};

// Soft colour blobs drifting behind the text. Where they are depends only on the time, so pausing and replaying always agree.
const BLOBS = Array.from({ length: 9 }, (_, i) => ({ r: 0.22 + ((i * 37) % 10) / 50, px: i * 1.7, py: i * 2.3, sx: 0.6 + (i % 4) * 0.25, sy: 0.5 + (i % 3) * 0.3 }));
function drawBlobs(cv, t, rgbs) {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const w = cv.width, h = cv.height, base = Math.max(w, h);
  ctx.clearRect(0, 0, w, h);
  BLOBS.forEach((b, i) => {
    const x = w * (0.5 + 0.45 * Math.sin(t * 0.00011 * b.sx + b.px)), y = h * (0.5 + 0.45 * Math.cos(t * 0.00009 * b.sy + b.py)), r = base * b.r;
    const white = i % 3 === 2; // every third one is a pale glow so the picture is not all one colour
    const [R, G, B] = white ? [255, 255, 255] : rgbs[i % rgbs.length];
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${R},${G},${B},${white ? 0.12 : 0.4})`);
    g.addColorStop(1, `rgba(${R},${G},${B},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  });
}

const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

// As plain text the emoji came out blank in the recap on some devices, so they are drawn as the same Tossface pictures the rest of Aduna uses.
// One with no picture falls back to the character.
const EMOJI_RE = /(?![©®™])\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*/gu;
function EmojiPic({ e }) {
  const [bad, setBad] = useState(false);
  const src = tossfaceUrl(e);
  if (!src || bad) return <>{e}</>;
  return <img className="rc-emoji" src={src} alt={e} draggable={false} onError={() => setBad(true)} />;
}
function WithEmoji({ text }) {
  const s = String(text ?? '');
  const out = [];
  let at = 0;
  for (const m of s.matchAll(EMOJI_RE)) {
    if (m.index > at) out.push(s.slice(at, m.index));
    out.push(<EmojiPic key={m.index} e={m[0]} />);
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push(s.slice(at));
  return <>{out}</>;
}

function Scene({ s, ms, last, numRef, year }) {
  const m = s.main;
  return (
    <div className={'rc-scene' + (last ? ' last' : '')} data-anchor={s.anchor} style={{ '--sm': ms + 'ms' }}>
      <div className="rc-main">
        {m.logo ? (
          <>
            <span className="rc-logo" role="img" aria-label="Aduna"><i className="rc-mark" /><i className="rc-word" /></span>
            <span className="rc-year">{year}</span>
          </>
        ) : m.count ? <span className="rc-num" ref={numRef} /> : <span className="rc-big"><WithEmoji text={m.text} /></span>}
        {s.unit && <span className="rc-unit">{s.unit}</span>}
      </div>
      {s.sub && <p className="rc-sub"><WithEmoji text={s.sub} /></p>}
    </div>
  );
}

function Player({ scenes, year, kind, look, song }) {
  const n = scenes.length;
  const sceneMs = TOTAL_MS / n;
  const src = song ? songUrl(song) : '';
  // The song plays from its start for the whole video: a search pick is Apple's 30 second preview (the part chosen for the profile card is ignored here),
  // and an uploaded clip is stopped when the video ends.
  // Web Audio goes silent on a sound from another site (the previews come from Apple's servers), so those fade with the element's own volume
  const external = /^https?:\/\//i.test(src) && !src.startsWith(location.origin);
  const [status, setStatus] = useState('idle'); // idle (poster, nothing has played), playing, paused, ended
  const [scene, setScene] = useState(0);
  const [run, setRun] = useState(0); // goes up on every replay so the scene's CSS animations start over
  const [muted, setMuted] = useState(true);
  const [audioBad, setAudioBad] = useState(false);
  const [reduce] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

  const clk = useRef({ t: 0, last: null });
  const raf = useRef(0);
  const sceneRef = useRef(0);
  const rendered = useRef(0); // the scene that is actually on screen (sceneRef runs one render ahead)
  const statusRef = useRef(status); statusRef.current = status;
  const mutedRef = useRef(true);
  const lastShown = useRef('');
  const stage = useRef(null), cv = useRef(null), num = useRef(null), bar = useRef(null), time = useRef(null), audio = useRef(null), graph = useRef(null);
  const rgbs = useMemo(() => look.colors.map(toRgb), [look]);
  const live = useRef({});
  live.current = { scenes, sceneMs, rgbs, reduce };

  // One frame of everything that follows the clock: which scene, the counting number, the progress bar, the blobs and the song's volume.
  const paint = useCallback((t) => {
    const { scenes: sc, sceneMs: sm, rgbs: cols, reduce: still } = live.current;
    const idx = Math.min(sc.length - 1, Math.floor(t / sm));
    if (idx !== sceneRef.current) { sceneRef.current = idx; setScene(idx); }
    const s = sc[idx];
    if (idx === rendered.current && num.current && s.main.count) num.current.textContent = countText(s.main, t - idx * sm, still); // not while the old scene is still on screen
    if (bar.current) bar.current.style.transform = `scaleX(${t / TOTAL_MS})`;
    if (time.current) {
      const txt = `${clock(t)} / ${clock(TOTAL_MS)}`;
      if (txt !== lastShown.current) { lastShown.current = txt; time.current.textContent = txt; }
    }
    if (cv.current) drawBlobs(cv.current, t, cols);
    const v = gainAt(t), g = graph.current;
    if (g && g.gain) g.gain.gain.value = v; else if (audio.current) audio.current.volume = v;
  }, []);

  const finish = useCallback(() => {
    cancelAnimationFrame(raf.current);
    setStatus('ended');
    if (audio.current) audio.current.pause();
    const g = graph.current;
    if (g && g.gain) g.gain.gain.value = 0;
  }, []);

  const loop = useCallback((now) => {
    const c = clk.current;
    const dt = c.last == null ? 0 : Math.min(now - c.last, 200); // a long gap (the tab was asleep) must not skip scenes
    c.last = now;
    c.t = Math.min(TOTAL_MS, c.t + dt);
    paint(c.t);
    if (c.t >= TOTAL_MS) { finish(); return; }
    raf.current = requestAnimationFrame(loop);
  }, [paint, finish]);

  // Web Audio gives a real fade on every browser; iPhones ignore audio.volume, so the element's own volume is only the fallback.
  const ensureGraph = () => {
    const a = audio.current;
    if (!a || graph.current) return;
    if (external) { graph.current = { ctx: null, gain: null }; return; }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      ctx.createMediaElementSource(a).connect(gain).connect(ctx.destination);
      graph.current = { ctx, gain };
    } catch { graph.current = { ctx: null, gain: null }; }
  };
  const startAudio = (t) => {
    const a = audio.current;
    if (!a) return;
    ensureGraph();
    const g = graph.current;
    if (g && g.ctx && g.ctx.state === 'suspended') g.ctx.resume().catch(() => {});
    a.muted = mutedRef.current;
    const at = t / 1000;
    if (Number.isFinite(a.duration) && at >= a.duration) return; // the song is shorter than the video: it is already over
    try { a.currentTime = at; } catch { /* not loaded yet, so it starts from the beginning */ }
    a.play().catch(() => setAudioBad(true));
  };

  const start = (fromStart) => {
    const c = clk.current;
    if (statusRef.current === 'idle') { mutedRef.current = false; setMuted(false); } // pressing play is what lets the song be heard
    if (fromStart || c.t >= TOTAL_MS) { c.t = 0; sceneRef.current = 0; setScene(0); setRun((r) => r + 1); }
    c.last = null;
    setStatus('playing');
    startAudio(c.t);
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(loop);
  };
  const pause = useCallback(() => {
    cancelAnimationFrame(raf.current);
    clk.current.last = null;
    setStatus('paused');
    if (audio.current) audio.current.pause();
  }, []);

  const toggleMute = () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    const a = audio.current;
    if (!a) return;
    a.muted = next;
    if (!next) {
      ensureGraph();
      const g = graph.current;
      if (g && g.ctx && g.ctx.state === 'suspended') g.ctx.resume().catch(() => {});
      if (statusRef.current === 'playing' && a.paused) a.play().catch(() => setAudioBad(true));
    }
  };

  // The count shown the moment a scene appears (the loop takes over on the next frame).
  useLayoutEffect(() => {
    rendered.current = scene;
    const s = scenes[scene];
    if (num.current && s && s.main.count) num.current.textContent = countText(s.main, clk.current.t - scene * sceneMs, reduce || statusRef.current === 'idle');
  }, [scene, run]);

  useEffect(() => { if (audio.current) audio.current.muted = muted; }, [muted, src]);

  // keep the blobs the right size, and drawn while nothing is playing
  useEffect(() => {
    const el = stage.current, c = cv.current;
    if (!el || !c) return undefined;
    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      c.width = Math.max(1, Math.round(el.clientWidth * dpr));
      c.height = Math.max(1, Math.round(el.clientHeight * dpr));
      drawBlobs(c, clk.current.t, live.current.rgbs);
    };
    size();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(size);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rgbs]);

  // leaving the tab or the page stops everything
  useEffect(() => {
    const hide = () => { if (document.hidden && statusRef.current === 'playing') pause(); };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, [pause]);
  useEffect(() => () => {
    cancelAnimationFrame(raf.current);
    if (audio.current) audio.current.pause();
    const g = graph.current;
    if (g && g.ctx) g.ctx.close().catch(() => {});
  }, []);

  const [sharing, setSharing] = useState(false);
  // Counts go into the text and nothing else; nothing is sent anywhere until the person picks where in the sheet.
  const openShare = () => { if (statusRef.current === 'playing') pause(); setSharing(true); };

  const avg = look.colors.reduce((s, c) => s + lightness(c), 0) / look.colors.length;
  const light = avg > 0.4;
  const stageStyle = {
    backgroundImage: `linear-gradient(${look.angle}deg, ${look.colors.join(', ')})`,
    backgroundSize: '240% 240%',
    backgroundPosition: BG_POS[scene % BG_POS.length],
    '--rc-ink': light ? '#14110d' : '#fbf8f1',
    '--rc-inv': light ? '#fbf8f1' : '#14110d',
    '--rc-glow': light ? '255,255,255' : '0,0,0',
  };
  const playing = status === 'playing';

  return (
    <div className="rc">
      <div className="rc-frame">
        <div ref={stage} className={'rc-stage' + (status === 'idle' ? ' idle' : '') + (playing ? '' : ' halted')} style={stageStyle} role="group" aria-label={kind === 'mine' ? `Your ${year} on Aduna` : `Aduna in ${year}`}>
          <canvas ref={cv} className="rc-canvas" aria-hidden="true" />
          <Scene key={scene + ':' + run} s={scenes[scene]} ms={sceneMs} last={scene === n - 1} numRef={num} year={year} />
          {status === 'idle' && <button type="button" className="rc-bigplay" onClick={() => start(false)}><Icon name="play" size={18} /> {src ? 'Play with sound' : 'Play'}</button>}
        </div>
        <div className="rc-bar" aria-hidden="true"><i ref={bar} /></div>
      </div>
      <div className="rc-controls">
        <button type="button" className="btn primary" onClick={() => (playing ? pause() : start(false))}><Icon name={playing ? 'pause' : 'play'} size={16} /> {playing ? 'Pause' : 'Play'}</button>
        <button type="button" className="btn" onClick={() => start(true)}>Replay</button>
        {src && !audioBad && (
          <button type="button" className="icon-btn" onClick={toggleMute} aria-pressed={!muted} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Sound is off' : 'Mute'}>
            <Icon name={muted ? 'speakeroff' : 'speaker'} size={18} />
          </button>
        )}
        <span className="rc-time" ref={time}>{`0:00 / ${clock(TOTAL_MS)}`}</span>
        <span className="rc-spacer" />
        <button type="button" className="btn" onClick={openShare}><Icon name="send" size={16} /> Share</button>
      </div>
      {sharing && (
        <ShareSheet what="recap" link={location.origin} text={shareText(scenes, kind, year)} title={kind === 'mine' ? `My ${year} on Aduna` : `Aduna in ${year}`}
          onClose={() => setSharing(false)} onShared={() => {}} />
      )}
      <p className="hint">
        {kind === 'mine' ? 'Only you can see this. Nothing is shared unless you press Share.' : 'The same for everyone. It only counts things: no messages, names or servers.'}
        {src && !audioBad && <> {status === 'idle' ? 'Sound stays off until you press play.' : ''}<span className="rc-song"> <Icon name="music" size={13} className="inline-icon" /> {String(song.title || 'Song').slice(0, 60)}</span></>}
        {audioBad && ' The song could not be played.'}
      </p>
      <p className="rc-sr">{scenes.map((s) => [s.main.text || (s.main.count ? countText(s.main, 0, true) : String(year)), s.unit, s.sub].filter(Boolean).join(' ')).join('. ')}</p>
      {src && <audio ref={audio} src={src} preload="auto" onError={() => setAudioBad(true)} />}
    </div>
  );
}

export function RecapSettings({ me, recap }) {
  const { lang } = useLang();
  const themes = useProfileThemes();
  const hasMine = !!(recap && recap.mine);
  const [view, setView] = useState(hasMine ? 'mine' : 'global');
  const scenes = useMemo(() => buildScenes(recap, view, lang), [recap, view, lang]);

  const theme = view === 'mine' ? userTheme(themes, me) : findProfileTheme(themes, recap.global && recap.global.topTheme);
  const look = useMemo(() => (theme && Array.isArray(theme.colors) && theme.colors.length >= 2
    ? { colors: theme.colors, angle: Number.isFinite(theme.angle) ? theme.angle : 135 }
    : DEFAULT_LOOK), [theme]);
  // their song as it is now, falling back to the one the recap was built with; the global one is the most popular song
  const mySong = me && me.song && (me.song.id || me.song.url) ? me.song : recap.mine && recap.mine.song;
  const song = view === 'mine' ? mySong : recap.global && recap.global.topSong;

  return (
    <div className="recap-settings">
      {hasMine && (
        <div className="mode-pick rc-views">
          <button type="button" className={view === 'mine' ? 'on' : ''} onClick={() => setView('mine')}>Your year</button>
          <button type="button" className={view === 'global' ? 'on' : ''} onClick={() => setView('global')}>Everyone</button>
        </div>
      )}
      {scenes
        ? <Player key={view} scenes={scenes} year={recap.year} kind={view} look={look} song={song} />
        : <p className="hint">There is nothing to show here yet.</p>}
    </div>
  );
}
