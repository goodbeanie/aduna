// Which ringtone an incoming call plays. Pure (no React, no audio): client/scripts/ringtones-test.mjs tests it in Node.
//
// The normal Aduna ringtone plays all year. The two special ones take over around their event:
//   starting DAYS_BEFORE (14) days before the event, through DAYS_AFTER (7) days after it (the event day itself is inside the window).
//   Halloween (31 Oct):  17 Oct - 7 Nov
//   Christmas (25 Dec):  11 Dec - 1 Jan
// "Day" means the calendar day on the person's own device, so it flips at their local midnight, not at UTC midnight.
// To add another one, put its file in client/public/sounds and add a line to SEASONAL.

export const DAYS_BEFORE = 14;
export const DAYS_AFTER = 7;

export const DEFAULT_RINGTONE = { id: 'default', label: 'Aduna', url: '/sounds/ringtone.mp3' };
export const SEASONAL = [
  { id: 'halloween', label: 'Halloween', url: '/sounds/ringtone-halloween.mp3', month: 10, day: 31 }, // month is 1-12
  { id: 'christmas', label: 'Christmas', url: '/sounds/ringtone-christmas.mp3', month: 12, day: 25 },
];

// Developer test mode (Settings > Developer): act as if this event's window were open, whatever the date. null = the real calendar.
// App.jsx sets it from the signed-in account; the themes (seasonal.js), the decorations and the ringtone all follow seasonOf(), so they follow it too.
let forced = null;
export function forceSeason(id) { forced = SEASONAL.some((s) => s.id === id) ? id : null; }
export const forcedSeason = () => forced;

// A whole-number day count for a calendar date. Built from UTC so daylight-saving changes can never shift a day by one.
const dayNumber = (year, month, day) => Math.floor(Date.UTC(year, month - 1, day) / 86400000);

// The first and last calendar day (as Date objects at local midnight) of a special ringtone's window for the event in `year`.
export function windowOf(special, year) {
  return {
    from: new Date(year, special.month - 1, special.day - DAYS_BEFORE),
    to: new Date(year, special.month - 1, special.day + DAYS_AFTER),
  };
}

// The special event whose window contains `now`: { special, end } (end = last day of the window, a Date at local midnight), or null.
// Ringtones and the limited-time themes (seasonal.js) both use this, so they always start and stop together. `end` is null in test mode.
export function seasonOf(now = new Date()) {
  if (forced) return { special: SEASONAL.find((s) => s.id === forced), end: null }; // test mode: no end date
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  const year = now.getFullYear();
  const today = dayNumber(year, now.getMonth() + 1, now.getDate());
  for (const s of SEASONAL) {
    // last year's, this year's and next year's event, so a window that crosses New Year (Christmas, in early January) is found too
    for (let y = year - 1; y <= year + 1; y++) {
      const event = dayNumber(y, s.month, s.day);
      if (today >= event - DAYS_BEFORE && today <= event + DAYS_AFTER) return { special: s, end: new Date(y, s.month - 1, s.day + DAYS_AFTER) };
    }
  }
  return null;
}

// The ringtone to play on `now`: { id, label, url }.
export function ringtoneFor(now = new Date()) {
  const f = seasonOf(now);
  return f ? { id: f.special.id, label: f.special.label, url: f.special.url } : DEFAULT_RINGTONE;
}
