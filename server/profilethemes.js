// Profile themes: a gradient look for a profile card (banner and card tint, some of them slowly moving).
// Every theme is free for everybody, and so is the Custom gradient (your own colours and angle). Nothing is sold.
//
// Animated themes are written but switched off (`released: false`) until they are ready. To launch one later, delete that flag
// (or set it to true): it then shows up in everybody's picker. People who bought one back when themes cost credits still own it.
//
// Like shop.js this has no Express / Postgres imports: the rules are plain functions on a user record, so they can be
// unit tested (server/profilethemes-test.js). credits.js wires them to the routes.
//   u.profileTheme  = the id of the theme being worn (or nothing)
//   u.profileThemes = ids of themes this person got early (kept so that earlier purchases are never lost)
//   u.profileGradient = the person's own gradient { colors: [2 to 4 #rrggbb], angle } (worn when u.profileTheme is 'custom')

const THEMES = [
  // ----- free, still -----
  { id: 'sunrise',  name: 'Sunrise',        price: 0, angle: 135, colors: ['#ff9a8b', '#ff6a88', '#ffb199'] },
  { id: 'ocean',    name: 'Ocean Breeze',   price: 0, angle: 120, colors: ['#43c6ac', '#3a8fd9', '#191654'] },
  { id: 'mint',     name: 'Mint Fresh',     price: 0, angle: 150, colors: ['#a8e6cf', '#7fd1ae', '#dcedc1'] },
  { id: 'lavender', name: 'Lavender Dream', price: 0, angle: 135, colors: ['#c3b1f5', '#8e7cf0', '#f3b6e3'] },
  { id: 'glacier',  name: 'Glacier',        price: 0, angle: 160, colors: ['#e0f7ff', '#8fd3f4', '#5b8def'] },
  { id: 'golden',   name: 'Golden Hour',    price: 0, angle: 135, colors: ['#f6d365', '#fda085', '#f5576c'] },
  // ----- animated: ready in the code, not on sale yet (flip `released` to launch) -----
  { id: 'aurora',   name: 'Aurora',         price: 0, angle: 135, colors: ['#0f2027', '#2c5364', '#5eead4'], animated: true, released: false },
  { id: 'ember',    name: 'Ember',          price: 0, angle: 160, colors: ['#1c0f0f', '#8a3b12', '#ffb066'], animated: true, released: false },
  { id: 'nebula',   name: 'Nebula',         price: 0, angle: 135, colors: ['#1a1033', '#5b2a86', '#e0a8ff', '#ff7ac6'], animated: true, released: false },
  { id: 'neon',     name: 'Neon Nights',    price: 0, angle: 120, colors: ['#12c2e9', '#c471ed', '#f64f59'], animated: true, released: false },
];

const byId = (id) => THEMES.find((t) => t.id === id) || null;
const isReleased = (t) => t.released !== false;

// ----- custom gradient: free for everybody. The person picks 2 to 4 colours and an angle (u.profileTheme = 'custom', u.profileGradient = { colors, angle }) -----
const CUSTOM_ID = 'custom';
const HEX = /^#[0-9a-fA-F]{6}$/;
function cleanCustom(g) {
  if (!g || typeof g !== 'object' || !Array.isArray(g.colors) || g.colors.length < 2 || g.colors.length > 4) return null;
  if (!g.colors.every((c) => typeof c === 'string' && HEX.test(c))) return null;
  const a = Number(g.angle);
  if (!Number.isFinite(a)) return null;
  return { colors: g.colors.map((c) => c.toLowerCase()), angle: ((Math.round(a) % 360) + 360) % 360 };
}

// Everything released is owned by everybody; an unreleased theme only by people who already had it.
function ownedSet(u) {
  const s = new Set(THEMES.filter(isReleased).map((t) => t.id));
  if (Array.isArray(u.profileThemes)) for (const id of u.profileThemes) if (byId(id)) s.add(id);
  return s;
}

// The theme other people see on this person's profile: the one they wear, if they still own it.
function wornId(u) {
  if (u.profileTheme === CUSTOM_ID) return cleanCustom(u.profileGradient) ? CUSTOM_ID : null;
  return u.profileTheme && byId(u.profileTheme) && ownedSet(u).has(u.profileTheme) ? u.profileTheme : null;
}

// The custom gradient other people see (colours and angle), or null when the person does not wear it.
const customOf = (u) => (wornId(u) === CUSTOM_ID ? cleanCustom(u.profileGradient) : null);

// Everything the picker needs: the look of every theme this person can use, and whether they wear it.
// Unreleased themes are left out unless the person already owns one, so they stay hidden until launch.
function view(u) {
  const own = ownedSet(u), worn = wornId(u);
  return THEMES.filter((t) => own.has(t.id)).map((t) => ({
    id: t.id, name: t.name, angle: t.angle, colors: t.colors, animated: !!t.animated,
    owned: true, worn: worn === t.id,
  }));
}

// null / '' takes the theme off. 'custom' wears the person's own gradient (`custom` = { colors, angle }; left out, the saved one is kept).
// Returns { ok } or { ok: false, status, error } and changes nothing on failure.
function wear(u, id, custom) {
  if (id === null || id === '' || id === undefined) { delete u.profileTheme; return { ok: true }; }
  if (id === CUSTOM_ID) {
    const g = cleanCustom(custom !== undefined ? custom : u.profileGradient);
    if (!g) return { ok: false, status: 400, error: 'Pick 2 to 4 colours and an angle for your custom gradient' };
    u.profileTheme = CUSTOM_ID; u.profileGradient = g;
    return { ok: true };
  }
  if (typeof id !== 'string' || !byId(id)) return { ok: false, status: 400, error: 'Unknown profile theme' };
  if (!ownedSet(u).has(id)) return { ok: false, status: 403, error: 'This profile theme is not available yet' };
  u.profileTheme = id;
  return { ok: true };
}

module.exports = { THEMES, CUSTOM_ID, byId, isReleased, cleanCustom, ownedSet, wornId, customOf, view, wear };
