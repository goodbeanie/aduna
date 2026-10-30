// Passkeys, without a browser: a fake authenticator makes real registrations and sign-ins. Run: node server/passkeys-test.js
const assert = require('assert');
const crypto = require('crypto');
const P = require('./passkeys');

const sha = (b) => crypto.createHash('sha256').update(b).digest();
const ORIGIN = 'https://aduna.example', RPID = 'aduna.example';

// a tiny CBOR writer for the test
function enc(v) {
  const head = (major, n) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [enc(k), enc(x)])]);
  throw new Error('test cbor');
}

function authenticator(alg = 'es256') {
  const pair = alg === 'es256'
    ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const cose = alg === 'es256'
    ? new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])
    : new Map([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]]);
  const credId = crypto.randomBytes(32);
  let counter = 0;
  const flags = (o = {}) => (o.up === false ? 0 : 1) | (o.uv === false ? 0 : 4);
  const cd = (type, challenge, origin = ORIGIN, extra = {}) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra }));
  return {
    credId,
    create(challenge, o = {}) {
      const authData = Buffer.concat([sha(Buffer.from(o.rpId || RPID)), Buffer.from([flags(o) | 0x40]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, credId.length]), credId, enc(cose)]);
      const att = enc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { clientDataJSON: cd('webauthn.create', challenge, o.origin).toString('base64url'), attestationObject: att.toString('base64url') };
    },
    get(challenge, o = {}) {
      counter = o.counter ?? counter + 1;
      const ad = Buffer.concat([sha(Buffer.from(o.rpId || RPID)), Buffer.from([flags(o)]), Buffer.from([counter >>> 24, counter >>> 16 & 255, counter >>> 8 & 255, counter & 255])]);
      const c = cd('webauthn.get', challenge, o.origin);
      const sig = crypto.sign('sha256', Buffer.concat([ad, sha(c)]), o.key || pair.privateKey);
      return { clientDataJSON: c.toString('base64url'), authenticatorData: ad.toString('base64url'), signature: sig.toString('base64url'), counter };
    },
  };
}

const ch = () => crypto.randomBytes(32).toString('base64url');
const base = { origin: ORIGIN, rpId: RPID };
let n = 0; const step = (s) => console.log(++n + '. ' + s);

step('cbor reads what a real attestation object looks like, and refuses garbage without crashing');
assert.deepStrictEqual(P.cbor(enc(new Map([['a', 1], [-3, Buffer.from('xy')]])))[0], new Map([['a', 1], [-3, Buffer.from('xy')]]));
for (const bad of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from([0xbf]), Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff]), Buffer.from([0x9f, 0x01]), Buffer.from('a1', 'hex')]) assert.throws(() => P.cbor(bad), 'garbage is refused: ' + bad.toString('hex'));
const deep = Buffer.concat([Buffer.alloc(40, 0x81), Buffer.from([0])]); assert.throws(() => P.cbor(deep), 'nesting is capped');

for (const alg of ['es256', 'rs256']) {
  const a = authenticator(alg);
  step(alg + ': a new passkey is accepted and its public key is kept');
  const c1 = ch();
  const reg = P.verifyRegistration({ ...a.create(c1), challenge: c1, ...base });
  assert.strictEqual(reg.id, a.credId.toString('base64url'));
  assert.ok(reg.spki.length > 40 && reg.signCount === 0);

  step(alg + ': a registration for another challenge, site or address is refused');
  assert.throws(() => P.verifyRegistration({ ...a.create(c1), challenge: ch(), ...base }), /challenge/);
  assert.throws(() => P.verifyRegistration({ ...a.create(c1, { origin: 'https://evil.example' }), challenge: c1, ...base }), /origin/);
  assert.throws(() => P.verifyRegistration({ ...a.create(c1, { rpId: 'evil.example' }), challenge: c1, ...base }), /site/);
  assert.throws(() => P.verifyRegistration({ ...a.create(c1, { uv: false }), challenge: c1, ...base }), /verified/);
  assert.throws(() => P.verifyRegistration({ ...a.create(c1), clientDataJSON: a.get(c1).clientDataJSON, challenge: c1, ...base }), /ceremony/, 'a sign-in is not a registration');

  step(alg + ': a real sign-in passes, the counter is returned, and each answer works for its own challenge only');
  const s1 = ch();
  const g = a.get(s1);
  const out = P.verifyAssertion({ ...g, challenge: s1, ...base, credential: reg });
  assert.strictEqual(out.signCount, g.counter);
  assert.throws(() => P.verifyAssertion({ ...g, challenge: ch(), ...base, credential: reg }), /challenge/);
  assert.throws(() => P.verifyAssertion({ ...g, challenge: s1, ...base, origin: 'https://evil.example', credential: reg }), /origin/);
  assert.throws(() => P.verifyAssertion({ ...g, challenge: s1, ...base, rpId: 'evil.example', credential: reg }), /site/);

  step(alg + ': the wrong key, a tampered answer, and "not verified" are refused');
  const other = authenticator(alg);
  const s2 = ch();
  assert.throws(() => P.verifyAssertion({ ...other.get(s2), challenge: s2, ...base, credential: reg }), /signature/, 'another device cannot sign for this passkey');
  const t = a.get(s2); const tam = Buffer.from(t.authenticatorData, 'base64url'); tam[36] ^= 1;
  assert.throws(() => P.verifyAssertion({ ...t, authenticatorData: tam.toString('base64url'), challenge: s2, ...base, credential: reg }), /signature|counter/);
  assert.throws(() => P.verifyAssertion({ ...a.get(s2, { uv: false }), challenge: s2, ...base, credential: reg }), /verified/);
  assert.throws(() => P.verifyAssertion({ ...a.get(s2), signature: 'AAAA', challenge: s2, ...base, credential: reg }), /./);

  step(alg + ': a counter that goes back is refused, but syncing passkeys that always say 0 are fine');
  assert.throws(() => P.verifyAssertion({ ...a.get(s2, { counter: 1 }), challenge: s2, ...base, credential: { ...reg, signCount: 5 } }), /counter/);
  assert.strictEqual(P.verifyAssertion({ ...a.get(s2, { counter: 0 }), challenge: s2, ...base, credential: { ...reg, signCount: 0 } }).signCount, 0);
  assert.strictEqual(P.verifyAssertion({ ...a.get(s2, { counter: 9 }), challenge: s2, ...base, credential: { ...reg, signCount: 5 } }).signCount, 9);
}

step('an unsupported key type is refused');
assert.throws(() => P.coseToSpki(new Map([[1, 1], [3, -8]])), /unsupported/);
assert.throws(() => P.coseToSpki(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(31)], [-3, Buffer.alloc(32)]])), /bad key/);

step('the locked key copy has a fixed shape');
const wrap = { iv: crypto.randomBytes(12).toString('base64'), data: crypto.randomBytes(200).toString('base64') };
assert.deepStrictEqual(P.cleanWrap({ ...wrap, extra: 'x' }), wrap);
for (const bad of [null, {}, { iv: wrap.iv }, { iv: 'short', data: wrap.data }, { iv: wrap.iv, data: 'A'.repeat(901) }, { iv: wrap.iv, data: '<script>' }, 'x']) assert.strictEqual(P.cleanWrap(bad), null);

step('challenges work once, for their own purpose and person, and expire');
let t0 = 1000; const C = new P.Challenges({ ttlMs: 60_000, max: 3, now: () => t0 });
const a1 = C.issue({ kind: 'create', uid: 'u1' });
assert.strictEqual(C.peek(a1.id, 'create', 'u1'), a1.challenge);
assert.strictEqual(C.peek(a1.id, 'get'), null, 'a registration challenge cannot be used to sign in');
assert.strictEqual(C.peek(a1.id, 'create', 'u2'), null, 'or by someone else');
assert.strictEqual(C.take(a1.id, 'create', 'u1'), a1.challenge);
assert.strictEqual(C.take(a1.id, 'create', 'u1'), null, 'spent');
const a2 = C.issue({ kind: 'get' }); t0 += 61_000;
assert.strictEqual(C.take(a2.id, 'get'), null, 'expired');
for (let i = 0; i < 3; i++) assert.ok(C.issue({ kind: 'get' }));
assert.strictEqual(C.issue({ kind: 'get' }), null, 'full');
assert.strictEqual(C.take({}, 'get'), null); assert.strictEqual(C.take(undefined, 'get'), null);
assert.notStrictEqual(P.b64u(crypto.randomBytes(8)), P.b64u(crypto.randomBytes(8)));

console.log('passkeys: all ' + n + ' checks passed');
