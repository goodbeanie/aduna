// Where the app's sections sit. Kept on this device and only used on wide screens (panels.css);
// phones and small tablets keep the standard layout (bottom tab bar).
//
// A layout is one ordered list of section ids per slot:
//   { top: [], left: [], right: [], bottom: [], dock: [], off: [] }
//   top / bottom   sections run across the window, one row each, listed from the top down
//   left / right   sections stand beside the page, one column each, listed from left to right
//   dock           (profile only) stays at the foot of the side list, where it always was
//   off            hidden
// Every section is in exactly one list. The page (chat) always sits in the middle.
import { useSyncExternalStore } from 'react';

const KEY = 'aduna-panels';
const STYLE_ID = 'aduna-panels-style';

export const SLOTS = ['top', 'left', 'right', 'bottom'];
export const SLOT_NAME = { top: 'Top', left: 'Left', right: 'Right', bottom: 'Bottom', dock: 'Under side list', off: 'Hidden' };
const LISTS = [...SLOTS, 'dock', 'off'];

// `home` is where a section sits in the standard layout and where it goes when a saved layout does not mention it
// (so a section added in a later version appears without anyone resetting their layout).
// `where` is every place the section looks right: the two lists are columns by nature, so they only go left or right.
export const SECTIONS = [
  { id: 'rail', name: 'Server bar', hint: 'Your servers, direct messages and search', home: 'top', where: SLOTS },
  { id: 'side', name: 'Side list', hint: 'Channels, or your conversations', home: 'left', where: ['left', 'right'] },
  { id: 'members', name: 'Member list', hint: 'Who is in this server', home: 'right', where: ['left', 'right'] },
  { id: 'profile', name: 'Profile and voice', hint: 'Your status, mute, deafen and settings', home: 'dock', where: [...SLOTS, 'dock'] },
  { id: 'quick', name: 'Shortcuts', hint: 'Jump to, Friends, Explorer, Shop and Settings', home: 'off', where: SLOTS },
  { id: 'unread', name: 'Unread', hint: 'Every channel, group and message with something new', home: 'off', where: SLOTS },
];
export const sectionName = (id) => SECTIONS.find((s) => s.id === id)?.name || id;
export const canGo = (id, to) => to === 'off' || !!SECTIONS.find((s) => s.id === id)?.where.includes(to);

const emptyLists = () => ({ top: [], left: [], right: [], bottom: [], dock: [], off: [] });

export function defaultPanels() {
  const l = emptyLists();
  for (const s of SECTIONS) l[s.home].push(s.id);
  return l;
}

export function normalizePanels(raw) {
  let src = raw && typeof raw === 'object' ? raw : null;
  if (src && typeof src.rail === 'string') { // the first version stored one edge per section: { rail: 'left', side: 'left', members: 'right' }
    const old = emptyLists();
    for (const id of ['rail', 'side', 'members']) if (SLOTS.includes(src[id])) old[src[id]].push(id);
    src = old;
  }
  const out = emptyLists();
  const seen = new Set();
  for (const list of LISTS) {
    for (const id of Array.isArray(src?.[list]) ? src[list] : []) {
      const s = SECTIONS.find((x) => x.id === id);
      if (!s || seen.has(id) || !canGo(id, list)) continue; // a layout saved before a section got limited goes home
      seen.add(id); out[list].push(id);
    }
  }
  for (const s of SECTIONS) if (!seen.has(s.id)) out[s.home].push(s.id);
  // the dock lives inside the side list, so with the side list hidden the profile bar steps out to the left edge instead of vanishing with it
  if (out.off.includes('side') && out.dock.length) { out.left.push(...out.dock); out.dock = []; }
  return out;
}

export const slotOf = (l, id) => LISTS.find((k) => l[k].includes(id)) || 'off';

const DEFAULT = defaultPanels();
export const isDefaultPanels = (l) => LISTS.every((k) => l[k].length === DEFAULT[k].length && l[k].every((id, i) => id === DEFAULT[k][i]));

// Move a section to a slot. `at` is its place in that slot counted without the section itself (the end when left out), so the same call also reorders within a slot.
export function placePanel(l, id, to, at) {
  const s = SECTIONS.find((x) => x.id === id);
  if (!s || !LISTS.includes(to) || !canGo(id, to)) return l;
  const out = emptyLists();
  for (const k of LISTS) out[k] = l[k].filter((x) => x !== id);
  out[to].splice(at === undefined ? out[to].length : Math.max(0, Math.min(at, out[to].length)), 0, id);
  return normalizePanels(out);
}

export const PRESETS = [
  ['Standard', defaultPanels()],
  ['Server bar on the left', normalizePanels({ left: ['rail', 'side'], right: ['members'] })],
  ['Mirrored', normalizePanels({ top: ['rail'], left: ['members'], right: ['side'] })],
  ['Everything on the right', normalizePanels({ right: ['side', 'members', 'rail'] })],
  ['Compact', normalizePanels({ left: ['rail', 'side'], off: ['members'] })],
  ['With a shortcuts bar', normalizePanels({ top: ['rail'], left: ['side'], right: ['members'], bottom: ['quick'] })],
];

// The grid for the whole app. Top and bottom sections are rows across the window; left and right sections are columns
// between them; the page sits in the one flexible cell in the middle. `.body` stops being a box (display: contents) so the
// side list, member list and the rest take part in the same grid as the server bar. Everything that is not a section lives
// in `.center` (App.jsx), so it all shares that one middle cell and nothing else is left to be placed by the grid.
const at = (id) => `html[data-pan] [data-panel="${id}"]`;
export function panelCss(l) {
  const { top, bottom, left, right } = l;
  const cols = [...left.map(() => 'auto'), 'minmax(0, 1fr)', ...right.map(() => 'auto')];
  const rows = [...top.map(() => 'auto'), 'minmax(0, 1fr)', ...bottom.map(() => 'auto')];
  const cc = left.length + 1, cr = top.length + 1, across = `1 / ${cols.length + 1}`;
  const cell = (id, row, col) => `${at(id)} { grid-row: ${row}; grid-column: ${col}; }`;
  return [
    `html[data-pan] .app { display: grid; grid-template-columns: ${cols.join(' ')}; grid-template-rows: ${rows.join(' ')}; }`,
    'html[data-pan] .app > .body { display: contents; }',
    `html[data-pan] .center { display: flex; grid-row: ${cr}; grid-column: ${cc}; min-width: 0; min-height: 0; }`,
    ...top.map((id, i) => cell(id, i + 1, across)),
    ...bottom.map((id, i) => cell(id, cr + 1 + i, across)),
    ...left.map((id, i) => cell(id, cr, i + 1)),
    ...right.map((id, i) => cell(id, cr, cc + 1 + i)),
    ...l.off.map((id) => `${at(id)} { display: none !important; }`),
  ].join('\n');
}

// html carries data-pan-<section>="<slot>" always (so a theme can react to where things are) and data-pan only when the layout is not the standard one.
export function applyPanels(l) {
  const el = document.documentElement;
  for (const s of SECTIONS) el.setAttribute(`data-pan-${s.id}`, slotOf(l, s.id));
  let style = document.getElementById(STYLE_ID);
  if (isDefaultPanels(l)) {
    el.removeAttribute('data-pan');
    style?.remove();
    return;
  }
  el.setAttribute('data-pan', '1');
  if (!style) { style = document.createElement('style'); style.id = STYLE_ID; document.head.appendChild(style); }
  style.textContent = `@media (min-width: 1051px) {\n${panelCss(l)}\n}`;
}

function read() {
  try { return normalizePanels(JSON.parse(localStorage.getItem(KEY))); } catch { return defaultPanels(); }
}

// Creator accounts only for now: until setLayoutAllowed(true) is called (App.jsx does it for creators) everyone gets the standard layout,
// whatever is saved on the device. Remove the gate by calling setLayoutAllowed(true) for everyone.
let saved = defaultPanels();
let allowed = false;
let current = defaultPanels();
const subs = new Set();
const notify = () => subs.forEach((fn) => fn());
const refresh = () => { current = allowed ? saved : defaultPanels(); applyPanels(current); notify(); };

export const getPanels = () => current;
export const loadPanels = read;
export function subscribePanels(fn) { subs.add(fn); return () => subs.delete(fn); }
export const usePanels = () => useSyncExternalStore(subscribePanels, getPanels, getPanels);
export function setLayoutAllowed(v) { if (!!v !== allowed) { allowed = !!v; refresh(); } }
export const useLayoutAllowed = () => useSyncExternalStore(subscribePanels, () => allowed, () => allowed);

// The layout only applies on wide screens (the same breakpoint as panels.css). Below it every section stays where the standard layout has it.
const WIDE = '(min-width: 1051px)';
const wideNow = () => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia(WIDE).matches;
const wideWatch = (fn) => {
  const m = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(WIDE) : null;
  m?.addEventListener?.('change', fn);
  return () => m?.removeEventListener?.('change', fn);
};
export const useWide = () => useSyncExternalStore(wideWatch, wideNow, () => true);

export function initPanels() {
  saved = read();
  refresh();
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => { // another tab of Aduna changed it
      if (e.key !== KEY) return;
      saved = read(); refresh();
    });
  }
  return current;
}

export function setPanels(next) {
  if (!allowed) return;
  saved = normalizePanels(next);
  try {
    if (isDefaultPanels(saved)) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(saved));
  } catch { /* storage blocked: applies until reload */ }
  refresh();
}
