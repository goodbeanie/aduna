// The AI bot builder tests bots with the SAME rules as the server. Those rules live in server/ (CommonJS, tested on their own);
// the desktop app uses generated copies so the two can never disagree about limits, refused channels, timers, storage or URLs.
//   node desktop/ai/sync-server.js           write the copies
//   node desktop/ai/sync-server.js --check   exit 1 if a copy is out of date (used by npm test)
// An installed copy of the app has no server/ folder: then there is nothing to check and the committed copies are kept.
'use strict';
const fs = require('fs');
const path = require('path');

const FILES = ['sandbox-core.js', 'botstate.js', 'botrun.js', 'botfetch.js'];
const serverDir = path.join(__dirname, '..', '..', 'server');
const header = (f) => `// GENERATED from server/${f} by desktop/ai/sync-server.js. Edit that file, not this one.\n`;
const expected = (f) => header(f) + fs.readFileSync(path.join(serverDir, f), 'utf8');

if (!fs.existsSync(path.join(serverDir, FILES[0]))) {
  console.log('sync-server: no server/ folder next to desktop/, keeping the committed copies');
  process.exit(0);
}

if (process.argv.includes('--check')) {
  const stale = FILES.filter((f) => { let have = ''; try { have = fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch { /* missing */ } return have !== expected(f); });
  if (stale.length) { console.error('desktop/ai is out of date for: ' + stale.join(', ') + '. Run: node desktop/ai/sync-server.js'); process.exit(1); }
  console.log('desktop/ai copies match server/ (' + FILES.join(', ') + ')');
} else {
  for (const f of FILES) fs.writeFileSync(path.join(__dirname, f), expected(f));
  console.log('sync-server: wrote ' + FILES.join(', '));
}
