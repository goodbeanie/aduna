// The yearly recap through the server: node server/recap-flow-test.js (needs TEST_DATABASE_URL, see test-env.js)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanup } = require('./test-env');
process.env.RESEND_API_KEY = 're_test_not_real';
process.env.CREATOR_EMAILS = 'recap.creator@gmail.com';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-flow-'));
process.env.RECAP_DIR = dir;
const mailer = require('./mailer');
const credits = require('./credits');
const recap = require('./recap');
const { httpServer, ready, store, recapSweep, voiceTick } = require('./index');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const reg = async (name, email) => {
  const mark = mailer.outbox.length;
  const r = await call('/register', { method: 'POST', body: { username: name, email, password: 'password123', publicKey: 'k', encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  const m = mailer.outbox.slice(mark).find((x) => x.to === email.trim().toLowerCase());
  const code = m && (/\b(\d{6})\b/.exec(m.subject) || [])[1];
  await call('/me/verify-email', { method: 'POST', token: r.token, body: { code } });
  return r;
};
const step = (m) => console.log('✓', m);

(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://127.0.0.1:' + httpServer.address().port;
  const year = new Date().getUTCFullYear();

  const creator = await reg('recap_creator', 'recap.creator@gmail.com');
  const nina = await reg('recap_nina', 'nina.recap@example.com');
  const cu = store.db.users[creator.user.id], nu = store.db.users[nina.user.id];

  credits.grant(cu, 50, 'quest', { note: 'test' });
  credits.grant(cu, 20, 'message');
  credits.grant(cu, 100, 'purchase', { kind: 'buy' });
  assert.strictEqual(recap.counter(cu, year, 'credits'), 70, 'earned credits count, bought ones do not');
  assert.strictEqual(recap.counter(nu, year, 'credits'), null);
  step('credits earned are counted on the user, bought ones are not');

  assert.strictEqual(voiceTick(), undefined);
  step('the voice tick runs with nobody in voice');

  assert.strictEqual((await call('/admin/recap/test', { method: 'POST', token: nina.token, body: {} })).status, 404);
  assert.strictEqual((await call('/admin/recap/test', { method: 'POST', body: {} })).status, 401);
  step('only a creator account can generate a test recap');

  let r = await call('/admin/recap/test', { method: 'POST', token: creator.token, body: {} });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual(r.year, year);
  assert.strictEqual(r.mine.credits, 70);
  assert.strictEqual(r.mine.userId, creator.user.id);
  assert.ok(r.global.users >= 2 && !('userId' in r.global));
  assert.ok(!fs.existsSync(path.join(dir, String(year))), 'a test run saves nothing');
  assert.strictEqual((await call('/admin/recap/test', { method: 'POST', token: creator.token, body: { year: 1999 } })).status, 400);
  assert.strictEqual((await call('/admin/recap/test', { method: 'POST', token: creator.token, body: { year: 'x' } })).status, 400);
  step('a creator gets the global recap and their own, nothing is saved, a bad year is refused');

  assert.strictEqual(recapSweep(), null, 'nothing is due outside January to March of the next year');
  assert.strictEqual((await call('/recap', { token: nina.token })).year, null);
  const built = recap.buildAll({ ...store.db }, year);
  recap.write(dir, year, built);
  r = await call('/recap', { token: creator.token });
  assert.strictEqual(r.year, year); assert.strictEqual(r.mine.credits, 70);
  r = await call('/recap', { token: nina.token });
  assert.strictEqual(r.mine, null, 'nobody has seen anyone else\'s recap');
  assert.ok(r.global && r.global.year === year);
  step('everyone reads the global recap and only their own');

  console.log('\nAll recap flow checks passed.');
  httpServer.close();
  fs.rmSync(dir, { recursive: true, force: true });
  await cleanup();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
