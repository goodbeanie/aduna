// Every sound a call makes (browser only; Call.jsx is the one caller).
//   - incoming ring: the MP3 ringtone from public/sounds, looped until the call is answered, declined or missed.
//     Which file plays is decided by ringtones.js (the normal one, or Halloween / Christmas around their dates).
//   - outgoing ring: the caller hears the SAME ringtone while waiting (so both sides hear Halloween / Christmas).
//   - small cues, like Discord's: connected, disconnected, muted, unmuted, deafened, undeafened.
import { ringtoneFor } from './ringtones.js';
import { applyOutput } from './devices.js';

const VOLUME = 0.8; // of the MP3
const CUE = 0.05;   // gain of the generated blips (they are meant to be quiet)

// ---------- Web Audio (blips, ringback, the speaking meter in Call.jsx) ----------
let audioCtx = null;
export function ctx() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

// notes: [frequency Hz, start offset s, length s]. Each note fades in and out quickly so it never clicks.
function notes(list, gain = CUE) {
  try {
    const c = ctx(), t0 = c.currentTime + 0.01;
    for (const [freq, at, len] of list) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(gain, t0 + at + 0.012);
      g.gain.linearRampToValueAtTime(0, t0 + at + len);
      o.connect(g); g.connect(c.destination);
      o.start(t0 + at); o.stop(t0 + at + len + 0.02);
    }
  } catch { /* sound is best effort */ }
}
export const cue = {
  connect: () => notes([[587, 0, 0.1], [880, 0.09, 0.16]]),
  disconnect: () => notes([[880, 0, 0.1], [587, 0.09, 0.2]]),
  mute: () => notes([[392, 0, 0.11]]),
  unmute: () => notes([[587, 0, 0.11]]),
  deafen: () => notes([[440, 0, 0.09], [330, 0.08, 0.13]]),
  undeafen: () => notes([[330, 0, 0.09], [440, 0.08, 0.13]]),
};

// Browsers keep sound blocked until the page has had a click or key press, which made incoming calls ring silently.
// Wake audio on the first interaction. (Notification permission is asked in NotifyPrompt / Settings.)
const interactions = ['pointerdown', 'keydown'];
if (typeof window !== 'undefined') {
  const unlock = () => { try { ctx(); } catch { /* no audio support */ } };
  for (const e of interactions) window.addEventListener(e, unlock, { once: true });
}

// ---------- ringing ----------
let ring = null; // { kind, el?, timer?, retry? }

// The old generated "two-tone" ring: only used when the MP3 cannot be played at all, so a call never rings silently.
function beepRing() {
  const play = () => notes([[440, 0, 0.35], [520, 0.42, 0.35]], 0.06);
  play();
  return setInterval(play, 2200);
}

let warm = null; // { url, el }: the ringtone element kept loaded, so a ring starts at once instead of waiting for a download
function elementFor(url) {
  if (warm && warm.url === url) return warm.el;
  const el = new Audio(url); el.preload = 'auto';
  warm = { url, el };
  return el;
}
// Load today's ringtone in the background (called when the app starts).
export function preloadRingtone(now = new Date()) {
  try { elementFor(ringtoneFor(now).url).load(); } catch { /* nothing to warm up */ }
}

export function startRing(kind, now = new Date()) {
  stopRing();
  const me = (ring = { kind }); // kind: 'in' (someone is calling you) or 'out' (you are calling): both play the ringtone
  let el;
  try { el = elementFor(ringtoneFor(now).url); } catch { me.timer = beepRing(); return; }
  me.el = el;
  el.loop = true; el.volume = VOLUME;
  applyOutput(el); // the speakers chosen in Settings > Voice & Video
  try { el.currentTime = 0; } catch { /* not loaded yet */ }
  me.onError = () => { if (ring === me && !me.timer) me.timer = beepRing(); }; // the file is missing or cannot be decoded
  el.addEventListener('error', me.onError);
  if (el.error) me.onError();
  const start = () => {
    if (ring !== me) return;
    const p = el.play();
    if (p && p.catch) p.catch((e) => {
      if (ring !== me || e?.name === 'AbortError') return;
      if (e?.name !== 'NotAllowedError') { me.onError(); return; }
      // blocked because the page has not been clicked yet: try again on the first click or key press
      const again = () => { for (const ev of interactions) window.removeEventListener(ev, again); me.retry = null; start(); };
      me.retry = again;
      for (const ev of interactions) window.addEventListener(ev, again, { once: true });
    });
  };
  start();
}

export function stopRing() {
  const r = ring; ring = null;
  if (!r) return;
  clearInterval(r.timer);
  if (r.retry) for (const ev of interactions) window.removeEventListener(ev, r.retry);
  if (r.el) {
    r.el.removeEventListener('error', r.onError);
    try { r.el.pause(); r.el.currentTime = 0; } catch { /* already gone */ } // kept loaded for the next call
  }
}
export const ringing = () => ring?.kind || null;

// Settings > Voice & Video "Test speakers": today's ringtone once, through the chosen speakers. Returns a stop function;
// `onEnd(why)` is called when it finishes ('done'), is stopped ('stopped') or cannot play ('error' | 'blocked').
let preview = null;
export function testSpeakers(onEnd = () => {}, now = new Date()) {
  stopTest();
  const el = new Audio(ringtoneFor(now).url);
  el.volume = VOLUME;
  const me = (preview = { el, onEnd });
  const end = (why) => { if (preview === me) preview = null; el.onended = el.onerror = null; try { el.pause(); } catch { /* gone */ } onEnd(why); };
  el.onended = () => end('done');
  el.onerror = () => end('error');
  applyOutput(el).then(() => {
    if (preview !== me) return;
    const p = el.play();
    if (p && p.catch) p.catch((e) => end(e?.name === 'NotAllowedError' ? 'blocked' : 'error'));
  });
  return () => end('stopped');
}
export function stopTest() { const p = preview; if (p) { preview = null; p.el.onended = p.el.onerror = null; try { p.el.pause(); } catch { /* gone */ } p.onEnd('stopped'); } }
