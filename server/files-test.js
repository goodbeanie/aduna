// Attachment limit + auto-expiry tests: node server/files-test.js
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aduna-files-'));
const { cleanup } = require('./test-env');
process.env.ATTACHMENT_TTL_DAYS = '0.00003'; // about 2.6 seconds, so the test can watch files expire
process.env.LARGE_ATTACHMENT_TTL_DAYS = '0.00003';
const { httpServer, expireOldAttachments, ready } = require('./index');
const { io: connect } = require('socket.io-client');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const reg = (username) => call('/register', { method: 'POST', body: { username, email: username + '@example.com', password: 'password123', publicKey: 'pk' + username, encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
const upload = async (token, kind, target, bytes) => {
  const r = await fetch(`${base}/api/files?kind=${kind}&target=${target}`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }, body: bytes });
  return { status: r.status, ...(await r.json()) };
};
const getFile = (token, id) => fetch(`${base}/api/files/${id}`, { headers: { Authorization: 'Bearer ' + token } });
const ack = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
const once = (s, ev) => new Promise((res) => s.once(ev, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log('✓', m);

ready.then(() => httpServer.listen(0, async () => {
  base = 'http://127.0.0.1:' + httpServer.address().port;
  try {
    const alice = await reg('alice_f');
    const { server: hub } = await call('/servers', { method: 'POST', token: alice.token, body: { name: 'Hub' } });
    const cid = hub.channels[0].id;

    // ---- 20 MB limit ----
    const MB = 1024 * 1024;
    assert.strictEqual((await upload(alice.token, 'channel', cid, Buffer.alloc(20 * MB, 1))).status, 200, 'exactly 20 MB is allowed');
    let r = await upload(alice.token, 'channel', cid, Buffer.alloc(20 * MB + 1, 1));
    assert.strictEqual(r.status, 413); assert.ok(/20 MB/.test(r.error), 'message names the 20 MB limit, got: ' + r.error);
    r = await upload(alice.token, 'channel', cid, Buffer.alloc(25 * MB, 1));
    assert.strictEqual(r.status, 413); assert.ok(/20 MB/.test(r.error));
    step('20 MB attachments allowed, anything larger refused with a clear message');

    // ---- size-based expiry rule: small files 14 days, big files 5 days (dates backdated in the database) ----
    {
      const store = require('./db');
      const DAY = 24 * 3600 * 1000, rules = { smallMs: 14 * DAY, largeMs: 5 * DAY, thresholdBytes: 1000 };
      const small = await store.putFile(Buffer.alloc(500, 1), { owner: 'x', scope: 'dm:a:b' });
      const large = await store.putFile(Buffer.alloc(2000, 1), { owner: 'x', scope: 'dm:a:b' });
      const age = (id, days) => store.query('UPDATE files SET created_at = $1 WHERE id = $2', [Date.now() - days * DAY, id]);
      await age(small, 4); await age(large, 4);
      assert.ok(!(await store.expireFiles(rules)).some((x) => x === small || x === large), '4 days old: both kept');
      await age(small, 6); await age(large, 6);
      const gone = await store.expireFiles(rules);
      assert.ok(gone.includes(large) && !gone.includes(small), '6 days old: the big file goes, the small one stays');
      await age(small, 13);
      assert.ok(!(await store.expireFiles(rules)).includes(small), '13 days old: small file kept');
      await age(small, 15);
      assert.ok((await store.expireFiles(rules)).includes(small), '15 days old: small file removed');
      step('expiry by size: files over the threshold go after 5 days, smaller ones after 14');
    }

    // ---- expiry (shortened for the test) ----
    const sa = connect(base, { auth: { token: alice.token } });
    await once(sa, 'connect');
    sa.emit('channel:join', cid); // harmless if the server uses a different join flow
    const bytes = Buffer.from('expiry-marker-' + 'z'.repeat(100));
    const up = await upload(alice.token, 'channel', cid, bytes);
    const sent = once(sa, 'message:new');
    const res = await ack(sa, 'message:send', { channelId: cid, content: 'see file', attachments: [{ id: up.id, name: 'a.txt', type: 'text/plain' }] });
    assert.ok(res.ok, JSON.stringify(res));
    await sent;
    assert.strictEqual((await getFile(alice.token, up.id)).status, 200, 'file is readable while fresh');
    assert.strictEqual(await expireOldAttachments(), 0, 'nothing expires early');

    await sleep(3200);
    const edited = once(sa, 'message:edited');
    assert.ok(await expireOldAttachments() >= 1, 'old file removed');
    const ev = await edited;
    assert.strictEqual(ev.message.attachments[0].expired, true, 'live clients are told the attachment expired');
    assert.strictEqual((await getFile(alice.token, up.id)).status, 404, 'expired file is gone');
    const hist = await call(`/channels/${cid}/messages`, { token: alice.token });
    const m = (hist.messages || []).find((x) => x.content === 'see file');
    assert.ok(m, 'message itself is kept'); assert.strictEqual(m.attachments[0].expired, true); assert.strictEqual(m.attachments[0].name, 'a.txt');
    step('attachments expire after the TTL, message stays and is flagged expired');
    console.log('ALL PASSED');
    sa.close();
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  await cleanup();
  process.exit();
}));
