import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './ui.jsx';
import { TileSkeleton } from './ShellBits.jsx';
import EmojiPicker from './EmojiPicker.jsx';
import { api } from './api.js';
import { useEmoji } from './Emoji.jsx';
import { isVoice, keepDays, kindOf, loadBlob, safeGif, saveAttachment, sizeLabel, voiceSecs } from './files.js';

function fit(w, h, maxW = 380, maxH = 320) {
  if (!w || !h) return null;
  const s = Math.min(1, maxW / w, maxH / h);
  return { width: Math.round(w * s), height: Math.round(h * s) };
}

function useBlobUrl(att, dm, enabled) {
  const [state, setState] = useState({ url: null, err: false, expired: false });
  useEffect(() => {
    if (!enabled) return undefined;
    let url, dead = false;
    loadBlob(att, dm).then((b) => { if (!dead) { url = URL.createObjectURL(b); setState({ url, err: false, expired: false }); } })
      .catch((e) => !dead && setState({ url: null, err: true, expired: !!e?.expired }));
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [att.id, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

function Expired({ att }) {
  return (
    <div className="att-file att-expired" title={`Files are removed ${keepDays(att.size)} days after they are sent`}>
      <Icon name="clock" size={26} />
      <div className="att-meta"><div className="att-name">{att.name || 'Attachment'}</div><div className="muted small">Expired and removed after {keepDays(att.size)} days</div></div>
    </div>
  );
}

function ImageAtt({ att, dm, onOpen }) {
  const { url, err, expired } = useBlobUrl(att, dm, true);
  if (expired) return <Expired att={att} />;
  const box = fit(att.w, att.h) || { width: 300, height: 180 };
  return (
    <button className="att-img" style={url && !att.w ? undefined : box} onClick={() => url && onOpen({ url, name: att.name, att })} title={att.name}>
      {url ? <img src={url} alt={att.name} draggable={false} /> : <span className="att-wait">{err ? 'Could not load image' : 'Loading…'}</span>}
    </button>
  );
}

const clock = (s) => {
  const n = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
};

// Our own video player: play/pause, a seek bar, download, and maximize/minimize (instead of the browser's default controls).
function VideoAtt({ att, dm, url }) {
  const vref = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [max, setMax] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!max) return undefined;
    const h = (e) => e.key === 'Escape' && setMax(false);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [max]);

  const toggle = () => {
    const v = vref.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };
  // Recorded .webm files often report an infinite length until the end has been reached once; jump there and back to learn it.
  const onMeta = (e) => {
    const v = e.currentTarget;
    if (v.duration === Infinity) {
      const fix = () => { v.removeEventListener('timeupdate', fix); v.currentTime = 0; setDur(Number.isFinite(v.duration) ? v.duration : 0); };
      v.addEventListener('timeupdate', fix);
      v.currentTime = 1e101;
    } else setDur(v.duration || 0);
  };
  const seek = (e) => {
    const v = vref.current, t = Number(e.target.value);
    if (v) v.currentTime = t;
    setCur(t);
  };
  async function download() {
    setBusy(true);
    try { await saveAttachment(att, dm); } catch { /* expired or offline: nothing more to show on a player */ }
    setBusy(false);
  }

  return (
    <div className={'vp' + (max ? ' max' : '')}>
      <video
        ref={vref} className="att-video" src={url} playsInline preload="metadata" onClick={toggle}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onLoadedMetadata={onMeta} onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
      />
      {!playing && <button className="vp-big" onClick={toggle} aria-label="Play"><Icon name="playc" size={26} className="fill" /></button>}
      <div className="vp-bar">
        <button className="icon-btn" title={playing ? 'Pause' : 'Play'} aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}><Icon name={playing ? 'pause' : 'play'} size={18} className="fill" /></button>
        <input className="vp-seek" type="range" min="0" max={dur || 0} step="0.05" value={Math.min(cur, dur || 0)} onChange={seek} disabled={!dur} aria-label="Seek" />
        <span className="vp-time">{clock(cur)} / {clock(dur)}</span>
        <button className="icon-btn" title="Download" aria-label="Download" onClick={download} disabled={busy}><Icon name="download" size={18} /></button>
        <button className="icon-btn" title={max ? 'Minimize' : 'Maximize'} aria-label={max ? 'Minimize' : 'Maximize'} onClick={() => setMax(!max)}><Icon name={max ? 'shrink' : 'expand'} size={18} /></button>
      </div>
    </div>
  );
}

let playingNow = null; // only one voice message plays at a time

// A voice message: a round play button, a seek bar, the time and a speed button. Recorded audio often reports no length until the end has
// been reached once (and then cannot be seeked): jump there and back to learn it, like the video player does. The length written into the
// file name is the fallback until then.
function VoiceAtt({ att, url }) {
  const aref = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(voiceSecs(att));
  const [rate, setRate] = useState(1);
  useEffect(() => () => { if (playingNow === aref.current) playingNow = null; }, []);
  const toggle = () => {
    const a = aref.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {}); else a.pause();
  };
  const onMeta = (e) => {
    const a = e.currentTarget;
    if (a.duration === Infinity) {
      const fix = () => { a.removeEventListener('timeupdate', fix); a.currentTime = 0; if (Number.isFinite(a.duration) && a.duration > 0) setDur(a.duration); };
      a.addEventListener('timeupdate', fix);
      a.currentTime = 1e101;
    } else if (a.duration > 0) setDur(a.duration);
  };
  const seek = (e) => {
    const a = aref.current, t = Number(e.target.value);
    if (a) a.currentTime = t;
    setCur(t);
  };
  const faster = () => {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    setRate(next);
    if (aref.current) aref.current.playbackRate = next;
  };
  return (
    <div className="voice-msg">
      <audio
        ref={aref} src={url} preload="metadata"
        onPlay={(e) => { if (playingNow && playingNow !== e.currentTarget) playingNow.pause(); playingNow = e.currentTarget; setPlaying(true); }}
        onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setCur(0); }}
        onLoadedMetadata={onMeta} onTimeUpdate={(e) => { if (e.currentTarget.currentTime < 86400) setCur(e.currentTarget.currentTime); }}
      />
      <button className="icon-btn" title={playing ? 'Pause' : 'Play'} aria-label={playing ? 'Pause voice message' : 'Play voice message'} onClick={toggle}><Icon name={playing ? 'pause' : 'play'} size={18} className="fill" /></button>
      <input className="vp-seek" type="range" min="0" max={dur || 0} step="0.05" value={Math.min(cur, dur || 0)} onChange={seek} disabled={!dur} aria-label="Seek voice message" />
      <span className="voice-time">{clock(playing || cur > 0 ? cur : dur)}</span>
      <button className="voice-rate" onClick={faster} title="Playback speed" aria-label={`Playback speed ${rate}x`}>{rate}x</button>
    </div>
  );
}

// Volume and mute are remembered (and shared by every player on screen), like the speed button on voice messages is per message.
let audioPrefs = null;
const prefListeners = new Set();
function loadPrefs() {
  if (!audioPrefs) {
    audioPrefs = { volume: 1, muted: false };
    try {
      const s = JSON.parse(localStorage.getItem('aduna-audio') || 'null');
      if (s && typeof s.volume === 'number') audioPrefs = { volume: Math.min(1, Math.max(0, s.volume)), muted: !!s.muted };
    } catch { /* storage blocked: the defaults are fine */ }
  }
  return audioPrefs;
}
function useAudioPrefs() {
  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => { prefListeners.add(setPrefs); return () => { prefListeners.delete(setPrefs); }; }, []);
  const change = useCallback((next) => {
    audioPrefs = next;
    try { localStorage.setItem('aduna-audio', JSON.stringify(next)); } catch { /* not saved, still applied */ }
    prefListeners.forEach((f) => f(next));
  }, []);
  return [prefs, change];
}

const RATES = [1, 1.25, 1.5, 2, 0.75];

// An audio file (music, a podcast, anything that is not a voice message): our own player instead of the browser's, with the title
// and size, a play button, a seek bar, volume, speed and download. Space plays/pauses, left/right on the seek bar jump 5 seconds, M mutes.
function AudioAtt({ att, dm, url }) {
  const aref = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [rate, setRate] = useState(1);
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefs] = useAudioPrefs();

  useEffect(() => () => { if (playingNow === aref.current) playingNow = null; }, []);
  useEffect(() => { const a = aref.current; if (a) { a.volume = prefs.volume; a.muted = prefs.muted; } }, [prefs]);

  const toggle = () => {
    const a = aref.current;
    if (!a || bad) return;
    if (a.paused) a.play().catch(() => {}); else a.pause();
  };
  // same trick as the video player: recorded files often report no length until the end has been reached once
  const onMeta = (e) => {
    const a = e.currentTarget;
    if (a.duration === Infinity) {
      const fix = () => { a.removeEventListener('timeupdate', fix); a.currentTime = 0; if (Number.isFinite(a.duration) && a.duration > 0) setDur(a.duration); };
      a.addEventListener('timeupdate', fix);
      a.currentTime = 1e101;
    } else if (a.duration > 0) setDur(a.duration);
  };
  const jump = (t) => {
    const a = aref.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(dur || t, t));
    setCur(a.currentTime);
  };
  const onSeekKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    jump((aref.current?.currentTime || 0) + (e.key === 'ArrowRight' ? 5 : -5));
  };
  const onKey = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === ' ' && e.target.tagName !== 'BUTTON') { e.preventDefault(); toggle(); }
    else if (e.key === 'm' || e.key === 'M') setPrefs({ ...prefs, muted: !prefs.muted });
  };
  const silent = prefs.muted || prefs.volume === 0;
  const mute = () => setPrefs(silent ? { volume: prefs.volume || 0.5, muted: false } : { ...prefs, muted: true });
  const nextRate = () => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    setRate(next);
    if (aref.current) aref.current.playbackRate = next;
  };
  async function download() {
    setBusy(true);
    try { await saveAttachment(att, dm); } catch { /* expired or offline: nothing more to show on a player */ }
    setBusy(false);
  }

  const named = /^(.*)\.([A-Za-z0-9]{1,5})$/.exec(att.name || '');
  const title = (named ? named[1] : att.name) || 'Audio';
  const sub = bad ? "Can't play this file here" : [named ? named[2].toUpperCase() : '', att.size > 0 ? sizeLabel(att.size) : ''].filter(Boolean).join(' · ');
  const pct = (v, max) => (max > 0 ? Math.min(100, Math.max(0, (v / max) * 100)) : 0) + '%';

  return (
    <div className={'ap' + (playing ? ' playing' : '') + (bad ? ' bad' : '')} onKeyDown={onKey}>
      <audio
        ref={aref} src={url} preload="metadata"
        onPlay={(e) => { if (playingNow && playingNow !== e.currentTarget) playingNow.pause(); playingNow = e.currentTarget; setPlaying(true); }}
        onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setCur(0); }} onError={() => { setBad(true); setPlaying(false); }}
        onLoadedMetadata={onMeta} onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0 && setDur(e.currentTarget.duration)}
        onTimeUpdate={(e) => { if (e.currentTarget.currentTime < 86400) setCur(e.currentTarget.currentTime); }}
      />
      <div className="ap-top">
        <div className="ap-art" aria-hidden="true">{playing ? <span className="ap-eq"><i /><i /><i /><i /></span> : <Icon name="music" size={20} />}</div>
        <div className="ap-meta">
          <div className="ap-title" title={att.name}>{title}</div>
          <div className="ap-sub">{sub}</div>
        </div>
        <button className="icon-btn" title="Download" aria-label="Download" onClick={download} disabled={busy}><Icon name="download" size={18} /></button>
      </div>
      <div className="ap-bar">
        <button className="ap-play" title={playing ? 'Pause' : 'Play'} aria-label={playing ? 'Pause' : 'Play'} onClick={toggle} disabled={bad}><Icon name={playing ? 'pause' : 'play'} size={18} className="fill" /></button>
        <span className="ap-time">{clock(cur)}</span>
        <input
          className="ap-seek" type="range" min="0" max={dur || 0} step="0.01" value={Math.min(cur, dur || 0)} disabled={!dur || bad}
          style={{ '--p': pct(cur, dur) }} onChange={(e) => jump(Number(e.target.value))} onKeyDown={onSeekKey} aria-label="Seek"
          aria-valuetext={`${clock(cur)} of ${clock(dur)}`}
        />
        <span className="ap-time">{clock(dur)}</span>
        <button className="icon-btn ap-mute" title={silent ? 'Unmute' : 'Mute'} aria-label={silent ? 'Unmute' : 'Mute'} onClick={mute}><Icon name={silent ? 'speakeroff' : 'speaker'} size={18} /></button>
        <input
          className="ap-seek ap-volume" type="range" min="0" max="1" step="0.05" value={silent ? 0 : prefs.volume} style={{ '--p': pct(silent ? 0 : prefs.volume, 1) }}
          onChange={(e) => { const v = Number(e.target.value); setPrefs({ volume: v, muted: v === 0 }); }} aria-label="Volume"
        />
        <button className="voice-rate" onClick={nextRate} title="Playback speed" aria-label={`Playback speed ${rate}x`}>{rate}x</button>
      </div>
    </div>
  );
}

function MediaAtt({ att, dm, kind }) {
  const { url, err, expired } = useBlobUrl(att, dm, true);
  if (expired) return <Expired att={att} />;
  if (err) return <div className="att-file muted">Could not load {att.name}</div>;
  if (!url) return <div className="att-file muted">Loading {att.name}…</div>;
  return kind === 'video'
    ? <VideoAtt att={att} dm={dm} url={url} />
    : isVoice(att) ? <VoiceAtt att={att} url={url} />
    : <AudioAtt att={att} dm={dm} url={url} />;
}

function FileAtt({ att, dm }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [expired, setExpired] = useState(false);
  async function download() {
    setBusy(true); setErr('');
    try { await saveAttachment(att, dm); } catch (e) { if (e?.expired) setExpired(true); else setErr(e.message); }
    setBusy(false);
  }
  if (expired) return <Expired att={att} />;
  return (
    <div className="att-file">
      <Icon name="file" size={26} />
      <div className="att-meta"><div className="att-name" title={att.name}>{att.name}</div><div className="muted small">{err || `${sizeLabel(att.size)} · removed ${keepDays(att.size)} days after sending`}</div></div>
      <button className="icon-btn" title="Download" onClick={download} disabled={busy}><Icon name="download" size={18} /></button>
    </div>
  );
}

export function Attachments({ atts, dm, onOpen }) {
  if (!atts?.length) return null;
  return (
    <div className="atts">
      {atts.map((a, i) => {
        if (a.gif) {
          if (!safeGif(a.url)) return null;
          return <button key={i} className="att-img" style={fit(a.w, a.h, 320, 260)} onClick={() => onOpen({ url: a.url, name: a.title || 'GIF' })} title={a.title}>
            <img src={a.url} alt={a.title || 'GIF'} loading="lazy" referrerPolicy="no-referrer" draggable={false} />
          </button>;
        }
        if (a.expired) return <Expired key={a.id} att={a} />;
        const kind = kindOf(a.type);
        if (kind === 'image') return <ImageAtt key={a.id} att={a} dm={dm} onOpen={onOpen} />;
        if (kind === 'video' || kind === 'audio') return <MediaAtt key={a.id} att={a} dm={dm} kind={kind} />;
        return <FileAtt key={a.id} att={a} dm={dm} />;
      })}
    </div>
  );
}

export function Lightbox({ view, onClose }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="lightbox" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <img src={view.url} alt={view.name} referrerPolicy="no-referrer" />
      <div className="lightbox-bar">
        <span>{view.name}</span>
        {view.att && <button className="icon-btn" title="Download" onClick={() => saveAttachment(view.att, view.dm)}><Icon name="download" size={18} /></button>}
        <button className="icon-btn" title="Close" onClick={onClose}><Icon name="close" size={18} /></button>
      </div>
    </div>
  );
}

function Popover({ onClose, className = '', children }) {
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => ref.current && !ref.current.contains(e.target) && onClose();
    const k = (e) => e.key === 'Escape' && onClose();
    const t = setTimeout(() => document.addEventListener('mousedown', h), 0);
    document.addEventListener('keydown', k);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [onClose]);
  return <div className={'pop ' + className} ref={ref}>{children}</div>;
}

export function EmojiPop({ onPick, onClose }) {
  const { openManager } = useEmoji();
  return (
    <Popover onClose={onClose} className="emoji-pop">
      <EmojiPicker onPick={onPick} onCustom={(e) => onPick(`:${e.name}: `)} onManage={() => { onClose(); openManager(); }} />
    </Popover>
  );
}

// Splits GIFs into two columns, always adding the next one to the shorter column, so earlier ones never move when more load.
function columns(list) {
  const cols = [[], []], h = [0, 0];
  for (const g of list) {
    const i = h[0] <= h[1] ? 0 : 1;
    cols[i].push(g); h[i] += g.h / g.w;
  }
  return cols;
}

export function GifPop({ onPick, onClose, enabled }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState([]);
  const [next, setNext] = useState(0);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const gen = useRef(0);
  const grid = useRef(null);

  const run = useCallback((query, offset) => {
    const id = ++gen.current;
    setLoading(true); setErr('');
    api(`/gifs?q=${encodeURIComponent(query)}&offset=${offset}`).then((r) => {
      if (id !== gen.current) return;
      setList((prev) => (offset === 0 ? r.gifs : [...prev, ...r.gifs.filter((g) => !prev.some((p) => p.id === g.id))]));
      setNext(r.next ?? 0); setMore(r.next != null); setLoading(false);
    }).catch((e) => { if (id !== gen.current) return; setErr(e.message); setMore(false); setLoading(false); });
  }, []);

  // new search text: throw away anything still loading, start again from the top
  useEffect(() => {
    if (!enabled) return;
    gen.current++;
    setList([]); setMore(true); setNext(0);
    const t = setTimeout(() => run(q.trim(), 0), q ? 350 : 0);
    return () => clearTimeout(t);
  }, [q, enabled, run]);

  function loadMore() { if (!loading && more && list.length) run(q.trim(), next); }
  const onScroll = (e) => { const el = e.currentTarget; if (el.scrollTop + el.clientHeight > el.scrollHeight - 240) loadMore(); };
  // a tall window can show the first page without scrolling; keep loading until it is full
  useEffect(() => { const el = grid.current; if (el && !loading && more && list.length && el.scrollHeight <= el.clientHeight + 40) loadMore(); });

  const cols = useMemo(() => columns(list), [list]);
  return (
    <Popover onClose={onClose} className="gif-pop">
      {!enabled ? (
        <div className="gif-setup">
          <b>GIF search isn’t set up yet</b>
          <p className="muted small">GIFs come from GIPHY. Whoever runs this Aduna server needs a free API key from developers.giphy.com, then starts the server with <code>GIPHY_API_KEY=your_key</code>. After a restart, this button opens a searchable, endlessly scrolling GIF library.</p>
        </div>
      ) : (
        <>
          <div className="gif-search">
            <Icon name="search" size={16} className="ep-search-ic" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search GIFs" maxLength={60} />
          </div>
          <div className="gif-label muted small">{q.trim() ? `Results for “${q.trim()}”` : 'Trending'}</div>
          <div className="gif-grid" ref={grid} onScroll={onScroll}>
            {list.length > 0 && (
              <div className="gif-cols">
                {cols.map((col, i) => (
                  <div className="gif-col" key={i}>
                    {col.map((g) => (
                      <button key={g.id} type="button" onClick={() => onPick(g)} title={g.title} style={{ aspectRatio: `${g.w} / ${g.h}` }}>
                        <img src={g.url} alt={g.title} loading="lazy" referrerPolicy="no-referrer" />
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {loading && <TileSkeleton tiles={list.length ? 4 : 12} size={96} label="Loading GIFs" />}
            {err && <div className="error-text pad center">{err}</div>}
            {!loading && !err && list.length === 0 && <div className="muted pad center">No GIFs found.</div>}
            {!loading && !more && list.length > 0 && <div className="muted small pad center">That’s everything.</div>}
          </div>
          <div className="gif-credit muted small">Powered by GIPHY. Viewing a GIF loads it from GIPHY.</div>
        </>
      )}
    </Popover>
  );
}
