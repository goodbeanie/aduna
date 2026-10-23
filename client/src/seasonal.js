// Limited-time themes. They show up in Settings > Appearance only while their event's window is open (the same window as the
// event's ringtone: 14 days before through 7 days after, see ringtones.js), and the little decorations (cobwebs, presents...)
// are drawn by CSS keyed on <html data-season="halloween|christmas"> (styles.css, "seasonal themes"; pictures in public/deco).
// Pure: no React, no DOM. client/scripts/seasonal-test.mjs tests it.
import { seasonOf } from './ringtones.js';

export const SEASONAL_THEMES = [
  { id: 'haunted',   icon: '\u{1F383}', name: 'Haunted Night', season: 'halloween', dark: true,  bg: '#1b1024', accent: '#ff8a1f' },
  { id: 'candycorn', icon: '\u{1F36C}', name: 'Candy Corn',    season: 'halloween', dark: false, bg: '#fff5e1', accent: '#e8731a' },
  { id: 'winter',    icon: '\u{1F384}', name: 'Winter Night',  season: 'christmas', dark: true,  bg: '#10261e', accent: '#ef4b41' },
  { id: 'candycane', icon: '\u{1F381}', name: 'Candy Cane',    season: 'christmas', dark: false, bg: '#fff7f4', accent: '#c8312c' },
];

// The limited-time themes open on `now`: { season, label, until: Date (last day, or null in developer test mode), themes: [...] } or null.
export function seasonalNow(now = new Date()) {
  const f = seasonOf(now);
  if (!f) return null;
  return { season: f.special.id, label: f.special.label, until: f.end, themes: SEASONAL_THEMES.filter((t) => t.season === f.special.id) };
}

// A saved theme id -> the theme, but only while it is open. Out of season it is null (the app then shows the default look,
// and the choice is kept, so it comes back next year).
export function seasonalTheme(id, now = new Date()) {
  const t = SEASONAL_THEMES.find((x) => x.id === id);
  if (!t) return null;
  const n = seasonalNow(now);
  return n && n.season === t.season ? t : null;
}
