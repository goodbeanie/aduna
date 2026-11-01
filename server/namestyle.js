// Name styles: the font and the gradient a person's display name is drawn in. Both are free for everybody and both are optional.
//   u.nameFont     = the id of one of FONTS (the app has each of them bundled), or nothing for the app's own font
//   u.nameGradient = { colors: [2 or 3 #rrggbb], angle }, painted over the name instead of the plain colour (u.accentColor, which stays as the fallback)
//
// Like profilethemes.js this has no Express / Postgres imports: the rules are plain functions on a user record, so they can be
// unit tested (server/namestyle-test.js). index.js calls apply() from PATCH /api/me and view() from publicUser().

// Keep in sync with client/src/namestyle.js, which maps each id to the font it is drawn in.
const FONTS = ['aduna', 'serif', 'rounded', 'hand', 'mono', 'display', 'script'];
const HEX = /^#[0-9a-fA-F]{6}$/;

const cleanFont = (id) => (typeof id === 'string' && FONTS.includes(id) ? id : null);

// 2 or 3 colours and an angle in degrees, or null. Colours are lower-cased and the angle wraps into 0 to 359.
function cleanGradient(g) {
  if (!g || typeof g !== 'object' || !Array.isArray(g.colors) || g.colors.length < 2 || g.colors.length > 3) return null;
  if (!g.colors.every((c) => typeof c === 'string' && HEX.test(c))) return null;
  const a = Number(g.angle);
  if (!Number.isFinite(a)) return null;
  return { colors: g.colors.map((c) => c.toLowerCase()), angle: ((Math.round(a) % 360) + 360) % 360 };
}

// What other people are sent about this person's name.
const view = (u) => ({ nameFont: cleanFont(u.nameFont), nameGradient: cleanGradient(u.nameGradient) });

// Applies the name fields of a profile update (`b`, the request body) to the user record. A field that is not in the request is left alone,
// null (or '' for the font) takes it off, and junk is ignored, the same way the colour fields are.
function apply(u, b) {
  if (b.nameFont !== undefined) {
    const f = cleanFont(b.nameFont);
    if (f) u.nameFont = f; else if (b.nameFont === null || b.nameFont === '') delete u.nameFont;
  }
  if (b.nameGradient !== undefined) {
    const g = cleanGradient(b.nameGradient);
    if (g) u.nameGradient = g; else if (b.nameGradient === null) delete u.nameGradient;
  }
}

module.exports = { FONTS, cleanFont, cleanGradient, view, apply };
