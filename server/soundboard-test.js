// Soundboard rules without a server: node server/soundboard-test.js
const assert = require('assert');
const S = require('./soundboard');
const step = (m) => console.log('✓', m);

const wav = (secs, rate = 8000) => { // a silent 8-bit mono WAV: only the header is real
  const n = Math.round(secs * rate), h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8, 'latin1'); h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.alloc(n, 128)]);
};

// ---- settings ----
assert.deepStrictEqual(S.settingsOf({}), { enabled: true, who: 'everyone', roles: [] });
assert.deepStrictEqual(S.settingsOf({ soundboard: { enabled: false, who: 'roles', roles: ['r1', 5] } }), { enabled: false, who: 'roles', roles: ['r1'] });
assert.deepStrictEqual(S.settingsOf({ soundboard: { who: 'nobody' } }), { enabled: true, who: 'everyone', roles: [] }, 'an unknown "who" falls back to everyone');
step('a server that never touched the settings has the soundboard on, for everyone');

let r = S.cleanSettings({ enabled: false }, undefined, ['r1']);
assert.deepStrictEqual(r.value, { enabled: false, who: 'everyone', roles: [] });
r = S.cleanSettings({ who: 'roles', roles: ['r1', 'r1', 'r2'] }, { enabled: false, who: 'everyone', roles: [] }, ['r1', 'r2']);
assert.deepStrictEqual(r.value, { enabled: false, who: 'roles', roles: ['r1', 'r2'] }, 'what is left out stays; repeats are dropped');
assert.ok(S.cleanSettings({ enabled: 'yes' }, {}, []).error);
assert.ok(S.cleanSettings({ who: 'admins' }, {}, []).error);
assert.ok(S.cleanSettings({ roles: 'r1' }, {}, ['r1']).error);
assert.ok(S.cleanSettings({ roles: ['gone'] }, {}, ['r1']).error, 'a role the server does not have');
assert.ok(S.cleanSettings({ roles: [{}] }, {}, ['r1']).error);
assert.ok(S.cleanSettings({ roles: Array.from({ length: 26 }, (_, i) => 'r' + i) }, {}, Array.from({ length: 26 }, (_, i) => 'r' + i)).error, 'at most 25 roles');
assert.deepStrictEqual(S.cleanSettings(null, { enabled: false }, []).value, { enabled: false, who: 'everyone', roles: [] });
step('settings: each field is checked, roles must exist, the rest is kept');

// ---- who may play ----
const everyone = { soundboard: { enabled: true, who: 'everyone' } };
const rolesOnly = { soundboard: { enabled: true, who: 'roles', roles: ['dj'] } };
const off = { soundboard: { enabled: false, who: 'everyone' } };
const member = { owner: false, admin: false, roleIds: [] };
assert.strictEqual(S.whyNot({}, member), null, 'default: everyone');
assert.strictEqual(S.whyNot(everyone, member), null);
assert.strictEqual(S.whyNot(rolesOnly, member), S.WHO_MESSAGE);
assert.strictEqual(S.whyNot(rolesOnly, { ...member, roleIds: ['other'] }), S.WHO_MESSAGE);
assert.strictEqual(S.whyNot(rolesOnly, { ...member, roleIds: ['other', 'dj'] }), null);
assert.strictEqual(S.whyNot(rolesOnly, { ...member, owner: true }), null, 'the owner always can');
assert.strictEqual(S.whyNot(rolesOnly, { ...member, admin: true }), null, 'so can an administrator');
for (const who of [member, { ...member, owner: true }, { ...member, admin: true }, { ...member, roleIds: ['dj'] }]) assert.strictEqual(S.whyNot(off, who), S.OFF_MESSAGE, 'off is off for everybody, the owner included');
assert.strictEqual(S.whyNot({ soundboard: { enabled: false, who: 'roles', roles: ['dj'] } }, { ...member, roleIds: ['dj'] }), S.OFF_MESSAGE);
assert.strictEqual(S.whyNot(rolesOnly, { roleIds: undefined }), S.WHO_MESSAGE, 'a missing role list is no roles');
step('who may play: everyone, only some roles (owner and administrators always), or nobody when it is off');

// ---- the view ----
const sv = { soundboard: { enabled: true, who: 'roles', roles: ['dj'] }, sounds: [{ id: 'a', name: 'Airhorn', emoji: '📣', audio: 'SECRETID', mime: 'audio/wav', by: 'u1', at: 1 }, { id: 'b', name: 'Quack', audio: 'X2' }] };
assert.deepStrictEqual(S.view(sv), { soundboard: { enabled: true, who: 'roles', roles: ['dj'] }, sounds: [{ id: 'a', name: 'Airhorn', emoji: '📣' }, { id: 'b', name: 'Quack', emoji: '' }] });
assert.deepStrictEqual(S.view({}), { soundboard: { enabled: true, who: 'everyone', roles: [] }, sounds: [] });
assert.deepStrictEqual(S.audioIds(sv), ['SECRETID', 'X2']);
assert.strictEqual(S.find(sv, 'b').name, 'Quack'); assert.strictEqual(S.find(sv, 'nope'), null); assert.strictEqual(S.find(sv, { id: 'a' }), null); assert.strictEqual(S.find(sv, '__proto__'), null);
step('the view lists names and icons only; storage ids stay on the server');

// ---- names and icons ----
assert.deepStrictEqual(S.cleanName('  Air   horn '), { name: 'Air horn' });
assert.strictEqual(S.cleanName('<b>Boom</b>').name, 'b Boom /b');
assert.ok(S.cleanName('').error); assert.ok(S.cleanName('   ').error); assert.ok(S.cleanName(undefined).error);
assert.ok(S.cleanName('x'.repeat(25)).error); assert.ok(!S.cleanName('x'.repeat(24)).error);
assert.strictEqual(S.cleanName('\u202eevil\u0000').name, 'evil', 'control and direction characters go');
step('sound names: 1 to 24 characters, tidied');

assert.deepStrictEqual(S.cleanEmoji(undefined), { emoji: '' });
assert.deepStrictEqual(S.cleanEmoji(''), { emoji: '' });
assert.deepStrictEqual(S.cleanEmoji('📣'), { emoji: '📣' });
assert.strictEqual(S.cleanEmoji('👨‍👩‍👧').emoji, '👨‍👩‍👧', 'a joined family emoji stays whole');
assert.ok(S.cleanEmoji('abc').error); assert.ok(S.cleanEmoji('1').error); assert.ok(S.cleanEmoji({}).error); assert.ok(S.cleanEmoji(5).error);
assert.ok(S.cleanEmoji('😀'.repeat(9)).error); assert.ok(!S.cleanEmoji('😀'.repeat(8)).error);
step('icons: optional, emoji only, up to 8 characters');

// ---- room ----
assert.deepStrictEqual(S.roomFor({}, 'Boom'), { ok: true });
assert.strictEqual(S.roomFor(sv, 'airhorn').status, 409, 'a name is taken whatever the capitals');
const full = { sounds: Array.from({ length: 24 }, (_, i) => ({ id: 'i' + i, name: 'S' + i })) };
assert.strictEqual(S.roomFor(full, 'New').status, 400); assert.ok(S.roomFor({ sounds: full.sounds.slice(1) }, 'New').ok);
step('a server holds up to 24 sounds with different names');

// ---- the bytes ----
let c = S.check(wav(2)); assert.deepStrictEqual([c.mime, c.ext, c.data.length], ['audio/wav', 'wav', 44 + 16000]);
assert.ok(!S.check(wav(5)).error, 'exactly 5 seconds is fine');
assert.ok(S.check(wav(6)).error, 'a WAV over 5 seconds is too long');
assert.ok(S.check(Buffer.alloc(S.LIMITS.bytes + 1, 1)).error, 'over 256 KB');
assert.ok(S.check(Buffer.alloc(200, 7)).error, 'bytes that are not audio');
assert.ok(S.check(Buffer.alloc(0)).error); assert.ok(S.check('RIFF').error); assert.ok(S.check(null).error);
c = S.check(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100)])); assert.deepStrictEqual([c.mime, c.ext], ['audio/mpeg', 'mp3']);
c = S.check(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(100)])); assert.strictEqual(c.mime, 'audio/ogg');
step('clips: 256 KB, a real audio signature, and a WAV is measured');

// ---- the pause ----
const plays = new Map();
assert.strictEqual(S.allow(plays, 'u1', 1000), true);
assert.strictEqual(S.allow(plays, 'u1', 2000), false, 'too soon');
assert.strictEqual(S.allow(plays, 'u2', 2000), true, 'someone else is not held up');
assert.strictEqual(S.allow(plays, 'u1', 1000 + S.LIMITS.cooldownMs - 1), false);
assert.strictEqual(S.allow(plays, 'u1', 1000 + S.LIMITS.cooldownMs), true);
for (let i = 0; i < 600; i++) plays.set('x' + i, 0);
assert.strictEqual(S.allow(plays, 'late', 1e9), true); assert.ok(plays.size < 10, 'old entries are swept when the map grows');
step('a person can play one sound every 3 seconds; the map stays small');

console.log('soundboard tests passed');
