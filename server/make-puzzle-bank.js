// Builds server/puzzle-bank.js, the puzzles the daily chess puzzle picks from: node server/make-puzzle-bank.js [seconds to spend on each depth]
// It makes random positions (puzzle-gen.js) and keeps the ones that are a forced mate with a single first move. The seed is fixed, so the
// same run gives the same puzzles. The daily puzzle of a day depends on the bank's order and length: once the game is live, run this
// again only to ADD puzzles (a longer time gives the same puzzles first, then more), never to replace them.
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./puzzle-gen');

const secs = Number(process.argv[2]) || 120;
const TARGET = { 1: 80, 2: 80, 3: 60 };
const rng = G.rngFrom(20261101);
const bank = { 1: [], 2: [], 3: [] };

for (const n of [1, 2, 3]) {
  const t0 = Date.now(), seen = new Set();
  let tried = 0;
  while (bank[n].length < TARGET[n] && Date.now() - t0 < secs * 1000) {
    tried++;
    const f = G.tryOne(n, rng);
    if (f && !seen.has(f)) { seen.add(f); bank[n].push(f); }
  }
  console.log(`mate in ${n}: ${bank[n].length} puzzles from ${tried} positions in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const body = [1, 2, 3].map((n) => `  ${n}: [\n${bank[n].map((f) => `    '${f}',`).join('\n')}\n  ],`).join('\n');
fs.writeFileSync(path.join(__dirname, 'puzzle-bank.js'),
  `'use strict';\n// The puzzles of the daily chess puzzle, by how many moves the mate takes. Made by make-puzzle-bank.js: every one is a forced mate with\n// exactly one first move and no shorter mate (puzzle-test.js checks them all). Do not reorder or remove any: which puzzle a day gets depends on this list.\nmodule.exports = {\n${body}\n};\n`);
console.log('wrote server/puzzle-bank.js');
if ([1, 2, 3].some((n) => bank[n].length < 20)) { console.error('fewer than 20 puzzles for some depth: run it again with more seconds'); process.exitCode = 1; }
