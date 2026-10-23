// Which microphone, camera and speakers Aduna uses. Saved on this device only (device ids mean nothing on another computer).
// Calls, voice channels, the ringtone and the tests in Settings > Voice & Video all read it from here.
// A saved device that is unplugged just falls back to the system default: every constraint uses `ideal`, never `exact`.

const KEY = 'aduna-devices'; // { mic, cam, out }: device ids, '' = system default
export const EVENT = 'aduna:devices';

export function loadDevices() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null') || {};
    const id = (v) => (typeof v === 'string' && v.length < 300 ? v : '');
    return { mic: id(s.mic), cam: id(s.cam), out: id(s.out) };
  } catch { return { mic: '', cam: '', out: '' }; }
}
export function saveDevices(patch) {
  const next = { ...loadDevices(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: lasts until the page closes */ }
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: next })); } catch { /* no window */ }
  return next;
}

// getUserMedia constraint pieces for the chosen devices ('' = default, so nothing extra is asked).
export const micConstraint = (d = loadDevices()) => (d.mic ? { deviceId: { ideal: d.mic } } : {});
export const camConstraint = (d = loadDevices()) => (d.cam ? { deviceId: { ideal: d.cam } } : {});

// Choosing speakers needs setSinkId (Chrome, Edge, Android WebView; not Firefox or iPhone Safari).
export const canPickOutput = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
// Point an <audio>/<video> at the chosen speakers. Never throws: a missing device leaves it on the default.
export function applyOutput(el, d = loadDevices()) {
  if (!el || !canPickOutput()) return Promise.resolve(false);
  const want = d.out || '';
  if ((el.sinkId || '') === want) return Promise.resolve(true);
  return el.setSinkId(want).then(() => true, () => false);
}

// { mics, cams, outs } as [{ id, label }]. Labels are blank until the person has allowed the microphone once.
export async function listDevices() {
  const out = { mics: [], cams: [], outs: [], labelled: true };
  if (!navigator.mediaDevices?.enumerateDevices) return out;
  const all = await navigator.mediaDevices.enumerateDevices();
  const n = { audioinput: 0, videoinput: 0, audiooutput: 0 };
  for (const d of all) {
    if (!(d.kind in n)) continue;
    n[d.kind]++;
    if (!d.label) out.labelled = false;
    const item = { id: d.deviceId, label: d.label || ({ audioinput: 'Microphone ', videoinput: 'Camera ', audiooutput: 'Speakers ' }[d.kind] + n[d.kind]) };
    (d.kind === 'audioinput' ? out.mics : d.kind === 'videoinput' ? out.cams : out.outs).push(item);
  }
  return out;
}
export const onDeviceChange = (fn) => {
  const md = navigator.mediaDevices;
  if (!md?.addEventListener) return () => {};
  md.addEventListener('devicechange', fn);
  return () => md.removeEventListener('devicechange', fn);
};
