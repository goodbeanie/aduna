'use strict';
// Builds the word data Contexto needs: node server/contexto-build.js [--force]
//
// Contexto ranks every guess by how close its meaning is to the secret word. "Meaning" comes from GloVe word vectors (trained on
// Wikipedia and news text, public domain licence PDDL). This script downloads the 100-dimension set once, keeps the 30,000 most
// common English words (checked against the dictionary package), and writes three small files into server/contexto-data/:
//   words.txt    the vocabulary, one word per line, most common first (every one of these is a legal guess)
//   vectors.bin  8-byte header (uint32 words, uint32 dimensions) then words x dimensions signed bytes, each vector scaled to length 127
//   answers.txt  the words that can be picked as the word of the day, one per line. Do not reorder or remove words once Contexto is
//                live: which word a day gets depends on this list.
// The files are committed to the repository (about 3 MB), so the server never has to download anything. Run this only to rebuild them.
// If answers.txt already exists it is kept (so the daily words never change); pass --force to replace it as well.
// --if-missing (used by "npm run build") does nothing when the data is already there, and never fails the build if the download does.

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const readline = require('readline');

const SRC = 'https://github.com/RaRe-Technologies/gensim-data/releases/download/glove-wiki-gigaword-100/glove-wiki-gigaword-100.gz';
const OUT = path.join(__dirname, 'contexto-data');
const VOCAB = 30000, DIM = 100;
const ANSWER_FROM = 300, ANSWER_TO = 16000; // answers come from the common-but-not-function-word part of the list
const FORCE = process.argv.includes('--force'), IF_MISSING = process.argv.includes('--if-missing');

// Words that never make a good word of the day (they can still be guessed).
const NO_ANSWER = new Set(('also been being both could does done each even ever from have here into just like made make many more most much must only other over said same some such than that their them then there these they this those very were what when where which while will with would your about after again against almost along already always among another because before below between cannot during either enough every first former however indeed instead itself later latter least less little might neither never next none often once others ought perhaps rather really since still though through thus today together toward under until upon whether within without yourself ' +
  'fuck shit bitch cunt dick cock pussy nigger nigga fag faggot whore slut rape rapist porn nazi hitler bastard damn crap piss tits boob penis vagina anal sex sexual sexy nude naked kill murder murderer suicide terror terrorist abortion homosexual prostitute holocaust racist cocaine diarrhea assassin gunman sniper shrapnel').split(/\s+/));

// Places, nationalities and calendar names are poor answers (hard to reach by meaning alone).
const PLACES = new Set(('america american europe european asia asian africa african china chinese japan japanese russia russian india indian france french germany german britain british england english scotland ireland irish italy italian spain spanish mexico mexican canada canadian australia australian brazil israel israeli iran iraq syria turkey greek greece egypt korea korean vietnam texas california florida york london paris berlin moscow beijing tokyo washington ohio jersey virginia carolina georgia michigan illinois pennsylvania ' +
  'january february april june july august september october november december monday tuesday wednesday thursday friday saturday sunday').split(/\s+/));

// With the WordNet package installed (npm i --no-save wordnet-db) answers are limited to everyday nouns. Without it a suffix check is used.
function everydayNouns() {
  let dir; try { dir = path.join(path.dirname(require.resolve('wordnet-db/package.json')), 'dict'); } catch { return null; }
  const tagged = (file) => { const m = new Map(); for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) { if (line[0] === ' ') continue; const f = line.split(' '); if (f.length < 8) continue; const p = Number(f[3]); m.set(f[0], Number(f[5 + p])); } return m; };
  const noun = tagged('index.noun'), others = [tagged('index.verb'), tagged('index.adj'), tagged('index.adv')];
  const lower = new Set();
  for (const line of fs.readFileSync(path.join(dir, 'data.noun'), 'utf8').split('\n')) {
    if (line[0] === ' ') continue;
    const f = line.split(' '), n = parseInt(f[3], 16);
    for (let i = 0; i < n; i++) { const w = f[4 + i * 2]; if (w && w === w.toLowerCase()) lower.add(w); }
  }
  const ok = new Set();
  for (const [w, c] of noun) if (c >= 1 && lower.has(w) && c >= Math.max(0, ...others.map((m) => m.get(w) || 0))) ok.add(w);
  return ok;
}

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'aduna-contexto-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); return resolve(get(new URL(res.headers.location, url).href, redirects - 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('Download failed: HTTP ' + res.statusCode)); }
      resolve(res);
    }).on('error', reject);
  });
}

async function main() {
  if (IF_MISSING && !FORCE && fs.existsSync(path.join(OUT, 'words.txt')) && fs.existsSync(path.join(OUT, 'vectors.bin')) && fs.existsSync(path.join(OUT, 'answers.txt'))) return console.log('Contexto data is already there');
  const dict = new Set(require('an-array-of-english-words').filter((w) => /^[a-z]+$/.test(w)));
  console.log('Downloading GloVe 100d (about 130 MB, once)…');
  const stream = (await get(SRC)).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const words = [], vecs = new Int8Array(VOCAB * DIM);
  for await (const line of rl) {
    if (words.length >= VOCAB) break;
    const sp = line.indexOf(' ');
    const w = line.slice(0, sp);
    if (!/^[a-z]{2,14}$/.test(w) || !dict.has(w)) continue;
    const parts = line.slice(sp + 1).split(' ').map(Number);
    if (parts.length !== DIM || parts.some((x) => !Number.isFinite(x))) continue;
    let n = 0; for (const x of parts) n += x * x; n = Math.sqrt(n) || 1;
    const o = words.length * DIM;
    for (let i = 0; i < DIM; i++) vecs[o + i] = Math.round((parts[i] / n) * 127);
    words.push(w);
  }
  rl.close(); stream.destroy();
  if (words.length < VOCAB) throw new Error('Only found ' + words.length + ' usable words');

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'words.txt'), words.join('\n') + '\n');
  const header = Buffer.alloc(8); header.writeUInt32LE(words.length, 0); header.writeUInt32LE(DIM, 4);
  fs.writeFileSync(path.join(OUT, 'vectors.bin'), Buffer.concat([header, Buffer.from(vecs.buffer)]));

  const ansFile = path.join(OUT, 'answers.txt');
  if (FORCE || !fs.existsSync(ansFile)) {
    const set = new Set(words), answers = [], nouns = everydayNouns();
    console.log(nouns ? 'Choosing answers from WordNet nouns' : 'WordNet not installed: choosing answers by spelling only');
    for (let i = ANSWER_FROM; i < Math.min(ANSWER_TO, words.length); i++) {
      const w = words[i];
      if (w.length < 4 || w.length > 10 || NO_ANSWER.has(w) || PLACES.has(w)) continue;
      if (nouns && !nouns.has(w)) continue;
      if (/s$/.test(w) && !/(ss|us|is)$/.test(w) && (set.has(w.slice(0, -1)) || set.has(w.replace(/ies$/, 'y')) || set.has(w.replace(/es$/, '')))) continue; // plurals: the singular is the answer
      if (/(ed|ly)$/.test(w) && w.length > 5) continue; // past tenses and adverbs read badly as answers
      if (/ing$/.test(w) && w.length > 6 && set.has(w.slice(0, -3))) continue;
      answers.push(w);
    }
    fs.writeFileSync(ansFile, answers.join('\n') + '\n');
    console.log('answers:', answers.length);
  } else console.log('answers.txt kept as it is');
  console.log('Wrote', words.length, 'words,', DIM, 'dimensions to', OUT);
}
main().catch((e) => { console.error(IF_MISSING ? 'Contexto data could not be built (' + (e.message || e) + '): the game will say it is not set up' : e.message || e); process.exit(IF_MISSING ? 0 : 1); });
