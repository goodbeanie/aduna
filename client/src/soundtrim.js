// Audio trimming (browser only), for soundboard sounds and profile songs. When the chosen file is longer (or heavier) than allowed, the person picks the part
// they want (SoundTrim.jsx) and this file turns that part into a small mono WAV, which the server already accepts.
import { SOUND } from './soundboard.js';

const MIN_SECS = 0.1;

const AC = () => (typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null);
const OAC = () => (typeof window !== 'undefined' ? window.OfflineAudioContext || window.webkitOfflineAudioContext : null);
export const canTrim = () => !!AC() && !!OAC();

// Reads the whole file into an AudioBuffer. Throws a sentence the person can read.
export async function decodeSound(file) {
  const Ctx = AC();
  if (!Ctx) throw new Error('This browser cannot cut audio. Choose a clip of up to ' + SOUND.secs + ' seconds instead.');
  const ctx = new Ctx();
  try {
    const data = await file.arrayBuffer();
    return await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(data, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  } catch {
    throw new Error('That file could not be read as audio');
  } finally {
    try { ctx.close(); } catch { /* already closed */ }
  }
}

// n loudness values (0 to 1) across the whole sound, for drawing the wave.
export function peaksOf(buf, n = 480) {
  const out = new Float32Array(n), len = buf.length, step = Math.max(1, Math.floor(len / n));
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let m = 0;
      const a = i * step, b = Math.min(len, a + step), hop = Math.max(1, (b - a) >> 5);
      for (let j = a; j < b; j += hop) { const v = Math.abs(d[j]); if (v > m) m = v; }
      if (m > out[i]) out[i] = m;
    }
  }
  return out;
}

// Cuts [start, end] seconds out of the sound and returns it as a WAV File (a few milliseconds of fade at each end so it does not click).
// `maxSecs` / `maxBytes` are the limits of whatever it is for (a soundboard sound, or a profile song). A WAV is big, so the sample rate is chosen to make
// the longest allowed part fit: 5 seconds in 256 KB is about 26 kHz; 30 seconds in 1 MB is 16 kHz. Shorter parts get a higher rate (better quality).
export const rateFor = (secs, maxBytes) => Math.max(8000, Math.min(44100, Math.floor((maxBytes - 44 - 1024) / (2 * Math.max(MIN_SECS, secs)))));
export async function clipToWav(buf, start, end, baseName = 'sound', { maxSecs = SOUND.secs, maxBytes = SOUND.bytes } = {}) {
  const Off = OAC();
  const from = Math.max(0, Math.min(start, buf.duration - MIN_SECS));
  const secs = Math.min(maxSecs, Math.max(MIN_SECS, Math.min(end, buf.duration) - from));
  const rate = rateFor(secs, maxBytes);
  const len = Math.max(1, Math.round(secs * rate));
  const off = new Off(1, len, rate);
  const src = off.createBufferSource();
  src.buffer = buf; src.connect(off.destination); src.start(0, from, secs);
  const rendered = await off.startRendering();
  const data = rendered.getChannelData(0);

  const view = new DataView(new ArrayBuffer(44 + len * 2));
  const text = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + len * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, len * 2, true);
  const fade = Math.min(Math.round(rate * 0.008), len >> 1);
  for (let i = 0; i < len; i++) {
    let v = data[i];
    if (fade && i < fade) v *= i / fade; else if (fade && i >= len - fade) v *= (len - 1 - i) / fade;
    v = Math.max(-1, Math.min(1, v));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  const name = (String(baseName).replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 60) || 'sound') + '.wav';
  return new File([view.buffer], name, { type: 'audio/wav' });
}
