// Webhook routes: POST /api/hooks/:server/:hook/:token and the manager routes under /api/servers/:id/webhooks.
// Covers what webhooks-test.js cannot (it has no Express and no database): one answer for every wrong address, the rate limits, a bot beating a
// channel, and the 512 KB body cap. node server/webhooks-flow-test.js (needs TEST_DATABASE_URL and `npm install`)
const assert = require('assert');
const nodeCrypto = require('crypto');
const { webcrypto } = require('crypto');
const { cleanup } = require('./test-env');
const { httpServer, ready, store } = require('./index');
const sandbox = require('./sandbox');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
// What another service does: POST to the secret address. No login, no cookie. `raw` sends exact bytes (GitHub signs those).
async function post(path, body, { headers = {}, raw } = {}) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw !== undefined ? raw : JSON.stringify(body) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const step = (m) => console.log('✓', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 6000) {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) assert.fail('timed out waiting for ' + what); await sleep(40); }
}
async function makeUser(name) {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const pub = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const r = await call('/register', { method: 'POST', body: { username: name, email: name + '@example.com', password: 'password123', publicKey: JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }), encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  assert.strictEqual(r.status, 200, 'register ' + JSON.stringify(r));
  return r;
}
const T = (u) => u.token;
const hookPath = (made) => new URL(made.url).pathname; // /api/hooks/<server>/<webhook>/<token>
const hex16 = () => nodeCrypto.randomBytes(8).toString('hex');
const newAddressToken = () => nodeCrypto.randomBytes(32).toString('base64url');

(async () => {
  await ready;
  await sandbox.ready();
  assert.ok(sandbox.available(), 'the bot sandbox is not installed: run npm install (the bot-over-channel checks need it)');
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://localhost:' + httpServer.address().port;

  const owner = await makeUser('hookowner'), other = await makeUser('hookother');
  assert.strictEqual((await call('/developer/join', { method: 'POST', body: { accept: true }, token: T(owner) })).status, 200);

  const sv = (await call('/servers', { method: 'POST', body: { name: 'Hook Land' }, token: T(owner) })).server;
  const general = sv.channels[0];
  const side = (await call(`/servers/${sv.id}/channels`, { method: 'POST', body: { name: 'side' }, token: T(owner) })).server.channels.find((c) => c.name === 'side');
  const osv = (await call('/servers', { method: 'POST', body: { name: 'Elsewhere' }, token: T(other) })).server;

  const mk = async (u, srv, body) => { const r = await call(`/servers/${srv.id}/webhooks`, { method: 'POST', body, token: T(u) }); assert.strictEqual(r.status, 200, JSON.stringify(r)); return r; };
  const inChannel = (ch) => Object.values(store.db.messages).filter((m) => m.channelId === ch.id);
  const fromHook = (ch, id) => inChannel(ch).filter((m) => m.authorId === 'hook:' + id);
  const hookRecord = (srv, id) => store.db.servers[srv.id].webhooks.find((h) => h.id === id);

  // wrong addresses are counted so the exhaustion check at the end can say exactly where the limit sits
  let misses = 0;
  const guess = async (path) => { const r = await post(path, { content: 'x' }); if (r.status === 404) misses++; return r; };

  // ---------- baseline: a channel webhook posts a message with no account behind it ----------
  const plain = await mk(owner, sv, { name: 'Deploys', channelId: general.id });
  const plainPath = hookPath(plain);
  assert.ok(/^\/api\/hooks\/[0-9a-f]{16}\/[0-9a-f]{16}\/[A-Za-z0-9_-]{43}$/.test(plainPath), 'the address is /api/hooks/<server>/<webhook>/<43-character token>: ' + plainPath);
  assert.strictEqual(plain.secret, undefined, 'a generic webhook has no signing secret');
  let r = await post(plainPath, { content: 'Deploy **done**' });
  assert.deepStrictEqual([r.status, r.ok], [200, true], JSON.stringify(r));
  let posted = fromHook(general, plain.webhook.id);
  assert.strictEqual(posted.length, 1);
  assert.deepStrictEqual([posted[0].content, posted[0].bot, posted[0].hook], ['Deploy **done**', true, { id: plain.webhook.id, name: 'Deploys', kind: 'generic' }]);
  assert.strictEqual(hookRecord(sv, plain.webhook.id).uses, 1, 'the delivery is counted');
  step('baseline: a delivery to the secret address posts a bot-marked message that belongs to no account');

  // ---------- 404 uniformity: every wrong address gets the same answer ----------
  const [sid, hid] = [sv.id, plain.webhook.id];
  const token = plainPath.split('/')[5];
  const otherHook = await mk(other, osv, { name: 'Theirs', channelId: osv.channels[0].id });
  const temp = await mk(owner, sv, { name: 'Temp', channelId: general.id });
  const tempPath = hookPath(temp);
  assert.strictEqual((await call(`/servers/${sid}/webhooks/${temp.webhook.id}`, { method: 'DELETE', token: T(owner) })).status, 200);
  const wrong = {
    'an unknown server': `/api/hooks/${hex16()}/${hid}/${token}`,
    'an unknown webhook': `/api/hooks/${sid}/${hex16()}/${token}`,
    'a well-formed address that was never issued': `/api/hooks/${sid}/${hid}/${newAddressToken()}`,
    'the real address with its last character changed': `/api/hooks/${sid}/${hid}/${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
    'the right webhook id on someone else’s server': `/api/hooks/${osv.id}/${hid}/${token}`,
    'someone else’s webhook id on this server': `/api/hooks/${sid}/${otherHook.webhook.id}/${token}`,
    'a server id that is not hex': `/api/hooks/zzzzzzzzzzzzzzzz/${hid}/${token}`,
    'a webhook id that is too short': `/api/hooks/${sid}/abc/${token}`,
    'a token that is too short': `/api/hooks/${sid}/${hid}/short`,
    'a token with characters no token has': `/api/hooks/${sid}/${hid}/${'*'.repeat(43)}`,
    '__proto__ as the server id': `/api/hooks/__proto__/${hid}/${token}`,
    'a webhook that was deleted': tempPath,
  };
  const answers = {};
  for (const [what, path] of Object.entries(wrong)) answers[what] = await guess(path);
  for (const [what, a] of Object.entries(answers)) assert.deepStrictEqual(a, { status: 404, error: 'Not found' }, `${what} must get the same 404 as every other wrong address, got ${JSON.stringify(a)}`);
  // renewing makes the old address wrong at once, and it looks like any other wrong address
  const renewed = await call(`/servers/${sid}/webhooks/${hid}/renew`, { method: 'POST', token: T(owner) });
  assert.strictEqual(renewed.status, 200, JSON.stringify(renewed));
  assert.notStrictEqual(hookPath(renewed), plainPath);
  assert.deepStrictEqual(await guess(plainPath), { status: 404, error: 'Not found' }, 'the old address stops working at once');
  const livePath = hookPath(renewed);
  assert.strictEqual((await post(livePath, { content: 'new address' })).status, 200, 'and the new one works');
  assert.strictEqual(fromHook(general, hid).length, 2, 'wrong addresses posted nothing');
  assert.ok(!JSON.stringify(Object.values(answers)).includes(token), 'no answer repeats the address');
  step('404 uniformity: unknown server, unknown webhook, wrong or malformed address, someone else’s ids, a deleted or renewed webhook all get the identical 404');

  // ---------- rate limit: 30 deliveries a minute per webhook ----------
  const busy = await mk(owner, sv, { name: 'Busy', channelId: side.id });
  const busyPath = hookPath(busy);
  for (let i = 1; i <= 30; i++) { r = await post(busyPath, { content: 'n' + i }); assert.strictEqual(r.status, 200, `delivery ${i}: ${JSON.stringify(r)}`); }
  r = await post(busyPath, { content: 'n31' });
  assert.strictEqual(r.status, 429, 'the 31st delivery in a minute is refused');
  assert.match(r.error, /Too many deliveries \(30 a minute at most\)/);
  assert.strictEqual(fromHook(side, busy.webhook.id).length, 30, 'the refused one was not posted');
  assert.strictEqual((await post(livePath, { content: 'a different webhook is not affected' })).status, 200, 'the limit is per webhook');
  assert.strictEqual(hookRecord(sv, busy.webhook.id).uses, 30, 'refused deliveries are not counted as uses');
  step('rate limit: 30 deliveries a minute per webhook, the 31st gets 429 and is not posted, other webhooks are unaffected');

  // ---------- rate limit: managers changing webhooks (30 an hour per person) ----------
  // `other` has made one webhook so far (1 of 30); 29 renewals use up the rest
  for (let i = 1; i <= 29; i++) { r = await call(`/servers/${osv.id}/webhooks/${otherHook.webhook.id}/renew`, { method: 'POST', token: T(other) }); assert.strictEqual(r.status, 200, `change ${i + 1}: ${JSON.stringify(r)}`); }
  r = await call(`/servers/${osv.id}/webhooks/${otherHook.webhook.id}/renew`, { method: 'POST', token: T(other) });
  assert.strictEqual(r.status, 429, 'the 31st change in an hour is refused');
  assert.match(r.error, /changing webhooks too fast/);
  assert.strictEqual((await call(`/servers/${osv.id}/webhooks/${otherHook.webhook.id}`, { method: 'PATCH', body: { name: 'Renamed' }, token: T(other) })).status, 429, 'edits count too');
  assert.strictEqual((await call(`/servers/${osv.id}/webhooks`, { method: 'POST', body: { name: 'More', channelId: osv.channels[0].id }, token: T(other) })).status, 429, 'and so does making a new one');
  const renewedAgain = await call(`/servers/${sv.id}/webhooks/${hid}/renew`, { method: 'POST', token: T(owner) });
  assert.strictEqual(renewedAgain.status, 200, 'the limit is per person, not for everyone');
  const livePath2 = hookPath(renewedAgain); // renewing changed the address of the first webhook again: the rest of the file uses this one
  step('rate limit: 30 changes an hour per manager (create, edit, renew), another manager is unaffected');

  // ---------- a bot beats a channel ----------
  const BOT = "bot.on('webhook', (e) => bot.send(e.channels[0].id, 'bot got ' + e.hook.name + ' ' + (e.json ? e.json.n : e.text)));";
  const bot = (await call('/bots', { method: 'POST', body: { name: 'Hooker', code: BOT }, token: T(owner) })).bot;
  assert.ok(bot && bot.id, 'the developer made a bot');
  const inst = await call(`/servers/${sv.id}/bots`, { method: 'POST', body: { botId: bot.id }, token: T(owner) });
  assert.strictEqual(inst.status, 200, JSON.stringify(inst));
  const botUser = inst.server.members.find((m) => m.bot);
  const botSaid = () => inChannel(general).filter((m) => m.authorId === botUser.id);

  const both = await mk(owner, sv, { name: 'Both', channelId: side.id, botId: bot.id });
  const botOnly = await mk(owner, sv, { name: 'BotOnly', botId: bot.id });
  const bothPath = hookPath(both);
  r = await post(bothPath, { n: 7 });
  assert.deepStrictEqual([r.status, r.ok], [200, true], 'a bot takes any JSON object, it needs no "content" field: ' + JSON.stringify(r));
  const said = await until(() => botSaid()[0], 'the bot to answer the webhook');
  assert.strictEqual(said.content, 'bot got Both 7');
  assert.strictEqual(fromHook(side, both.webhook.id).length, 0, 'the channel got nothing: when a webhook has both, the bot wins');
  assert.strictEqual(inChannel(side).filter((m) => m.authorId === botUser.id).length, 0, 'the bot decided where to post, not the webhook');
  assert.strictEqual(hookRecord(sv, both.webhook.id).uses, 1);
  r = await post(livePath2, { n: 7 });
  assert.strictEqual(r.status, 400, 'the same data to a channel-only webhook is refused: a channel needs text');
  // the bot is taken out of the server: the channel is the fallback, a bot-only webhook has nowhere to go
  assert.strictEqual((await call(`/servers/${sv.id}/bots/${bot.id}`, { method: 'DELETE', token: T(owner) })).status, 200);
  const list = (await call(`/servers/${sv.id}/webhooks`, { token: T(owner) })).webhooks;
  const view = (id) => list.find((h) => h.id === id);
  assert.deepStrictEqual([view(both.webhook.id).botMissing, view(both.webhook.id).broken], [true, false], 'the manager sees the bot is gone but the channel still works');
  assert.deepStrictEqual([view(botOnly.webhook.id).botMissing, view(botOnly.webhook.id).broken], [true, true], 'and that a bot-only webhook is broken');
  r = await post(bothPath, { content: 'fallback' });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  const fb = fromHook(side, both.webhook.id);
  assert.deepStrictEqual([fb.length, fb[0] && fb[0].content], [1, 'fallback'], 'with the bot gone the channel gets the message');
  assert.strictEqual(botSaid().length, 1, 'and the removed bot heard nothing more');
  r = await post(hookPath(botOnly), { content: 'anyone?' });
  assert.strictEqual(r.status, 409, 'a bot-only webhook whose bot was removed has nowhere to send to');
  assert.match(r.error, /nowhere to send/);
  step('bot over channel: a bot gets the data and the channel nothing; with the bot removed the channel takes over; bot-only becomes a 409');

  // ---------- the 512 KB cap (and the signed raw body that rides on the same parser) ----------
  const LIMIT = 512 * 1024;
  const sized = (total) => { const head = '{"content":"cap","pad":"', tail = '"}'; return head + 'y'.repeat(total - head.length - tail.length) + tail; };
  const before = fromHook(general, hid).length;
  r = await post(livePath2, null, { raw: sized(100 * 1024) });
  assert.strictEqual(r.status, 200, 'GitHub events are bigger than the 64 KB of other routes, 100 KB is fine: ' + JSON.stringify(r));
  r = await post(livePath2, null, { raw: sized(LIMIT - 1024) });
  assert.strictEqual(r.status, 200, 'just under 512 KB is accepted: ' + JSON.stringify(r));
  assert.strictEqual(fromHook(general, hid).length, before + 2);
  r = await post(livePath2, null, { raw: sized(LIMIT + 1024) });
  assert.deepStrictEqual(r, { status: 413, error: 'That is too big (512 KB at most)' }, 'just over 512 KB is refused');
  r = await post(livePath2, null, { raw: sized(2 * LIMIT) });
  assert.strictEqual(r.status, 413, 'and so is a body twice the size');
  assert.strictEqual(fromHook(general, hid).length, before + 2, 'a refused body posts nothing');
  assert.deepStrictEqual(await post(livePath2, null, { raw: '{nope' }), { status: 400, error: 'Send JSON' }, 'broken JSON is a 400 with a plain answer');

  const gh = await mk(owner, sv, { name: 'Repo', kind: 'github', channelId: general.id });
  assert.ok(gh.secret && gh.secret.length >= 30, 'a GitHub webhook shows its signing secret once');
  const push = { ref: 'refs/heads/main', repository: { full_name: 'acme/web' }, sender: { login: 'octo' }, commits: [{ id: 'abcdef1234567', message: 'Fix bug', author: { username: 'octo' } }] };
  const rawPush = JSON.stringify(push);
  const sign = (secret) => 'sha256=' + nodeCrypto.createHmac('sha256', secret).update(rawPush).digest('hex');
  const ghHeaders = (secret, delivery) => ({ 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': delivery, 'X-Hub-Signature-256': sign(secret) });
  r = await post(hookPath(gh), null, { raw: rawPush, headers: ghHeaders(gh.secret, 'd-1') });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  const ghMsgs = () => fromHook(general, gh.webhook.id);
  assert.ok(ghMsgs().length === 1 && ghMsgs()[0].content.startsWith('**octo** pushed 1 commit to `main` in **acme/web**'), 'a correctly signed push posts: ' + JSON.stringify(ghMsgs().map((m) => m.content)));
  assert.strictEqual((await post(hookPath(gh), null, { raw: rawPush, headers: ghHeaders('not-the-secret', 'd-2') })).status, 401, 'a signature made with another secret is refused');
  assert.strictEqual((await post(hookPath(gh), null, { raw: rawPush, headers: ghHeaders(gh.secret, 'd-1') })).ignored, 'duplicate delivery', 'GitHub redelivering the same id posts nothing twice');
  assert.strictEqual(ghMsgs().length, 1);
  step('512 KB cap: 100 KB and just under pass, just over and double get 413 and post nothing, broken JSON is 400; a signed GitHub push goes through the same parser');

  // ---------- a stranger cannot keep guessing: 30 wrong addresses a minute, counted last because it uses the limit up ----------
  for (let i = 0; i < 60 && (r = await guess(`/api/hooks/${sid}/${hid}/${newAddressToken()}`)).status === 404; i++);
  assert.strictEqual(r.status, 429, 'after 30 wrong addresses the visitor is slowed down');
  assert.match(r.error, /Too many wrong addresses/);
  assert.strictEqual(misses, 30, 'exactly 30 wrong addresses were answered before that');
  assert.strictEqual((await post(livePath2, { content: 'right address, still welcome' })).status, 200, 'a correct address is not held back by it');
  step('rate limit: 30 wrong addresses a minute per visitor, then 429; a correct address still works');

  await sandbox.stop();
  console.log('\nAll webhook route checks passed.');
  await cleanup();
  process.exit(0);
})().catch(async (e) => { console.error('\n✗ FAILED:', e && e.stack || e); try { await sandbox.stop(); await cleanup(); } catch {} process.exit(1); });
