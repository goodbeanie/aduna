// Changing the password must keep the same encryption key: node client/scripts/rewrap-test.mjs
import assert from 'assert';
import { createIdentity, unlockIdentity, rewrapIdentity, encryptFor, decryptFrom } from '../src/crypto.js';

const ok = (m) => console.log('✓', m);
const alice = await createIdentity('old-password-1');
const bob = await createIdentity('bobs-password-1');

const blob = await rewrapIdentity(alice.encPrivKey, 'old-password-1', 'new-password-2');
assert.deepStrictEqual(Object.keys(blob).sort(), ['data', 'iv', 'salt'], 'same blob shape the server stores');
assert.notStrictEqual(blob.salt, alice.encPrivKey.salt, 'fresh salt');
assert.notStrictEqual(blob.data, alice.encPrivKey.data);
ok('re-wrapped blob has the stored shape and a fresh salt');

const key = await unlockIdentity(blob, 'new-password-2');
await assert.rejects(unlockIdentity(blob, 'old-password-1'), 'the old password no longer opens it');
ok('the new password opens the new blob; the old one does not');

// same key: a DM sent before the change decrypts after it, and the other way round
const before = await encryptFor(alice.privateKey, bob.publicKey, 'sent before the change');
assert.strictEqual(await decryptFrom(key, bob.publicKey, before.ciphertext, before.iv), 'sent before the change');
const after = await encryptFor(key, bob.publicKey, 'sent after the change');
assert.strictEqual(await decryptFrom(alice.privateKey, bob.publicKey, after.ciphertext, after.iv), 'sent after the change');
ok('messages stay readable across the change (it is the same key)');

await assert.rejects(rewrapIdentity(alice.encPrivKey, 'not-the-password', 'new-password-2'), 'a wrong current password throws');
ok('a wrong current password is refused before anything is uploaded');
console.log('\nAll re-wrap checks passed.');
