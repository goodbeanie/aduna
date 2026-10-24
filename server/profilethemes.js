// Profile themes: a gradient look for a profile card (banner and card tint, some of them slowly moving).
// A few are free for everybody; the rest are bought once with credits and are then yours to keep.
//
// Like shop.js this has no Express / Postgres imports: the rules are plain functions on a user record, so they can be
// unit tested (server/profilethemes-test.js). credits.js wires them to the routes.
//   u.profileTheme  = the id of the theme being worn (or nothing)
//   u.profileThemes = ids of the paid themes this person bought
// Prices live here, on the server. The browser only ever names a theme; it never sends an amount.

const THEMES = [
  // ----- free -----
  { id: 'sunrise',  name: 'Sunrise',       price: 0, angle: 135, colors: ['#ff9a8b', '#ff6a88', '#ffb199'] },
  { id: 'ocean',    name: 'Ocean Breeze',  price: 0, angle: 120, colors: ['#43c6ac', '#3a8fd9', '#191654'] },
  { id: 'mint',     name: 'Mint Fresh',    price: 0, angle: 150, colors: ['#a8e6cf', '#7fd1ae', '#dcedc1'] },
  { id: 'lavender', name: 'Lavender Dream', price: 0, angle: 135, colors: ['#c3b1f5', '#8e7cf0', '#f3b6e3'] },
  // ----- paid -----
  { id: 'glacier',  name: 'Glacier',       price: 150, angle: 160, colors: ['#e0f7ff', '#8fd3f4', '#5b8def'] },
  { id: 'golden',   name: 'Golden Hour',   price: 200, angle: 135, colors: ['#f6d365', '#fda085', '#f5576c'] },
  { id: 'aurora',   name: 'Aurora',        price: 250, angle: 135, colors: ['#0f2027', '#2c5364', '#5eead4'], animated: true },
  { id: 'ember',    name: 'Ember',         price: 300, angle: 160, colors: ['#1c0f0f', '#8a3b12', '#ffb066'], animated: true },
  { id: 'nebula',   name: 'Nebula',        price: 400, angle: 135, colors: ['#1a1033', '#5b2a86', '#e0a8ff', '#ff7ac6'], animated: true },
  { id: 'neon',     name: 'Neon Nights',   price: 600, angle: 120, colors: ['#12c2e9', '#c471ed', '#f64f59'], animated: true },
];

const byId = (id) => THEMES.find((t) => t.id === id) || null;

function ownedSet(u) {
  const s = new Set(THEMES.filter((t) => !t.price).map((t) => t.id));
  if (Array.isArray(u.profileThemes)) for (const id of u.profileThemes) if (byId(id)) s.add(id);
  return s;
}

// The theme other people see on this person's profile: the one they wear, if they still own it.
function wornId(u) {
  return u.profileTheme && byId(u.profileTheme) && ownedSet(u).has(u.profileTheme) ? u.profileTheme : null;
}

// Everything the picker needs: the look of every theme, its price, and whether this person owns / wears it.
function view(u) {
  const own = ownedSet(u), worn = wornId(u);
  return THEMES.map((t) => ({
    id: t.id, name: t.name, price: t.price, angle: t.angle, colors: t.colors, animated: !!t.animated,
    owned: own.has(t.id), worn: worn === t.id,
  }));
}

// null / '' takes the theme off. Returns { ok } or { ok: false, status, error } and changes nothing on failure.
function wear(u, id) {
  if (id === null || id === '' || id === undefined) { delete u.profileTheme; return { ok: true }; }
  if (typeof id !== 'string' || !byId(id)) return { ok: false, status: 400, error: 'Unknown profile theme' };
  if (!ownedSet(u).has(id)) return { ok: false, status: 403, error: 'You do not own this profile theme yet' };
  u.profileTheme = id;
  return { ok: true };
}

// spend is credits.spend (false when the balance does not cover it). The theme is added only after the payment went through.
function buy(u, id, spend, { now = Date.now() } = {}) {
  const t = typeof id === 'string' ? byId(id) : null;
  if (!t) return { ok: false, status: 404, error: 'Unknown profile theme' };
  if (!t.price) return { ok: false, status: 400, error: 'This theme is free' };
  if (ownedSet(u).has(t.id)) return { ok: false, status: 409, error: 'You already own this theme' };
  if (!spend(u, t.price, 'shop', { note: `${t.name} profile theme`, now })) return { ok: false, status: 402, error: 'Not enough credits' };
  if (!Array.isArray(u.profileThemes)) u.profileThemes = [];
  u.profileThemes.push(t.id);
  return { ok: true, theme: t };
}

module.exports = { THEMES, byId, ownedSet, wornId, view, wear, buy };
