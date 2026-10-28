// Group keys: the browser side of server/groups.js. Uses the REAL server rules (checkWraps, cleanName, rotate, viewFor), so what the
// client produces is checked against what the server accepts: node client/scripts/groupkeys-test.mjs
import assert from 'assert';
import { createRequire } from 'module';
import { createIdentity, encryptWithKey, decryptWithKey, encryptBytesWithKey, decryptBytesWithKey, rosterFingerprint } from '../src/crypto.js';
import { makeEpoch, openKeys, openName, sealName, titleOf, staleRoster, NAME_MAX } from '../src/groupkeys.js';

const require = createRequire(import.meta.url);
const G = require('../../server/groups.js');
const ok = (m) => console.log('✓', m);

const mk = async (id, displayName) => { const i = await createIdentity('pw-' + id + '-123456'); return { id, displayName, publicKey: i.publicKey, priv: i.privateKey }; };
const [a, b, c, d] = await Promise.all([mk('a', 'Ann'), mk('b', 'Ben'), mk('c', 'Cy'), mk('d', 'Dee')]);
const pub = (u) => ({ id: u.id, displayName: u.displayName, publicKey: u.publicKey });
const toPub = (id) => [a, b, c, d].filter((u) => u.id === id).map(pub)[0];

// ---- create: Ann makes epoch 1 for Ann, Ben, Cy
const e1 = await makeEpoch({ privKey: a.priv, members: [a, b, c].map(pub), name: 'Weekend plans' });
const wraps1 = G.checkWraps(e1.wraps, ['a', 'b', 'c']);
assert.ok(wraps1, 'the server accepts the wraps (one good wrap per member, nothing else)');
assert.ok(G.cleanName(e1.nameEnc), 'the server accepts the sealed name');
ok('a new epoch passes the server checks');

const g = G.createGroup({ id: 'g1', ownerId: 'a', others: ['b', 'c'], nameEnc: G.cleanName(e1.nameEnc), wraps: wraps1, byKey: a.publicKey, at: 1 });
const viewOf = (uid) => G.viewFor(g, uid, toPub);

// every member opens the same key and reads the name; nobody else can
for (const u of [a, b, c]) {
  const keys = await openKeys(u.priv, viewOf(u.id));
  assert.ok(keys.has(1), u.id + ' holds epoch 1');
  const name = await openName(keys.get(1), viewOf(u.id).nameEnc);
  assert.strictEqual(name.n, 'Weekend plans');
  const sealed = await encryptWithKey(keys.get(1), 'hello group');
  assert.strictEqual(await decryptWithKey((await openKeys(a.priv, viewOf('a'))).get(1), sealed.ciphertext, sealed.iv), 'hello group', 'everyone shares one key');
}
assert.strictEqual((await openKeys(d.priv, viewOf('a'))).size, 0, 'someone outside the group cannot open a wrap meant for another member');
assert.deepStrictEqual(Object.keys(viewOf('b').keys), ['1'], 'a member is only given their own wrap');
ok('members open the key and the name; an outsider cannot');

// ---- the key is a different one per epoch; a file round-trips under it
const keysA = await openKeys(a.priv, viewOf('a'));
const bytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;
assert.deepStrictEqual(new Uint8Array(await decryptBytesWithKey(keysA.get(1), await encryptBytesWithKey(keysA.get(1), bytes))), new Uint8Array([1, 2, 3, 4, 5]));
ok('files round-trip under the epoch key');

// ---- add Dee: epoch 2 for four people; Dee cannot read epoch 1, the others still can
const e2 = await makeEpoch({ privKey: b.priv, members: [a, b, c, d].map(pub), name: 'Weekend plans' }); // Ben adds her
G.rotate(g, { members: ['a', 'b', 'c', 'd'], nameEnc: G.cleanName(e2.nameEnc), wraps: G.checkWraps(e2.wraps, ['a', 'b', 'c', 'd']), by: 'b', byKey: b.publicKey });
const dKeys = await openKeys(d.priv, viewOf('d'));
assert.deepStrictEqual([...dKeys.keys()], [2], 'a newcomer only holds the new epoch');
const aKeys2 = await openKeys(a.priv, viewOf('a'), keysA);
assert.deepStrictEqual([...aKeys2.keys()].sort(), [1, 2], 'old members keep old and new epochs');
assert.strictEqual(aKeys2.get(1), keysA.get(1), 'an epoch already opened is reused, not opened again');
const sealed2 = await encryptWithKey(aKeys2.get(2), 'new message');
assert.strictEqual(await decryptWithKey(dKeys.get(2), sealed2.ciphertext, sealed2.iv), 'new message');
const old = await encryptWithKey(aKeys2.get(1), 'old');
await assert.rejects(decryptWithKey(dKeys.get(2), old.ciphertext, old.iv), 'epoch 1 text is unreadable with the epoch 2 key');
ok('adding someone makes a new epoch: the newcomer reads only what comes after');

// ---- someone leaves: Cy is out of epoch 3 and her old wraps are gone
const e3 = await makeEpoch({ privKey: c.priv, members: [a, b, d].map(pub), name: 'Weekend plans' });
G.rotate(g, { members: ['a', 'b', 'd'], nameEnc: G.cleanName(e3.nameEnc), wraps: G.checkWraps(e3.wraps, ['a', 'b', 'd']), by: 'c', byKey: c.publicKey });
assert.deepStrictEqual(Object.keys(viewOf('a').keys).sort(), ['1', '2', '3']);
const cView = G.viewFor(g, 'c', toPub);
assert.deepStrictEqual(cView.keys, {}, 'a person who left holds no wraps at all any more');
ok('after leaving, the server keeps no wraps for that person');

// ---- the roster fingerprint notices a reset identity
const cur = await openName((await openKeys(a.priv, viewOf('a'))).get(3), viewOf('a').nameEnc);
assert.strictEqual(await staleRoster(viewOf('a'), cur), false, 'nothing changed: no refresh needed');
const d2 = await createIdentity('another-password-9');
const changed = { ...viewOf('a'), members: viewOf('a').members.map((m) => (m.id === 'd' ? { ...m, publicKey: d2.publicKey } : m)) };
assert.strictEqual(await staleRoster(changed, cur), true, 'Dee reset her account: her key differs from the one the epoch was made for');
assert.strictEqual(await rosterFingerprint([{ id: 'x', publicKey: '1' }, { id: 'y', publicKey: '2' }]), await rosterFingerprint([{ id: 'y', publicKey: '2' }, { id: 'x', publicKey: '1' }]), 'member order does not matter');
ok('a changed identity key is noticed from inside the sealed name');

// ---- keepRoster: a rename must not hide that someone's identity key changed since the epoch was made
const k3 = (await openKeys(a.priv, viewOf('a'))).get(3);
const renamed = await openName(k3, await sealName(k3, 'Renamed', changed.members, cur.r)); // what useGroups.rename does: keep the epoch's own fingerprint
assert.strictEqual(renamed.n, 'Renamed', 'the new name is sealed');
assert.strictEqual(renamed.r, cur.r, 'a rename keeps the fingerprint the epoch was made for');
assert.strictEqual(await staleRoster(changed, renamed), true, 'so the changed key of Dee is still noticed after the rename');
const careless = await openName(k3, await sealName(k3, 'Renamed', changed.members)); // no keepRoster: the fingerprint is recomputed from the CURRENT keys
assert.strictEqual(await staleRoster(changed, careless), false, 'without keepRoster the rename would cover up the change (the thing keepRoster prevents)');
assert.strictEqual((await openName(k3, await sealName(k3, 'Same people', viewOf('a').members, cur.r))).r, cur.r, 'with nothing changed the fingerprint is the same either way');
assert.strictEqual((await openName(k3, await sealName(k3, 'Odd', changed.members, 42))).r, await rosterFingerprint(changed.members), 'a keepRoster that is not a string is ignored');
ok('keepRoster: a rename keeps the roster fingerprint, so it cannot hide a changed identity key');

// ---- names
assert.strictEqual((await openName(keysA.get(1), await sealName(keysA.get(1), 'x'.repeat(200), [a].map(pub)))).n.length, NAME_MAX, 'names are cut to the limit');
assert.ok(G.cleanName(await sealName(keysA.get(1), '😀'.repeat(NAME_MAX), [a, b, c, d].map(pub))), 'the longest possible name still fits the server limit');
assert.strictEqual(await openName(dKeys.get(2), viewOf('d').nameEnc), null, 'the epoch 3 name cannot be opened with the epoch 2 key');
assert.strictEqual((await openName((await openKeys(d.priv, viewOf('d'), dKeys)).get(3), viewOf('d').nameEnc)).n, 'Weekend plans', 'but it opens with the epoch 3 key');
assert.strictEqual(await openName(null, viewOf('d').nameEnc), null, 'no key: no name');
assert.strictEqual(titleOf({ name: 'Trip', members: [] }, 'a'), 'Trip');
assert.strictEqual(titleOf({ name: '', members: [a, b, c].map(pub) }, 'a'), 'Ben, Cy');
assert.strictEqual(titleOf({ name: '', members: [a, b, c, d, { id: 'e', displayName: 'Eve' }, { id: 'f', displayName: 'Fay' }].map((x) => x) }, 'a'), 'Ben, Cy, Dee +2');
ok('names: sealed, cut to the limit, fall back to the members');

console.log('\nAll group key checks passed.');
