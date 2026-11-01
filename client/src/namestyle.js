import './namestyle.css';

// Name styles: the font and the gradient a display name is drawn in. The server (server/namestyle.js) validates and stores them:
//   user.nameFont     = one of the ids below, or null for the app's own font
//   user.nameGradient = { colors: [2 or 3 #rrggbb], angle }, or null for the plain colour (user.accentColor)
// Keep the ids in sync with FONTS in server/namestyle.js. The fonts themselves are bundled by namestyle.css.
export const NAME_FONTS = [
  { id: 'aduna', label: 'Aduna', vibe: 'Default' },
  { id: 'serif', label: 'Serif', vibe: 'Classic' },
  { id: 'rounded', label: 'Rounded', vibe: 'Friendly' },
  { id: 'cute', label: 'Cute', vibe: 'Playful' },
  { id: 'hand', label: 'Handwritten', vibe: 'Casual' },
  { id: 'script', label: 'Script', vibe: 'Fancy' },
  { id: 'romantic', label: 'Romantic', vibe: 'Elegant' },
  { id: 'display', label: 'Display', vibe: 'Bold' },
  { id: 'mono', label: 'Mono', vibe: 'Technical' },
  { id: 'pixel', label: 'Pixel', vibe: 'Gaming' },
  { id: 'terminal', label: 'Terminal', vibe: 'Retro hacker' },
  { id: 'scifi', label: 'Sci-fi', vibe: 'Futuristic' },
  { id: 'fantasy', label: 'Fantasy', vibe: 'Medieval, RPG' },
  { id: 'marker', label: 'Marker', vibe: 'Street' },
  { id: 'comic', label: 'Comic', vibe: 'Action' },
  { id: 'spooky', label: 'Spooky', vibe: 'Horror' },
];
const FONT_IDS = new Set(NAME_FONTS.map((f) => f.id));
export const MAX_NAME_STOPS = 3; // the server accepts 2 or 3 colours
export const DEFAULT_NAME_GRADIENT = { colors: ['#ff7a59', '#7a5cff'], angle: 90 };

export const nameGradientCss = (g) => `linear-gradient(${g.angle}deg, ${g.colors.join(', ')})`;

const validGradient = (g) => (g && Array.isArray(g.colors) && g.colors.length >= 2 && g.colors.length <= MAX_NAME_STOPS && Number.isFinite(g.angle) ? g : null);

// Spread onto the element that holds a display name: <b {...nameProps(user)}>{user.displayName}</b>
//   override = a colour that wins over the person's own (a role colour in a server). A role colour also wins over the gradient,
//   so a server's roles still read as roles; the font always applies.
export function nameProps(user, override) {
  const style = { '--nc': override || user?.accentColor };
  const props = { 'data-nc': true, style };
  const g = override ? null : validGradient(user?.nameGradient);
  if (g) { props['data-ng'] = true; style['--ng'] = nameGradientCss(g); }
  const f = user?.nameFont;
  if (f && f !== 'aduna' && FONT_IDS.has(f)) props['data-nf'] = f;
  return props;
}
