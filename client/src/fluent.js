// Fluent 3D emoji pictures. They are plain files in /fluent (copied there by scripts/fluent-emoji.mjs), plus a short list of their names.
// Emoji.jsx loads this the first time an emoji is drawn and waits for `ready`.
let names = new Set();

export const ready = fetch('/fluent/index.txt')
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
  .then((t) => { names = new Set(t.split(',')); });

// File names are the code points in lowercase hex, joined by "-", with the fe0f selector only where the full emoji has it
const hex = (s) => Array.from(s, (c) => c.codePointAt(0).toString(16).padStart(4, '0'));

export function fluentUrl(emoji) {
  const all = hex(emoji);
  const bare = all.filter((c) => c !== 'fe0f');
  const name = [all.join('-'), bare.join('-'), [bare[0], 'fe0f', ...bare.slice(1)].join('-')].find((n) => names.has(n));
  return name ? `/fluent/${name}.webp` : null;
}
