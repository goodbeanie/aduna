// Server bar layout validation: node server/railfolders-test.js
const assert = require('assert');
const { cleanRail } = require('./railfolders');

assert.deepStrictEqual(cleanRail([]), [], 'an empty layout is fine (no folders)');
assert.deepStrictEqual(cleanRail([{ s: 'a1' }, { f: 'f1', name: '  Games ', color: '#E8743B', ids: ['b2', 'c3'] }]),
  [{ s: 'a1' }, { f: 'f1', name: 'Games', color: '#e8743b', ids: ['b2', 'c3'] }], 'names are trimmed, colours lower-cased');
assert.deepStrictEqual(cleanRail([{ f: 'f1', name: '', color: '#000000', ids: ['b2'] }])[0].name, 'Folder', 'no name becomes Folder');
assert.deepStrictEqual(cleanRail([{ s: 'a1' }, { s: 'a1' }, { f: 'f1', name: 'x', color: '#000000', ids: ['a1', 'b2'] }]),
  [{ s: 'a1' }, { f: 'f1', name: 'x', color: '#000000', ids: ['b2'] }], 'a server shows up once');
assert.deepStrictEqual(cleanRail([{ f: 'f1', name: 'x', color: '#000000', ids: [] }]), [], 'an empty folder is dropped');

const bad = [null, undefined, {}, 'x', 5, [null], [[]], [{}], [{ s: 5 }], [{ s: '' }], [{ s: 'a b' }], [{ s: 'a'.repeat(65) }], [{ s: { toString: 'x' } }],
  [{ f: 'f', name: 'x', color: '#000000' }], [{ f: 'f', name: 'x', color: '#000000', ids: 'a' }], [{ f: 'f', name: 'x', color: 'red', ids: ['a'] }],
  [{ f: 'f', name: 'x', color: '#fff', ids: ['a'] }], [{ f: 'f', name: '<img src=x onerror=alert(1)>', color: '#000000', ids: ['a'] }],
  [{ f: 'f', name: 'x'.repeat(31), color: '#000000', ids: ['a'] }], [{ f: 'f', name: { toString: 'x' }, color: '#000000', ids: ['a'] }],
  [{ f: 'f', name: 'x', color: '#000000', ids: [5] }], [{ f: 'f', name: 'x\u0000', color: '#000000', ids: ['a'] }],
  Array.from({ length: 201 }, (_, i) => ({ s: 's' + i })), [{ f: 'f', name: 'x', color: '#000000', ids: Array.from({ length: 201 }, (_, i) => 's' + i) }]];
for (const b of bad) assert.strictEqual(cleanRail(b), null, 'refused: ' + JSON.stringify(b)?.slice(0, 60));

console.log('railfolders-test: all passed');
