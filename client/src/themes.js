// Aduna themes. A theme is a map of CSS variables applied to <html>.
// Built-in themes are generated from a small seed (background + accent + light/dark),
// so the "Custom" theme just lets people pick their own seed.

const STORE = 'aduna-theme';        // { id: 'parchment' | ... | 'system' | 'custom', custom: { dark, bg, accent } }
const CACHE = 'aduna-theme-vars';   // last computed variables, used by index.html to avoid a flash on load

// ---------- colour helpers ----------
const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
export function parseHex(h) {
  let s = String(h || '').trim().replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return [0, 0, 0];
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}
const toHex = ([r, g, b]) => '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('');
// mix(a, b, t): t = 0 -> a, t = 1 -> b
export function mix(a, b, t) {
  const A = parseHex(a), B = parseHex(b);
  return toHex(A.map((v, i) => v + (B[i] - v) * t));
}
export function luminance(h) {
  const [r, g, b] = parseHex(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const isDark = (h) => luminance(h) < 0.35;
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const readableOn = (bg) => (contrast(bg, '#14110d') >= contrast(bg, '#fbf8f1') ? '#14110d' : '#fbf8f1');
const alpha = (h, a) => h + Math.round(a * 255).toString(16).padStart(2, '0');

// ---------- palette generation ----------
export function buildPalette({ dark, bg, accent }) {
  const text = dark ? mix(bg, '#ffffff', 0.88) : mix(bg, '#000000', 0.84);
  const head = dark ? mix(bg, '#ffffff', 0.97) : mix(bg, '#000000', 0.93);
  const ink = accent;
  const on = readableOn(ink);
  const t = dark ? '#ffffff' : '#000000';
  const v = {
    '--bg': bg,
    '--bg2': dark ? mix(bg, '#000000', 0.18) : mix(bg, t, 0.04),
    '--bg3': dark ? mix(bg, '#000000', 0.38) : mix(bg, t, 0.09),
    '--field': dark ? mix(bg, t, 0.07) : mix(bg, t, 0.05),
    '--line': mix(bg, t, dark ? 0.13 : 0.11),
    '--line2': mix(bg, t, dark ? 0.24 : 0.22),
    '--text': text,
    '--muted': mix(bg, t, dark ? 0.55 : 0.52),
    '--head': head,
    '--ink': ink,
    '--ink-h': mix(ink, bg, 0.25),
    '--on-ink': on,
    '--hover': mix(bg, t, dark ? 0.06 : 0.06),
    '--sel': mix(bg, t, dark ? 0.12 : 0.11),
    '--msg-hover': mix(bg, t, dark ? 0.035 : 0.03),
    '--raised': dark ? mix(bg, '#ffffff', 0.07) : mix(bg, '#ffffff', 0.65),
    '--chip-on': mix(bg, t, dark ? 0.16 : 0.12),
    '--placeholder': mix(bg, t, dark ? 0.42 : 0.4),
    '--link': dark ? '#7fb2e0' : '#2d5f8a',
    '--danger': dark ? '#e56f5a' : '#b8442f',
    '--danger-h': dark ? '#f08a77' : '#9c3825',
    '--green': dark ? '#4fb07a' : '#3f8f5b',
    '--green-h': dark ? '#63c48d' : '#327a4b',
    '--ok-bg': dark ? mix(bg, '#4fb07a', 0.22) : mix(bg, '#3f8f5b', 0.16),
    '--ok-bg-h': dark ? mix(bg, '#4fb07a', 0.32) : mix(bg, '#3f8f5b', 0.26),
    '--ok-fg': dark ? '#8fd9ab' : '#2f6b45',
    '--err-bg': dark ? mix(bg, '#e56f5a', 0.2) : mix(bg, '#b8442f', 0.14),
    '--err-fg': dark ? '#f2a597' : '#9b3623',
    '--idle': dark ? '#e0b043' : '#d9a22b',
    '--dnd': dark ? '#e05a4c' : '#c9473a',
    '--offline': mix(bg, t, 0.4),
    '--gold': dark ? '#d9a944' : '#c9953a',
    '--tile': dark ? mix(bg, '#000000', 0.45) : '#2a251e',
    '--scrim': dark ? '#000000a6' : alpha(mix(bg, '#000000', 0.82), 0.45),
    '--scrim-soft': dark ? '#00000080' : alpha(mix(bg, '#000000', 0.82), 0.33),
    '--shadow': dark ? '#00000066' : alpha(mix(bg, '#000000', 0.7), 0.12),
    '--name-lift': dark ? '45%' : '0%',
  };
  v.__scheme = dark ? 'dark' : 'light';
  return v;
}

// ---------- the themes ----------
// `vars` (optional) pins exact values so the original look stays pixel-identical.
const PARCHMENT = { id: 'parchment', name: 'Parchment', dark: false, bg: '#fbf8f1', accent: '#1c1812', vars: null };

export const THEMES = [
  PARCHMENT,
  { id: 'ocean',    name: 'Ocean',    dark: false, bg: '#f3f8fb', accent: '#1f5f8b' },
  { id: 'forest',   name: 'Forest',   dark: false, bg: '#f4f8f1', accent: '#2f6b45' },
  { id: 'rose',     name: 'Rose',     dark: false, bg: '#fcf4f4', accent: '#b4435a' },
  { id: 'lavender', name: 'Lavender', dark: false, bg: '#f7f4fc', accent: '#6a4fb3' },
  { id: 'sunset',   name: 'Sunset',   dark: false, bg: '#fdf5ec', accent: '#c2551d' },
  { id: 'charcoal', name: 'Charcoal', dark: true,  bg: '#2a2a2d', accent: '#e8e4da' },
  { id: 'midnight', name: 'Midnight', dark: true,  bg: '#161b2a', accent: '#7aa2ff' },
  { id: 'evergreen', name: 'Evergreen', dark: true, bg: '#17221d', accent: '#6fcf97' },
  { id: 'plum',     name: 'Plum',     dark: true,  bg: '#241a2b', accent: '#d68cf0' },
  { id: 'ember',    name: 'Ember',    dark: true,  bg: '#271c17', accent: '#f09a5a' },
];

export const DEFAULT_CUSTOM = { dark: true, bg: '#1b1f2a', accent: '#ff7a90' };
export const THEME_LS_KEY = STORE;

function parchmentVars() {
  // Clear overrides: the defaults in styles.css :root are the Parchment look.
  return { __scheme: 'light', __clear: true, __meta: '#ebe4d4' };
}

export function loadTheme() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (s && typeof s.id === 'string') return { id: s.id, custom: { ...DEFAULT_CUSTOM, ...(s.custom || {}) }, serverThemes: s.serverThemes !== false };
  } catch { /* ignore */ }
  return { id: 'parchment', custom: { ...DEFAULT_CUSTOM }, serverThemes: true };
}

export function resolveVars(settings) {
  let id = settings.id;
  if (id === 'system') {
    const darkOS = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
    id = darkOS ? 'charcoal' : 'parchment';
  }
  if (id === 'custom') {
    const c = settings.custom;
    return buildPalette({ dark: !!c.dark, bg: c.bg, accent: c.accent });
  }
  const t = THEMES.find((x) => x.id === id) || PARCHMENT;
  if (t.id === 'parchment') return parchmentVars();
  return buildPalette(t);
}

// A server can have its own theme (see setServerTheme). While you are on that server it replaces your own theme;
// the colours fade between the two (the transition is declared in styles.css on registered custom properties).
let overlay = null;        // { dark, bg, accent } of the server being viewed, or null
let overlayForce = false;  // true while the owner previews a theme in server settings, even if they turned server themes off

export function cleanSeed(t) {
  const hex = /^#[0-9a-fA-F]{6}$/;
  return t && typeof t.dark === 'boolean' && hex.test(t.bg) && hex.test(t.accent) ? { dark: t.dark, bg: t.bg, accent: t.accent } : null;
}

function paint(vars, id) {
  const root = document.documentElement;
  // wipe previous overrides
  for (const k of [...root.style]) if (k.startsWith('--')) root.style.removeProperty(k);
  if (!vars.__clear) for (const [k, v] of Object.entries(vars)) if (!k.startsWith('__')) root.style.setProperty(k, v);
  root.style.colorScheme = vars.__scheme;
  root.dataset.theme = id;
  const metaColor = vars.__meta || vars['--bg3'];
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', metaColor);
  return metaColor;
}

let mq;
export function applyTheme(settings, { save = false } = {}) {
  const base = resolveVars(settings);
  const showServer = overlay && (overlayForce || settings.serverThemes !== false);
  const metaColor = paint(showServer ? buildPalette(overlay) : base, showServer ? 'server' : settings.id);
  try {
    if (save) localStorage.setItem(STORE, JSON.stringify(settings));
    // The cache is what index.html paints before the app loads, so it always holds the person's own theme, never a server's.
    const out = {};
    if (!base.__clear) for (const [k, v] of Object.entries(base)) if (!k.startsWith('__')) out[k] = v;
    localStorage.setItem(CACHE, JSON.stringify({ vars: out, scheme: base.__scheme, meta: base.__meta || base['--bg3'] }));
  } catch { /* storage unavailable: theme still applies for this session */ }
  return metaColor;
}

// Show a server's theme (or go back to the person's own theme with null). `force` is for the owner's live preview.
export function setServerTheme(theme, { force = false } = {}) {
  const next = cleanSeed(theme);
  if (JSON.stringify(next) === JSON.stringify(overlay) && force === overlayForce) return;
  overlay = next;
  overlayForce = force && !!next;
  applyTheme(loadTheme());
}

export function initTheme() {
  const settings = loadTheme();
  applyTheme(settings);
  if (typeof matchMedia === 'function') {
    mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', () => { const s = loadTheme(); if (s.id === 'system') applyTheme(s); });
  }
  return settings;
}

export function previewColors(theme) {
  if (theme.id === 'parchment') return { bg: '#fbf8f1', bg2: '#f4efe3', accent: '#1c1812' };
  const v = buildPalette(theme);
  return { bg: v['--bg'], bg2: v['--bg2'], accent: v['--ink'] };
}
