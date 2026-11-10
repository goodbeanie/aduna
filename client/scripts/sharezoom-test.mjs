// Screen-share zoom maths and shortcut keys: node client/scripts/sharezoom-test.mjs
import assert from 'assert';
import zoomLib from '../../desktop/zoom.js'; // the desktop side (CommonJS): its idea of a valid shortcut must agree with what Settings builds
import { DEFAULT_KEY, ZOOM, stepLevel, cropRect, ease, keyFromCode, acceleratorFrom, keyLabel } from '../src/sharezoom.js';
const ok = (m) => console.log('✓', m);
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} vs ${b}`);

// scroll steps stay between the limits
near(stepLevel(2, 1), 2.4, 'one step in');
near(stepLevel(2, -1), 2 / 1.2, 'one step out');
assert.strictEqual(stepLevel(ZOOM.max, 1), ZOOM.max, 'cannot go past the maximum');
assert.strictEqual(stepLevel(ZOOM.min, -1), ZOOM.min, 'cannot go below the minimum');
{ let l = ZOOM.start; for (let i = 0; i < 50; i++) l = stepLevel(l, 1); assert.strictEqual(l, ZOOM.max); for (let i = 0; i < 50; i++) l = stepLevel(l, -1); assert.strictEqual(l, ZOOM.min); }
ok('scrolling zooms in and out in steps and stops at the limits');

// the crop follows the cursor but never leaves the picture
assert.deepStrictEqual(cropRect(1000, 500, 0.5, 0.5, 2), { sx: 250, sy: 125, sw: 500, sh: 250 });
assert.deepStrictEqual(cropRect(1000, 500, 0, 0, 2), { sx: 0, sy: 0, sw: 500, sh: 250 }, 'cursor in the top-left corner');
assert.deepStrictEqual(cropRect(1000, 500, 1, 1, 2), { sx: 500, sy: 250, sw: 500, sh: 250 }, 'cursor in the bottom-right corner');
assert.deepStrictEqual(cropRect(1000, 500, 0.3, 0.8, 1), { sx: 0, sy: 0, sw: 1000, sh: 500 }, 'no zoom shows everything');
assert.deepStrictEqual(cropRect(1000, 500, 0.3, 0.8, 0.5), { sx: 0, sy: 0, sw: 1000, sh: 500 }, 'a level below 1 is treated as 1');
{ const r = cropRect(1920, 1080, 0.9, 0.1, 4); assert.ok(r.sx >= 0 && r.sy >= 0 && r.sx + r.sw <= 1920 + 1e-9 && r.sy + r.sh <= 1080 + 1e-9); near(r.sw, 480, 'width at 4x'); }
ok('the zoomed crop is centred on the cursor and stays inside the screen');

// easing
assert.strictEqual(ease(0, 10, 0, 9), 0, 'no time, no movement');
assert.ok(ease(0, 10, 100, 9) > 9.999, 'given time it arrives');
{ const a = ease(0, 10, 1 / 30, 9), b = ease(ease(0, 10, 1 / 60, 9), 10, 1 / 60, 9); near(a, b, 'same result at 30 and 60 fps'); }
ok('easing looks the same at 30 and 60 frames a second');

// key names
assert.strictEqual(keyFromCode('KeyZ'), 'Z');
assert.strictEqual(keyFromCode('Digit5'), '5');
assert.strictEqual(keyFromCode('F12'), 'F12');
assert.strictEqual(keyFromCode('F25'), null);
assert.strictEqual(keyFromCode('Space'), 'Space');
assert.strictEqual(keyFromCode('ArrowUp'), 'Up');
assert.strictEqual(keyFromCode('ControlLeft'), null, 'a modifier alone is not a key');
assert.strictEqual(keyFromCode('Enter'), null);
assert.strictEqual(keyFromCode(undefined), null);
ok('key codes become accelerator key names');

const ev = (code, mods = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
assert.strictEqual(acceleratorFrom(ev('KeyZ', { ctrlKey: true, altKey: true, shiftKey: true })), 'Control+Alt+Shift+Z');
assert.strictEqual(acceleratorFrom(ev('F8', { altKey: true })), 'Alt+F8');
assert.strictEqual(acceleratorFrom(ev('KeyK', { ctrlKey: true, metaKey: true })), 'Control+Super+K');
assert.strictEqual(acceleratorFrom(ev('KeyZ', { shiftKey: true })), null, 'Shift + a letter is normal typing');
assert.strictEqual(acceleratorFrom(ev('KeyZ')), null, 'a bare key is refused');
assert.strictEqual(acceleratorFrom(ev('ControlLeft', { ctrlKey: true })), null, 'still holding only modifiers');
ok('a key press becomes a shortcut only with Ctrl, Alt or Win');

// the page and the desktop app agree
assert.strictEqual(DEFAULT_KEY, zoomLib.DEFAULT_KEY, 'same default on both sides');
assert.ok(zoomLib.validKey(DEFAULT_KEY));
for (const e of [ev('KeyZ', { ctrlKey: true, altKey: true, shiftKey: true }), ev('F8', { altKey: true }), ev('KeyK', { ctrlKey: true, metaKey: true }), ev('ArrowUp', { ctrlKey: true }), ev('Digit0', { altKey: true, shiftKey: true })]) {
  const a = acceleratorFrom(e);
  assert.ok(a && zoomLib.validKey(a), 'the desktop app accepts what Settings builds: ' + a);
}
ok('every shortcut Settings can build is accepted by the desktop app');

assert.strictEqual(keyLabel('Control+Alt+Shift+Z'), 'Ctrl + Alt + Shift + Z');
assert.strictEqual(keyLabel('Super+Left'), 'Win + Left');
ok('shortcuts are shown with friendly names');

console.log('all sharezoom tests passed');
