// Sign in on a new device by approving it from a signed-in one, without a database: node server/devicelogin-test.js
const assert = require('assert');
const crypto = require('crypto');
const D = require('./devicelogin');
const step = (m) => console.log('✓', m);

const point = () => Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]).toString('base64');
const sealed = () => ({ publicKey: point(), iv: crypto.randomBytes(12).toString('base64'), data: crypto.randomBytes(170).toString('base64') });
const clock = (t0 = 1_000_000) => { const c = { t: t0, now: () => c.t }; return c; };

// codes: the shape, typing tolerance
{
  const r = new D.DeviceLogins().start({ publicKey: point(), ua: 'x', ip: '1.1.1.1' });
  assert.ok(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(r.code), 'ABCD-EFGH, no I O 0 1: ' + r.code);
  assert.ok(/^[A-Za-z0-9_-]{32}$/.test(r.id), 'the secret id is 192 random bits');
  assert.notStrictEqual(r.id, r.code);
  assert.strictEqual(D.normCode(r.code.toLowerCase().replace('-', ' ')), r.code.replace('-', ''), 'typed in lower case with a space');
  for (const bad of ['', 'ABCD', 'ABCD-EFG', 'ABCD-EFGHJ', 'ABCD-EFG0', 'ABCD-EFGI', 'ABCD-EFG!', null, undefined, 12345678, {}]) assert.strictEqual(D.normCode(bad), '', 'refused: ' + String(bad));
  const seen = new Set(Array.from({ length: 300 }, () => new D.DeviceLogins().start({ publicKey: point() }).code));
  assert.ok(seen.size > 295, 'codes are random');
  step('codes: 8 easy symbols, tolerant typing, nothing else passes');
}

// the whole happy path, and that it works once
{
  const L = new D.DeviceLogins();
  const a = L.start({ publicKey: point(), ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', ip: '9.9.9.9' });
  assert.deepStrictEqual(L.poll(a.id), { status: 'pending' });
  const seen = L.find(a.code);
  assert.strictEqual(seen.device, 'Chrome on Windows');
  assert.strictEqual(seen.ip, '9.9.9.9');
  assert.ok(seen.publicKey, 'the approver is given the new device\'s public key');
  const s = sealed();
  assert.strictEqual(L.approve(a.code.toLowerCase(), 'user-1', s), 'ok');
  assert.deepStrictEqual(L.poll(a.id), { status: 'approved' });
  assert.strictEqual(L.find(a.code), null, 'an answered request cannot be looked up again');
  assert.strictEqual(L.approve(a.code, 'user-2', sealed()), 'gone', 'a second person cannot approve the same request');
  const got = L.take(a.id);
  assert.strictEqual(got.uid, 'user-1');
  assert.deepStrictEqual(got.sealed, s);
  assert.strictEqual(L.take(a.id), null, 'handed over once');
  assert.deepStrictEqual(L.poll(a.id), { status: 'expired' });
  assert.strictEqual(L.size, 0, 'nothing is left behind');
  step('approve: the new device gets the sealed key once, nobody else can answer it');
}

// the secret id is not the code; only the id collects the answer
{
  const L = new D.DeviceLogins();
  const a = L.start({ publicKey: point() });
  L.approve(a.code, 'user-1', sealed());
  assert.strictEqual(L.take(a.code), null, 'the code cannot collect the sealed key');
  assert.strictEqual(L.take(a.code.replace('-', '')), null);
  for (const bad of ['', 'x', a.id.slice(1), a.id + 'x', null, undefined, 5, {}, '../../etc/passwd']) { assert.strictEqual(L.take(bad), null); assert.deepStrictEqual(L.poll(bad), { status: 'expired' }); }
  assert.ok(L.take(a.id), 'the real id still works');
  step('only the secret id collects the answer; junk ids are treated as expired');
}

// refusal is reported once
{
  const L = new D.DeviceLogins();
  const a = L.start({ publicKey: point() });
  assert.strictEqual(L.deny(a.code), true);
  assert.strictEqual(L.deny(a.code), false);
  assert.strictEqual(L.approve(a.code, 'u', sealed()), 'gone', 'a refused request cannot be approved afterwards');
  assert.deepStrictEqual(L.poll(a.id), { status: 'denied' });
  assert.deepStrictEqual(L.poll(a.id), { status: 'expired' }, 'the refusal is said once');
  step('deny: the new device is told once');
}

// time limit, for waiting and for collecting
{
  const c = clock(), L = new D.DeviceLogins({ ttlMs: 60_000, now: c.now });
  const a = L.start({ publicKey: point() }), b = L.start({ publicKey: point() });
  c.t += 59_000;
  assert.deepStrictEqual(L.poll(a.id), { status: 'pending' });
  L.approve(b.code, 'u', sealed());
  c.t += 2_000;
  assert.deepStrictEqual(L.poll(a.id), { status: 'expired' });
  assert.strictEqual(L.find(a.code), null, 'an expired code is gone');
  assert.strictEqual(L.approve(a.code, 'u', sealed()), 'gone');
  assert.strictEqual(L.take(b.id), null, 'an approved answer that was never collected also expires');
  const x = L.start({ publicKey: point() });
  assert.strictEqual(L.size, 1, 'starting a request sweeps the dead ones');
  assert.ok(x.expiresAt > c.t);
  step('requests expire, answered or not');
}

// bad input
{
  const L = new D.DeviceLogins();
  for (const bad of [undefined, null, '', 'abc', 5, {}, Buffer.alloc(65, 4).toString('base64') + 'AA', Buffer.concat([Buffer.from([3]), crypto.randomBytes(64)]).toString('base64'), crypto.randomBytes(32).toString('base64'), '!!' + point()])
    assert.deepStrictEqual(L.start({ publicKey: bad }), { error: 'bad' }, 'public key refused: ' + String(bad).slice(0, 20));
  assert.strictEqual(L.size, 0);
  const a = L.start({ publicKey: point() });
  const good = sealed();
  for (const bad of [null, 'x', {}, { ...good, publicKey: 'AAAA' }, { ...good, iv: 'AAAA' }, { ...good, data: '' }, { ...good, data: 'AAAA' }, { ...good, data: crypto.randomBytes(900).toString('base64') }, { ...good, data: 5 }, { publicKey: good.publicKey, iv: good.iv }])
    assert.strictEqual(L.approve(a.code, 'u', bad), 'bad');
  assert.ok(L.find(a.code), 'a refused blob does not use the request up');
  const extra = L.approve(a.code, 'u', { ...good, secret: 'x', __proto__: { a: 1 } });
  assert.strictEqual(extra, 'ok');
  assert.deepStrictEqual(Object.keys(L.take(a.id).sealed).sort(), ['data', 'iv', 'publicKey'], 'only the three known fields are kept');
  step('bad public keys and sealed blobs are refused');
}

// limits
{
  const L = new D.DeviceLogins({ maxPending: 3 });
  const made = [1, 2, 3].map(() => L.start({ publicKey: point() }));
  assert.deepStrictEqual(L.start({ publicKey: point() }), { error: 'busy' }, 'a full table says busy');
  L.take(made[0].id); // not approved: still there
  assert.strictEqual(L.size, 3);
  L.deny(made[0].code); L.poll(made[0].id);
  assert.ok(L.start({ publicKey: point() }).id, 'room again');
  step('the table is capped');
}

// describing the device that asks
{
  const d = D.describeDevice;
  assert.strictEqual(d('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'), 'Edge on Windows');
  assert.strictEqual(d('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Aduna/1.4.69 Chrome/130.0.6723.152 Electron/33.4.11 Safari/537.36'), 'the Aduna desktop app on Windows');
  assert.strictEqual(d('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 AdunaAndroid'), 'the Aduna Android app');
  assert.strictEqual(d('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'), 'Chrome on Android');
  assert.strictEqual(d('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), 'Safari on iOS');
  assert.strictEqual(d('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; rv:130.0) Gecko/20100101 Firefox/130.0'), 'Firefox on macOS');
  assert.strictEqual(d(''), 'an unknown device');
  assert.strictEqual(d(undefined), 'an unknown device');
  assert.strictEqual(d('x'.repeat(50_000)), 'an unknown device');
  step('describeDevice: names the browser and system, never throws');
}

console.log('\nAll device sign-in checks passed.');
