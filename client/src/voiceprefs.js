// What YOU chose for each person in a voice channel, kept on this device only (nobody else sees it, and it is not sent to the server):
//   vol     0 to 150, how loud that person is for you (100 = as sent; above 100 boosts). It also scales their soundboard sounds, up to 100.
//   mute    you do not hear that person speak
//   sbMute  you do not hear the soundboard sounds that person plays
// Set from the right-click menu on their tile (Voice.jsx), applied in Voice.jsx (their voice) and when a sound arrives.
import { useSyncExternalStore } from 'react';

const KEY = 'aduna.voiceUserPrefs';
export const VOL = { min: 0, max: 150, normal: 100 };
const DEFAULT = Object.freeze({ vol: VOL.normal, mute: false, sbMute: false });

export const cleanVol = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(VOL.max, Math.max(VOL.min, n)) : VOL.normal;
};

let cache = null;
const subs = new Set();
function load() {
  if (cache) return cache;
  cache = {};
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [id, p] of Object.entries(raw)) if (p && typeof p === 'object') cache[id] = { vol: cleanVol(p.vol ?? VOL.normal), mute: !!p.mute, sbMute: !!p.sbMute };
  } catch { /* no storage, or it holds junk: start from the defaults */ }
  return cache;
}

export const prefsOf = (id) => ({ ...DEFAULT, ...(load()[id] || {}) });

export function setPrefs(id, patch) {
  const next = { ...prefsOf(id), ...patch };
  next.vol = cleanVol(next.vol);
  next.mute = !!next.mute; next.sbMute = !!next.sbMute;
  const all = { ...load() };
  if (next.vol === DEFAULT.vol && !next.mute && !next.sbMute) delete all[id]; else all[id] = next; // all-default entries are not kept
  cache = all;
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private mode: it lasts until the page closes */ }
  subs.forEach((f) => f());
}

const subscribe = (f) => { subs.add(f); return () => { subs.delete(f); }; };
// React hook: the settings for one person; the component re-renders when they change.
export function useUserPrefs(id) {
  const all = useSyncExternalStore(subscribe, load);
  return { ...DEFAULT, ...(all[id] || {}) };
}
// The same for a whole list of people at once (the tiles).
export const useAllUserPrefs = () => useSyncExternalStore(subscribe, load);

// How loud a sound played by this person should be: their volume, but a clip cannot be louder than it is (0 to 1).
export const soundVolume = (p) => Math.min(1, p.vol / VOL.normal);
