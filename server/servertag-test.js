// Server tags without a server: node server/servertag-test.js
const assert = require('assert');
const T = require('./servertag');
const step = (s) => console.log('ok -', s);

// ---- designing a tag ----
assert.deepStrictEqual(T.clean({ text: 'ADUN', bg: '#5865F2', frame: null }), { value: { text: 'ADUN', bg: '#5865f2', frame: null } });
assert.deepStrictEqual(T.clean({ text: ' ab ', bg: '#000000', frame: '#FFFFFF' }), { value: { text: 'ab', bg: '#000000', frame: '#ffffff' } }, 'trimmed, colours lowercased');
assert.deepStrictEqual(T.clean({ text: 'X1', bg: '#000000' }), { value: { text: 'X1', bg: '#000000', frame: null } }, 'no frame field = no frame');
assert.deepStrictEqual(T.clean({ text: '日本語', bg: '#000000' }).value.text, '日本語', 'other languages count by character');
step('valid tags');

assert.ok(T.clean({ text: 'ABCDE', bg: '#000000' }).error, 'five characters is too long');
assert.ok(T.clean({ text: 'a b', bg: '#000000' }).error, 'no spaces');
assert.ok(T.clean({ text: 'A!', bg: '#000000' }).error, 'no symbols');
assert.ok(T.clean({ text: '😀', bg: '#000000' }).error, 'no emoji');
assert.ok(T.clean({ text: 'ABC' }).error, 'a background colour is required');
assert.ok(T.clean({ text: 'ABC', bg: 'red' }).error, 'colours are #rrggbb');
assert.ok(T.clean({ text: 'ABC', bg: '#000000', frame: 'blue' }).error, 'a frame colour must be #rrggbb too');
assert.ok(T.clean('ABC').error && T.clean([]).error, 'must be an object');
step('invalid tags are refused');

assert.deepStrictEqual(T.clean(null), { value: null });
assert.deepStrictEqual(T.clean({ text: '   ', bg: '#000000' }), { value: null }, 'empty text removes the tag');
step('removing a tag');

// ---- readable text colour ----
assert.strictEqual(T.textColorOn('#ffffff'), '#111111');
assert.strictEqual(T.textColorOn('#000000'), '#ffffff');
assert.strictEqual(T.textColorOn('#fee75c'), '#111111', 'a light yellow gets dark text');
assert.strictEqual(T.textColorOn('#5865f2'), '#ffffff', 'a mid blue gets white text');
step('text colour');

// ---- wearing a tag ----
const servers = {
  s1: { id: 's1', name: 'Alpha', members: ['ann', 'bob'], serverTag: { text: 'ALPH', bg: '#ff0000', frame: '#ffffff' } },
  s2: { id: 's2', name: 'Beta', members: ['ann'], serverTag: { text: 'BT', bg: '#ffffff', frame: null } },
  s3: { id: 's3', name: 'NoTag', members: ['ann'] },
};
const ann = { id: 'ann', serverTag: 's1' };

assert.deepStrictEqual(T.wornView(ann, servers), { serverId: 's1', name: 'Alpha', text: 'ALPH', bg: '#ff0000', frame: '#ffffff', fg: '#ffffff' });
assert.strictEqual(T.wornView({ id: 'ann' }, servers), null, 'wearing nothing');
step('what a worn tag looks like');

assert.strictEqual(T.wornView({ id: 'cy', serverTag: 's1' }, servers), null, 'not a member (any more): nothing shows');
assert.strictEqual(T.wornView({ id: 'ann', serverTag: 'gone' }, servers), null, 'the server was deleted');
assert.strictEqual(T.wornView({ id: 'ann', serverTag: 's3' }, servers), null, 'the server removed its tag');
assert.strictEqual(T.wornView({ id: 'ann', serverTag: '__proto__' }, servers), null, 'odd ids are not looked up on the prototype');
assert.strictEqual(T.wornView({ id: 'bot', bot: true, serverTag: 's1' }, servers), null, 'bots wear none');
step('a tag that stops being valid stops showing');

// ---- choosing which tag to wear ----
assert.deepStrictEqual(T.choicesFor(ann, servers).map((c) => [c.serverId, c.worn]), [['s1', true], ['s2', false]], 'only servers I am in that have a tag, A to Z, with the worn one marked');
assert.deepStrictEqual(T.choicesFor({ id: 'bob' }, servers).map((c) => c.serverId), ['s1']);
assert.deepStrictEqual(T.choicesFor({ id: 'zed' }, servers), []);
step('choices');

assert.deepStrictEqual(T.cleanWorn('s2', ann, servers), { value: 's2' });
assert.deepStrictEqual(T.cleanWorn('', ann, servers), { value: null });
assert.deepStrictEqual(T.cleanWorn(null, ann, servers), { value: null });
assert.ok(T.cleanWorn('s1', { id: 'cy' }, servers).error, 'cannot wear the tag of a server you are not in');
assert.ok(T.cleanWorn('s3', ann, servers).error, 'cannot wear a tag that does not exist');
assert.ok(T.cleanWorn('nope', ann, servers).error, 'unknown server');
assert.ok(T.cleanWorn(7, ann, servers).error, 'must be a server id');
step('equipping is checked');

console.log('server tag tests passed');
