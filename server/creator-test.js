// The creator account and badges: node server/creator-test.js (needs TEST_DATABASE_URL, see test-env.js)
const assert = require('assert');
const { cleanup } = require('./test-env');
process.env.RESEND_API_KEY = 're_test_not_real'; // verification on; NODE_ENV=test keeps mail in mailer.outbox
const mailer = require('./mailer');
const { httpServer, ready } = require('./index');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
// Several accounts share one mailbox here, so each account's code is taken from the mail its own sign-up produced
const reg = async (name, email) => {
  const mark = mailer.outbox.length;
  const r = await call('/register', { method: 'POST', body: { username: name, email, password: 'password123', publicKey: 'k', encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  const m = mailer.outbox.slice(mark).find((x) => x.to === email.trim().toLowerCase());
  return { ...r, code: m && (/\b(\d{6})\b/.exec(m.subject) || [])[1] };
};
const verify = (acc) => call('/me/verify-email', { method: 'POST', token: acc.token, body: { code: acc.code } });
const step = (m) => console.log('✓', m);
const CREATOR = 'adunachatapp@gmail.com';

(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://127.0.0.1:' + httpServer.address().port;

  // any number of accounts can sign up with the creator address, and none of them is told it is "taken"
  const c1 = await reg('creator_one', CREATOR);
  const c2 = await reg('creator_two', 'Adunachatapp@gmail.com');
  const c3 = await reg('creator_three', 'aduna.chat.app+x@gmail.com');
  for (const c of [c1, c2, c3]) assert.strictEqual(c.status, 200, JSON.stringify(c));
  step('three accounts can register with the creator address');

  // typing the address gives nothing until the emailed code is entered
  let r = await call('/badges', { token: c1.token });
  assert.strictEqual(r.status, 403); assert.ok(!c1.user.creator && !(c1.user.badges || []).length);
  step('an unverified creator-address account has no badge and no creator powers');

  // each one proves it can read the mailbox, one after the other
  for (const acc of [c1, c2, c3]) {
    assert.ok(/^\d{6}$/.test(acc.code), 'each account is sent its own code');
    r = await verify(acc);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
  }
  for (const acc of [c1, c2, c3]) {
    r = await call('/me', { token: acc.token });
    assert.ok(r.user.creator === true && r.user.developer === true && r.user.badges.some((b) => b.id === 'creator'), JSON.stringify(r.user.badges));
  }
  step('every account that verifies the creator address becomes a creator, a developer and gets the Creator badge');

  // a normal account cannot touch badges
  const norm = await reg('normal_nina', 'nina@example.com');
  await verify(norm);
  assert.strictEqual((await call('/badges', { token: norm.token })).status, 403);
  assert.strictEqual((await call('/badges', { method: 'POST', token: norm.token, body: { name: 'Mine' } })).status, 403);
  step('other accounts are refused by the badge API');

  // make a badge and give it away
  r = await call('/badges', { method: 'POST', token: c2.token, body: { name: 'Tester', emoji: '🧪', color: '#112233' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r)); const id = r.badge.id;
  assert.strictEqual((await call('/badges', { method: 'POST', token: c2.token, body: { name: 'tester' } })).status, 409);
  assert.strictEqual((await call('/badges', { method: 'POST', token: c2.token, body: { name: 'Creator' } })).status, 409);
  step('a creator makes a badge; duplicate names and "Creator" are refused');

  assert.strictEqual((await call('/badges/' + id + '/give', { method: 'POST', token: c1.token, body: { username: 'nobody_here' } })).status, 404);
  r = await call('/badges/' + id + '/give', { method: 'POST', token: c1.token, body: { username: '@normal_nina' } });
  assert.strictEqual(r.status, 200);
  r = await call('/me', { token: norm.token });
  assert.ok(r.user.badges.some((b) => b.id === id && b.name === 'Tester'), JSON.stringify(r.user.badges));
  assert.ok(!r.user.creator, 'a given badge does not make anyone a creator');
  step('any creator account can give a badge; the person sees it on their profile');

  console.log('\ncreator-test: all passed');
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; }).finally(async () => { httpServer.close(); await cleanup(); process.exit(process.exitCode || 0); });
