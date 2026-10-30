// End-to-end encryption for direct messages.
//
// Each user has an ECDH P-256 identity keypair created in the browser at sign-up.
//  - The public key is uploaded to the server.
//  - The private key is wrapped (AES-GCM, key from PBKDF2 of the password) and the
//    wrapped blob is uploaded so the user can sign in on another device. The server
//    cannot unwrap it without the password.
//  - For a conversation, both sides derive the same AES-256-GCM key via ECDH, so the
//    server only ever stores ciphertext.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const hasCrypto = () => !!(window.crypto && window.crypto.subtle);

const toB64 = (buf) => {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

async function passKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Import as non-extractable so page scripts can never read the raw private key again.
async function importPrivate(jwk) {
  const clean = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d };
  return crypto.subtle.importKey('jwk', clean, ECDH, false, ['deriveKey', 'deriveBits']);
}

export async function createIdentity(password) {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveKey', 'deriveBits']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrap = await passKey(password, salt);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrap, enc.encode(JSON.stringify(priv)));

  return {
    publicKey: JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }),
    encPrivKey: { salt: toB64(salt), iv: toB64(iv), data: toB64(data) },
    privateKey: await importPrivate(priv),
    recovery: await makeRecovery(priv), // { key (show once), blob, auth } for the recovery key; see below
  };
}

export async function unlockIdentity(encPrivKey, password) {
  const wrap = await passKey(password, fromB64(encPrivKey.salt));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(encPrivKey.iv) }, wrap, fromB64(encPrivKey.data));
  return importPrivate(JSON.parse(dec.decode(plain)));
}

// Changing the password: unwrap the identity key with the old password and wrap it again with the new one. The key itself does not
// change, so every conversation keeps working. Throws if the old password is wrong. The result is opened once with the new password
// before it is returned, so a broken blob is never uploaded.
export async function rewrapIdentity(encPrivKey, oldPassword, newPassword) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(encPrivKey.iv) },
    await passKey(oldPassword, fromB64(encPrivKey.salt)),
    fromB64(encPrivKey.data)
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await passKey(newPassword, salt), plain);
  const blob = { salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
  await unlockIdentity(blob, newPassword);
  return blob;
}

// ---- account recovery key ----
// The password wraps the identity key, so a forgotten password used to lose the account. A recovery key is a second, independent
// wrapping: 160 random bits shown to the person ONCE, never stored by us. HKDF turns it into two unrelated values:
//   wrap: an AES-GCM key that wraps the identity key (the blob the server keeps, it cannot open it), and
//   auth: a proof that the person holds the key; the server only stores a hash of it and compares on reset.
// Resetting the password unwraps the identity key with the recovery key and wraps it with the new password, so the same key survives
// and every conversation keeps working. The key is high-entropy, so no slow hash is needed (unlike a password).
const RK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no I or O or 0 or 1: easy to read out loud and to type

export function newRecoveryKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0, acc = 0, out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += RK_ALPHABET[(acc >> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  return out.match(/.{4}/g).join('-'); // 32 symbols in 8 groups
}

// Accepts what a person might type or paste (any case, spaces, dashes). Returns the 20 raw bytes or null if it cannot be a key.
function recoveryBytes(input) {
  const s = String(input || '').toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== 32) return null;
  const out = new Uint8Array(20);
  let bits = 0, acc = 0, n = 0;
  for (const ch of s) {
    const v = RK_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { out[n++] = (acc >> (bits - 8)) & 255; bits -= 8; }
    acc &= (1 << bits) - 1;
  }
  return out;
}
export const isRecoveryKey = (s) => !!recoveryBytes(s);

async function recoveryParts(keyText, salt) {
  const raw = recoveryBytes(keyText);
  if (!raw) throw new Error('That is not a recovery key. It has 32 letters and numbers.');
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const p = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) });
  return {
    wrap: await crypto.subtle.deriveKey(p('aduna recovery wrap v1'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    auth: toB64(await crypto.subtle.deriveBits(p('aduna recovery auth v1'), base, 256)),
  };
}

const cleanJwk = (jwk) => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }); // fixed shape, so every blob has the same size

// A new recovery key for an identity (the private JWK). { key, blob, auth }: show `key` once; send blob + auth to the server.
export async function makeRecovery(jwk) {
  const key = newRecoveryKey();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const { wrap, auth } = await recoveryParts(key, salt);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrap, enc.encode(JSON.stringify(cleanJwk(jwk))));
  return { key, blob: { salt: toB64(salt), iv: toB64(iv), data: toB64(data) }, auth };
}

// For an account that has an identity but no recovery key yet (or wants a new one): open the identity with the password first.
export async function makeRecoveryFromPassword(encPrivKey, password) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(encPrivKey.iv) }, await passKey(password, fromB64(encPrivKey.salt)), fromB64(encPrivKey.data));
  return makeRecovery(JSON.parse(dec.decode(plain)));
}

// Forgot the password: open the recovery blob with the key, wrap the identity with the NEW password. Returns what the server needs
// (auth proof, new password blob) plus the usable private key. Throws if the key is wrong (nothing has been sent anywhere yet).
export async function recoverIdentity(recoveryBlob, keyText, newPassword) {
  const { wrap, auth } = await recoveryParts(keyText, fromB64(recoveryBlob.salt));
  let jwk;
  try {
    jwk = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(recoveryBlob.iv) }, wrap, fromB64(recoveryBlob.data))));
  } catch { throw new Error('That recovery key is not right.'); }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await passKey(newPassword, salt), enc.encode(JSON.stringify(jwk)));
  const encPrivKey = { salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
  return { auth, encPrivKey, privateKey: await unlockIdentity(encPrivKey, newPassword) }; // opened once before upload, like rewrapIdentity
}

// ---- handing the identity key to a device that does not know the password: another signed-in device, or a passkey ----
// Both start from the key as a plain JWK, which only someone who can open the password's wrap has. Everything below happens in the
// browser; the server only ever stores or passes on the locked result.
export async function identityJwk(encPrivKey, password) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(encPrivKey.iv) }, await passKey(password, fromB64(encPrivKey.salt)), fromB64(encPrivKey.data));
  return cleanJwk(JSON.parse(dec.decode(plain)));
}
// An AES key from secret bytes. The label means the same bytes can never serve two purposes.
async function hkdfAes(raw, label) {
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(label) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function lockJwk(key, jwk) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(cleanJwk(jwk))));
  return { iv: toB64(iv), data: toB64(data) };
}
// `publicKey` (the account's, as the server gives it) is checked against the opened key, so a blob for some other account is refused.
async function unlockJwk(key, blob, publicKey) {
  const jwk = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.data))));
  if (publicKey) { const p = JSON.parse(publicKey); if (p.x !== jwk.x || p.y !== jwk.y) throw new Error('That key does not belong to this account.'); }
  return importPrivate(jwk);
}

// Sign in on a new device by approving it from a signed-in one (server/devicelogin.js). The NEW device makes a throwaway key pair and
// asks; the SIGNED-IN device opens the identity with the password and locks it to the throwaway public key; only the new device can open it.
const importPoint = (b64) => crypto.subtle.importKey('raw', fromB64(b64), ECDH, false, []);
async function sharedKey(priv, pubB64) {
  return hkdfAes(await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPoint(pubB64) }, priv, 256), 'aduna device login v1');
}
export async function newDeviceRequest() {
  const pair = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
  return { publicKey: toB64(await crypto.subtle.exportKey('raw', pair.publicKey)), privateKey: pair.privateKey };
}
// Throws if the password is wrong. Returns { publicKey, iv, data }, the shape the server keeps.
export async function sealIdentityForDevice(encPrivKey, password, devicePublicKey) {
  const jwk = await identityJwk(encPrivKey, password);
  const eph = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
  const sealed = await lockJwk(await sharedKey(eph.privateKey, devicePublicKey), jwk);
  return { publicKey: toB64(await crypto.subtle.exportKey('raw', eph.publicKey)), ...sealed };
}
export async function openSealedIdentity(sealed, devicePrivateKey, accountPublicKey) {
  return unlockJwk(await sharedKey(devicePrivateKey, sealed.publicKey), sealed, accountPublicKey);
}

// Passkeys: the authenticator's "prf" output (32 secret bytes only that passkey can make) locks a copy of the identity key.
export async function lockIdentityWithPasskey(jwk, prf) { return lockJwk(await hkdfAes(prf, 'aduna passkey wrap v1'), jwk); }
export async function unlockIdentityWithPasskey(wrapped, prf, accountPublicKey) { return unlockJwk(await hkdfAes(prf, 'aduna passkey wrap v1'), wrapped, accountPublicKey); }

// ---- persist the (non-extractable) private key in IndexedDB so reloads keep working ----
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('aduna-keys', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function saveKey(userId, key) {
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put(key, userId);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
export async function loadKey(userId) {
  const db = await idb();
  return new Promise((res, rej) => {
    const req = db.transaction('keys').objectStore('keys').get(userId);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
  });
}
export async function clearKeys() {
  const db = await idb();
  await new Promise((res) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').clear();
    tx.oncomplete = res;
  });
  sharedCache = new WeakMap();
}

// ---- per-conversation keys ----
// Cached per private key and per other public key (one page normally holds one identity, but a cache keyed only by the other
// person's key would hand back the wrong secret the moment two identities are used in one place, as the tests do).
let sharedCache = new WeakMap(); // private key -> Map(their public key -> AES key)

async function sharedKey(privateKey, theirPublic) {
  let mine = sharedCache.get(privateKey);
  if (!mine) { mine = new Map(); sharedCache.set(privateKey, mine); }
  if (mine.has(theirPublic)) return mine.get(theirPublic);
  const pub = await crypto.subtle.importKey('jwk', JSON.parse(theirPublic), ECDH, false, []);
  const key = await crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  mine.set(theirPublic, key);
  return key;
}

export async function encryptFor(privateKey, theirPublic, text) {
  const key = await sharedKey(privateKey, theirPublic);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return { ciphertext: toB64(ct), iv: toB64(iv) };
}

export async function decryptFrom(privateKey, theirPublic, ciphertext, iv) {
  const key = await sharedKey(privateKey, theirPublic);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(ciphertext));
  return dec.decode(pt);
}

// Files: the same conversation key, bytes in / bytes out. Layout is iv (12) | ciphertext.
export async function encryptBytesFor(privateKey, theirPublic, buffer) {
  const key = await sharedKey(privateKey, theirPublic);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}

export async function decryptBytesFrom(privateKey, theirPublic, buffer) {
  const key = await sharedKey(privateKey, theirPublic);
  const b = new Uint8Array(buffer);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, key, b.slice(12));
}

// ---- group chats ----
// A group has one AES-256 key per epoch (see server/groups.js). It is made here, in the browser of whoever changes the member list, and
// wrapped once per member with the pairwise ECDH key that member already shares with the maker (the same one DMs use). The server only
// stores wraps it cannot open. A wrap is { ciphertext, iv, pk }: pk is a short fingerprint of the public key it was wrapped for.

// 12 URL-safe characters of SHA-256: short, stable, and enough to notice that a key changed (not a security boundary by itself).
export async function fingerprint(text) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(text))));
  return toB64(h.slice(0, 9)).replace(/\+/g, '-').replace(/\//g, '_');
}

// Fingerprint of "who is in the group and with which identity keys". It is sealed inside the encrypted group name, so every member who can
// read the epoch can tell when someone's identity key changed since the epoch was made (and make a fresh epoch for them).
export function rosterFingerprint(members) {
  const list = members.map((m) => m.id + ':' + (m.publicKey || '')).sort().join('|');
  return fingerprint(list);
}

export async function newGroupKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function wrapGroupKey(privateKey, memberPublic, groupKey) {
  const raw = await crypto.subtle.exportKey('raw', groupKey);
  const shared = await sharedKey(privateKey, memberPublic);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, shared, raw);
  return { ciphertext: toB64(ct), iv: toB64(iv), pk: await fingerprint(memberPublic) };
}

// `byPublic` is the public key of the member who made the epoch (the server keeps it as `byKey`). Throws if the wrap is not for us.
export async function unwrapGroupKey(privateKey, byPublic, wrap) {
  const shared = await sharedKey(privateKey, byPublic);
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(wrap.iv) }, shared, fromB64(wrap.ciphertext));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); // not extractable once opened
}

export async function encryptWithKey(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return { ciphertext: toB64(ct), iv: toB64(iv) };
}

export async function decryptWithKey(key, ciphertext, iv) {
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(ciphertext)));
}

// Files in a group: iv (12) | ciphertext, like DM files, but under the epoch key.
export async function encryptBytesWithKey(key, buffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}

export async function decryptBytesWithKey(key, buffer) {
  const b = new Uint8Array(buffer);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, key, b.slice(12));
}

// Both people see the same number; comparing it out-of-band detects a swapped key.
export async function safetyNumber(pubA, pubB) {
  const [a, b] = [pubA, pubB].sort();
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(a + b)));
  const groups = [];
  for (let i = 0; i < 30; i += 5) {
    let n = 0;
    for (let j = 0; j < 5; j++) n = (n * 256 + bytes[i + j]) % 100000;
    groups.push(String(n).padStart(5, '0'));
  }
  return groups.join(' ');
}
