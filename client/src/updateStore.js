import { useEffect, useState, useSyncExternalStore } from 'react';
import { isNativeApp } from './notify.js';

// One shared picture of "is there an update" for the phone layout: UpdatePrompt (the Android app's new build) and SiteUpdateNotice (the site itself)
// both report here, and the status chip in the server bar (RailUpdate.jsx) shows it, the same chip the desktop app shows on the right of its server bar.
let s = { apk: null, apkState: 'idle', pct: -1, why: '', site: false, checking: false, none: false };
const subs = new Set();
export const update = (patch) => { s = { ...s, ...patch }; subs.forEach((f) => f()); };
export const useUpdateState = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => s);
export const actions = {}; // apkGo, apkLater: set by UpdatePrompt while it is mounted

// The first round of checks after the page opens is announced ("Checking for update…", then "No update available" for 10 s), like the desktop app does.
const waiting = new Set();
let noneTimer = 0;
export function expectCheck(kind) { waiting.add(kind); update({ checking: true }); }
export function checkDone(kind, ok) {
  if (!waiting.delete(kind) || waiting.size) return;
  update({ checking: false });
  if (ok && !s.apk && !s.site) { update({ none: true }); clearTimeout(noneTimer); noneTimer = setTimeout(() => update({ none: false }), 10000); }
}

// Phones (narrow screens) and the Android app get the chip in the server bar; computers keep the floating box.
const wide = () => !isNativeApp() && !(window.matchMedia && window.matchMedia('(max-width: 720px)').matches);
export function useRailMode() {
  const [rail, setRail] = useState(() => !wide());
  useEffect(() => {
    const q = window.matchMedia ? window.matchMedia('(max-width: 720px)') : null;
    const f = () => setRail(!wide());
    f(); q?.addEventListener?.('change', f);
    return () => q?.removeEventListener?.('change', f);
  }, []);
  return rail;
}
