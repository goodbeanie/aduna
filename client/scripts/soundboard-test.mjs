// Soundboard rules in the browser (they mirror server/soundboard.js): node client/scripts/soundboard-test.mjs
import assert from 'assert';
import { settingsOf, whyNotPlay, soundUrl, SOUND, OFF_MESSAGE, WHO_MESSAGE } from '../src/soundboard.js';
const ok = (m) => console.log('✓', m);

// the settings a server that never touched them has: on, for everyone
assert.deepStrictEqual(settingsOf({}), { enabled: true, who: 'everyone', roles: [] });
assert.deepStrictEqual(settingsOf(undefined), { enabled: true, who: 'everyone', roles: [] });
assert.deepStrictEqual(settingsOf({ soundboard: { enabled: false, who: 'roles', roles: ['r1', 5] } }), { enabled: false, who: 'roles', roles: ['r1'] });
assert.strictEqual(settingsOf({ soundboard: { who: 'nobody' } }).who, 'everyone', 'an unknown "who" falls back to everyone');
ok('settings: defaults, bad values and non-string roles');

// who may play: a server with an owner, a DJ role, an admin role and three members
const sv = (soundboard) => ({
  ownerId: 'owner',
  everyone: [],
  roles: [{ id: 'dj', name: 'DJ', perms: [] }, { id: 'adm', name: 'Admin', perms: ['administrator'] }],
  memberRoles: { dj1: ['dj'], admin1: ['adm'] },
  soundboard,
});
const everyone = sv({ enabled: true, who: 'everyone' });
const rolesOnly = sv({ enabled: true, who: 'roles', roles: ['dj'] });
const off = sv({ enabled: false, who: 'everyone' });

assert.strictEqual(whyNotPlay(everyone, 'plain'), null);
assert.strictEqual(whyNotPlay(sv(undefined), 'plain'), null, 'never touched = everyone may play');
ok('everyone: any member may play');

assert.strictEqual(whyNotPlay(rolesOnly, 'plain'), WHO_MESSAGE);
assert.strictEqual(whyNotPlay(rolesOnly, 'dj1'), null);
assert.strictEqual(whyNotPlay(rolesOnly, 'owner'), null, 'the owner can always play');
assert.strictEqual(whyNotPlay(rolesOnly, 'admin1'), null, 'an administrator can always play');
assert.strictEqual(whyNotPlay(sv({ enabled: true, who: 'roles', roles: [] }), 'dj1'), WHO_MESSAGE, 'no roles listed: only owner and administrators');
ok('only some roles: the listed roles, the owner and administrators');

for (const uid of ['plain', 'dj1', 'owner', 'admin1']) assert.strictEqual(whyNotPlay(off, uid), OFF_MESSAGE, 'off is off for ' + uid);
ok('off completely: nobody can play, the owner included');

assert.strictEqual(soundUrl('s1', 'x9'), '/api/servers/s1/sounds/x9/audio');
assert.deepStrictEqual([SOUND.sounds, SOUND.secs, SOUND.bytes, SOUND.cooldownMs], [24, 5, 256 * 1024, 3000], 'limits match LIMITS in server/soundboard.js');
ok('sound url and limits');

console.log('soundboard (client) tests passed');
