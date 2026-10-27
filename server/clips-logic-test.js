// Clip rules, no database needed: node server/clips-logic-test.js
const assert = require('assert');
const clips = require('./clips');
const step = (m) => console.log('✓', m);
const MB = clips.MB, DAY = clips.DAY;

// ---- a tiny MP4: ftyp, moov (with an mvhd that says how long it is), mdat ----
const box = (type, payload) => { const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(b.length, 0); b.write(type, 4, 'latin1'); payload.copy(b, 8); return b; };
function mvhd(seconds, { v1 = false, scale = 1000 } = {}) {
  const p = Buffer.alloc(v1 ? 112 : 100);
  if (v1) { p[0] = 1; p.writeUInt32BE(scale, 20); p.writeBigUInt64BE(BigInt(Math.round(seconds * scale)), 24); }
  else { p.writeUInt32BE(scale, 12); p.writeUInt32BE(Math.round(seconds * scale), 16); }
  return box('mvhd', p);
}
function mp4(seconds, { faststart = true, brand = 'isom', v1 = false } = {}) {
  const ftyp = box('ftyp', Buffer.concat([Buffer.from(brand, 'latin1'), Buffer.alloc(4), Buffer.from('isom')]));
  const moov = box('moov', mvhd(seconds, { v1 }));
  const mdat = box('mdat', Buffer.alloc(200, 7));
  return Buffer.concat(faststart ? [ftyp, moov, mdat] : [ftyp, mdat, moov]);
}
module.exports = { mp4, box }; // clips-test.js uses the same helper

if (require.main === module) {
  const cfg = clips.settings({});
  const good = { size: 4 * MB, posterSize: 40_000, seconds: 20, width: 720, height: 1280, caption: 'hello there' };

  // ---- settings ----
  assert.deepStrictEqual([cfg.maxBytes, cfg.maxSeconds, cfg.limitBytes, cfg.ttlMs, cfg.dailyLimit, cfg.credits, cfg.reportsToHide, cfg.publicUrl],
    [8 * MB, 30, 5 * clips.GB, 7 * DAY, 5, 0, 5, ''], 'defaults: 8 MB, 30 s, 5 GB, 7 days, 5 a day, free, 5 reports');
  const env = clips.settings({ CLIP_MAX_MB: '4', CLIP_MAX_SECONDS: '15', CLIPS_LIMIT_GB: '1.5', CLIPS_TTL_DAYS: '3', CLIP_DAILY_LIMIT: '2', CLIP_UPLOAD_CREDITS: '3', CLIPS_PUBLIC_URL: 'https://clips.example.com/' });
  assert.deepStrictEqual([env.maxBytes, env.maxSeconds, env.limitBytes, env.ttlMs, env.dailyLimit, env.credits, env.publicUrl], [4 * MB, 15, 1.5 * clips.GB, 3 * DAY, 2, 3, 'https://clips.example.com']);
  assert.strictEqual(clips.settings({ CLIP_UPLOAD_CREDITS: '-4' }).credits, 0);
  assert.strictEqual(clips.settings({ CLIP_MAX_MB: 'abc' }).maxBytes, 8 * MB, 'nonsense falls back to the default');
  step('settings: the defaults are 5 GB for clips, 7 days, 8 MB, 30 seconds; the environment overrides them');

  // ---- the request ----
  const ok = clips.checkRequest(good, cfg, ['nazi']);
  assert.ok(ok.value && ok.value.posterType === 'image/jpeg' && ok.value.caption === 'hello there', JSON.stringify(ok));
  const bad = (patch, re) => { const r = clips.checkRequest({ ...good, ...patch }, cfg, ['nazi']); assert.ok(r.error && re.test(r.error), JSON.stringify([patch, r])); };
  bad({ size: 9 * MB }, /at most 8 MB/);
  bad({ size: 10 }, /Choose a video/);
  bad({ size: 'big' }, /Choose a video/);
  bad({ seconds: 31 }, /at most 30 seconds/);
  bad({ seconds: 0 }, /Choose a video/);
  bad({ posterSize: 0 }, /cover picture/);
  bad({ posterSize: 300_000 }, /cover picture/);
  bad({ posterType: 'image/gif' }, /JPEG, WebP or PNG/);
  bad({ width: 1080, height: 1920 }, /720p/);
  bad({ caption: 'x'.repeat(151) }, /at most 150/);
  bad({ caption: 'see www.example.com' }, /links/);
  bad({ caption: 'Nazi stuff' }, /not allowed/);
  assert.ok(clips.checkRequest(null, cfg).error && clips.checkRequest('x', cfg).error, 'garbage body refused');
  assert.strictEqual(clips.checkRequest({ ...good, caption: '  lots   of\n space  ' }, cfg).value.caption, 'lots of space');
  bad({ width: 1280, height: 720 }, /portrait/);
  bad({ width: 720, height: 720 }, /portrait/); // square is not portrait either
  bad({ width: undefined, height: undefined }, /size of the video is missing/);
  step('a request over the limits (size, length, size of the picture, 720p, portrait, caption) is refused before any link is handed out');

  // ---- the bytes ----
  assert.strictEqual(clips.sniffMp4(mp4(12.5)).seconds, 12.5);
  assert.strictEqual(clips.sniffMp4(mp4(30, { v1: true })).seconds, 30, 'version 1 header');
  assert.strictEqual(clips.sniffMp4(mp4(8, { brand: 'mp42' })).seconds, 8);
  assert.match(clips.sniffMp4(mp4(10, { faststart: false })).error, /fast start/, 'index after the video data');
  assert.match(clips.sniffMp4(mp4(10, { brand: 'qt  ' })).error, /not an MP4/, 'QuickTime brand');
  assert.match(clips.sniffMp4(Buffer.from('<html><script>alert(1)</script></html>'.padEnd(64, ' '))).error, /not an MP4/);
  assert.match(clips.sniffMp4(Buffer.alloc(200)).error, /not an MP4/);
  assert.match(clips.sniffMp4(null).error, /not an MP4/);
  assert.match(clips.sniffMp4(mp4(5).subarray(0, 40)).error, /fast start|not an MP4/, 'cut short');
  step('MP4 check: real header, index first, real length read from the file; HTML, other formats and cut files are refused');

  // ---- room ----
  const rec = (o) => ({ id: Math.random().toString(36).slice(2), owner: 'u1', state: 'live', size: 1000, posterSize: 100, createdAt: 1e12, liveAt: 1e12, expiresAt: 2e12, views: 0, likes: 0, ...o });
  const tiny = { ...cfg, limitBytes: 5000 };
  const set = [rec({}), rec({ state: 'pending' }), rec({ state: 'hidden' }), rec({ state: 'expired', purgedAt: 1 }), rec({ state: 'removed', purgedAt: 1 }), rec({ state: 'rejected', purgedAt: 1 })];
  assert.strictEqual(clips.usedBytes(set), 3300, 'live, pending and hidden hold their video and cover; expired, removed and rejected hold nothing');
  assert.ok(clips.hasRoom(set, 1700, tiny) && !clips.hasRoom(set, 1701, tiny), 'cap is exact');
  assert.ok(clips.hasRoom(set, 2800, tiny, set[1].id), 'a pending upload is not counted against itself');
  step('the clips cap counts what is really held: expired and removed clips free their room');

  // ---- per person ----
  const t = 1_700_000_000_000, mid = t - (t % DAY) + 3600_000;
  const mine = [rec({ createdAt: mid - 1800_000 }), rec({ createdAt: mid - DAY }), rec({ createdAt: mid - 10, state: 'rejected' }), rec({ owner: 'u2', createdAt: mid }), rec({ state: 'pending', createdAt: mid })];
  assert.strictEqual(clips.uploadsToday(mine, 'u1', mid), 3, 'counts every upload since UTC midnight (rejected ones too), not yesterday\'s, not other people\'s');
  assert.strictEqual(clips.pendingOf(mine, 'u1'), 1);
  step('daily upload count is per person and per UTC day');

  // ---- clean-up ----
  const now = 5_000_000_000_000;
  const old = rec({ state: 'live', expiresAt: now - 1 }), young = rec({ state: 'live', expiresAt: now + 1 });
  const hiddenOld = rec({ state: 'hidden', expiresAt: now - 5 });
  const stale = rec({ state: 'pending', createdAt: now - 16 * 60_000 }), fresh = rec({ state: 'pending', createdAt: now - 60_000 });
  const stuck = rec({ state: 'removed', key: 'clips/a.mp4', posterKey: 'posters/a' }), clean = rec({ state: 'removed', key: null, posterKey: null });
  const d = clips.due([old, young, hiddenOld, stale, fresh, stuck, clean], now, cfg);
  assert.deepStrictEqual([d.expire.length, d.abandoned.length, d.retry.length], [2, 1, 1]);
  assert.ok(d.expire.includes(old) && d.expire.includes(hiddenOld) && d.abandoned.includes(stale) && d.retry.includes(stuck));
  const kept = rec({ state: 'live', key: 'clips/k.mp4', posterKey: 'posters/k', views: 41, likes: 3, likedBy: ['a', 'b', 'c'], reportCount: 2, caption: 'cap', seconds: 12 });
  clips.purge(kept, 'expired', now);
  assert.deepStrictEqual([kept.state, kept.purgedAt, kept.key, kept.posterKey, kept.likedBy.length], ['expired', now, null, null, 0], 'bytes gone');
  assert.deepStrictEqual([kept.views, kept.likes, kept.reportCount, kept.caption, kept.seconds, kept.owner, kept.createdAt], [41, 3, 2, 'cap', 12, 'u1', 1e12], 'numbers kept');
  const o = clips.ownerView(kept);
  assert.deepStrictEqual([o.state, o.views, o.likes, o.reports, o.available, o.purgedAt], ['expired', 41, 3, 2, false, now]);
  assert.ok(!('key' in o) && !('likedBy' in o), 'the poster is not handed file names');
  step('expiry keeps the record and its numbers; only the file names and the list of who liked it go');

  // ---- likes and reports ----
  const c = rec({});
  assert.strictEqual(clips.toggleLike(c, 'a'), true); assert.strictEqual(clips.toggleLike(c, 'b'), true);
  assert.strictEqual(c.likes, 2); assert.strictEqual(clips.toggleLike(c, 'a'), false); assert.strictEqual(c.likes, 1);
  const users = { r1: { createdAt: 0 }, r2: { createdAt: 0 }, fresh: { createdAt: now } };
  const hide = { ...cfg, reportsToHide: 2 };
  clips.addReport(c, 'r1', 'spam', '', now);
  clips.addReport(c, 'r1', 'illegal', 'again', now); // same person: replaces
  assert.deepStrictEqual([c.reports.length, c.reportCount, c.reports[0].reason], [1, 2, 'illegal']);
  clips.addReport(c, 'fresh', 'spam', '', now);
  assert.ok(!clips.shouldHide(c, users, now, hide), 'a brand new account does not count toward hiding');
  clips.addReport(c, 'r2', 'spam', '', now);
  assert.ok(clips.shouldHide(c, users, now, hide), 'two established accounts hide it');
  c.state = 'hidden';
  assert.ok(!clips.shouldHide(c, users, now, hide), 'already hidden');
  step('likes toggle; reports from brand-new accounts do not count toward hiding; reportCount never goes down');

  // ---- the feed ----
  const pub = { ...cfg, publicUrl: 'https://clips.example.com' };
  const U = { u1: { username: 'ann', avatarImage: 'img1' }, u2: { username: 'bob' } };
  const f1 = rec({ id: 'f1', liveAt: 100, key: 'clips/1.mp4', posterKey: 'posters/1', views: 10, likes: 0, owner: 'u2' });
  const f2 = rec({ id: 'f2', liveAt: 300, key: 'clips/2.mp4', posterKey: 'posters/2', views: 1, likes: 3, likedBy: ['me', 'x', 'y'] });
  const f3 = rec({ id: 'f3', liveAt: 200, key: 'clips/3.mp4', posterKey: 'posters/3', views: 5, likes: 0 });
  const gone = [rec({ id: 'g1', state: 'hidden', liveAt: 400 }), rec({ id: 'g2', state: 'expired', purgedAt: 1, liveAt: 401 }), rec({ id: 'g3', expiresAt: 1, liveAt: 402 }), rec({ id: 'g4', owner: 'nobody', liveAt: 403 }), rec({ id: 'g5', state: 'pending', liveAt: 404 })];
  const all = [f1, f2, f3, ...gone];
  const ids = (a) => a.map((x) => x.id);
  const args = (o) => ({ uid: 'me', now: 1000, ...o });
  assert.deepStrictEqual(ids(clips.feed(all, U, args({}), pub)), ['f2', 'f3', 'f1'], 'newest first; hidden, expired, pending and unknown-owner clips are left out');
  assert.deepStrictEqual(ids(clips.feed(all, U, args({ before: 300 }), pub)), ['f3', 'f1'], 'paging by time');
  assert.deepStrictEqual(ids(clips.feed(all, U, args({ limit: 1 }), pub)), ['f2']);
  assert.deepStrictEqual(ids(clips.feed(all, U, args({ sort: 'top' }), pub)), ['f2', 'f1', 'f3'], 'top: likes count five times a view');
  assert.deepStrictEqual(ids(clips.feed(all, U, args({ sort: 'top', offset: 1 }), pub)), ['f1', 'f3']);
  const many = Array.from({ length: 40 }, (_, i) => rec({ id: 'm' + i, liveAt: i }));
  assert.strictEqual(clips.feed(many, U, args({ limit: 500 }), pub).length, 20, 'a page is at most 20');
  const v = clips.feed(all, U, args({}), pub)[0];
  assert.deepStrictEqual([v.url, v.poster, v.owner.username, v.owner.avatarImage, v.liked, v.mine, v.likes], ['https://clips.example.com/clips/2.mp4', 'https://clips.example.com/posters/2', 'ann', 'img1', true, false, 3]);
  assert.ok(!('reports' in v) && !('likedBy' in v) && !('key' in v) && !('credits' in v), 'viewers see no reports, no list of likers, no internals');
  step('feed: only live clips, newest or top, 20 a page, nothing private in what viewers get');

  console.log('\nAll clip logic tests passed.');
}
