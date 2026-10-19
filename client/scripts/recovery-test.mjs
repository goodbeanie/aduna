// Recovery key: node client/scripts/recovery-test.mjs
import assert from 'assert';
import { createIdentity, unlockIdentity, makeRecovery, makeRecoveryFromPassword, recoverIdentity, isRecoveryKey, newRecoveryKey, encryptFor, decryptFrom } from '../src/crypto.js';

const ok = (m) => console.log('✓', m);
const alice = await createIdentity('old-password-1');
const bob = await createIdentity('bobs-password-1');

assert.ok(/^([A-Z2-9]{4}-){7}[A-Z2-9]{4}$/.test(alice.recovery.key), 'key looks like XXXX-XXXX-... (8 groups)');
assert.ok(!/[IO01]/.test(alice.recovery.key));
assert.deepStrictEqual(Object.keys(alice.recovery.blob).sort(), ['data', 'iv', 'salt']);
assert.strictEqual(alice.recovery.blob.data.length, 256, 'fixed blob size (the server relies on it for decoy answers)');
assert.strictEqual(atob(alice.recovery.auth).length, 32);
assert.strictEqual(new Set(Array.from({ length: 200 }, newRecoveryKey)).size, 200, 'keys are random');
ok('a new identity comes with a recovery key, blob and proof of the right shape');

assert.ok(isRecoveryKey(alice.recovery.key));
assert.ok(isRecoveryKey(alice.recovery.key.toLowerCase().replace(/-/g, ' ')), 'typed in lower case with spaces');
assert.ok(!isRecoveryKey('ABCD-EFGH') && !isRecoveryKey(alice.recovery.key.slice(0, -1) + 'I') && !isRecoveryKey(''));
ok('typed keys are normalised; wrong length or letters are refused');

// reset: the same identity key, now wrapped by the new password, and the old DMs still decrypt
const before = await encryptFor(alice.privateKey, bob.publicKey, 'sent before the reset');
const r = await recoverIdentity(alice.recovery.blob, alice.recovery.key.toLowerCase(), 'brand-new-pass-3');
assert.strictEqual(r.auth, alice.recovery.auth, 'the proof is the same one the server stored a hash of');
const reopened = await unlockIdentity(r.encPrivKey, 'brand-new-pass-3');
await assert.rejects(unlockIdentity(r.encPrivKey, 'old-password-1'), 'old password does not open the new wrap');
assert.strictEqual(await decryptFrom(reopened, bob.publicKey, before.ciphertext, before.iv), 'sent before the reset');
assert.strictEqual(await decryptFrom(r.privateKey, bob.publicKey, before.ciphertext, before.iv), 'sent before the reset');
ok('reset keeps the same identity key: old messages stay readable, new password opens it');

await assert.rejects(recoverIdentity(alice.recovery.blob, newRecoveryKey(), 'x'.repeat(10)), /not right/, 'another key');
await assert.rejects(recoverIdentity(bob.recovery.blob, alice.recovery.key, 'x'.repeat(10)), /not right/, "someone else's blob");
await assert.rejects(recoverIdentity(alice.recovery.blob, 'short', 'x'.repeat(10)), /not a recovery key/);
ok('wrong keys fail on the device, before anything is sent');

// legacy accounts: make a key from the password
const legacy = await makeRecoveryFromPassword(alice.encPrivKey, 'old-password-1');
await assert.rejects(makeRecoveryFromPassword(alice.encPrivKey, 'wrong-password'));
const l2 = await recoverIdentity(legacy.blob, legacy.key, 'another-pass-4');
assert.strictEqual(await decryptFrom(l2.privateKey, bob.publicKey, before.ciphertext, before.iv), 'sent before the reset');
assert.notStrictEqual(legacy.auth, alice.recovery.auth, 'a new key gives a new proof, so the old key stops working once replaced');
ok('an existing account can create a recovery key from its password');
console.log('\nAll recovery-key checks passed.');
