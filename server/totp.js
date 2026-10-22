// Time-based one-time passwords (RFC 6238, SHA-1, 6 digits, 30 s) for two-factor login, plus single-use recovery codes.
// Pure: no Express, no database. Tested in totp-test.js.
const crypto = require('crypto');

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // base32, what authenticator apps expect
const PERIOD = 30;

function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = ((val << 8) | b) & 0xfffff;
    bits += 8;
    while (bits >= 5) { out += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHA[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  const s = String(str || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, val = 0;
  const out = [];
  for (const ch of s) {
    const i = ALPHA.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    val = ((val << 5) | i) & 0xfffff;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newSecret = () => b32encode(crypto.randomBytes(20)); // 160 bits

function hotp(secretBuf, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}
const stepAt = (now = Date.now()) => Math.floor(now / 1000 / PERIOD);

// The time step the code belongs to (this one, or one either side for clock drift), or null. A step at or below `lastStep`
// is refused, so a code that was already used (or one older than the last one used) cannot be replayed.
function verify(secret, code, { now = Date.now(), window = 1, lastStep = -1 } = {}) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  let key;
  try { key = b32decode(secret); } catch { return null; }
  const cur = stepAt(now);
  let hit = null;
  for (let s = cur - window; s <= cur + window; s++) { // no early exit: same work whatever the answer
    const ok = crypto.timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(c));
    if (ok && s > lastStep && (hit === null || s > hit)) hit = s;
  }
  return hit;
}

function otpauthUri({ secret, account, issuer = 'Aduna' }) {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${PERIOD}`;
}

// Recovery codes: 10 characters (50 bits), shown as xxxxx-xxxxx, stored only as hashes, each usable once.
const normRecovery = (c) => String(c ?? '').replace(/[\s-]/g, '').toLowerCase();
const hashRecovery = (c) => crypto.createHash('sha256').update('aduna-recovery:' + normRecovery(c)).digest('hex');
function newRecoveryCodes(n = 8) {
  return Array.from({ length: n }, () => {
    const c = b32encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase();
    return c.slice(0, 5) + '-' + c.slice(5);
  });
}

module.exports = { newSecret, b32encode, b32decode, hotp, stepAt, verify, otpauthUri, newRecoveryCodes, hashRecovery, normRecovery, PERIOD };
