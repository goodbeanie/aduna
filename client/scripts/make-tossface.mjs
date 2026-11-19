// Imports the Tossface emoji pictures (github.com/toss/tossface, dist/svg) into public/tossface/ and lists their names in index.txt.
// Run it again to update:  git clone https://github.com/toss/tossface.git tmp-tossface  (next to the client folder), then  npm run tossface
// Pass another folder to read from as the first argument. The files are copied as they are: Toss's terms allow free use but not changing the art.
// Tossface names its files u1F62D.svg / u1F1E6_u1F1E8.svg; here they become the lowercase code points joined by "-" (1f62d, 1f1e6-1f1e8),
// which is how src/tossface.js looks a Unicode emoji up.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.resolve(process.argv[2] || path.join(root, '..', 'tmp-tossface', 'dist', 'svg'));
const to = path.join(root, 'public', 'tossface');

if (!fs.existsSync(from)) {
  console.error(`tossface: ${from} not found. Clone https://github.com/toss/tossface.git next to the client folder as tmp-tossface, or pass the dist/svg folder.`);
  process.exit(1);
}

fs.rmSync(path.join(root, 'public', 'fluent'), { recursive: true, force: true }); // the picture set this one replaced
fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });

const names = [];
let skipped = 0;
for (const file of fs.readdirSync(from)) {
  const m = /^(u[0-9A-F]{4,6}(?:_u[0-9A-F]{4,6})*)\.svg$/.exec(file);
  if (!m) { skipped++; continue; } // plain-named copies of digits and symbols (one.svg, asterisk.svg): not emoji
  const name = m[1].split('_').map((c) => c.slice(1).toLowerCase().padStart(4, '0')).join('-');
  fs.copyFileSync(path.join(from, file), path.join(to, name + '.svg'));
  names.push(name);
}
fs.writeFileSync(path.join(to, 'index.txt'), names.sort().join(','));
const bytes = names.reduce((n, x) => n + fs.statSync(path.join(to, x + '.svg')).size, 0);
console.log(`tossface: ${names.length} pictures (${(bytes / 1048576).toFixed(1)} MB) in public/tossface, ${skipped} other files skipped`);
