// Cloudflare R2 storage test against a tiny in-process S3 stand-in: node server/r2-test.js
const http = require('http'), assert = require('assert'), zlib = require('zlib');
const { cleanup } = require('./test-env');

// ---- minimal S3 path-style server: PUT / GET / DELETE /<bucket>/<key>, and it checks requests are signed ----
const objects = new Map();
let unsigned = 0;
const s3 = http.createServer((req, res) => {
  if (!/^AWS4-HMAC-SHA256 /.test(req.headers.authorization || '')) unsigned++;
  const key = decodeURIComponent(req.url.split('?')[0]);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.method === 'PUT') { objects.set(key, Buffer.concat(chunks)); res.writeHead(200).end(); }
    else if (req.method === 'GET') { const o = objects.get(key); o ? res.writeHead(200).end(o) : res.writeHead(404).end(); }
    else if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); }
    else res.writeHead(405).end();
  });
});

function crc32(buf) { let crc = 0xffffffff; for (const byte of buf) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }
function makePng(w, h, marker) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0' + marker, 'latin1')), chunk('IDAT', zlib.deflateSync(Buffer.alloc((w * 3 + 1) * h, 0x7f))), chunk('IEND', Buffer.alloc(0))]);
}
const step = (m) => console.log('✓', m);

(async () => {
  await new Promise((r) => s3.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { R2_BUCKET: 'aduna-test', R2_ACCESS_KEY_ID: 'AKIDEXAMPLE', R2_SECRET_ACCESS_KEY: 'secret', R2_ENDPOINT: 'http://127.0.0.1:' + s3.address().port });
  const { httpServer, ready } = require('./index');
  const store = require('./db');
  await ready;
  assert.ok(store.usingR2, 'R2 backend should be active');
  await new Promise((r) => httpServer.listen(0, r));
  const base = 'http://127.0.0.1:' + httpServer.address().port;
  const call = async (p, { method = 'GET', body, token } = {}) => {
    const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };

  // profile picture through the API
  const u = await call('/register', { method: 'POST', body: { username: 'r2user', email: 'r2user@example.com', password: 'password123', publicKey: 'pk', encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  const marker = 'R2-MARKER-' + 'x'.repeat(40);
  const put = await fetch(base + '/api/me/avatar', { method: 'PUT', headers: { 'Content-Type': 'image/png', Authorization: 'Bearer ' + u.token }, body: makePng(8, 8, marker) });
  const up = await put.json();
  assert.strictEqual(put.status, 200, JSON.stringify(up));
  const iid = up.user.avatarImage;
  assert.ok(objects.has(`/aduna-test/images/${iid}`), 'image bytes were uploaded to R2');
  assert.ok(!objects.get(`/aduna-test/images/${iid}`).toString('latin1').includes(marker), 'R2 only holds ciphertext');
  assert.strictEqual((await store.query('SELECT octet_length(data) AS n FROM images WHERE id = $1', [iid])).rows[0].n, 0, 'Postgres keeps no image bytes');
  const got = await fetch(`${base}/api/images/${iid}`);
  assert.strictEqual(got.status, 200);
  assert.ok(Buffer.from(await got.arrayBuffer()).toString('latin1').includes(marker), 'image served back from R2 intact');
  step('profile picture: stored in R2 (encrypted), Postgres holds only the index row, served back intact');

  // replacing deletes the old object
  const put2 = await (await fetch(base + '/api/me/avatar', { method: 'PUT', headers: { 'Content-Type': 'image/png', Authorization: 'Bearer ' + u.token }, body: makePng(8, 8, 'second') })).json();
  assert.ok(!objects.has(`/aduna-test/images/${iid}`), 'old picture removed from R2');
  assert.ok(objects.has(`/aduna-test/images/${put2.user.avatarImage}`));
  const rm = await call('/me/avatar', { method: 'DELETE', token: u.token });
  assert.strictEqual(rm.status, 200);
  assert.strictEqual([...objects.keys()].filter((k) => k.includes('/images/')).length, 0, 'removing the picture empties R2');
  step('replacing or removing a picture deletes the R2 object');

  // attachments + expiry
  const fid = await store.putFile(Buffer.from('attachment-bytes-plugh'), { owner: 'x', scope: 'dm:a:b', size: 22 });
  assert.ok(objects.has(`/aduna-test/files/${fid}`));
  assert.ok(!objects.get(`/aduna-test/files/${fid}`).toString('latin1').includes('plugh'));
  assert.strictEqual((await store.getFileBytes(fid)).toString(), 'attachment-bytes-plugh');
  const gone = await store.expireFiles({ smallMs: -1000, largeMs: -1000, thresholdBytes: 1e12 });
  assert.ok(gone.includes(fid) && !objects.has(`/aduna-test/files/${fid}`), 'expired attachment removed from R2');
  step('attachments: encrypted in R2, read back, removed on expiry');

  // rows written before R2 was switched on (bytes inside Postgres) keep working
  const legacyId = 'a'.repeat(32), legacyPng = makePng(8, 8, 'legacy');
  await store.query('INSERT INTO images (id, data, created_at) VALUES ($1, $2, $3)', [legacyId, store._seal(legacyPng, `images:${legacyId}`), Date.now()]);
  assert.ok((await store.getImage(legacyId)).equals(legacyPng), 'old Postgres-stored image still readable');
  await store.deleteImage(legacyId);
  assert.strictEqual(await store.getImage(legacyId), null);
  step('images stored in Postgres before switching to R2 still work');

  // storage limit
  const before = await store.r2BytesUsed();
  assert.strictEqual(before, 0, 'everything uploaded so far was cleaned up');
  const f1 = await store.putFile(Buffer.alloc(3000, 1), { owner: 'x', scope: 'dm:a:b', size: 3000 });
  assert.ok((await store.r2BytesUsed()) > 3000, 'usage counts the stored bytes');
  process.env.STORAGE_LIMIT_GB = String(5000 / 1024 ** 3); // 5000 bytes
  await assert.rejects(() => store.putFile(Buffer.alloc(3000, 2), { owner: 'x', scope: 'dm:a:b', size: 3000 }), (e) => e.code === 'STORAGE_FULL');
  assert.strictEqual([...objects.keys()].filter((k) => k.includes('/files/')).length, 1, 'refused upload never reached R2');
  const full = await fetch(base + '/api/me/avatar', { method: 'PUT', headers: { 'Content-Type': 'image/png', Authorization: 'Bearer ' + u.token }, body: makePng(40, 40, 'x'.repeat(4000)) });
  const fullBody = await full.json();
  assert.strictEqual(full.status, 507, JSON.stringify(fullBody));
  assert.ok(/storage limit/i.test(fullBody.error));
  await store.deleteFiles([f1]);
  const small = await store.putFile(Buffer.alloc(3000, 3), { owner: 'x', scope: 'dm:a:b', size: 3000 });
  assert.ok(small, 'deleting frees room');
  await store.deleteFiles([small]);
  process.env.STORAGE_LIMIT_GB = '0';
  const big = await store.putFile(Buffer.alloc(9000, 4), { owner: 'x', scope: 'dm:a:b', size: 9000 });
  await store.deleteFiles([big]);
  delete process.env.STORAGE_LIMIT_GB;
  step('storage limit: refused above the cap (HTTP 507, nothing sent to R2), freed by deletes, 0 turns it off');

  assert.strictEqual(unsigned, 0, 'every R2 request must be signed');
  console.log('\nR2 checks passed.');
  await cleanup();
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
