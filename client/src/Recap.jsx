import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon } from './ui.jsx';
import { useLang } from './i18n.js';
import { useProfileThemes, userTheme, findProfileTheme, lightness } from './profilethemes.js';
import { songUrl } from './ProfileSong.jsx';
import ShareSheet from './ShareSheet.jsx';
import { tossfaceUrl } from './tossface.js';
import { DEFAULT_LOOK, SUPPORTER_TIERS, XFADE_MS, buildScenes, countText, fmtCount, inThird, recapToken, sceneAt, shareText, songGain, songWindows, timeline, totalMs } from './recap.js';
import { imageUrl } from './image.js';
import { serverInitials } from './ui.jsx';

// Settings > Year in review. Two versions with the same kind of scenes: the global one (60 seconds, the same for everyone, painted with the most popular
// profile theme and played over the two most popular songs) and the person's own (30 seconds, their theme, their profile song). What goes into the scenes,
// and which stat is picked, is in recap.js. The numbers come from GET /api/recap and are counts only, apart from the names and pictures of the fastest growing public servers.

const BG_POS = ['0% 0%', '100% 0%', '100% 100%', '0% 100%', '50% 50%', '0% 50%']; // the gradient drifts to a new corner each scene
const FADE_IN_MS = 1500, FADE_OUT_MS = 2500;
const gainAt = (t, total) => Math.max(0, Math.min(1, t / FADE_IN_MS, (total - t) / FADE_OUT_MS));

// Where a song is at video time ms. In a person's own recap a song shorter than its stretch of the video starts over. In the global one it plays once.
const spot = (a, ms, repeat) => (repeat && Number.isFinite(a.duration) && a.duration > 0 ? (ms / 1000) % a.duration : ms / 1000);
function setVolume(g, a, v) {
  if (g && g.gain) g.gain.gain.value = v; else if (a) a.volume = v;
}

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

// A server's picture in the list. No picture, or one that does not load, shows its initials.
function ListIcon({ item }) {
  const [bad, setBad] = useState(false);
  const src = imageUrl(item.icon);
  return (
    <span className={'rc-ico' + (src && !bad ? '' : ' no-img')} aria-hidden="true">
      {src && !bad ? <img src={src} alt="" draggable={false} onError={() => setBad(true)} /> : serverInitials(item.name)}
    </span>
  );
}

// A supporter's picture in their pill. No picture, or one that does not load, shows the first letter on grey.
function PersonPic({ person }) {
  const [bad, setBad] = useState(false);
  const src = imageUrl(person.icon);
  return (
    <span className="rc-pic" aria-hidden="true">
      {src && !bad ? <img src={src} alt="" draggable={false} onError={() => setBad(true)} /> : Array.from(person.name)[0].toUpperCase()}
    </span>
  );
}

const CHIP_FIRST_MS = 650;   // the first pills slide in a moment after the heading
const CHIP_STEP_MS = 110;    // and one after the other
const SCROLL_FROM_MS = 2600; // the list starts to move once the first screen has settled
const SCROLL_REST_MS = 1500; // and stops this long before the scene ends

// The pills, highest rank on top, each rank in its own block. When they do not all fit the frame the list scrolls by itself over the length of
// the scene, and each pill slides in from the side at the moment it comes into view. Sizes are measured, so it follows the frame.
function Crowd({ people, ms }) {
  const box = useRef(null), body = useRef(null);
  useLayoutEffect(() => {
    const el = box.current, list = body.current;
    if (!el || !list) return undefined;
    const lay = () => {
      const view = el.clientHeight, over = Math.max(0, list.offsetHeight - view);
      const span = Math.max(1000, ms - SCROLL_FROM_MS - SCROLL_REST_MS);
      list.style.setProperty('--over', over + 'px');
      list.style.setProperty('--sfrom', SCROLL_FROM_MS + 'ms');
      list.style.setProperty('--sdur', span + 'ms');
      list.querySelectorAll('.rc-chip').forEach((c, i) => {
        const need = c.offsetTop + c.offsetHeight - view; // how far the list has to move before this pill is fully in the frame
        const at = need <= 0 ? CHIP_FIRST_MS + Math.min(i, 14) * CHIP_STEP_MS : Math.max(CHIP_FIRST_MS, SCROLL_FROM_MS + (need / over) * span - 300);
        c.style.setProperty('--d', Math.round(at) + 'ms');
      });
    };
    lay();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(lay);
    ro.observe(el);
    return () => ro.disconnect();
  }, [people, ms]);

  let n = 0;
  return (
    <div className="rc-crowd" ref={box}>
      <div className="rc-crowd-body" ref={body}>
        {SUPPORTER_TIERS.map((tier) => {
          const group = people.filter((p) => p.tier === tier);
          return group.length ? (
            <div className="rc-tier" data-tier={tier} key={tier}>
              {group.map((p) => (
                <span key={p.name} className={'rc-chip ' + (n++ % 2 ? 'from-r' : 'from-l')}>
                  <PersonPic person={p} />
                  <span className="rc-chip-name">@{p.name}</span>
                </span>
              ))}
            </div>
          ) : null;
        })}
      </div>
    </div>
  );
}

function Scene({ s, ms, last, numRef, year }) {
  const m = s.main;
  const unit = s.unit && <span className="rc-unit">{s.unit}</span>;
  return (
    <div className={'rc-scene' + (last ? ' last' : '') + (m.people ? ' crowd' : '')} data-anchor={s.anchor} style={{ '--sm': ms + 'ms' }}>
      <div className="rc-main">
        {m.people ? (
          <>
            {unit}
            <Crowd people={m.people} ms={ms} />
          </>
        ) : m.list ? (
          <>
            {unit}
            <ol className="rc-list">
              {m.list.map((it, i) => (
                <li key={i} style={{ '--i': i }}>
                  <b className="rc-rank">{i + 1}</b>
                  <ListIcon item={it} />
                  <span className="rc-name"><WithEmoji text={it.name} /></span>
                  <span className="rc-gain">+{fmtCount(it.count, m.lang)}</span>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <>
            {m.logo ? (
              <>
                <span className="rc-logo" role="img" aria-label="Aduna"><i className="rc-mark" /><i className="rc-word" /></span>
                <span className="rc-year">{year}</span>
              </>
            ) : m.count ? <span className="rc-num" ref={numRef} /> : <span className="rc-big"><WithEmoji text={m.text} /></span>}
            {unit}
          </>
        )}
      </div>
      {s.sub && <p className="rc-sub"><WithEmoji text={s.sub} /></p>}
    </div>
  );
}

// received: a recap someone shared into a chat, shown over the chat (no Share button). autoPlay starts it as soon as it opens.
// songs is one or two songs: one plays the whole video, two cross over in the middle (songWindows in recap.js).
export function Player({ scenes, year, kind, look, songs, name, received = false, autoPlay = false }) {
  const total = totalMs(kind);
  const tl = useMemo(() => timeline(scenes, total), [scenes, total]);
  // Each song plays from its start: a search pick is Apple's 30 second preview (the part chosen for the profile card is ignored here),
  // and in a person's own recap a song that is shorter than its stretch of the video starts over. The global recap plays each song once.
  const tracks = useMemo(() => (songs || []).map((song) => ({ song, src: songUrl(song) })).filter((x) => x.src).slice(0, 2), [songs]);
  const wins = useMemo(() => songWindows(tracks.length, total), [tracks.length, total]);
  const hasSong = tracks.length > 0;
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
  const badRef = useRef(false);
  const lastShown = useRef('');
  const stage = useRef(null), cv = useRef(null), num = useRef(null), bar = useRef(null), time = useRef(null);
  const audios = useRef([]), graphs = useRef([]); // one audio element and one Web Audio gain per song
  const rgbs = useMemo(() => look.colors.map(toRgb), [look]);
  const live = useRef({});
  const repeat = kind === 'mine';
  live.current = { scenes, tl, wins, rgbs, reduce, total, repeat };

  const fail = useCallback(() => { badRef.current = true; setAudioBad(true); }, []);

  // Keeps the songs in step with the clock: sets each volume, starts one when its turn comes and stops it when its turn is over.
  // seek is true when the clock jumped (play, resume, replay) and every song that should be sounding has to be moved to its place.
  const drive = useCallback((t, seek) => {
    if (badRef.current) return;
    const { wins: windows, total: len, repeat: again } = live.current;
    windows.forEach((w, i) => {
      const a = audios.current[i];
      if (!a) return;
      // a song that plays once fades out over its own last seconds instead of stopping mid-sound
      const left = !again && Number.isFinite(a.duration) ? (a.duration - a.currentTime) * 1000 : Infinity;
      setVolume(graphs.current[i], a, gainAt(t, len) * songGain(w, t, len) * Math.max(0, Math.min(1, left / XFADE_MS)));
      if (!(t >= w.from && t < w.to)) { if (!a.paused) a.pause(); return; }
      if (!a.paused && !seek) return;
      if (!again && a.ended && !seek) return;
      const pos = spot(a, t - w.from, again);
      if (!again && Number.isFinite(a.duration) && pos >= a.duration) { if (!a.paused) a.pause(); return; }
      a.muted = mutedRef.current;
      try { a.currentTime = pos; } catch { /* not loaded yet, so it starts from the beginning */ }
      a.play().catch(fail);
    });
  }, [fail]);

  // One frame of everything that follows the clock: which scene, the counting number, the progress bar, the blobs and the songs' volume.
  const paint = useCallback((t) => {
    const { scenes: sc, tl: line, rgbs: cols, reduce: still, total: len } = live.current;
    const idx = sceneAt(line, t);
    if (idx !== sceneRef.current) { sceneRef.current = idx; setScene(idx); }
    const s = sc[idx];
    if (idx === rendered.current && num.current && s.main.count) num.current.textContent = countText(s.main, t - line[idx].from, still); // not while the old scene is still on screen
    if (bar.current) bar.current.style.transform = `scaleX(${t / len})`;
    if (time.current) {
      const txt = `${clock(t)} / ${clock(len)}`;
      if (txt !== lastShown.current) { lastShown.current = txt; time.current.textContent = txt; }
    }
    if (cv.current) drawBlobs(cv.current, t, cols);
    drive(t, false);
  }, [drive]);

  const finish = useCallback(() => {
    cancelAnimationFrame(raf.current);
    setStatus('ended');
    audios.current.forEach((a, i) => {
      if (a) a.pause();
      const g = graphs.current[i];
      if (g && g.gain) g.gain.gain.value = 0;
    });
  }, []);

  const loop = useCallback((now) => {
    const c = clk.current;
    const dt = c.last == null ? 0 : Math.min(now - c.last, 200); // a long gap (the tab was asleep) must not skip scenes
    c.last = now;
    c.t = Math.min(total, c.t + dt);
    paint(c.t);
    if (c.t >= total) { finish(); return; }
    raf.current = requestAnimationFrame(loop);
  }, [paint, finish, total]);

  // Web Audio gives a real fade on every browser; iPhones ignore audio.volume, so the element's own volume is only the fallback.
  // Web Audio goes silent on a sound from another site (the previews come from Apple's servers), so those fade with the element's own volume.
  const ensureGraph = (i) => {
    const a = audios.current[i], src = tracks[i] && tracks[i].src;
    if (!a || graphs.current[i]) return;
    if (/^https?:\/\//i.test(src) && !src.startsWith(location.origin)) { graphs.current[i] = { ctx: null, gain: null }; return; }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      ctx.createMediaElementSource(a).connect(gain).connect(ctx.destination);
      graphs.current[i] = { ctx, gain };
    } catch { graphs.current[i] = { ctx: null, gain: null }; }
  };
  const wake = () => tracks.forEach((_, i) => {
    ensureGraph(i);
    const g = graphs.current[i];
    if (g && g.ctx && g.ctx.state === 'suspended') g.ctx.resume().catch(() => {});
  });
  // Some phones only let a sound start from a tap. The song that comes in later is started and stopped again here, while the tap is still counted.
  const unlockLater = (t) => audios.current.forEach((a, i) => {
    const w = wins[i];
    if (!a || !w || (t >= w.from && t < w.to)) return;
    a.muted = true;
    a.play().then(() => { a.pause(); a.muted = mutedRef.current; }).catch(() => {});
  });

  const start = (fromStart) => {
    const c = clk.current;
    if (statusRef.current === 'idle') { mutedRef.current = false; setMuted(false); } // pressing play is what lets the song be heard
    if (fromStart || c.t >= total) { c.t = 0; sceneRef.current = 0; setScene(0); setRun((r) => r + 1); }
    c.last = null;
    setStatus('playing');
    wake();
    unlockLater(c.t);
    drive(c.t, true);
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(loop);
  };
  const pause = useCallback(() => {
    cancelAnimationFrame(raf.current);
    clk.current.last = null;
    setStatus('paused');
    audios.current.forEach((a) => { if (a) a.pause(); });
  }, []);

  const toggleMute = () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    audios.current.forEach((a) => { if (a) a.muted = next; });
    if (!next) {
      wake();
      if (statusRef.current === 'playing') drive(clk.current.t, false);
    }
  };

  // The count shown the moment a scene appears (the loop takes over on the next frame).
  useLayoutEffect(() => {
    rendered.current = scene;
    const s = scenes[scene];
    if (num.current && s && s.main.count) num.current.textContent = countText(s.main, clk.current.t - tl[scene].from, reduce || statusRef.current === 'idle');
  }, [scene, run]);

  const sources = tracks.map((x) => x.src).join('|');
  useEffect(() => { audios.current.forEach((a) => { if (a) a.muted = muted; }); }, [muted, sources]);

  useEffect(() => { if (autoPlay) start(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    audios.current.forEach((a) => { if (a) a.pause(); });
    graphs.current.forEach((g) => { if (g && g.ctx) g.ctx.close().catch(() => {}); });
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
          <Scene key={scene + ':' + run} s={scenes[scene]} ms={tl[scene].to - tl[scene].from} last={scene === scenes.length - 1} numRef={num} year={year} />
          {status === 'idle' && <button type="button" className="rc-bigplay" onClick={() => start(false)}><Icon name="play" size={18} /> {hasSong ? 'Play with sound' : 'Play'}</button>}
        </div>
        <div className="rc-bar" aria-hidden="true"><i ref={bar} /></div>
      </div>
      <div className="rc-controls">
        <button type="button" className="btn primary" onClick={() => (playing ? pause() : start(false))}><Icon name={playing ? 'pause' : 'play'} size={16} /> {playing ? 'Pause' : 'Play'}</button>
        <button type="button" className="btn" onClick={() => start(true)}>Replay</button>
        {hasSong && !audioBad && (
          <button type="button" className="icon-btn" onClick={toggleMute} aria-pressed={!muted} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Sound is off' : 'Mute'}>
            <Icon name={muted ? 'speakeroff' : 'speaker'} size={18} />
          </button>
        )}
        <span className="rc-time" ref={time}>{`0:00 / ${clock(total)}`}</span>
        <span className="rc-spacer" />
        {!received && <button type="button" className="btn" onClick={openShare}><Icon name="send" size={16} /> Share</button>}
      </div>
      {sharing && (
        <ShareSheet what="recap" link={location.origin} text={shareText(scenes, kind, year)} title={kind === 'mine' ? `My ${year} on Aduna` : `Aduna in ${year}`}
          message={recapToken(kind === 'mine' ? inThird(scenes, name) : scenes, { kind, year, look, songs: tracks.map((x) => x.song) }) || undefined}
          onClose={() => setSharing(false)} onShared={() => {}} />
      )}
      <p className="hint">
        {received ? 'Numbers only, shared in chat.' : kind === 'mine' ? 'Only you can see this. Nothing is shared unless you press Share.' : 'The same for everyone. It mostly counts things: no messages, and only public servers and people who supported Aduna are named.'}
        {hasSong && !audioBad && <> {status === 'idle' ? 'Sound stays off until you press play.' : ''}<span className="rc-song"> <Icon name="music" size={13} className="inline-icon" /> {tracks.map((x) => String(x.song.title || 'Song').slice(0, 60)).join(' · ')}</span></>}
        {audioBad && ' The song could not be played.'}
      </p>
      <p className="rc-sr">{scenes.map((s) => [s.main.text || (s.main.people ? s.main.people.map((p) => '@' + p.name).join(', ') : s.main.list ? s.main.list.map((i) => `${i.name} +${i.count}`).join(', ') : s.main.count ? countText(s.main, 0, true) : String(year)), s.unit, s.sub].filter(Boolean).join(' ')).join('. ')}</p>
      {tracks.map((x, i) => <audio key={i} ref={(el) => { audios.current[i] = el; }} src={x.src} loop={repeat} preload="auto" onError={fail} />)}
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
  // their song as it is now, falling back to the one the recap was built with; the global one has the two most popular songs
  const mySong = me && me.song && (me.song.id || me.song.url) ? me.song : recap.mine && recap.mine.song;
  const songs = useMemo(() => {
    if (view === 'mine') return mySong ? [mySong] : [];
    const g = recap.global || {};
    return Array.isArray(g.topSongs) && g.topSongs.length ? g.topSongs : g.topSong ? [g.topSong] : [];
  }, [view, mySong, recap]);

  return (
    <div className="recap-settings">
      {hasMine && (
        <div className="mode-pick rc-views">
          <button type="button" className={view === 'mine' ? 'on' : ''} onClick={() => setView('mine')}>Your year</button>
          <button type="button" className={view === 'global' ? 'on' : ''} onClick={() => setView('global')}>Everyone</button>
        </div>
      )}
      {scenes
        ? <Player key={view} scenes={scenes} year={recap.year} kind={view} look={look} songs={songs} name={me && (me.displayName || me.username)} />
        : <p className="hint">There is nothing to show here yet.</p>}
    </div>
  );
}
