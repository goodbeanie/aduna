// Developer themes on the client. A developer theme is a stylesheet the server hands out from its own address (server/devthemes.js has every rule),
// so it is loaded with a <link> tag: the page policy only allows styles from this site. The link goes last in <head>, so it wins over the app's own CSS.
//   saved     { id, v, name }  what this person chose (v = the version, which makes the stylesheet cacheable); kept on this device
//   preview   { id, key }      a theme that is not verified (yet), shown only on this page and never saved: the author's own preview, or an admin reading it
// The colours (light or dark, background, accent) are an ordinary custom theme made from the theme's seed: see showSeed in DevThemes.jsx.

const KEY = 'aduna-devtheme';
const LINK = 'aduna-devtheme-css';
const ID = /^[\w-]{1,64}$/;

// The hooks a theme can rely on. They stay when the app is reworked; the other class names are the app's own and may change.
export const UI_HOOKS = [
  ['app', 'The whole app'], ['server-bar', 'The bar of servers'], ['tabbar', 'The bottom bar on phones'], ['body', 'Everything under the server bar'],
  ['sidebar', 'The channel / DM list'], ['chat', 'A conversation'], ['chat-header', 'Its title bar'], ['message', 'One message'],
  ['composer', 'The box you type in'], ['members', 'The member list'], ['modal', 'Every pop-up window'],
];
// The palette. Redefine these on :root (or html[data-devtheme]) to recolour everything at once.
export const CSS_VARS = [
  ['--bg --bg2 --bg3', 'page, side panels, server bar'], ['--raised --field', 'menus and popovers, inputs'], ['--line --line2', 'borders'],
  ['--text --head --muted --placeholder', 'text'], ['--ink --on-ink', 'accent, and text on it'], ['--hover --sel --msg-hover --chip-on', 'states'],
  ['--link --danger --green --idle --dnd --gold', 'links, danger, success, presence, mentions'], ['--scrim --shadow', 'dim layers and shadows'],
];

const clean = (s) => (s && typeof s.id === 'string' && ID.test(s.id) ? s : null);
export function loadDevTheme() {
  try { return clean(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return null; }
}
const hrefFor = ({ id, v, key }) => `/api/devthemes/${encodeURIComponent(id)}/css` + (key ? `?k=${encodeURIComponent(key)}` : v ? `?v=${encodeURIComponent(v)}` : '');

let previewing = null; // { id, key } or null
let saved = null;

function setLink(sel) {
  const root = document.documentElement;
  let el = document.getElementById(LINK);
  if (!sel) { el?.remove(); delete root.dataset.devtheme; return; }
  if (!el) {
    el = document.createElement('link');
    el.id = LINK; el.rel = 'stylesheet';
    // a theme that was revoked, hidden or deleted answers 404: forget it instead of failing silently on every start
    el.addEventListener('error', () => { if (!previewing && saved && el.dataset.id === saved.id) clearDevTheme(); });
  }
  const href = hrefFor(sel);
  if (el.getAttribute('href') !== href) el.setAttribute('href', href);
  el.dataset.id = sel.id;
  root.dataset.devtheme = sel.id;
  if (document.head.lastElementChild !== el) document.head.appendChild(el);
}

export const currentDevTheme = () => (previewing ? null : saved);
export const previewingId = () => (previewing ? previewing.id : null);

// "Preview on the whole site": the preview stays on after Settings closes, until the person stops it (the bar in DevThemes.jsx).
let held = null; // { name } while a preview is held across the whole site
export const previewHeld = () => (previewing && held ? held : null);
export function holdPreview(name) {
  held = name ? { name: String(name).slice(0, 30) } : null;
  window.dispatchEvent(new CustomEvent('aduna:devtheme', { detail: null }));
}

// Use a verified theme on this device (null turns it off). The colours are applied by the caller.
export function applyDevTheme(sel) {
  saved = sel ? clean({ id: sel.id, v: sel.v, name: String(sel.name || '').slice(0, 30) }) : null;
  try { if (saved) localStorage.setItem(KEY, JSON.stringify(saved)); else localStorage.removeItem(KEY); } catch { /* the theme still shows for this session */ }
  if (!previewing) setLink(saved);
  window.dispatchEvent(new CustomEvent('aduna:devtheme', { detail: saved }));
}
export const clearDevTheme = () => applyDevTheme(null);

// Show a theme that is not verified, on this page only. Calling stopPreview puts the saved theme back.
export function previewDevTheme(id, key) {
  if (!ID.test(String(id)) || !/^[0-9a-f]{32}$/.test(String(key))) return;
  previewing = { id, key };
  setLink(previewing);
  window.dispatchEvent(new CustomEvent('aduna:devtheme', { detail: null }));
}
export function stopPreview() {
  previewing = null;
  held = null;
  setLink(saved);
  window.dispatchEvent(new CustomEvent('aduna:devtheme', { detail: saved }));
}

// An admin reads a theme in the app: /?devthemepreview=<id>.<key>.<dark|light>.<background>.<accent> (the admin page builds it; nothing is saved).
const PREVIEW_URL = /^([\w-]{1,64})\.([0-9a-f]{32})\.(dark|light)\.([0-9a-f]{6})\.([0-9a-f]{6})$/i;
export function previewFromUrl() {
  try {
    const u = new URL(location.href);
    const p = u.searchParams.get('devthemepreview');
    if (p === null) return null;
    u.searchParams.delete('devthemepreview');
    history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    const m = PREVIEW_URL.exec(p);
    return m ? { id: m[1], key: m[2].toLowerCase(), seed: { dark: m[3] === 'dark', bg: '#' + m[4], accent: '#' + m[5] } } : null;
  } catch { return null; }
}

// Called once when the app starts, after the person's own colours are applied. Returns the seed to show when a preview link was opened.
export function initDevTheme() {
  saved = loadDevTheme();
  const p = previewFromUrl();
  if (p) { previewDevTheme(p.id, p.key); return p.seed; }
  setLink(saved);
  return null;
}
