// Shared WebRTC helpers for DM calls (Call.jsx) and voice channels (Voice.jsx).
import { api } from './api.js';

// Public STUN only: enough to find each other on friendly networks, not enough behind strict NATs or firewalls.
export const FALLBACK_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

let cache = null;            // { servers, relay, at }
let inflight = null;
const MAX_AGE = 10 * 60 * 1000; // the server hands out credentials valid for hours; this only limits how often we ask

// { servers, relay }: relay is true when the server has a TURN server set up. Never throws.
export async function getIce({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < MAX_AGE) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await api('/call/config');
      if (Array.isArray(r.iceServers) && r.iceServers.length) cache = { servers: r.iceServers, relay: !!r.relay, at: Date.now() };
    } catch { /* keep whatever we had */ }
    return cache || { servers: FALLBACK_ICE, relay: false, at: 0 };
  })().finally(() => { inflight = null; });
  return inflight;
}

export const forgetIce = () => { cache = null; };

// Give a running connection fresh credentials and ask both sides to find a new path.
// Returns false if the browser cannot do it (the caller then gives up).
export async function restartPath(pc) {
  try {
    const { servers } = await getIce({ fresh: true });
    try { pc.setConfiguration({ ...pc.getConfiguration(), iceServers: servers }); } catch { /* older browsers: keep the old list */ }
    if (typeof pc.restartIce !== 'function') return false;
    pc.restartIce();
    return true;
  } catch { return false; }
}

// The bitrate cap and the "keep smooth or keep sharp" preference for what a video sender sends (a screen share). Without a cap the browser stays far
// below what 1080p at 60 fps needs. kbps 0 removes the cap again (used when the share ends). content: 'motion' | 'detail' | anything else = balanced.
export async function tuneSender(sender, kbps, content) {
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    if (kbps) p.encodings[0].maxBitrate = kbps * 1000; else delete p.encodings[0].maxBitrate;
    p.degradationPreference = content === 'motion' ? 'maintain-framerate' : content === 'detail' ? 'maintain-resolution' : 'balanced';
    await sender.setParameters(p);
  } catch { /* not supported here: the browser's own limits apply */ }
}

export const failureText = (relay) => relay
  ? 'The call could not connect. A firewall or network on one side may be blocking it.'
  : 'The call could not connect. Aduna has no relay server set up yet, so some networks cannot reach each other.';
