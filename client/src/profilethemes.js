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

export const findProfileTheme = (list, id) => (id && list ? list.find((t) => t.id === id) || null : null);
export const themeGradient = (t) => `linear-gradient(${t.angle}deg, ${t.colors.join(', ')})`;
// a soft wash of the theme's colours over the card's own background, so it works in light and dark themes
export const themeCardTint = (t) => `linear-gradient(160deg, color-mix(in srgb, ${t.colors[0]} 24%, var(--bg2)), color-mix(in srgb, ${t.colors[t.colors.length - 1]} 14%, var(--bg2)))`;
