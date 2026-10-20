// The notification rules live in server/notifprefs.js (CommonJS, tested on its own). The browser uses the very same
// code through a generated copy, client/src/notifprefs.js, so the two can never disagree about what counts or alerts.
//   node scripts/sync-notifprefs.mjs           write the copy (runs before `vite` and `vite build`)
//   node scripts/sync-notifprefs.mjs --check   exit 1 if the copy is out of date (used by npm test)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.join(here, '..', '..', 'server', 'notifprefs.js');
const to = path.join(here, '..', 'src', 'notifprefs.js');

const src = fs.readFileSync(from, 'utf8');
const m = /^module\.exports = \{([^}]*)\};\s*$/m.exec(src);
if (!m) { console.error('sync-notifprefs: could not find the module.exports line in server/notifprefs.js'); process.exit(1); }
const out = '// GENERATED from server/notifprefs.js by client/scripts/sync-notifprefs.mjs. Edit that file, not this one.\n'
  + src.slice(0, m.index) + 'export {' + m[1] + '};\n';

if (process.argv.includes('--check')) {
  let have = '';
  try { have = fs.readFileSync(to, 'utf8'); } catch { /* missing */ }
  if (have !== out) { console.error('client/src/notifprefs.js is out of date. Run: node client/scripts/sync-notifprefs.mjs'); process.exit(1); }
  console.log('client/src/notifprefs.js matches server/notifprefs.js');
} else {
  // an installed copy of the project may have no server/ folder next to client/ (client-only build): keep the committed copy then
  fs.writeFileSync(to, out);
}
