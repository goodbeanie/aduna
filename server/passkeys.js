// Passkeys (WebAuthn) without any library, in the same spirit as security.js and devicelogin.js: no Express / Postgres imports,
// so server/passkeys-test.js can test it alone with a fake authenticator.
//
// What a passkey does here: it replaces typing the password. The server keeps the public half (and a sign counter); the private half
// stays in the person's phone, laptop or security key, behind Face ID / fingerprint / PIN. Signing in = the device signs a one-time
// challenge, the server checks the signature against the stored public key.
//
// Your messages are end-to-end encrypted and the key that opens them is locked by your password, so a passkey also has to unlock that
// key. It does so with the WebAuthn "prf" extension: the authenticator turns a fixed label into 32 secret bytes that only it can make.
// The browser uses them to lock a copy of the identity key (`wrapped`), and we store that copy; we cannot open it. See client/src/passkeys.js.
const crypto = require('crypto');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const B64U = /^[A-Za-z0-9_-]+$/;
const fromB64u = (s, max = 8192) => {
  if (typeof s !== 'string' || !s || s.length > max || !B64U.test(s)) throw new Error('bad encoding');
  return Buffer.from(s, 'base64url');
};

// ---------- CBOR (just enough for an attestation object and a COSE key) ----------
// Returns [value, nextOffset]. Maps come back as Map (so a key like "__proto__" is harmless); byte strings as Buffer.
function cbor(buf, i = 0, depth = 0) {
  if (depth > 8 || i >= buf.length) throw new Error('bad cbor');
  const head = buf[i++], major = head >> 5, ai = head & 31;
  let n;
  if (ai < 24) n = ai;
  else if (ai === 24) { if (i + 1 > buf.length) throw new Error('bad cbor'); n = buf[i]; i += 1; }
  else if (ai === 25) { if (i + 2 > buf.length) throw new Error('bad cbor'); n = buf.readUInt16BE(i); i += 2; }
  else if (ai === 26) { if (i + 4 > buf.length) throw new Error('bad cbor'); n = buf.readUInt32BE(i); i += 4; }
  else if (ai === 27) { if (i + 8 > buf.length) throw new Error('bad cbor'); const v = buf.readBigUInt64BE(i); if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('bad cbor'); n = Number(v); i += 8; }
  else throw new Error('bad cbor'); // indefinite lengths and reserved values are not used by WebAuthn
  switch (major) {
    case 0: return [n, i];
    case 1: return [-1 - n, i];
    case 2: case 3: {
      if (i + n > buf.length) throw new Error('bad cbor');
      const s = buf.subarray(i, i + n);
      return [major === 2 ? Buffer.from(s) : s.toString('utf8'), i + n];
    }
    case 4: {
      if (n > buf.length) throw new Error('bad cbor');
      const out = [];
      for (let k = 0; k < n; k++) { const [v, j] = cbor(buf, i, depth + 1); out.push(v); i = j; }
      return [out, i];
    }
    case 5: {
      if (n > buf.length) throw new Error('bad cbor');
      const out = new Map();
      for (let k = 0; k < n; k++) {
        const [key, j] = cbor(buf, i, depth + 1);
        const [v, j2] = cbor(buf, j, depth + 1);
        out.set(key, v); i = j2;
      }
      return [out, i];
    }
    case 7: if (ai === 20) return [false, i]; if (ai === 21) return [true, i]; if (ai === 22) return [null, i]; throw new Error('bad cbor');
    default: throw new Error('bad cbor');
  }
}

// ---------- authenticator data ----------
const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;
function parseAuthData(ad) {
  if (!Buffer.isBuffer(ad) || ad.length < 37) throw new Error('bad authData');
  const out = { rpIdHash: ad.subarray(0, 32), flags: ad[32], signCount: ad.readUInt32BE(33) };
  if (out.flags & FLAG_AT) {
    let p = 37 + 16; // skip the AAGUID
    if (ad.length < p + 2) throw new Error('bad authData');
    const len = ad.readUInt16BE(p); p += 2;
    if (len < 16 || len > 1023 || ad.length < p + len) throw new Error('bad authData');
    out.credentialId = Buffer.from(ad.subarray(p, p + len)); p += len;
    const [cose] = cbor(ad, p);
    if (!(cose instanceof Map)) throw new Error('bad authData');
    out.cose = cose;
  }
  return out;
}

// COSE key -> { alg, spki (DER, base64) }. ES256 (P-256) covers phones, Macs, Chrome and security keys; RS256 covers Windows Hello.
function coseToSpki(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  let key;
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) {
    const x = cose.get(-2), y = cose.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new Error('bad key');
    key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) }, format: 'jwk' });
  } else if (kty === 3 && alg === -257) {
    const n = cose.get(-1), e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length < 256 || n.length > 1024 || e.length > 8) throw new Error('bad key');
    key = crypto.createPublicKey({ key: { kty: 'RSA', n: b64u(n), e: b64u(e) }, format: 'jwk' });
  } else throw new Error('unsupported key type');
  return { alg, spki: key.export({ type: 'spki', format: 'der' }).toString('base64') };
}

// ---------- the browser's clientDataJSON ----------
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function checkClientData(raw, type, challenge, origin) {
  let cd;
  try { cd = JSON.parse(raw.toString('utf8')); } catch { throw new Error('bad clientData'); }
  if (!cd || cd.type !== type) throw new Error('wrong ceremony');
  if (typeof cd.challenge !== 'string' || !same(cd.challenge, challenge)) throw new Error('wrong challenge');
  if (typeof cd.origin !== 'string' || !same(cd.origin, origin)) throw new Error('wrong origin');
  if (cd.crossOrigin === true) throw new Error('cross-origin');
}
function checkAuthData(ad, rpId) {
  if (!same(ad.rpIdHash.toString('hex'), sha256(Buffer.from(rpId)).toString('hex'))) throw new Error('wrong site');
  if (!(ad.flags & FLAG_UP) || !(ad.flags & FLAG_UV)) throw new Error('not verified'); // present AND verified (biometric / PIN)
}

// A new passkey. Everything is base64url as the browser sends it. Returns what to store: { id, spki, alg, signCount }.
// We ask for no attestation (the maker of the device is none of our business), so the statement is not checked.
function verifyRegistration({ clientDataJSON, attestationObject, challenge, origin, rpId }) {
  checkClientData(fromB64u(clientDataJSON), 'webauthn.create', challenge, origin);
  const [att] = cbor(fromB64u(attestationObject, 16384));
  const authData = att instanceof Map ? att.get('authData') : null;
  const ad = parseAuthData(authData);
  if (!(ad.flags & FLAG_AT) || !ad.credentialId || !ad.cose) throw new Error('no credential');
  checkAuthData(ad, rpId);
  const k = coseToSpki(ad.cose);
  return { id: b64u(ad.credentialId), spki: k.spki, alg: k.alg, signCount: ad.signCount };
}

// A sign-in. `credential` is what we stored: { spki, alg, signCount }. Returns { signCount } to store, or throws.
function verifyAssertion({ clientDataJSON, authenticatorData, signature, challenge, origin, rpId, credential }) {
  const cdRaw = fromB64u(clientDataJSON);
  checkClientData(cdRaw, 'webauthn.get', challenge, origin);
  const adRaw = fromB64u(authenticatorData);
  const ad = parseAuthData(adRaw);
  checkAuthData(ad, rpId);
  const key = crypto.createPublicKey({ key: Buffer.from(credential.spki, 'base64'), format: 'der', type: 'spki' });
  const signed = Buffer.concat([adRaw, sha256(cdRaw)]);
  const ok = crypto.verify('sha256', signed, key, fromB64u(signature, 2048)); // ES256 signatures are DER, which is what Node expects
  if (!ok) throw new Error('bad signature');
  // Phones and password managers that sync passkeys always report 0. A device that counts must never go backwards (a copied key would).
  const was = Number(credential.signCount) || 0;
  if ((ad.signCount > 0 || was > 0) && ad.signCount <= was) throw new Error('counter went back');
  return { signCount: ad.signCount };
}

// The locked copy of the identity key a passkey carries: { iv (12 bytes), data (an AES-GCM blob about the size of a key) }, nothing else.
function cleanWrap(w) {
  const ok = (s, min, max) => typeof s === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length >= min && s.length <= max;
  if (!w || typeof w !== 'object' || !ok(w.iv, 16, 16) || !ok(w.data, 24, 900)) return null;
  return { iv: w.iv, data: w.data };
}

// One-time challenges, held in memory for a few minutes. `take` is the only way to spend one.
class Challenges {
  constructor({ ttlMs = 5 * 60_000, max = 5000, now = () => Date.now() } = {}) { Object.assign(this, { ttlMs, max, now }); this.m = new Map(); }
  _sweep() { const t = this.now(); for (const [k, v] of this.m) if (t > v.expiresAt) this.m.delete(k); }
  get size() { return this.m.size; }
  // { id, challenge }, or null when too many are waiting
  issue({ kind, uid = '' }) {
    this._sweep();
    if (this.m.size >= this.max) return null;
    const id = crypto.randomBytes(18).toString('base64url'), challenge = crypto.randomBytes(32).toString('base64url');
    this.m.set(id, { kind, uid, challenge, expiresAt: this.now() + this.ttlMs });
    return { id, challenge };
  }
  _get(id, kind, uid) {
    const v = typeof id === 'string' ? this.m.get(id) : null;
    if (!v) return null;
    if (this.now() > v.expiresAt) { this.m.delete(id); return null; }
    return v.kind === kind && v.uid === uid ? v : null;
  }
  peek(id, kind, uid = '') { const v = this._get(id, kind, uid); return v ? v.challenge : null; }
  take(id, kind, uid = '') { const v = this._get(id, kind, uid); if (!v) return null; this.m.delete(id); return v.challenge; }
}

module.exports = { cbor, parseAuthData, coseToSpki, verifyRegistration, verifyAssertion, cleanWrap, Challenges, b64u, fromB64u };
