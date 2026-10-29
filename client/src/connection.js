import { useSyncExternalStore } from 'react';

// Is Aduna talking to the server? Two things can break that: the device goes offline (the browser says so), or the live
// connection (socket) drops while the device still thinks it is online: a server restart, bad Wi-Fi, a phone that woke up.
// ConnectionBar.jsx shows the result. App.jsx calls watchSocket() with the socket it opens.
let state = { offline: typeof navigator !== 'undefined' && navigator.onLine === false, down: false };
const subs = new Set();
let sock = null;

function set(patch) {
  const next = { ...state, ...patch };
  if (next.offline === state.offline && next.down === state.down) return;
  state = next;
  subs.forEach((f) => f());
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => set({ offline: true }));
  window.addEventListener('online', () => set({ offline: false }));
}

// Follows one socket until the returned function is called (call it before disconnecting on purpose, so logging out is not shown as a drop).
export function watchSocket(s) {
  sock = s;
  const up = () => set({ down: false });
  const dn = () => set({ down: true });
  s.on('connect', up);
  s.on('disconnect', dn);
  s.on('connect_error', dn);
  return () => {
    s.off('connect', up); s.off('disconnect', dn); s.off('connect_error', dn);
    if (sock === s) { sock = null; set({ down: false }); }
  };
}

// "Retry now": skip the wait before the next automatic attempt.
export function retryNow() {
  const s = sock;
  if (!s || s.connected) return;
  s.disconnect(); // ends the automatic retry timer, then connect() starts a fresh attempt at once
  s.connect();
}

const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export function useConnection() {
  return useSyncExternalStore(subscribe, () => state);
}
