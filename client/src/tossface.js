// Tossface emoji pictures (see scripts/make-tossface.mjs). They are plain SVG files in /tossface, plus a short list of their names.
// Emoji.jsx loads this the first time an emoji is drawn and waits for `ready`.
// If the list cannot be read (offline, or the server sent a page instead of the list), `names` stays null and every emoji is tried
// as a picture anyway; Emoji.jsx falls back to the plain character for the ones that fail.
let names = null;

export const ready = fetch('/tossface/index.txt', { cache: 'no-cache' })
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
  .then((t) => { if (/^[0-9a-f-]+(,[0-9a-f-]+)*$/.test(t.trim())) names = new Set(t.trim().split(',')); })
  .catch(() => {});

// File names are the code points in lowercase hex, joined by "-", without the fe0f selector
const hex = (s) => Array.from(s, (c) => c.codePointAt(0).toString(16).padStart(4, '0'));

export function tossfaceUrl(emoji) {
  const name = hex(emoji).filter((c) => c !== 'fe0f').join('-');
  return !names || names.has(name) ? `/tossface/${name}.svg` : null;
}
