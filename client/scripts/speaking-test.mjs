// Speaking detection: node client/scripts/speaking-test.mjs
import assert from 'assert';
import { levelOf, SpeakingGate } from '../src/speaking.js';
const ok = (m) => console.log('✓', m);

// levelOf: 128 = silence; a full-scale square wave is ~1; a sine of amplitude A is A / sqrt(2)
assert.strictEqual(levelOf(new Uint8Array(512).fill(128)), 0);
assert.strictEqual(levelOf(new Uint8Array(0)), 0);
assert.strictEqual(levelOf(undefined), 0);
{
  const sq = new Uint8Array(512).map((_, i) => (i % 2 ? 255 : 0)); // about +-1
  assert.ok(levelOf(sq) > 0.99 && levelOf(sq) <= 1.01, 'square wave');
  const sine = new Uint8Array(512).map((_, i) => Math.round(128 + 64 * Math.sin(i / 5))); // amplitude 0.5
  assert.ok(Math.abs(levelOf(sine) - 0.5 / Math.SQRT2) < 0.02, 'sine wave ' + levelOf(sine));
  const hiss = new Uint8Array(512).map((_, i) => 128 + (i % 2 ? 1 : -1)); // +-1/128, far quieter than speech
  assert.ok(levelOf(hiss) < 0.01, 'background hiss');
}
ok('levelOf reads silence, hiss, a sine and a square wave correctly');

// the gate
const g = new SpeakingGate({ on: 0.02, off: 0.011, hold: 400 });
let t = 0;
const feed = (level, ms = 90) => { t += ms; return g.update(level, t); };
assert.strictEqual(feed(0), false, 'silence');
assert.strictEqual(feed(0.015), false, 'noise between off and on never starts it');
assert.strictEqual(feed(0.005), false);
assert.strictEqual(feed(0.05), true, 'speech starts it at once');
assert.strictEqual(feed(0.3), true);
ok('quiet noise does not trigger it, speech does immediately');

assert.strictEqual(feed(0), true, 'a pause between words (90 ms) keeps it on');
assert.strictEqual(feed(0), true, '180 ms');
assert.strictEqual(feed(0), true, '270 ms');
assert.strictEqual(feed(0), true, '360 ms: still inside the hold');
assert.strictEqual(feed(0), false, '450 ms of quiet: off');
ok('a short pause between words keeps the ring on, a real pause turns it off');

// each time it is loud again the hold timer restarts
feed(0.1); for (let i = 0; i < 4; i++) assert.strictEqual(feed(0.001), true);
feed(0.1); for (let i = 0; i < 4; i++) assert.strictEqual(feed(0.001), true);
assert.strictEqual(feed(0.001), false);
ok('the hold restarts every time there is speech');

// trailing-off speech between off and on keeps it alive, but only while it lasts
g.reset(); t = 0;
feed(0.05);
for (let i = 0; i < 20; i++) assert.strictEqual(feed(0.015), true, 'soft speech continues the sentence');
for (let i = 0; i < 4; i++) feed(0.002);
assert.strictEqual(feed(0.002), false);
ok('soft trailing speech keeps it on; it ends after silence');

// reset
g.update(0.5, 1); g.reset(); assert.strictEqual(g.speaking, false);
ok('reset turns it off');
console.log('\nAll speaking checks passed.');
