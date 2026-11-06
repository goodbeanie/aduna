// Soundboard: short sounds anyone in a voice channel can play for everyone in that channel (the buttons are in Soundboard.jsx, playing is in Voice.jsx).
// The numbers and rules are mirrored from server/soundboard.js (the server repeats every check; this only decides what to show).
import { can, heldRoles } from './perms.js';
import { applyOutput } from './devices.js';

export const SOUND = { sounds: 24, name: 24, emoji: 8, bytes: 256 * 1024, secs: 5, burst: 40, windowMs: 5000 };
export const OFF_MESSAGE = 'The soundboard is turned off on this server';
export const WHO_MESSAGE = 'You are not allowed to use the soundboard on this server';

// A sound is fetched by its own id (members only); the clip never changes, so the browser may keep it.
export const soundUrl = (serverId, soundId) => `/api/servers/${serverId}/sounds/${soundId}/audio`;

// The settings as the server sends them (a server that never touched them: on, for everyone).
export function settingsOf(server) {
  const b = (server && server.soundboard) || {};
  return {
    enabled: b.enabled !== false,
    who: b.who === 'roles' ? 'roles' : 'everyone',
    roles: Array.isArray(b.roles) ? b.roles.filter((id) => typeof id === 'string') : [],
  };
}

// May this person play sounds? Returns null when yes, else the reason as a sentence.
// The owner and administrators can always play (while the soundboard is on).
export function whyNotPlay(server, uid) {
  const cfg = settingsOf(server);
  if (!cfg.enabled) return OFF_MESSAGE;
  if (cfg.who === 'everyone' || uid === server.ownerId || can(server, uid, 'administrator')) return null;
  return heldRoles(server, uid).some((r) => cfg.roles.includes(r.id)) ? null : WHO_MESSAGE;
}

// ---------- playing ----------
// Every browser in the channel plays the clip itself when the server announces it. Presses overlap freely (spam away); only a very large pile-up
// cuts the oldest clip off, so a flood cannot choke the browser. `volume` is 0 to 1 (the listener's volume for the person who played it).
const clips = new Set();
const MAX_AT_ONCE = 32;
function stop(a) {
  clips.delete(a);
  try { a.pause(); a.removeAttribute('src'); a.load(); } catch { /* already gone */ }
}
export function stopAllClips() { [...clips].forEach(stop); }
export function playClip(url, volume = 1) {
  if (typeof Audio === 'undefined') return;
  const a = new Audio(url);
  a.volume = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1));
  a.onended = a.onerror = () => stop(a);
  clips.add(a);
  while (clips.size > MAX_AT_ONCE) stop(clips.values().next().value);
  applyOutput(a).then(() => a.play()).catch(() => stop(a)); // the speakers chosen in Settings > Voice & Video; a refused play just ends quietly
}
