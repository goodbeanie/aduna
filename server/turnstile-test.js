// Sign-up check: node server/turnstile-test.js
const assert = require('assert');
const { cleanup } = require('./test-env');
process.env.TURNSTILE_SECRET = 'test-secret';
process.env.TURNSTILE_SITE_KEY = 'test-site';
const T = require('./turnstile');
const { httpServer, ready } = require('./index');

const realFetch = globalThis.fetch;
const asked = [];
let verdict = { success: true };
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith(T.VERIFY_URL)) return realFetch(url, init);
  asked.push(new URLSearchParams(init.body));
  if (verdict === 'down') throw new Error('unreachable');
  return { json: async () => verdict };
};

let base;
async function call(p, { method = 'GET', body } = {}) {
  const r = await realFetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const signup = (username, turnstile) => call('/register', { method: 'POST', body: { username, password: 'password123', publicKey: 'k', encPrivKey: { salt: 'a', iv: 'b', data: 'c' }, ...(turnstile ? { turnstile } : {}) } });
const step = (m) => console.log('✓', m);

(async () => {
  const off = {};
  assert.deepStrictEqual(await T.verify('x', '1.2.3.4', { env: off }), { ok: true, reason: 'off' });
  assert.strictEqual(T.enabled({ TURNSTILE_SECRET: 's' }), false, 'needs the site key too');
  step('off without both keys');

  assert.strictEqual((await T.verify('', '1.2.3.4')).ok, false);
  assert.strictEqual((await T.verify('x'.repeat(3000), '1.2.3.4')).ok, false);
  assert.strictEqual(asked.length, 0, 'a missing or oversize token never reaches Cloudflare');
  step('missing and oversize tokens are refused locally');

  assert.deepStrictEqual(await T.verify('tok', '1.2.3.4'), { ok: true });
  assert.strictEqual(asked[0].get('secret'), 'test-secret'); assert.strictEqual(asked[0].get('response'), 'tok'); assert.strictEqual(asked[0].get('remoteip'), '1.2.3.4');
  verdict = { success: false, 'error-codes': ['invalid-input-response'] };
  assert.deepStrictEqual(await T.verify('tok', ''), { ok: false, reason: 'invalid-input-response' });
  assert.strictEqual(asked[1].has('remoteip'), false);
  step('Cloudflare is asked with the secret, the token and the address, and its answer is used');

  verdict = 'down';
  assert.strictEqual((await T.verify('tok', '')).ok, false);
  assert.strictEqual((await T.verify('tok', '', { env: { ...process.env, TURNSTILE_FAIL_OPEN: '1' } })).ok, true);
  step('an unreachable Cloudflare fails closed unless TURNSTILE_FAIL_OPEN=1');

  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://127.0.0.1:' + httpServer.address().port;

  assert.strictEqual((await call('/auth-options')).turnstile, 'test-site'); step('the sign-up page is told the site key');

  verdict = { success: true };
  let r = await signup('nocheck');
  assert.strictEqual(r.status, 400); assert.strictEqual(r.code, 'turnstile_failed');
  assert.ok(!Object.values(require('./db').db.users).some((u) => u.username === 'nocheck')); step('sign-up without a token makes no account');

  verdict = { success: false, 'error-codes': ['timeout-or-duplicate'] };
  r = await signup('badtoken', 'used-before');
  assert.strictEqual(r.status, 400); assert.strictEqual(r.code, 'turnstile_failed'); step('a token Cloudflare rejects makes no account');

  verdict = { success: true };
  r = await signup('goodtoken', 'fresh');
  assert.strictEqual(r.status, 200); assert.ok(r.token); step('a good token makes the account');

  console.log('\nturnstile-test: all passed');
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; }).finally(async () => { httpServer.close(); await cleanup(); process.exit(process.exitCode || 0); });
