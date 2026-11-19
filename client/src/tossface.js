// Tossface emoji pictures (see scripts/make-tossface.mjs). They are plain SVG files in /tossface, plus a short list of their names.
// Emoji.jsx loads this the first time an emoji is drawn and waits for `ready`.
let names = new Set();

export const ready = fetch('/tossface/index.txt')
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
  .then((t) => { names = new Set(t.split(',')); });

// File names are the code points in lowercase hex, joined by "-", without the fe0f selector
const hex = (s) => Array.from(s, (c) => c.codePointAt(0).toString(16).padStart(4, '0'));

export function tossfaceUrl(emoji) {
  const name = hex(emoji).filter((c) => c !== 'fe0f').join('-');
  return names.has(name) ? `/tossface/${name}.svg` : null;
}
