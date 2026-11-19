// Copies the Fluent 3D emoji pictures out of node_modules into public/fluent/ and lists their names in index.txt.
// The app loads that short list and then each picture as a plain file, instead of bundling a table of every picture into its code.
// public/fluent/ is not tracked by git: this runs before every dev start and build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'node_modules', '@lobehub', 'fluent-emoji-3d', 'assets');
const to = path.join(root, 'public', 'fluent');

if (!fs.existsSync(from)) {
  console.warn('fluent-emoji: @lobehub/fluent-emoji-3d is not installed (run npm install); emoji will show as plain characters');
  process.exit(0);
}

fs.mkdirSync(to, { recursive: true });
const names = [];
let copied = 0;
for (const file of fs.readdirSync(from)) {
  if (!file.endsWith('.webp')) continue;
  const src = path.join(from, file), dst = path.join(to, file);
  if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) { fs.copyFileSync(src, dst); copied++; }
  names.push(file.slice(0, -5));
}
fs.writeFileSync(path.join(to, 'index.txt'), names.sort().join(','));
console.log(`fluent-emoji: ${names.length} pictures in public/fluent (${copied} copied)`);
