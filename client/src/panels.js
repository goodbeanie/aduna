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
import { buildPalette, luminance } from './themes.js';

const KEY = 'aduna-panels';
const OPTS_KEY = 'aduna-panel-opts';
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
    clearSheet('layout');
    return;
  }
  el.setAttribute('data-pan', '1');
  writeSheet('layout', `@media (min-width: 1051px) {\n${panelCss(l)}\n}`);
}

// ----- what each section shows, and where its content sits (double-click a part in Settings > Appearance > Layout) -----
// Every thing a section can show is a [data-item] element inside its [data-panel] (App.jsx, QuickPanel.jsx). A thing that is off is hidden with CSS,
// so nothing about the app's own logic changes. `on` is whether it shows when nobody has chosen. Kept on this device, wide screens only.
//   { [section]: { align: 'start' | 'center' | 'end', scheme: 'light' | 'dark', items: { [item]: true | false } } }
export const ITEMS = {
  rail: [
    { id: 'dms', name: 'Direct messages', on: true },
    { id: 'clips', name: 'Clips', on: true, clips: true },
    { id: 'add', name: 'Create or join a server', on: true },
    { id: 'search', name: 'Jump to…', on: true },
  ],
  side: [
    { id: 'lounge', name: 'Lounge (server)', on: true },
    { id: 'events', name: 'Events (server)', on: true },
    { id: 'addcat', name: 'Add category (server)', on: true },
    { id: 'friends', name: 'Friends', on: true },
    { id: 'explorer', name: 'Explorer', on: true },
    { id: 'shop', name: 'Shop', on: true },
    { id: 'quests', name: 'Quests', on: true },
    { id: 'voice', name: 'Voice bar', on: true },
    { id: 'storage', name: 'Storage bar', on: true },
  ],
  members: [
    { id: 'search', name: 'Search box', on: true },
    { id: 'headings', name: 'Role headings', on: true },
  ],
  profile: [
    { id: 'voice', name: 'Mute and deafen (while in voice)', on: true },
    { id: 'credits', name: 'Credits', on: true },
    { id: 'emoji', name: 'Custom emoji', on: true },
    { id: 'settings', name: 'Settings', on: true },
  ],
  quick: [
    { id: 'search', name: 'Jump to…', on: true, icon: 'search' },
    { id: 'friends', name: 'Friends', on: true, icon: 'users' },
    { id: 'explorer', name: 'Explorer', on: true, icon: 'globe' },
    { id: 'shop', name: 'Shop', on: true, icon: 'bag' },
    { id: 'settings', name: 'Settings', on: true, icon: 'gear' },
    { id: 'quests', name: 'Quests', on: false, icon: 'flag' },
    { id: 'dms', name: 'Direct messages', on: false, icon: 'message' },
    { id: 'clips', name: 'Clips', on: false, clips: true, icon: 'video' },
    { id: 'emoji', name: 'Custom emoji', on: false, icon: 'smile' },
    { id: 'profile', name: 'Your profile', on: false, icon: 'user' },
    { id: 'addserver', name: 'Create or join a server', on: false, icon: 'plus' },
  ],
  unread: [
    { id: 'channels', name: 'Channels', on: true },
    { id: 'groups', name: 'Group chats', on: true },
    { id: 'dms', name: 'Direct messages', on: true },
  ],
};
const ALIGN = ['start', 'center', 'end'];
export const SCHEMES = ['light', 'dark']; // a section can be light or dark whatever the app's theme is; no value = it follows the theme
const JUSTIFY = { start: 'safe flex-start', center: 'safe center', end: 'safe flex-end' };

// Shortcuts only (QuickPanel.jsx): the spacing between its buttons in px, whether they show their text and their icon (never both off),
// and the order they come in. QUICK_ORDER is the order the buttons are drawn in, so it is also the order when nobody has chosen.
//   quick: { gap: 0..40, text: false, icons: false, order: [item ids] }
export const QUICK_ORDER = ['search', 'dms', 'friends', 'explorer', 'shop', 'quests', 'clips', 'emoji', 'profile', 'addserver', 'settings'];
export const QUICK_GAP = 4; // the spacing in panels.css
export const QUICK_GAP_MAX = 40;
const fullOrder = (list) => {
  const seen = new Set();
  const out = [];
  for (const id of [...(Array.isArray(list) ? list : []), ...QUICK_ORDER]) if (QUICK_ORDER.includes(id) && !seen.has(id)) { seen.add(id); out.push(id); }
  return out;
};
export const quickOrder = (opts) => fullOrder(opts?.quick?.order);

export function normalizeOpts(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of Object.keys(ITEMS)) {
    const o = raw[id];
    if (!o || typeof o !== 'object') continue;
    const clean = {};
    if (ALIGN.includes(o.align)) clean.align = o.align;
    if (SCHEMES.includes(o.scheme)) clean.scheme = o.scheme;
    const items = {};
    for (const it of ITEMS[id]) if (typeof o.items?.[it.id] === 'boolean' && o.items[it.id] !== it.on) items[it.id] = o.items[it.id];
    if (Object.keys(items).length) clean.items = items;
    if (id === 'quick') {
      if (Number.isFinite(o.gap)) clean.gap = clamp(Math.round(o.gap), 0, QUICK_GAP_MAX);
      if (o.text === false) clean.text = false;
      if (o.icons === false && o.text !== false) clean.icons = false; // a button with neither text nor icon would be empty
      const order = fullOrder(o.order);
      if (order.join() !== QUICK_ORDER.join()) clean.order = order;
    }
    if (Object.keys(clean).length) out[id] = clean;
  }
  return out;
}

export const itemOn = (opts, id, item) => (typeof opts[id]?.items?.[item.id] === 'boolean' ? opts[id].items[item.id] : item.on);

// ----- a Settings button is always on screen -----
// Settings is also where the layout is changed, so a layout with no Settings button would lock the person out of undoing it.
// Two parts carry one: Profile and voice, and Shortcuts. At least one of them must be placed (not Hidden) with its Settings switched on.
const SETTINGS_IN = ['profile', 'quick'];
const settingsItem = (id) => ITEMS[id].find((it) => it.id === 'settings');
const settingsOn = (l, opts, id) => slotOf(l, id) !== 'off' && itemOn(opts, id, settingsItem(id));
export const settingsReachable = (l, opts) => SETTINGS_IN.some((id) => settingsOn(l, opts, id));
// Would hiding this part leave no Settings button?
export function canHide(l, opts, id) {
  if (!SETTINGS_IN.includes(id)) return true;
  const h = without(l, id);
  h.off.push(id);
  return settingsReachable(h, opts);
}
// Would switching this thing off leave no Settings button?
export function canSwitchOff(l, opts, sectionId, itemId) {
  if (itemId !== 'settings' || !SETTINGS_IN.includes(sectionId)) return true;
  const o = { ...opts, [sectionId]: { ...(opts[sectionId] || {}), items: { ...(opts[sectionId]?.items || {}), settings: false } } };
  return settingsReachable(l, o);
}
// A layout or option set that left none gets one back: where Settings already sits if a part is placed, otherwise the Profile and voice bar.
export function ensureSettings(l, opts) {
  if (settingsReachable(l, opts)) return { layout: l, opts };
  const target = slotOf(l, 'profile') !== 'off' ? 'profile' : slotOf(l, 'quick') !== 'off' ? 'quick' : 'profile';
  const layout = slotOf(l, target) === 'off' ? placePanel(l, target, 'dock') : l;
  const o = { ...opts, [target]: { ...(opts[target] || {}), items: { ...(opts[target]?.items || {}), settings: true } } };
  return { layout, opts: normalizeOpts(o) };
}

// Where the alignment can mean something: a bar (any part of it), or a column for the parts that are a plain stack of buttons.
export const canAlign = (id, slot) => ((slot === 'top' || slot === 'bottom') && ['rail', 'profile', 'quick', 'unread', 'members'].includes(id)) || ((slot === 'left' || slot === 'right') && ['rail', 'quick', 'unread'].includes(id));

export function optsCss(opts) {
  const rules = [];
  for (const [id, list] of Object.entries(ITEMS)) {
    for (const it of list) if (!itemOn(opts, id, it)) rules.push(`html [data-panel="${id}"] [data-item="${it.id}"] { display: none !important; }`);
  }
  for (const [id, o] of Object.entries(opts)) {
    if (!o.align) continue;
    const jc = JUSTIFY[o.align];
    const sc = `html [data-panel="${id}"]`;
    // a bar: its parts are packed to the left, the middle or the right
    rules.push(`${sc}:is([data-slot=top], [data-slot=bottom]) { justify-content: ${jc} !important; }`);
    if (id === 'profile') rules.push('html .user-panel[data-panel="profile"]:is([data-slot=top], [data-slot=bottom]) .me { margin-right: 0 !important; }');
    if (id === 'rail') rules.push(`${sc}:is([data-slot=top], [data-slot=bottom]) .rail-upd { margin-left: 8px !important; }`);
    // a column: the tiles sit on the left, in the middle or on the right of it
    if (id === 'rail') rules.push(`${sc}:is([data-slot=left], [data-slot=right]), ${sc}:is([data-slot=left], [data-slot=right]) .rail-list { align-items: ${jc} !important; }`);
    else if (id === 'quick' || id === 'unread') rules.push(`${sc}:is([data-slot=left], [data-slot=right]) .quick-btn { justify-content: ${jc} !important; }`);
  }
  const q = opts.quick;
  if (q) {
    const sc = 'html [data-panel="quick"]';
    if (typeof q.gap === 'number') rules.push(`${sc} { gap: ${q.gap}px !important; }`);
    if (q.text === false) {
      rules.push(`${sc} .quick-btn > span { display: none !important; }`);
      rules.push(`${sc}:is([data-slot=left], [data-slot=right]) { width: auto !important; }`); // icons only: no need for the wide column
    }
    if (q.icons === false) rules.push(`${sc} .quick-btn > svg { display: none !important; }`);
    if (q.order) q.order.forEach((sid, i) => rules.push(`${sc} [data-item="${sid}"] { order: ${i}; }`));
  }
  return rules.length ? `@media (min-width: 1051px) {\n${rules.join('\n')}\n}` : '';
}

// ----- a section that is light or dark whatever the theme is (double-click a part > Colours) -----
// The theme is a set of CSS variables on <html> (themes.js). A section that asks for the other scheme gets a palette declared on the section itself,
// so everything inside it (which only reads those variables) follows. It is built from the theme's own accent, and made again whenever the theme changes.
const SECTION_BG = { dark: '#1b1b1d', light: '#f6f4ef' };
const GRAD_SURFACE = { rail: '--bg3', profile: '--bg3' }; // gradient themes paint the panels see-through, so a recoloured part needs a surface of its own
export function schemeCss(opts) {
  const root = document.documentElement;
  const themeDark = root.style.colorScheme === 'dark';
  const ink = root.style.getPropertyValue('--ink').trim(); // inline on <html> while a theme other than Parchment is on (themes.js paint)
  const hex = /^#[0-9a-fA-F]{6}$/;
  const rules = [];
  for (const [id, o] of Object.entries(opts)) {
    if (!o.scheme || (o.scheme === 'dark') === themeDark) continue; // follows the theme, or the theme already is what it asked for
    const dark = o.scheme === 'dark';
    const accent = hex.test(ink) && (luminance(ink) > 0.35) === dark ? ink : dark ? '#ecd5b6' : '#1c1812'; // the accent has to stand out on the new background
    const palette = buildPalette({ dark, bg: SECTION_BG[o.scheme], accent });
    const vars = Object.entries(palette).filter(([k]) => k.startsWith('--')).map(([k, v]) => `${k}: ${v}`).join('; ');
    const sc = `html [data-panel="${id}"]`;
    rules.push(`${sc} { ${vars}; color-scheme: ${o.scheme}; color: var(--text); }`);
    rules.push(`html[data-grad] ${sc} { background: var(${GRAD_SURFACE[id] || '--bg2'}) !important; }`);
  }
  return rules.length ? `@media (min-width: 1051px) {\n${rules.join('\n')}\n}` : '';
}

// The site's CSP has no 'unsafe-inline' for styles, so a <style> element filled with text is refused. A stylesheet built through the CSSOM is not.
const sheets = {};
function writeSheet(key, text) {
  if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
    if (!sheets[key]) { sheets[key] = new CSSStyleSheet(); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheets[key]]; }
    sheets[key].replaceSync(text);
    return;
  }
  const id = STYLE_ID + '-' + key;
  let style = document.getElementById(id);
  if (!style) { style = document.createElement('style'); style.id = id; document.head.appendChild(style); }
  while (style.sheet.cssRules.length) style.sheet.deleteRule(0);
  style.sheet.insertRule(text, 0);
}
function clearSheet(key) {
  if (sheets[key]) { const gone = sheets[key]; document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== gone); delete sheets[key]; }
  document.getElementById(STYLE_ID + '-' + key)?.remove();
}

function read() {
  try { return normalizePanels(JSON.parse(localStorage.getItem(KEY))); } catch { return defaultPanels(); }
}
function readOpts() {
  try { return normalizeOpts(JSON.parse(localStorage.getItem(OPTS_KEY))); } catch { return {}; }
}

// Only for moderators, admins and creator accounts (App.jsx calls setLayoutAllowed). Everyone else stays on the standard layout, whatever is saved on the device.
let saved = defaultPanels();
let savedOpts = {};
let allowed = false;
let current = defaultPanels();
let currentOpts = {};
const subs = new Set();
const notify = () => subs.forEach((fn) => fn());
const refreshScheme = () => {
  const css = schemeCss(currentOpts);
  if (css) writeSheet('scheme', css); else clearSheet('scheme');
};
const refresh = () => {
  current = allowed ? saved : defaultPanels();
  currentOpts = allowed ? savedOpts : {};
  applyPanels(current);
  const css = optsCss(currentOpts);
  if (css) writeSheet('opts', css); else clearSheet('opts');
  refreshScheme();
  notify(); strips();
};

export const getPanels = () => current;
export const getOpts = () => currentOpts;
export const loadPanels = read;
export function subscribePanels(fn) { subs.add(fn); return () => subs.delete(fn); }
export const usePanels = () => useSyncExternalStore(subscribePanels, getPanels, getPanels);
export const useOpts = () => useSyncExternalStore(subscribePanels, getOpts, getOpts);
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

// Whatever was loaded or changed, keep a Settings button on screen (see ensureSettings).
function keepSettings() {
  const f = ensureSettings(saved, savedOpts);
  saved = f.layout;
  savedOpts = f.opts;
}

export function initPanels() {
  saved = read();
  savedOpts = readOpts();
  keepSettings();
  refresh();
  initPanelFx();
  if (typeof window !== 'undefined') {
    // a new theme (or a server's theme) rewrites the variables on <html>: the sections that are light or dark on their own are made again from it
    new MutationObserver(() => { if (Object.keys(currentOpts).some((k) => currentOpts[k].scheme)) refreshScheme(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
    window.addEventListener('storage', (e) => { // another tab of Aduna changed it
      if (e.key === KEY) { saved = read(); keepSettings(); refresh(); }
      else if (e.key === OPTS_KEY) { savedOpts = readOpts(); keepSettings(); refresh(); }
    });
  }
  return current;
}

export function setPanels(next) {
  if (!allowed) return;
  saved = normalizePanels(next);
  keepSettings();
  try {
    if (isDefaultPanels(saved)) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(saved));
  } catch { /* storage blocked: applies until reload */ }
  refresh();
}

// Change what one section shows or how it sits: patch is { align } (null for the default), { scheme } ('light', 'dark' or null to follow the theme) and/or { items: { id: bool } }; null for the patch puts the section back as it was.
export function setSection(id, patch) {
  if (!allowed || !ITEMS[id]) return;
  const o = { ...(savedOpts[id] || {}) };
  if (patch === null) delete savedOpts[id];
  else {
    if ('align' in patch) { if (patch.align) o.align = patch.align; else delete o.align; }
    if (patch.items) o.items = { ...(o.items || {}), ...patch.items };
    for (const k of ['gap', 'text', 'icons', 'order', 'scheme']) if (k in patch) { if (patch[k] === null || patch[k] === undefined) delete o[k]; else o[k] = patch[k]; }
    savedOpts = { ...savedOpts, [id]: o };
  }
  savedOpts = normalizeOpts(savedOpts);
  keepSettings();
  try {
    if (Object.keys(savedOpts).length) localStorage.setItem(OPTS_KEY, JSON.stringify(savedOpts));
    else localStorage.removeItem(OPTS_KEY);
  } catch { /* storage blocked: applies until reload */ }
  refresh();
}
