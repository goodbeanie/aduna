import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './ui.jsx';
import { TileSkeleton } from './ShellBits.jsx';
import EmojiPicker from './EmojiPicker.jsx';
import { api } from './api.js';
import { useEmoji } from './Emoji.jsx';
import { isVoice, keepDays, kindOf, loadBlob, loadChecked, safeGif, saveAttachment, sizeLabel, voiceSecs } from './files.js';

function fit(w, h, maxW = 380, maxH = 320) {
  if (!w || !h) return null;
  const s = Math.min(1, maxW / w, maxH / h);
  return { width: Math.round(w * s), height: Math.round(h * s) };
}

// A picture is checked on this device before it is shown (nsfw.js): 'block' is never shown, 'blur' is blurred until the reader taps it.
function useBlobUrl(att, dm, enabled) {
  const [state, setState] = useState({ url: null, err: false, expired: false, verdict: 'ok' });
  useEffect(() => {
    if (!enabled) return undefined;
    let url, dead = false;
    loadChecked(att, dm).then(({ blob, verdict }) => {
      if (dead) return;
      if (verdict !== 'block') url = URL.createObjectURL(blob);
      setState({ url: url || null, err: false, expired: false, verdict });
    }).catch((e) => !dead && setState({ url: null, err: true, expired: !!e?.expired, verdict: 'ok' }));
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [att.id, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

// pictures the reader chose to show, until the app is closed
const revealed = new Set();
const useReveal = (id) => {
  const [, again] = useState(0);
  return [revealed.has(id), () => { revealed.add(id); again((n) => n + 1); }];
};

function Hidden({ what = 'Image' }) {
  return (
    <div className="att-file att-expired" title="Checked on your device before it was shown">
      <Icon name="shield" size={26} />
      <div className="att-meta"><div className="att-name">{what} hidden</div><div className="muted small">It may contain nudity or explicit content</div></div>
    </div>
  );
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
  const { url, err, expired, verdict } = useBlobUrl(att, dm, true);
  const [shown, show] = useReveal(att.id);
  if (expired) return <Expired att={att} />;
  if (verdict === 'block') return <Hidden />;
  const veiled = (verdict === 'blur' || verdict === 'unknown') && !shown;
  const box = fit(att.w, att.h) || { width: 300, height: 180 };
  const click = () => {
    if (!url) return;
    if (veiled) show(); else onOpen({ url, name: att.name, att });
  };
  return (
    <button className={'att-img' + (veiled ? ' sensitive' : '')} style={url && !att.w ? undefined : box} onClick={click} title={veiled ? (verdict === 'unknown' ? 'Not checked' : 'Sensitive image') : att.name}>
      {url ? <img src={url} alt={veiled ? '' : att.name} draggable={false} /> : <span className="att-wait">{err ? 'Could not load image' : 'Loading…'}</span>}
      {veiled && <span className="att-veil">{verdict === 'unknown' ? "Couldn't check this image. Click to show" : 'Sensitive image. Click to show'}</span>}
    </button>
  );
}

const clock = (s) => {
  const n = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
};

// Our own video player: play/pause, a seek bar, the time, download and fullscreen (instead of the browser's default controls).
// Its class names start with mv- on purpose: the clips player (VideoPlayer.jsx, videoplayer.css) already owns .vp and .vp-seek.
// The in-page full view (for browsers that cannot do real fullscreen) is a second player in a portal on <body>: a position: fixed box inside
// the chat can be clipped or covered by the layers around it. It carries on from where the one in the chat was, and hands the position back.
function VideoAtt(props) {
  const [lift, setLift] = useState(null); // { t, play } while the full view is open
  const [back, setBack] = useState(null); // where the full view was closed: the player in the chat carries on from there
  return (
    <>
      <MvPlayer {...props} held={!!lift} resume={back} onLift={(t, play) => { setBack(null); setLift({ t, play }); }} />
      {lift && createPortal(
        <MvPlayer {...props} overlay start={lift} onClose={(t, play) => { setLift(null); setBack({ t, play }); }} />,
        document.body,
      )}
    </>
  );
}

function MvPlayer({ att, dm, url, overlay = false, start = null, held = false, resume = null, onLift, onClose }) {
  const box = useRef(null);
  const vref = useRef(null);
  const scrub = useRef({ down: false, probing: false, release: null });
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [ar, setAr] = useState(att.w && att.h ? att.w / att.h : 0); // width / height of the picture: the player takes the video's shape
  const [drag, setDrag] = useState(false);
  const [idle, setIdle] = useState(false); // playing and nobody has touched it for a moment: the bar steps aside so it does not cover the picture
  const idleT = useRef({ id: 0, on: false });
  const [full, setFull] = useState(false); // real fullscreen
  const [busy, setBusy] = useState(false);
  const isFull = full || overlay;

  // Any touch, click, key or mouse movement brings the bar back; a moment after the last one, while it plays, it goes again.
  const wake = () => {
    const t = idleT.current;
    t.on = false; setIdle(false);
    window.clearTimeout(t.id);
    t.id = window.setTimeout(() => { t.on = true; setIdle(true); }, 2500);
  };
  const calm = () => { const t = idleT.current; window.clearTimeout(t.id); t.on = false; setIdle(false); };

  // The in-page full view closes with Escape.
  useEffect(() => {
    if (!overlay) return undefined;
    const h = (e) => e.key === 'Escape' && close();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [overlay]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const h = () => setFull((document.fullscreenElement || document.webkitFullscreenElement) === box.current);
    document.addEventListener('fullscreenchange', h);
    document.addEventListener('webkitfullscreenchange', h);
    return () => {
      document.removeEventListener('fullscreenchange', h); document.removeEventListener('webkitfullscreenchange', h);
      const u = scrub.current.release;
      if (u) { window.removeEventListener('pointerup', u); window.removeEventListener('pointercancel', u); }
      window.clearTimeout(idleT.current.id);
    };
  }, []);

  // A full view is open over this player: it stops here, and carries on from where the full view was closed.
  useEffect(() => { if (held) vref.current?.pause(); }, [held]);
  useEffect(() => {
    const v = vref.current;
    if (!resume || !v) return;
    try { v.currentTime = resume.t; } catch { /* not ready yet: it stays where it was */ }
    setCur(resume.t);
    if (resume.play) v.play().catch(() => {});
  }, [resume]);

  // The one place the shown position is read from the video. It skips reads that cannot be trusted: while the handle is being dragged
  // (the person owns the position), while the video is still seeking (it can report its old position until the seek lands) and while
  // the length is being probed (see onMeta). A file that reports a position a few milliseconds behind the last one as it plays never
  // makes the handle step back.
  const sync = () => {
    const v = vref.current, s = scrub.current;
    if (!v || s.down || s.probing || v.seeking) return;
    const t = v.currentTime;
    if (!Number.isFinite(t) || t < 0 || t >= 86400) return;
    setCur((prev) => (!v.paused && t < prev && prev - t < 0.3 ? prev : t));
  };

  // While it plays, the bar follows the video's own clock every frame (timeupdate only fires a few times a second, so the handle
  // would jump).
  useEffect(() => {
    if (!playing) return undefined;
    let id = 0;
    const tick = () => { sync(); id = requestAnimationFrame(tick); };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    const v = vref.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };
  // A tap on the picture while the bar is away only brings the bar back (on a phone there is no mouse movement to do that first).
  const tap = () => { if (playing && idleT.current.on) { wake(); return; } toggle(); };
  // The in-page full view carries on from where the player in the chat was.
  const begin = (v) => {
    if (!start) return;
    if (start.t > 0) { try { v.currentTime = start.t; } catch { /* ignore */ } setCur(start.t); }
    if (start.play) v.play().catch(() => {});
  };
  // Recorded .webm files often report an infinite length until the end has been reached once; jump there and back to learn it.
  // Nothing is read from the video's clock while that happens, or the handle would flash to the end and back.
  const onMeta = (e) => {
    const v = e.currentTarget, s = scrub.current;
    if (v.videoWidth && v.videoHeight) setAr(v.videoWidth / v.videoHeight);
    if (v.duration !== Infinity) { setDur(v.duration || 0); begin(v); return; }
    s.probing = true;
    const fix = () => {
      v.removeEventListener('timeupdate', fix);
      window.clearTimeout(safety);
      setDur(Number.isFinite(v.duration) ? v.duration : 0);
      v.currentTime = 0; // the video counts as seeking from here, which keeps the clock out of the way until it has landed
      s.probing = false;
      setCur(0);
      begin(v);
    };
    const safety = window.setTimeout(() => { v.removeEventListener('timeupdate', fix); s.probing = false; }, 4000);
    v.addEventListener('timeupdate', fix);
    v.currentTime = 1e101;
  };
  const seek = (e) => {
    const v = vref.current, t = Number(e.target.value);
    if (v && Number.isFinite(t)) v.currentTime = t;
    setCur(t);
  };
  // The handle belongs to the person from the moment it is pressed until it is let go, wherever the pointer ends up: the release is
  // listened for on the window, because a drag that ends outside the bar never reaches the bar itself (the handle would stay frozen).
  // After it, nothing is read from the video until it has finished seeking (see sync).
  const grab = () => {
    const s = scrub.current;
    s.down = true; setDrag(true);
    if (s.release) return;
    const up = () => {
      window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      s.release = null; s.down = false; setDrag(false); sync();
    };
    s.release = up;
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
  async function download() {
    setBusy(true);
    try { await saveAttachment(att, dm); } catch { /* expired or offline: nothing more to show on a player */ }
    setBusy(false);
  }
  const where = () => { const v = vref.current; return [v ? v.currentTime : 0, v ? !v.paused : false]; };
  const close = () => onClose && onClose(...where());
  const lift = () => onLift && onLift(...where());
  // Real fullscreen of the whole player (so our controls stay). iPhone Safari only allows it for the bare video. A browser with neither,
  // or one that refuses, gets the in-page full view (a second player over everything, see VideoAtt).
  const fullscreen = () => {
    const el = box.current, v = vref.current;
    if (!el || !v) return;
    if (overlay) { close(); return; }
    if (document.fullscreenElement || document.webkitFullscreenElement) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      try { Promise.resolve(req.call(el)).catch(lift); } catch { lift(); }
      return;
    }
    if (v.webkitEnterFullscreen) { v.webkitEnterFullscreen(); return; }
    lift();
  };
  const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;

  return (
    <div
      ref={box} className={'mv' + (overlay ? ' max' : '') + (playing ? ' playing' : '') + (playing && idle && !drag ? ' idle' : '')} style={ar ? { '--ar': ar } : undefined}
      onPointerMove={() => playing && wake()} onPointerDown={() => playing && wake()} onFocus={() => playing && wake()}
    >
      <video
        ref={vref} className="mv-video" src={url} playsInline preload="metadata" onClick={tap}
        onPlay={() => { setPlaying(true); wake(); }} onPause={() => { setPlaying(false); calm(); }} onEnded={() => { setPlaying(false); calm(); sync(); }}
        onLoadedMetadata={onMeta} onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
        onTimeUpdate={sync} onSeeked={sync}
      />
      {!playing && <button className="mv-big" onClick={toggle} aria-label="Play"><Icon name="playc" size={34} className="fill" /></button>}
      <div className="mv-bar">
        <input
          className="mv-seek" type="range" min="0" max={dur || 0} step="0.05" value={Math.min(cur, dur || 0)} style={{ '--p': pct + '%' }}
          onChange={seek} onPointerDown={grab} disabled={!dur} aria-label="Seek"
        />
        <div className="mv-row">
          <button className="icon-btn" title={playing ? 'Pause' : 'Play'} aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}><Icon name={playing ? 'pause' : 'play'} size={22} className="fill" /></button>
          <span className="mv-time">{clock(cur)} / {clock(dur)}</span>
          <span className="mv-gap" />
          <button className="icon-btn mv-dl" title="Download" aria-label="Download" onClick={download} disabled={busy}><Icon name="download" size={22} /></button>
          <button className="icon-btn" title={isFull ? 'Exit fullscreen' : 'Fullscreen'} aria-label={isFull ? 'Exit fullscreen' : 'Fullscreen'} onClick={fullscreen}><Icon name={isFull ? 'shrink' : 'expand'} size={22} /></button>
        </div>
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
      <input className="voice-seek" type="range" min="0" max={dur || 0} step="0.05" value={Math.min(cur, dur || 0)} onChange={seek} disabled={!dur} aria-label="Seek voice message" />
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
  const { url, err, expired, verdict } = useBlobUrl(att, dm, true);
  const [shown, show] = useReveal(att.id);
  if (expired) return <Expired att={att} />;
  if (verdict === 'block') return <Hidden what="Video" />;
  if (err) return <div className="att-file muted">Could not load {att.name}</div>;
  if (!url) return <div className="att-file muted">Loading {att.name}…</div>;
  if ((verdict === 'blur' || verdict === 'unknown') && !shown) return <button className="att-file att-veil-file" onClick={show}><Icon name="shield" size={26} /><span>{verdict === 'unknown' ? "Couldn't check this video. Click to show" : 'Sensitive video. Click to show'}</span></button>;
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
  // Every image and GIF in this message, in order. Opening one gives the lightbox the whole list, so the person can step through them.
  const gallery = [];
  atts.forEach((a, i) => {
    if (a.gif) { if (safeGif(a.url)) gallery.push({ key: 'gif' + i, url: a.url, name: a.title || 'GIF' }); }
    else if (!a.expired && kindOf(a.type) === 'image') gallery.push({ key: a.id, att: a, name: a.name });
  });
  const open = (key) => (v) => onOpen({ ...v, items: gallery, index: Math.max(0, gallery.findIndex((g) => g.key === key)) });
  return (
    <div className="atts">
      {atts.map((a, i) => {
        if (a.gif) {
          if (!safeGif(a.url)) return null;
          return <button key={i} className="att-img" style={fit(a.w, a.h, 320, 260)} onClick={() => open('gif' + i)({ url: a.url, name: a.title || 'GIF' })} title={a.title}>
            <img src={a.url} alt={a.title || 'GIF'} loading="lazy" referrerPolicy="no-referrer" draggable={false} />
          </button>;
        }
        if (a.expired) return <Expired key={a.id} att={a} />;
        const kind = kindOf(a.type);
        if (kind === 'image') return <ImageAtt key={a.id} att={a} dm={dm} onOpen={open(a.id)} />;
        if (kind === 'video' || kind === 'audio') return <MediaAtt key={a.id} att={a} dm={dm} kind={kind} />;
        return <FileAtt key={a.id} att={a} dm={dm} />;
      })}
    </div>
  );
}

// One slide of the lightbox. A picture sent as a file is fetched (and decrypted) here; a GIF already has its address.
function BlobSlide({ item, dm }) {
  const { url, err, expired, verdict } = useBlobUrl(item.att, dm, true);
  const [shown, show] = useReveal(item.att.id);
  if (verdict === 'block') return <span className="lb-wait">This image may contain nudity or explicit content</span>;
  if (url && (verdict === 'blur' || verdict === 'unknown') && !shown) return <button className="lb-wait" onClick={show}>{verdict === 'unknown' ? "Couldn't check this image. Click to show" : 'Sensitive image. Click to show'}</button>;
  if (url) return <img src={url} alt={item.name} draggable={false} />;
  return <span className="lb-wait">{expired ? 'This image has expired' : err ? 'Could not load image' : 'Loading…'}</span>;
}

// Opens one image full size. When the message has several, the arrow buttons, the left/right keys and a swipe step through them
// (view.items is the list, view.index the one that was clicked; see Attachments).
export function Lightbox({ view, onClose }) {
  const items = view.items?.length ? view.items : [{ key: 'one', url: view.url, name: view.name, att: view.att }];
  const [i, setI] = useState(Math.min(Math.max(view.index || 0, 0), items.length - 1));
  const touch = useRef(null);
  const many = items.length > 1;
  const item = items[i];
  const step = useCallback((d) => setI((n) => Math.min(items.length - 1, Math.max(0, n + d))), [items.length]);

  useEffect(() => {
    const h = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, step]);

  // fetch the next and previous picture ahead of time (loadBlob keeps them), so stepping is instant
  useEffect(() => {
    for (const n of [i - 1, i + 1]) { const it = items[n]; if (it?.att) loadBlob(it.att, view.dm).catch(() => {}); }
  }, [i]); // eslint-disable-line react-hooks/exhaustive-deps

  const onTouchStart = (e) => { touch.current = many && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; };
  const onTouchEnd = (e) => {
    const t = touch.current; touch.current = null;
    if (!t || !e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - t.x, dy = e.changedTouches[0].clientY - t.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1); // swipe left = next, swipe right = previous
  };

  return (
    <div className="lightbox" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {item.att
        ? <BlobSlide key={item.key} item={item} dm={view.dm} />
        : <img key={item.key} src={item.url} alt={item.name} referrerPolicy="no-referrer" draggable={false} />}
      {many && <button className="lb-nav prev" title="Previous image" aria-label="Previous image" disabled={i === 0} onClick={() => step(-1)}><Icon name="chevron" size={26} /></button>}
      {many && <button className="lb-nav next" title="Next image" aria-label="Next image" disabled={i === items.length - 1} onClick={() => step(1)}><Icon name="chevron" size={26} /></button>}
      <div className="lightbox-bar">
        <span>{item.name}</span>
        {many && <span className="lb-count" aria-live="polite">{i + 1} / {items.length}</span>}
        {item.att && <button className="icon-btn" title="Download" onClick={() => saveAttachment(item.att, view.dm).catch(() => {})}><Icon name="download" size={18} /></button>}
        <button className="icon-btn" title="Close" onClick={onClose}><Icon name="close" size={18} /></button>
      </div>
    </div>
  );
}

export function Popover({ onClose, className = '', children }) {
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
