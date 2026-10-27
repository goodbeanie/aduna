// Clips end to end, against a tiny in-process S3 stand-in: node server/clips-test.js (needs TEST_DATABASE_URL)
const http = require('http'), assert = require('assert'), zlib = require('zlib');
const { cleanup, rawDb } = require('./test-env');
const { mp4 } = require('./clips-logic-test');

// ---- minimal S3 (path style: /<bucket>/<key>): PUT, GET (with Range), HEAD, DELETE. It counts requests that carry no signature. ----
const objects = new Map(); // '/bucket/key' -> { body, type }
let unsigned = 0, failDeletes = false;
const puts = [];
const s3 = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!/^AWS4-HMAC-SHA256 /.test(req.headers.authorization || '') && !u.searchParams.has('X-Amz-Signature')) unsigned++;
  const key = decodeURIComponent(u.pathname);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.method === 'PUT') { objects.set(key, { body: Buffer.concat(chunks), type: req.headers['content-type'] || 'binary/octet-stream' }); puts.push(u); return res.writeHead(200).end(); }
    if (req.method === 'DELETE') { if (failDeletes) return res.writeHead(500).end(); objects.delete(key); return res.writeHead(204).end(); }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const o = objects.get(key);
      if (!o) return res.writeHead(404).end();
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      const part = req.method === 'GET' && m ? o.body.subarray(Number(m[1]), Number(m[2]) + 1) : o.body;
      res.writeHead(req.method === 'GET' && m ? 206 : 200, { 'Content-Type': o.type, 'Content-Length': part.length });
      return req.method === 'HEAD' ? res.end() : res.end(part);
    }
    res.writeHead(405).end();
  });
});

function crc32(buf) { let crc = 0xffffffff; for (const byte of buf) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }
function makePng(w, h) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc((w * 3 + 1) * h, 0x7f))), chunk('IEND', Buffer.alloc(0))]);
}
const step = (m) => console.log('✓', m);
const DAY = 24 * 3600 * 1000;

(async () => {
  await new Promise((r) => s3.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    R2_ACCESS_KEY_ID: 'AKIDEXAMPLE', R2_SECRET_ACCESS_KEY: 'secret', R2_ENDPOINT: 'http://127.0.0.1:' + s3.address().port,
    CLIPS_R2_BUCKET: 'clips-test', CLIPS_PUBLIC_URL: 'https://clips.example.test/', ADMIN_USERNAMES: 'clipadmin',
    CLIP_MAX_MB: '0.1', CLIP_DAILY_LIMIT: '50', CLIP_REPORTS_TO_HIDE: '2',
  });
  delete process.env.R2_BUCKET; delete process.env.STORAGE_LIMIT_GB; delete process.env.CLIP_UPLOAD_CREDITS;
  const { httpServer, ready, sweepClips } = require('./index');
  const store = require('./db');
  const credits = require('./credits');
  await ready;
  assert.ok(store.clipsR2 && !store.usingR2, 'the clips bucket is on, the main bucket is not');
  await new Promise((r) => httpServer.listen(0, r));
  const base = 'http://127.0.0.1:' + httpServer.address().port;
  const call = async (p, { method = 'GET', body, token } = {}) => {
    const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const makeUser = async (name) => {
    const r = await call('/register', { method: 'POST', body: { username: name, email: name + '@example.com', password: 'password123', publicKey: 'pk', encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
    assert.strictEqual(r.status, 200, 'register ' + JSON.stringify(r));
    return r;
  };
  const clipObjects = () => [...objects.keys()].filter((k) => k.startsWith('/clips-test/'));
  const PNG = makePng(8, 8);
  const vid = (seconds = 10, pad = 3000, o = {}) => Buffer.concat([mp4(seconds, o), Buffer.alloc(pad, 1)]);
  // the whole flow: ask for links, PUT the bytes to them, say it is done
  async function post(u, { video = vid(), poster = PNG, seconds = 10, caption = '', declared, videoType = 'video/mp4', posterType = 'image/png', upload = true } = {}) {
    const up = await call('/clips/upload-url', { method: 'POST', token: u.token, body: { size: declared || video.length, posterSize: poster.length, posterType, seconds, width: 720, height: 1280, caption } });
    if (up.status !== 200) return { up };
    if (upload) {
      assert.strictEqual((await fetch(up.video.url, { method: 'PUT', headers: { ...up.video.headers, 'Content-Type': videoType }, body: video })).status, 200);
      assert.strictEqual((await fetch(up.poster.url, { method: 'PUT', headers: up.poster.headers, body: poster })).status, 200);
    }
    const done = await call(`/clips/${up.id}/complete`, { method: 'POST', token: u.token });
    return { up, done, id: up.id };
  }

  const ann = await makeUser('clipann'), bob = await makeUser('clipbob'), cat = await makeUser('clipcat'), dan = await makeUser('clipdan'), eve = await makeUser('clipeve'), admin = await makeUser('clipadmin');
  for (const u of [bob, cat]) store.db.users[u.user.id].createdAt = Date.now() - 2 * DAY; // established accounts: their reports count

  // ---- the defaults for the storage budget ----
  assert.strictEqual(store.storageLimitBytes(), 4 * 1024 ** 3, 'everything that is not a clip: 4 GB');
  assert.strictEqual(require('./clips').settings({}).limitBytes, 5 * 1024 ** 3, 'clips: 5 GB');
  step('storage budget: 4 GB for everything else + 5 GB for clips = 9 GB');

  // ---- the header lets the browser play and upload ----
  const csp = (await fetch(base + '/healthz')).headers.get('content-security-policy');
  const dir = (n) => csp.split('; ').find((d) => d.startsWith(n + ' '));
  assert.ok(dir('img-src').includes('https://clips.example.test') && dir('media-src').includes('https://clips.example.test'), 'clips address allowed for pictures and video');
  assert.ok(dir('connect-src').includes(process.env.R2_ENDPOINT), 'the R2 upload address is allowed for connections');
  assert.ok(!dir('script-src').includes('clips.example'), 'but never for scripts');
  step('the browser policy allows clips (and only for pictures, video and the upload)');

  // ---- signed in, and off switch ----
  assert.strictEqual((await call('/clips')).status, 401);
  assert.strictEqual((await call('/clips/upload-url', { method: 'POST', body: {} })).status, 401);
  process.env.CLIPS_PUBLIC_URL = '';
  assert.strictEqual((await call('/clips', { token: ann.token })).status, 503, 'no public address: clips are off');
  process.env.CLIPS_PUBLIC_URL = 'https://clips.example.test/';
  step('clips need a login, and are off until the bucket and its public address are set');

  // ---- a clip, start to finish ----
  const r1 = await post(ann, { caption: 'unique-caption-plugh', seconds: 12 });
  assert.strictEqual(r1.up.status, 200, JSON.stringify(r1.up));
  assert.strictEqual(r1.done.status, 200, JSON.stringify(r1.done));
  const put = puts.find((u) => u.pathname.includes('/clips/'));
  assert.ok(put.searchParams.get('X-Amz-Signature') && put.searchParams.get('X-Amz-Expires') === '600', 'a signed link that lasts 10 minutes');
  const c1 = store.db.clips[r1.id];
  assert.deepStrictEqual([c1.state, c1.owner, c1.seconds], ['live', ann.user.id, 10], 'live, and the length is the one read from the file (10), not the one claimed (12)');
  assert.ok(c1.expiresAt - c1.liveAt === 7 * DAY, 'kept for 7 days');
  assert.ok(objects.has('/clips-test/' + c1.key) && objects.has('/clips-test/' + c1.posterKey), 'video and cover are in the clips bucket');
  assert.strictEqual(r1.done.clip.url, 'https://clips.example.test/' + c1.key, 'viewers get the public address');
  assert.ok(!JSON.stringify(r1.done).includes('reports') && !JSON.stringify(r1.done).includes('likedBy'));
  assert.strictEqual((await call(`/clips/${r1.id}/complete`, { method: 'POST', token: ann.token })).status, 200, 'asking twice is fine');
  assert.strictEqual((await call(`/clips/${r1.id}/complete`, { method: 'POST', token: bob.token })).status, 404, 'only the poster can finish it');
  assert.strictEqual(unsigned, 0, 'every request to R2 was signed');
  step('upload: signed 10-minute links, video + cover go straight to R2, the server checks them, the clip goes live for 7 days');

  // ---- the feed, views, likes ----
  let feed = await call('/clips', { token: bob.token });
  assert.deepStrictEqual(feed.clips.map((c) => c.id), [r1.id]);
  assert.deepStrictEqual([feed.clips[0].owner.username, feed.clips[0].mine, feed.clips[0].liked], ['clipann', false, false]);
  assert.ok(feed.limits.maxSeconds === 30 && feed.limits.left === 50 && feed.limits.keepDays === 7, JSON.stringify(feed.limits));
  assert.strictEqual((await call(`/clips/${r1.id}/view`, { method: 'POST', token: bob.token })).views, 1);
  assert.strictEqual((await call(`/clips/${r1.id}/view`, { method: 'POST', token: bob.token })).views, 1, 'the same person counts once a day');
  assert.strictEqual((await call(`/clips/${r1.id}/view`, { method: 'POST', token: ann.token })).views, 1, 'the poster\'s own views do not count');
  assert.strictEqual((await call(`/clips/${r1.id}/view`, { method: 'POST', token: cat.token })).views, 2);
  let lk = await call(`/clips/${r1.id}/like`, { method: 'POST', token: bob.token });
  assert.deepStrictEqual([lk.liked, lk.likes], [true, 1]);
  assert.strictEqual((await call('/clips', { token: bob.token })).clips[0].liked, true);
  lk = await call(`/clips/${r1.id}/like`, { method: 'POST', token: cat.token });
  assert.strictEqual(lk.likes, 2);
  lk = await call(`/clips/${r1.id}/like`, { method: 'POST', token: bob.token });
  assert.deepStrictEqual([lk.liked, lk.likes], [false, 1], 'liking again takes the like back');
  step('feed, one counted view per person per day, likes that toggle');

  // ---- what the server refuses, and the bytes it deletes ----
  const before = clipObjects().length;
  const refused = async (opts, status, re) => {
    const r = await post(cat, opts);
    const res = r.done || r.up;
    assert.strictEqual(res.status, status, JSON.stringify([opts.caption, res]));
    assert.ok(re.test(res.error), res.error);
    return r;
  };
  await refused({ declared: 130000 }, 400, /at most 0\.1 MB/);               // claimed over the limit: no link at all
  await refused({ seconds: 31 }, 400, /at most 30 seconds/);
  await refused({ caption: 'visit www.example.com' }, 400, /links/);
  assert.strictEqual(clipObjects().length, before, 'a refused request creates nothing');
  const html = await refused({ video: Buffer.from('<html><script>alert(1)</script></html>'.padEnd(3000, ' ')) }, 400, /not an MP4/);
  assert.ok(!objects.has('/clips-test/' + store.db.clips[html.id].key) && store.db.clips[html.id].state === 'rejected' && store.db.clips[html.id].key === null, 'a fake video is deleted at once');
  await refused({ video: vid(10, 120000), declared: 3000 }, 413, /at most 0\.1 MB/);        // claimed small, uploaded big
  await refused({ video: vid(10, 3000), videoType: 'text/html' }, 400, /not an MP4/);
  await refused({ video: vid(10, 3000, { faststart: false }) }, 400, /fast start/);
  await refused({ video: vid(40), seconds: 10 }, 400, /at most 30 seconds/);                // claimed 10 s, really 40 s
  await refused({ poster: Buffer.from('not an image'), posterType: 'image/png' }, 400, /cover picture/);
  assert.strictEqual(clipObjects().length, before, 'everything that failed was deleted from R2');
  const early = await post(cat, { upload: false });
  assert.deepStrictEqual([early.done.status, early.done.code], [409, 'not_uploaded']);
  assert.strictEqual(store.db.clips[early.id].state, 'pending', 'nothing arrived yet: still open, the app can ask again');
  step('refused: claims over the limit, links in captions, fake videos, wrong type, big uploads, slow-start files, wrong length, bad covers; every failed upload is deleted');

  // ---- limits per person ----
  process.env.CLIP_DAILY_LIMIT = '2';
  assert.strictEqual((await post(dan)).done.status, 200);
  assert.strictEqual((await post(dan)).done.status, 200);
  const third = await post(dan);
  assert.deepStrictEqual([third.up.status, third.up.code], [429, 'daily_limit']);
  assert.strictEqual((await call('/clips', { token: dan.token })).limits.left, 0);
  process.env.CLIP_DAILY_LIMIT = '50';
  const open1 = await post(eve, { upload: false }), open2 = await post(eve, { upload: false });
  assert.ok(open1.up.id && open2.up.id);
  assert.strictEqual((await post(eve, { upload: false })).up.status, 429, 'two open uploads at a time');
  step('a daily limit per person, and two open upload links at a time');

  // ---- the 5 GB cap (shrunk to a few KB here) ----
  const used = (await call('/admin/clips', { token: admin.token })).usage;
  assert.ok(used.clipsBytes > 0 && used.live >= 3, JSON.stringify(used));
  process.env.CLIPS_LIMIT_GB = String((used.clipsBytes + 1000) / 1024 ** 3);
  const full = await post(cat);
  assert.deepStrictEqual([full.up.status, full.up.code], [507, 'clips_full']);
  assert.ok(/try again later/i.test(full.up.error));
  delete process.env.CLIPS_LIMIT_GB;
  assert.strictEqual((await post(cat)).done.status, 200, 'room again once the cap is back');
  step('clips are refused (with a clear message) once the clips cap is reached, and accepted again when there is room');

  // ---- credits ----
  process.env.CLIP_UPLOAD_CREDITS = '3';
  const fay = await makeUser('clipfay'), fu = store.db.users[fay.user.id];
  const bal = () => credits.acct(fu).balance;
  credits.grant(fu, 10, 'quest');
  const b0 = bal();
  const paid = await post(fay);
  assert.strictEqual(paid.done.status, 200);
  assert.strictEqual(bal(), b0 - 3, 'a clip costs 3 credits');
  const bad = await post(fay, { video: Buffer.from('nope'.padEnd(3000, 'x')) });
  assert.strictEqual(bad.done.status, 400);
  assert.strictEqual(bal(), b0 - 3, 'a rejected upload costs 3 credits at first...');
  assert.strictEqual(store.db.clips[bad.id].credits, 0, '...and they are given back');
  assert.strictEqual(bal(), b0 - 3 + 0, 'balance after the refund');
  process.env.CLIP_UPLOAD_CREDITS = '1000000';
  const poor = await post(fay);
  assert.deepStrictEqual([poor.up.status, poor.up.code], [402, 'not_enough_credits']);
  delete process.env.CLIP_UPLOAD_CREDITS;
  step('optional credits: charged per clip, refunded when the upload fails');

  // ---- reports, hiding, moderators ----
  assert.strictEqual((await call(`/clips/${r1.id}/report`, { method: 'POST', body: { reason: 'spam' }, token: ann.token })).status, 400, 'not your own');
  assert.strictEqual((await call(`/clips/${r1.id}/report`, { method: 'POST', body: { reason: 'nonsense' }, token: bob.token })).status, 400);
  assert.strictEqual((await call(`/clips/${r1.id}/report`, { method: 'POST', body: { reason: 'other' }, token: bob.token })).status, 400, 'other needs details');
  assert.strictEqual((await call(`/clips/${r1.id}/report`, { method: 'POST', body: { reason: 'spam' }, token: bob.token })).status, 200);
  assert.strictEqual(store.db.clips[r1.id].state, 'live', 'one report is not enough');
  assert.strictEqual((await call(`/clips/${r1.id}/report`, { method: 'POST', body: { reason: 'illegal', details: 'x' }, token: cat.token })).status, 200);
  assert.strictEqual(store.db.clips[r1.id].state, 'hidden', 'two established accounts hide it');
  assert.ok(!(await call('/clips', { token: bob.token })).clips.some((c) => c.id === r1.id), 'hidden clips leave the feed');
  assert.strictEqual((await call(`/clips/${r1.id}/view`, { method: 'POST', token: cat.token })).status, 404);
  assert.ok(objects.has('/clips-test/' + c1.key), 'hidden is not deleted: a moderator can still look');
  assert.strictEqual((await call('/admin/clips', { token: bob.token })).status, 404, 'moderators only');
  const q = await call('/admin/clips', { token: admin.token });
  const row = q.clips.find((x) => x.id === r1.id);
  assert.deepStrictEqual([row.state, row.counted, row.reports.length, row.owner, q.toHide], ['hidden', 2, 2, 'clipann', 2]);
  assert.ok(row.url.endsWith(c1.key), 'a moderator can open the video');
  assert.strictEqual((await call('/admin/clips/' + r1.id, { method: 'POST', body: { action: 'restore' }, token: admin.token })).state, 'live');
  assert.ok((await call('/clips', { token: bob.token })).clips.some((c) => c.id === r1.id), 'restored');
  assert.strictEqual(store.db.clips[r1.id].reports.length, 0);
  assert.strictEqual(store.db.clips[r1.id].reportCount, 2, 'the count of reports is kept');
  assert.strictEqual((await call('/admin/clips/' + r1.id, { method: 'POST', body: { action: 'dance' }, token: admin.token })).status, 400);
  step('reports from established accounts hide a clip; moderators see them, play the video, restore or remove it');

  // ---- expiry: the video goes, the numbers stay ----
  const r2 = await post(bob, { caption: 'short lived' });
  await call(`/clips/${r2.id}/view`, { method: 'POST', token: cat.token });
  await call(`/clips/${r2.id}/like`, { method: 'POST', token: cat.token });
  const k2 = store.db.clips[r2.id];
  const [vk, pk] = [k2.key, k2.posterKey];
  assert.ok(objects.has('/clips-test/' + vk));
  assert.deepStrictEqual(await sweepClips(), { expired: 0, abandoned: 0, retried: 0 }, 'nothing is due yet');
  k2.expiresAt = Date.now() - 1; // seven days later
  const swept = await sweepClips();
  assert.strictEqual(swept.expired, 1);
  assert.ok(!objects.has('/clips-test/' + vk) && !objects.has('/clips-test/' + pk), 'video and cover are deleted from R2');
  assert.deepStrictEqual([k2.state, k2.key, k2.posterKey, k2.views, k2.likes, k2.owner, k2.caption, k2.seconds], ['expired', null, null, 1, 1, bob.user.id, 'short lived', 10], 'the record and its numbers stay');
  assert.ok(typeof k2.purgedAt === 'number' && k2.likedBy.length === 0);
  assert.ok(!(await call('/clips', { token: ann.token })).clips.some((c) => c.id === r2.id), 'gone from the feed');
  const mine = (await call('/clips/mine', { token: bob.token })).clips.find((c) => c.id === r2.id);
  assert.deepStrictEqual([mine.state, mine.views, mine.likes, mine.available], ['expired', 1, 1, false]);
  assert.ok(!JSON.stringify(mine).includes('clips/'), 'no file names handed out');
  assert.strictEqual((await call(`/clips/${r2.id}/like`, { method: 'POST', token: ann.token })).status, 404);
  assert.deepStrictEqual(await sweepClips(), { expired: 0, abandoned: 0, retried: 0 }, 'swept once');
  await store.flush();
  const raw = await rawDb();
  assert.ok(!raw.includes('unique-caption-plugh') && !raw.includes('short lived'), 'captions are encrypted in the database like everything else');
  step('after 7 days the video and cover are deleted from R2; the record, views, likes, reports and owner stay');

  // ---- a link nobody used, a failed delete, the poster taking a clip down ----
  const ghost = await post(eve, { upload: false }); // eve already holds two open ones: wait for them to be dropped
  assert.strictEqual(ghost.up.status, 429);
  for (const o of [open1, open2]) store.db.clips[o.up.id].createdAt = Date.now() - 20 * 60_000;
  assert.strictEqual((await sweepClips()).abandoned, 2, 'upload links nobody finished are dropped after 15 minutes');
  assert.deepStrictEqual([store.db.clips[open1.up.id].state, store.db.clips[open1.up.id].why], ['rejected', 'The upload was never finished']);
  const r3 = await post(eve);
  assert.strictEqual(r3.done.status, 200);
  failDeletes = true;
  assert.strictEqual((await call('/clips/' + r3.id, { method: 'DELETE', token: eve.token })).status, 200);
  const k3 = store.db.clips[r3.id];
  assert.ok(k3.state === 'removed' && k3.key && objects.has('/clips-test/' + k3.key), 'taken down at once, bytes still there because R2 refused');
  assert.ok(!(await call('/clips', { token: bob.token })).clips.some((c) => c.id === r3.id), 'out of the feed immediately');
  failDeletes = false;
  assert.strictEqual((await sweepClips()).retried, 1, 'the next sweep deletes what is left');
  assert.ok(k3.key === null && !clipObjects().some((k) => k.includes('posters/') && k === '/clips-test/' + k3.posterKey));
  assert.strictEqual((await call('/clips/' + r3.id, { method: 'DELETE', token: ann.token })).status, 404, 'not yours');
  const r4 = await post(ann);
  assert.strictEqual((await call('/admin/clips/' + r4.id, { method: 'POST', body: { action: 'remove' }, token: admin.token })).state, 'removed');
  assert.ok(!objects.has('/clips-test/' + store.db.clips[r4.id].key) && store.db.clips[r4.id].why === 'Removed by a moderator');
  step('unfinished uploads are dropped, a failed delete is retried, posters and moderators can take a clip down');

  // ---- what is left in the bucket is exactly the live clips ----
  const live = Object.values(store.db.clips).filter((c) => c.state === 'live' || c.state === 'hidden');
  const expected = live.flatMap((c) => ['/clips-test/' + c.key, '/clips-test/' + c.posterKey]).sort();
  assert.deepStrictEqual(clipObjects().sort(), expected, 'no orphans: the bucket holds only the clips that are live');
  assert.strictEqual(unsigned, 0, 'every request to R2 was signed');
  step('the bucket holds exactly the live clips, nothing else');

  console.log('\nAll clips tests passed.');
  await new Promise((r) => httpServer.close(r)); s3.close();
  await cleanup();
  process.exit(0);
})().catch(async (e) => { console.error(e); try { await cleanup(); } catch {} process.exit(1); });
