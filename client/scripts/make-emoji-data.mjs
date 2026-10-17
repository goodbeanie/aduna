// Builds src/emoji-data.json (the full Unicode emoji set the picker uses) from the emojibase-data package.
// Run: node scripts/make-emoji-data.mjs
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const data = require('emojibase-data/en/data.json');
const GROUPS = { 0: 'Smileys & Emotion', 1: 'People & Body', 3: 'Animals & Nature', 4: 'Food & Drink', 5: 'Travel & Places', 6: 'Activities', 7: 'Objects', 8: 'Symbols', 9: 'Flags' };
const groups = Object.entries(GROUPS).map(([id, name]) => ({ id: Number(id), name, items: [] }));
const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
for (const e of data.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
  const g = byId[e.group];
  if (!g || !e.emoji) continue;
  // [emoji, label, search tags, unicode version, five skin-tone variants (single tone only)]
  const row = [e.emoji, e.label, (e.tags || []).join(' '), e.version || 0];
  const tones = (e.skins || []).filter((s) => typeof s.tone === 'number').sort((a, b) => a.tone - b.tone).map((s) => s.emoji);
  if (tones.length === 5) row.push(tones);
  g.items.push(row);
}
writeFileSync(new URL('../src/emoji-data.json', import.meta.url), JSON.stringify({ groups }));
console.log(groups.map((g) => g.name + ': ' + g.items.length).join('\n'));
