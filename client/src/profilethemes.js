import { useEffect, useState } from 'react';
import { api } from './api.js';

// The look of the gradient profile themes. The server owns the list (prices, colours, what you own); this keeps one copy in memory
// so a profile card can draw any theme from just its id (`user.profileTheme`).
let cache = null, inflight = null;
const subs = new Set();

export function setProfileThemes(list) { cache = Array.isArray(list) ? list : null; for (const f of subs) f(cache); }

export function loadProfileThemes(force = false) {
  if (cache && !force) return Promise.resolve(cache);
  if (!inflight) inflight = api('/profile-themes').then((r) => { setProfileThemes(r.themes); return cache; }).catch(() => cache).finally(() => { inflight = null; });
  return inflight;
}

export function useProfileThemes() {
  const [list, setList] = useState(cache);
  useEffect(() => { subs.add(setList); if (!cache) loadProfileThemes(); else setList(cache); return () => { subs.delete(setList); }; }, []);
  return list;
}

export const CUSTOM_THEME_ID = 'custom';
export const findProfileTheme = (list, id) => (id && list ? list.find((t) => t.id === id) || null : null);
export const themeGradient = (t) => `linear-gradient(${t.angle}deg, ${t.colors.join(', ')})`;

// The theme to draw for a person: one of the server's presets by id, or their own custom gradient (user.profileGradient).
export function userTheme(list, user) {
  const id = user?.profileTheme;
  if (!id) return null;
  if (id === CUSTOM_THEME_ID) {
    const g = user.profileGradient;
    return g && Array.isArray(g.colors) && g.colors.length >= 2 ? { id, name: 'Custom', colors: g.colors, angle: Number.isFinite(g.angle) ? g.angle : 135, animated: false } : null;
  }
  return findProfileTheme(list, id);
}
export const useUserTheme = (user) => userTheme(useProfileThemes(), user);

// How light a #rrggbb colour looks (0 = black, 1 = white)
function lightness(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}

// The inline style that paints a profile card (everything under the banner) with the theme's gradient. The writing switches to dark or light
// so it stays readable whatever the app theme is, and the ring round the profile picture takes the gradient's first colour.
export function themeCardStyle(t) {
  const light = t.colors.reduce((s, c) => s + lightness(c), 0) / t.colors.length > 0.4;
  const ink = light ? '#14110d' : '#fbf8f1';
  return {
    backgroundImage: themeGradient(t),
    '--bg2': t.colors[0],
    '--text': ink, '--head': light ? '#14110d' : '#ffffff',
    '--muted': light ? '#14110dc0' : '#fbf8f1c4',
    '--line': light ? '#14110d33' : '#ffffff33',
    color: ink,
  };
}

// The same idea for a whole page (a creator's Clips page): the gradient fills the page and the dark page palette (.yt-dash in dash.css)
// is swapped for one that reads on it. Used with the .cs-themed rules in clipssite.css, which cover the places that hard-code a colour.
export function themePageStyle(t) {
  const light = t.colors.reduce((s, c) => s + lightness(c), 0) / t.colors.length > 0.4;
  const ink = light ? '#14110d' : '#fbf8f1';
  const inv = light ? '#fbf8f1' : '#14110d';
  const veil = light ? '20,17,13' : '255,255,255';
  return {
    backgroundImage: themeGradient(t),
    '--bg': t.colors[0], '--bg2': t.colors[0], '--bg3': `rgba(${veil},.14)`, '--field': `rgba(${veil},.1)`, '--raised': `rgba(${veil},.18)`,
    '--line': `rgba(${veil},.22)`, '--line2': `rgba(${veil},.45)`,
    '--text': ink, '--head': ink, '--muted': light ? '#14110dc0' : '#fbf8f1c4', '--placeholder': light ? '#14110d8c' : '#fbf8f18c',
    '--ink': ink, '--ink-h': ink, '--on-ink': inv, '--chip-on': ink, '--link': ink,
    '--hover': `rgba(${veil},.16)`, '--sel': `rgba(${veil},.16)`,
    '--pt-ink': ink, '--pt-inv': inv, '--pt-veil': veil,
    color: ink,
  };
}
