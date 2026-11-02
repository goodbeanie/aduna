// Events (called "gatherings" on the server, see server/gatherings.js): the browser's side of the rules, time words, and the four calls.
// Times travel as milliseconds since 1970 and are always shown in the viewer's own time zone.
import { api } from './api.js';

export const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export const SOON_MS = 15 * MIN;   // "starting soon" (the server sends its reminder at the same moment)
export const KEEP_MS = HOUR;       // an event that ended stays on the list this long (the server drops it after that)
export const LIMITS = { title: 60, desc: 500 };

// 'live' (under way) | 'soon' (starts within 15 minutes) | 'upcoming' | 'over'
export function phaseOf(g, now = Date.now()) {
  if (now >= g.endsAt) return 'over';
  if (now >= g.startsAt) return 'live';
  if (g.startsAt - now <= SOON_MS) return 'soon';
  return 'upcoming';
}

// Events that are not over, or ended less than an hour ago, soonest first (the server already sorts; this also drops what ended while the page was open)
export function listFor(server, now = Date.now()) {
  return (server?.gatherings || []).filter((g) => g.endsAt + KEEP_MS > now).slice().sort((a, b) => a.startsAt - b.startsAt);
}
export const upcomingCount = (server, now = Date.now()) => (server?.gatherings || []).filter((g) => g.endsAt > now).length;
export const liveNow = (server, now = Date.now()) => (server?.gatherings || []).some((g) => g.startsAt <= now && now < g.endsAt);

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const clock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// "Today at 8:00 PM", "Tomorrow at 8:00 PM", "Fri, Nov 6 at 8:00 PM" (with the year when it is not this year)
export function whenLabel(ms, now = Date.now()) {
  const d = new Date(ms), n = new Date(now);
  const t = clock(d);
  if (sameDay(d, n)) return `Today at ${t}`;
  if (sameDay(d, new Date(now + DAY))) return `Tomorrow at ${t}`;
  if (sameDay(d, new Date(now - DAY))) return `Yesterday at ${t}`;
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== n.getFullYear()) opts.year = 'numeric';
  return `${d.toLocaleDateString([], opts)} at ${t}`;
}
// "8:00 PM – 10:00 PM" (the end gets its day when it is not the same day as the start)
export function rangeLabel(g, now = Date.now()) {
  const s = new Date(g.startsAt), e = new Date(g.endsAt);
  return `${whenLabel(g.startsAt, now)} \u2013 ${sameDay(s, e) ? clock(e) : whenLabel(g.endsAt, now)}`;
}
// The big little date block on a card: { month: 'NOV', day: 6 }
export function dateBlock(ms) {
  const d = new Date(ms);
  return { month: d.toLocaleDateString([], { month: 'short' }).toUpperCase(), day: d.getDate() };
}
const span = (ms) => {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) { const h = Math.floor(m / 60), r = m % 60; return r ? `${h} h ${r} min` : `${h} h`; }
  return `${Math.round(m / 1440)} days`;
};
// "Starts in 2 h 15 min", "Happening now", "Ended 12 min ago"
export function countdown(g, now = Date.now()) {
  const p = phaseOf(g, now);
  if (p === 'live') return 'Happening now';
  if (p === 'over') return `Ended ${span(now - g.endsAt)} ago`;
  return `Starts in ${span(g.startsAt - now)}`;
}

// <input type="datetime-local"> speaks "2026-11-06T20:00" in the viewer's own time zone
const pad = (n) => String(n).padStart(2, '0');
export const toInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const fromInput = (s) => { const t = new Date(s).getTime(); return Number.isFinite(t) ? t : NaN; };

// The next 8 pm: tonight when it is before 7 pm, otherwise tomorrow (the "game night" default)
export function defaultStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(20, 0, 0, 0);
  if (d.getTime() - now < HOUR) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// ---------- the calls (each answers { server }) ----------
export const createEvent = (serverId, body) => api(`/servers/${serverId}/gatherings`, { method: 'POST', body });
export const changeEvent = (serverId, id, body) => api(`/servers/${serverId}/gatherings/${id}`, { method: 'PATCH', body });
export const cancelEvent = (serverId, id) => api(`/servers/${serverId}/gatherings/${id}`, { method: 'DELETE' });
// status: 'yes' | 'maybe' | null (take the answer back)
export const answerEvent = (serverId, id, status) => api(`/servers/${serverId}/gatherings/${id}/rsvp`, { method: 'PUT', body: { status } });

// What I said about an event: 'yes' | 'maybe' | null
export const myAnswer = (g, meId) => (g.yes.includes(meId) ? 'yes' : g.maybe.includes(meId) ? 'maybe' : null);
