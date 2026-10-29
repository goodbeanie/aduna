// Tests for desktop/games.js: node desktop/games-test.js
const assert = require('assert');
const { GAMES, parseTasklist, pick } = require('./games');

const sample = [
  '"System Idle Process","0","Services","0","8 K"',
  '"chrome.exe","4120","Console","1","310,552 K"',
  '"cs2.exe","9988","Console","1","1,802,332 K"',
  '"Among Us.exe","7777","Console","1","400,000 K"',
  '"weird, name.exe","1","Console","1","1 K"',
  '',
  'INFO: not a process line',
].join('\r\n');

const running = parseTasklist(sample);
assert.ok(running.has('chrome.exe') && running.has('cs2.exe') && running.has('among us.exe'), 'names are read and lowercased');
assert.ok(running.has('weird, name.exe'), 'a comma inside a name is fine');
assert.strictEqual(running.size, 5, 'blank and non-process lines are skipped');
assert.strictEqual(parseTasklist('').size, 0);
assert.strictEqual(parseTasklist(null).size, 0);

assert.strictEqual(pick(parseTasklist('"chrome.exe","1","Console","1","1 K"'), null), null, 'no game running: nothing is reported');
assert.strictEqual(pick(new Set(['cs2.exe']), null), 'Counter-Strike 2');
assert.strictEqual(pick(new Set(['cs2.exe', 'among us.exe']), 'Counter-Strike 2'), 'Counter-Strike 2', 'the one already shown stays');
assert.strictEqual(pick(new Set(['cs2.exe', 'among us.exe']), 'Among Us'), 'Among Us', 'even when it sorts later');
assert.strictEqual(pick(new Set(['cs2.exe', 'among us.exe']), null), 'Among Us', 'a fresh pick is the same every time (alphabetical)');
assert.strictEqual(pick(new Set(['cs2.exe']), 'Among Us'), 'Counter-Strike 2', 'the old one closed: the new one is reported');
assert.strictEqual(pick(new Set(['r5apex.exe', 'r5apex_dx12.exe']), null), 'Apex Legends', 'two programs of one game count once');

for (const [exe, name] of Object.entries(GAMES)) {
  assert.strictEqual(exe, exe.toLowerCase(), 'list keys are lowercase: ' + exe);
  assert.ok(/\.exe$/.test(exe), 'list keys are program names: ' + exe);
  assert.ok(name && name.length <= 64, 'names fit the 64-character limit: ' + name);
  assert.ok(!/https?:|www\.|\.(com|net|org)\b/i.test(name), 'no link-like names: ' + name);
}
console.log('games: all good (' + Object.keys(GAMES).length + ' programs)');
