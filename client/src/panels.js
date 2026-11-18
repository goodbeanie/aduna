// Where the app's sections sit. Kept on this device and only used on wide screens (panels.css);
// phones and small tablets keep the standard layout (bottom tab bar).
//
// A layout is one ordered list per slot:
//   { top: [group], left: [group], right: [group], bottom: [group], dock: [id], off: [id] }
//   group          { ids: [section ids], fr: [share of the group each one gets, adding up to 1] }
//   top / bottom   a group is one bar across the window; its sections sit side by side, listed from the left
//                  (groups are listed from the top down)
//   left / right   a group is one column beside the page; its sections are stacked, listed from the top
//                  (groups are listed from the left to the right)
//   dock           (profile only) stays at the foot of the side list, where it always was
//   off            hidden
// A group with one section is how every layout used to work. Every section is in exactly one place. The page (chat) always sits in the middle.
import { useSyncExternalStore } from 'react';
import { initPanelFx, strips } from './panelfx.js';

const KEY = 'aduna-panels';
const STYLE_ID = 'aduna-panels-style';

export const SLOTS = ['top', 'left', 'right', 'bottom'];
export const SLOT_NAME = { top: 'Top', left: 'Left', right: 'Right', bottom: 'Bottom', dock: 'Under side list', off: 'Hidden' };
const FLAT = ['dock', 'off'];
const LISTS = [...SLOTS, ...FLAT];

// `home` is where a section sits in the standard layout and where it goes when a saved layout does not mention it
// (so a section added in a later version appears without anyone resetting their layout).
// `where` is every place the section is drawn for. All of them go in all four slots: a column on the left or right, a slim bar on the top or bottom (panels.css).
export const SECTIONS = [
  { id: 'rail', name: 'Server bar', hint: 'Your servers, direct messages and search', home: 'top', where: SLOTS },
  { id: 'side', name: 'Side list', hint: 'Channels, or your conversations', home: 'left', where: SLOTS },
  { id: 'members', name: 'Member list', hint: 'Who is in this server', home: 'right', where: SLOTS },
  { id: 'profile', name: 'Profile and voice', hint: 'Your status, mute, deafen and settings', home: 'dock', where: [...SLOTS, 'dock'] },
  { id: 'quick', name: 'Shortcuts', hint: 'Jump to, Friends, Explorer, Shop and Settings', home: 'off', where: SLOTS },
  { id: 'unread', name: 'Unread', hint: 'Every channel, group and message with something new', home: 'off', where: SLOTS },
];
export const sectionName = (id) => SECTIONS.find((s) => s.id === id)?.name || id;
export const canGo = (id, to) => to === 'off' || !!SECTIONS.find((s) => s.id === id)?.where.includes(to);

const r3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// The shares of a group: valid when every one is a positive number, otherwise even. Scaled to add up to 1, rounded, the last one taking the rounding.
function fitFr(fr, n) {
  if (n <= 1) return [1];
  const ok = Array.isArray(fr) && fr.length === n && fr.every((f) => Number.isFinite(f) && f > 0);
  const raw = ok ? fr : Array.from({ length: n }, () => 1);
  const total = raw.reduce((a, b) => a + b, 0);
  const out = raw.map((f) => r3(f / total));
  out[n - 1] = r3(1 - out.slice(0, n - 1).reduce((a, b) => a + b, 0));
  return out;
}
const mkGroup = (ids, fr) => ({ ids, fr: fitFr(fr, ids.length) });
export const evenFr = (n) => fitFr(null, n);

const emptyLayout = () => ({ top: [], left: [], right: [], bottom: [], dock: [], off: [] });

export function defaultPanels() {
  const l = emptyLayout();
  for (const s of SECTIONS) {
    if (SLOTS.includes(s.home)) l[s.home].push(mkGroup([s.id]));
    else l[s.home].push(s.id);
  }
  return l;
}

export function normalizePanels(raw) {
  let src = raw && typeof raw === 'object' ? raw : null;
  if (src && typeof src.rail === 'string') { // the first version stored one edge per section: { rail: 'left', side: 'left', members: 'right' }
    const old = emptyLayout();
    for (const id of ['rail', 'side', 'members']) if (SLOTS.includes(src[id])) old[src[id]].push(id);
    src = old;
  }
  const out = emptyLayout();
  const seen = new Set();
  const take = (id, list) => {
    if (typeof id !== 'string' || seen.has(id) || !canGo(id, list) || !SECTIONS.some((s) => s.id === id)) return false; // a layout saved before a section got limited goes home
    seen.add(id);
    return true;
  };
  for (const list of SLOTS) {
    // the second version stored a list of section ids per slot (each one its own bar or column); the third stores groups
    for (const entry of Array.isArray(src?.[list]) ? src[list] : []) {
      const ids0 = typeof entry === 'string' ? [entry] : Array.isArray(entry?.ids) ? entry.ids : [];
      const fr0 = Array.isArray(entry?.fr) ? entry.fr : [];
      const ids = [], fr = [];
      ids0.forEach((id, i) => { if (take(id, list)) { ids.push(id); fr.push(fr0[i]); } });
      if (ids.length) out[list].push(mkGroup(ids, fr));
    }
  }
  for (const list of FLAT) {
    for (const id of Array.isArray(src?.[list]) ? src[list] : []) if (take(id, list)) out[list].push(id);
  }
  for (const s of SECTIONS) {
    if (seen.has(s.id)) continue;
    if (SLOTS.includes(s.home)) out[s.home].push(mkGroup([s.id]));
    else out[s.home].push(s.id);
  }
  // the dock lives inside the side list, so with the side list hidden the profile bar steps out to the left edge instead of vanishing with it
  if (out.off.includes('side') && out.dock.length) { for (const id of out.dock) out.left.push(mkGroup([id])); out.dock = []; }
  return out;
}

export const slotOf = (l, id) => SLOTS.find((k) => l[k].some((g) => g.ids.includes(id))) || FLAT.find((k) => l[k].includes(id)) || 'off';

const DEFAULT = defaultPanels();
export const isDefaultPanels = (l) => JSON.stringify(l) === JSON.stringify(DEFAULT);

// The layout with one section taken out of wherever it is (a group left with nothing goes too). Positions given to placePanel count from this.
export function without(l, id) {
  const out = emptyLayout();
  for (const k of SLOTS) {
    out[k] = l[k].map((g) => {
      if (!g.ids.includes(id)) return g;
      const at = g.ids.indexOf(id);
      return { ids: g.ids.filter((_, i) => i !== at), fr: g.fr.filter((_, i) => i !== at) };
    }).filter((g) => g.ids.length);
  }
  for (const k of FLAT) out[k] = l[k].filter((x) => x !== id);
  return out;
}

// Move a section. `to` is a slot, and `target` says where in it (positions count in the layout without the section itself, see `without`):
//   { group: i, at: n }   share group i of the slot, as its n-th section
//   { newGroup: i }       a bar or column of its own, as the i-th of the slot
//   (nothing)             a bar or column of its own, last
// The dock and Hidden are plain lists, so they take it at the end. The same call also reorders within a slot.
export function placePanel(l, id, to, target) {
  const s = SECTIONS.find((x) => x.id === id);
  if (!s || !LISTS.includes(to) || !canGo(id, to)) return l;
  const base = without(l, id);
  if (FLAT.includes(to)) {
    base[to].push(id);
    return normalizePanels(base);
  }
  const groups = base[to].slice();
  if (target && Number.isInteger(target.group) && groups[target.group]) {
    const g = groups[target.group], n = g.ids.length;
    const at = clamp(Number.isInteger(target.at) ? target.at : n, 0, n);
    const ids = g.ids.slice(), fr = g.fr.map((f) => f * n / (n + 1)); // the newcomer takes an even share, the others give up the same proportion
    ids.splice(at, 0, id);
    fr.splice(at, 0, 1 / (n + 1));
    groups[target.group] = { ids, fr };
  } else {
    const gi = target && Number.isInteger(target.newGroup) ? clamp(target.newGroup, 0, groups.length) : groups.length;
    groups.splice(gi, 0, mkGroup([id]));
  }
  base[to] = groups;
  return normalizePanels(base);
}

// Move the divider between section i and section i + 1 of a group. `t` is where the divider goes inside that pair (0 to 1); the pair keeps its combined share.
export function splitPanel(l, slot, gi, i, t) {
  const g = l[slot]?.[gi];
  if (!g || !(i >= 0 && i < g.ids.length - 1) || !Number.isFinite(t)) return l;
  const total = g.fr[i] + g.fr[i + 1];
  const fr = g.fr.slice();
  fr[i] = r3(total * clamp(t, 0.1, 0.9));
  fr[i + 1] = r3(total - fr[i]);
  return normalizePanels({ ...l, [slot]: l[slot].map((x, j) => (j === gi ? { ids: g.ids, fr } : x)) });
}

// Give every section of a group the same share again.
export function evenPanel(l, slot, gi) {
  const g = l[slot]?.[gi];
  if (!g) return l;
  return normalizePanels({ ...l, [slot]: l[slot].map((x, j) => (j === gi ? { ids: g.ids, fr: evenFr(g.ids.length) } : x)) });
}

export const PRESETS = [
  ['Standard', defaultPanels()],
  ['Server bar on the left', normalizePanels({ left: ['rail', 'side'], right: ['members'] })],
  ['Mirrored', normalizePanels({ top: ['rail'], left: ['members'], right: ['side'] })],
  ['Everything on the right', normalizePanels({ right: ['side', 'members', 'rail'] })],
  ['Compact', normalizePanels({ left: ['rail', 'side'], off: ['members'] })],
  ['Side list on the bottom', normalizePanels({ top: ['rail'], right: ['members'], bottom: ['side'] })],
  ['With a shortcuts bar', normalizePanels({ top: ['rail'], left: ['side'], right: ['members'], bottom: ['quick'] })],
  ['Server bar and shortcuts together', normalizePanels({ top: [{ ids: ['rail', 'quick'], fr: [0.7, 0.3] }], left: ['side'], right: ['members'] })],
  ['Members and unread together', normalizePanels({ top: ['rail'], left: ['side'], right: [{ ids: ['members', 'unread'], fr: [0.65, 0.35] }] })],
];

// The grid for the whole app. Top and bottom groups are rows across the window; left and right groups are columns
// between them; the page sits in the one flexible cell in the middle. `.body` stops being a box (display: contents) so the
// side list, member list and the rest take part in the same grid as the server bar. Everything that is not a section lives
// in `.main-cell` (App.jsx), so it all shares that one middle cell and nothing else is left to be placed by the grid.
//
// Sections that share a group all sit in the same grid cell and divide it by their shares, without a wrapper around them:
//   in a bar, each one gets a width and a left margin as a percentage of the bar (percentages on a grid item are measured against its cell);
//   in a column, the middle of the grid is cut into rows wherever two stacked sections meet, and each one spans the rows it covers.
const at = (id) => `html[data-pan] [data-panel="${id}"]`;
const pct = (v) => `${r3(v * 100)}%`;
export function panelCss(l) {
  const { top, bottom, left, right } = l;
  const cuts = new Set([0, 1]);
  for (const g of [...left, ...right]) {
    let a = 0;
    for (let i = 0; i < g.ids.length - 1; i++) { a += g.fr[i]; cuts.add(r3(a)); }
  }
  const line = [...cuts].sort((a, b) => a - b);
  const mid = line.length - 1; // rows the page spans
  const lineAt = (v) => Math.max(0, line.findIndex((x) => Math.abs(x - v) < 0.0005));
  const cols = [...left.map(() => 'auto'), 'minmax(0, 1fr)', ...right.map(() => 'auto')];
  const rows = [...top.map(() => 'auto'), ...(mid === 1 ? ['minmax(0, 1fr)'] : line.slice(1).map((v, i) => `minmax(0, ${r3((v - line[i]) * 1000)}fr)`)), ...bottom.map(() => 'auto')];
  const cc = left.length + 1, cr = top.length + 1, endMid = cr + mid, across = `1 / ${cols.length + 1}`, down = `${cr} / ${endMid}`;
  const rules = [
    `html[data-pan] .app { display: grid; grid-template-columns: ${cols.join(' ')}; grid-template-rows: ${rows.join(' ')}; }`,
    'html[data-pan] .app > .body { display: contents; }',
    `html[data-pan] .main-cell { display: flex; grid-row: ${down}; grid-column: ${cc}; min-width: 0; min-height: 0; }`,
  ];
  const strip = (g, row) => {
    let off = 0;
    g.ids.forEach((id, k) => {
      if (g.ids.length === 1) rules.push(`${at(id)} { grid-row: ${row}; grid-column: ${across}; }`);
      else {
        const tall = id === 'side' || id === 'members' ? ' min-height: 60px !important;' : '';
        rules.push(`${at(id)} { grid-row: ${row}; grid-column: ${across}; justify-self: start; align-self: stretch; box-sizing: border-box; min-width: 0 !important; width: ${pct(g.fr[k])} !important; margin-left: ${pct(off)} !important; height: auto !important;${tall} }`);
      }
      off += g.fr[k];
    });
  };
  const column = (g, col) => {
    let off = 0;
    g.ids.forEach((id, k) => {
      if (g.ids.length === 1) rules.push(`${at(id)} { grid-row: ${down}; grid-column: ${col}; }`);
      else rules.push(`${at(id)} { grid-row: ${cr + lineAt(r3(off))} / ${cr + lineAt(r3(off + g.fr[k]))}; grid-column: ${col}; align-self: stretch; box-sizing: border-box; min-width: 100% !important; height: auto !important; min-height: 0 !important; }`);
      off += g.fr[k];
    });
  };
  top.forEach((g, i) => strip(g, i + 1));
  bottom.forEach((g, i) => strip(g, endMid + i));
  left.forEach((g, i) => column(g, i + 1));
  right.forEach((g, i) => column(g, cc + 1 + i));
  for (const id of l.off) rules.push(`${at(id)} { display: none !important; }`);
  return rules.join('\n');
}

// html carries data-pan-<section>="<slot>" always (so a theme can react to where things are) and data-pan only when the layout is not the standard one.
export function applyPanels(l) {
  const el = document.documentElement;
  for (const s of SECTIONS) el.setAttribute(`data-pan-${s.id}`, slotOf(l, s.id));
  if (isDefaultPanels(l)) {
    el.removeAttribute('data-pan');
    clearSheet();
    return;
  }
  el.setAttribute('data-pan', '1');
  writeSheet(`@media (min-width: 1051px) {\n${panelCss(l)}\n}`);
}

// The site's CSP has no 'unsafe-inline' for styles, so a <style> element filled with text is refused. A stylesheet built through the CSSOM is not.
let sheet = null;
function writeSheet(text) {
  if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
    if (!sheet) { sheet = new CSSStyleSheet(); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; }
    sheet.replaceSync(text);
    return;
  }
  let style = document.getElementById(STYLE_ID);
  if (!style) { style = document.createElement('style'); style.id = STYLE_ID; document.head.appendChild(style); }
  while (style.sheet.cssRules.length) style.sheet.deleteRule(0);
  style.sheet.insertRule(text, 0);
}
function clearSheet() {
  if (sheet) { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet); sheet = null; }
  document.getElementById(STYLE_ID)?.remove();
}

function read() {
  try { return normalizePanels(JSON.parse(localStorage.getItem(KEY))); } catch { return defaultPanels(); }
}

// Open to everyone. setLayoutAllowed(false) puts everyone back on the standard layout, whatever is saved on the device.
let saved = defaultPanels();
let allowed = true;
let current = defaultPanels();
const subs = new Set();
const notify = () => subs.forEach((fn) => fn());
const refresh = () => { current = allowed ? saved : defaultPanels(); applyPanels(current); notify(); strips(); };

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
  initPanelFx();
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
