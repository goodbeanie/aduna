// Signing in on a new device by approving it from one that is already signed in.
// Like security.js this has no Express / Postgres imports, so server/devicelogin-test.js can test it alone.
//
// Why it works the way it does: your messages are end-to-end encrypted and the key that opens them is locked by your password, so a
// "sign in without typing the password" feature has to hand the new device that key, and only a device that holds it can do that.
//   1. The new device makes a throwaway key pair in the browser and asks to sign in. It gets a SECRET request id (only it knows it)
//      and a short CODE to read out or type on the other device. Only the public half of the throwaway key comes to us.
//   2. On the signed-in device the person types the code, sees what is asking, and confirms with their password (and the two-factor code
//      if that is on). The browser opens the encryption key with the password, locks it for the new device's throwaway public key, and
//      sends us only that sealed blob. We cannot open it.
//   3. The new device, polling with its secret id, receives the sealed blob and a login cookie, opens the blob, and is in.
// Requests live only in memory for a few minutes and work once.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no I O 0 1: easy to read out loud
const CODE_LEN = 8;                                   // 32^8 is about 1.1e12 codes
const ID_RE = /^[A-Za-z0-9_-]{32}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

// "ABCD-EFGH" as shown; what is typed (any case, spaces, dashes) is reduced to 8 symbols, or '' if it cannot be a code
const formatCode = (c) => c.slice(0, 4) + '-' + c.slice(4);
function normCode(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '');
  return s.length === CODE_LEN && [...s].every((ch) => ALPHABET.includes(ch)) ? s : '';
}
const newCode = () => Array.from({ length: CODE_LEN }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

function bytes(s, n) {
  if (typeof s !== 'string' || s.length > 2000 || !B64.test(s)) return null;
  const b = Buffer.from(s, 'base64');
  return n && b.length !== n ? null : b;
}
// an uncompressed P-256 point: 65 bytes, starts with 0x04 (the browser checks it is really on the curve when it imports it)
const validPoint = (s) => { const b = bytes(s, 65); return !!b && b[0] === 4; };
// What device B receives: the approver's throwaway public key, the iv, and the encrypted key. A fixed shape and size, nothing else is kept.
function cleanSealed(x) {
  if (!x || typeof x !== 'object' || !validPoint(x.publicKey) || !bytes(x.iv, 12)) return null;
  const d = bytes(x.data);
  if (!d || d.length < 17 || d.length > 600) return null; // a sealed identity key is about 170 bytes
  return { publicKey: x.publicKey, iv: x.iv, data: x.data };
}

// "Chrome on Windows", "the Aduna Android app": enough for the person to recognise the device that is asking. Never fails.
function describeDevice(ua) {
  const s = String(ua || '').slice(0, 400);
  const os = /Android/.test(s) ? 'Android' : /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Windows/.test(s) ? 'Windows'
    : /Macintosh|Mac OS X/.test(s) ? 'macOS' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : '';
  if (/AdunaAndroid/.test(s)) return 'the Aduna Android app';
  if (/Electron\//.test(s)) return 'the Aduna desktop app' + (os ? ` on ${os}` : '');
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) || /FxiOS\//.test(s) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'an unknown device';
}

class DeviceLogins {
  constructor({ ttlMs = 5 * 60_000, maxPending = 5000, now = () => Date.now() } = {}) {
    Object.assign(this, { ttlMs, maxPending, now });
    this.byId = new Map();   // secret id -> request
    this.byCode = new Map(); // code (8 symbols) -> secret id
  }
  _drop(r) { this.byId.delete(r.id); if (this.byCode.get(r.code) === r.id) this.byCode.delete(r.code); }
  _sweep() { const t = this.now(); for (const r of [...this.byId.values()]) if (t > r.expiresAt) this._drop(r); }
  _live(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const r = this.byId.get(id);
    if (!r) return null;
    if (this.now() > r.expiresAt) { this._drop(r); return null; }
    return r;
  }
  get size() { return this.byId.size; }

  // The new device asks to sign in. { id, code, expiresAt }, or { error: 'bad' | 'busy' }.
  start({ publicKey, ua, ip }) {
    if (!validPoint(publicKey)) return { error: 'bad' };
    this._sweep();
    if (this.byId.size >= this.maxPending) return { error: 'busy' };
    let code = newCode();
    for (let i = 0; this.byCode.has(code); i++) { if (i > 20) return { error: 'busy' }; code = newCode(); }
    const t = this.now();
    const r = { id: crypto.randomBytes(24).toString('base64url'), code, publicKey, device: describeDevice(ua), ip: String(ip || ''), createdAt: t, expiresAt: t + this.ttlMs, status: 'pending', uid: null, sealed: null };
    this.byId.set(r.id, r);
    this.byCode.set(code, r.id);
    return { id: r.id, code: formatCode(code), expiresAt: r.expiresAt };
  }

  // The request behind a typed code while it still waits for an answer, or null (wrong, expired, already answered)
  find(rawCode) {
    const c = normCode(rawCode);
    const id = c && this.byCode.get(c);
    const r = id && this._live(id);
    return r && r.status === 'pending' ? r : null;
  }
  // 'ok', 'gone' (no such waiting request) or 'bad' (the sealed blob is not the right shape)
  approve(rawCode, uid, sealed) {
    const r = this.find(rawCode);
    if (!r) return 'gone';
    const s = cleanSealed(sealed);
    if (!s) return 'bad';
    Object.assign(r, { status: 'approved', uid, sealed: s });
    return 'ok';
  }
  deny(rawCode) {
    const r = this.find(rawCode);
    if (!r) return false;
    r.status = 'denied';
    return true;
  }

  // What the new device sees while it waits: { status: 'pending' | 'approved' | 'denied' | 'expired' }. A refusal is reported once, then forgotten.
  poll(id) {
    const r = this._live(id);
    if (!r) return { status: 'expired' };
    if (r.status === 'denied') { this._drop(r); return { status: 'denied' }; }
    return { status: r.status };
  }
  // Hands over an approved request exactly once: { uid, sealed }, or null
  take(id) {
    const r = this._live(id);
    if (!r || r.status !== 'approved') return null;
    this._drop(r);
    return { uid: r.uid, sealed: r.sealed };
  }
}

module.exports = { DeviceLogins, normCode, formatCode, describeDevice, validPoint, cleanSealed, ALPHABET };
