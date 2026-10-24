// Squeeze a video under the attachment limit inside the browser, with no extra libraries:
// the video is played into a smaller canvas and that picture (plus the sound) is recorded again at a lower bitrate.
// It runs in real time, so a 2 minute video takes about 2 minutes. The original file is never changed.
import { MAX_FILE, sizeLabel } from './files.js';

export const COMPRESS_TARGET = 18 * 1024 * 1024; // aim a little under the 20 MB limit, encoders always overshoot a bit
const AUDIO_BPS = 64000;
const MIN_VIDEO_BPS = 120000; // below this the picture would be unwatchable: the video is too long to fit

// [what MediaRecorder is asked for, the plain type the server and the players know]. mp4 first: it seeks properly.
const TYPES = [
  ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'],
  ['video/mp4', 'video/mp4'],
  ['video/webm;codecs=vp9,opus', 'video/webm'],
  ['video/webm;codecs=vp8,opus', 'video/webm'],
  ['video/webm', 'video/webm'],
];
const pickType = () => (typeof MediaRecorder === 'undefined' ? null : TYPES.find(([m]) => MediaRecorder.isTypeSupported(m)) || null);

export function canCompress() {
  try {
    return !!pickType() && !!HTMLCanvasElement.prototype.captureStream && !!(window.AudioContext || window.webkitAudioContext);
  } catch { return false; }
}

const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });

// Returns a smaller File (video/mp4 or video/webm). onProgress gets 0..1. Abort the signal to cancel.
export async function compressVideo(file, { onProgress, signal } = {}) {
  const pick = pickType();
  if (!pick || !canCompress()) throw new Error('This browser cannot compress video');
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  let ac = null, stream = null, rec = null, stopped = false, hidden = null;
  try {
    video.preload = 'auto'; video.playsInline = true; video.src = url;
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('This video could not be read')); });
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !video.videoWidth) throw new Error('This video could not be read');

    // what the size limit allows, per second, minus the sound and a safety margin
    const videoBps = Math.floor((COMPRESS_TARGET * 8 * 0.85) / duration - AUDIO_BPS);
    if (videoBps < MIN_VIDEO_BPS) throw new Error('Too long to fit in 20 MB. Trim it first');
    const longSide = videoBps >= 2500000 ? 1280 : videoBps >= 1200000 ? 854 : videoBps >= 500000 ? 640 : 426; // 720p, 480p, 360p, 240p
    const scale = Math.min(1, longSide / Math.max(video.videoWidth, video.videoHeight));
    const even = (n) => Math.max(2, Math.round((n * scale) / 2) * 2);
    const w = even(video.videoWidth), h = even(video.videoHeight);

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext('2d', { alpha: false });
    ac = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ac.createMediaStreamDestination(); // the sound goes to the recording only, not out of the speakers
    ac.createMediaElementSource(video).connect(dest);
    stream = canvas.captureStream(30);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

    const chunks = [];
    rec = new MediaRecorder(stream, { mimeType: pick[0], videoBitsPerSecond: videoBps, audioBitsPerSecond: AUDIO_BPS });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const finished = new Promise((resolve, reject) => {
      rec.onstop = resolve;
      rec.onerror = (e) => reject(e.error || new Error('Compressing failed'));
      video.onerror = () => reject(new Error('This video could not be played'));
      video.onended = () => { stopped = true; if (rec.state !== 'inactive') rec.stop(); };
      signal?.addEventListener('abort', () => { stopped = true; video.pause(); if (rec.state !== 'inactive') rec.stop(); });
    });

    // a hidden tab stops painting frames, so the video and the recording pause together and carry on when it is back
    hidden = () => {
      if (stopped || !rec || rec.state === 'inactive') return;
      if (document.hidden) { video.pause(); if (rec.state === 'recording') rec.pause(); }
      else { if (rec.state === 'paused') rec.resume(); video.play().catch(() => {}); }
    };
    document.addEventListener('visibilitychange', hidden);

    const draw = () => {
      if (stopped) return;
      g.drawImage(video, 0, 0, w, h);
      onProgress?.(Math.min(1, video.currentTime / duration));
      next();
    };
    const next = () => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(draw) : requestAnimationFrame(draw));

    rec.start(1000);
    await ac.resume();
    await video.play();
    draw();
    await finished;

    if (signal?.aborted) throw cancelled();
    const blob = new Blob(chunks, { type: pick[1] });
    if (!blob.size) throw new Error('Compressing failed');
    if (blob.size > MAX_FILE) throw new Error(`Still ${sizeLabel(blob.size)} after compressing`);
    const name = (file.name || 'video').replace(/\.[^.]+$/, '') + (pick[1] === 'video/mp4' ? '.mp4' : '.webm');
    return new File([blob], name, { type: pick[1] }); // the plain type: the server only plays mp4 and webm inline
  } finally {
    stopped = true;
    if (hidden) document.removeEventListener('visibilitychange', hidden);
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
    try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { ac?.close(); } catch {}
    URL.revokeObjectURL(url);
  }
}
