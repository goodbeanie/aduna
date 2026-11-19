// Fluent 3D emoji pictures, in their own chunk (Emoji.jsx loads it the first time an emoji is drawn).
const files = import.meta.glob('../node_modules/@lobehub/fluent-emoji-3d/assets/*.webp', { eager: true, query: '?url&no-inline', import: 'default' });

const urls = new Map();
for (const [path, url] of Object.entries(files)) urls.set(path.slice(path.lastIndexOf('/') + 1, -5), url);

// File names are the code points in lowercase hex, joined by "-", with the fe0f selector only where the full emoji has it
const hex = (s) => Array.from(s, (c) => c.codePointAt(0).toString(16).padStart(4, '0'));

export function fluentUrl(emoji) {
  const all = hex(emoji);
  const bare = all.filter((c) => c !== 'fe0f');
  return urls.get(all.join('-'))
    || urls.get(bare.join('-'))
    || urls.get([bare[0], 'fe0f', ...bare.slice(1)].join('-'))
    || null;
}
