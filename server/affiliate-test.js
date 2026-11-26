// The affiliate program's rules, without a database: node server/affiliate-test.js
const assert = require('assert');
const A = require('./affiliate');
const C = require('./credits');

const DAY = 86_400_000, T0 = Date.UTC(2026, 10, 26, 12, 0, 0);
const step = (m) => console.log('ok -', m);
const yt = (id) => `https://www.youtube.com/watch?v=${id}`;

// ---- what a video pays ----
{
  assert.deepStrictEqual([10, 29, 30, 90, 91, 300, 301, 3600].map(A.baseFor), [20, 20, 50, 50, 100, 100, 150, 150]);
  assert.strictEqual(A.payoutFor(45, 'standard'), 50);
  assert.strictEqual(A.payoutFor(45, 'mention'), 25);
  assert.strictEqual(A.payoutFor(120, 'showcase'), 150);
  assert.strictEqual(A.payoutFor(120, 'tutorial'), 200);
  assert.strictEqual(A.payoutFor(600, 'tutorial'), 300);
  assert.strictEqual(A.payoutFor(10, 'mention'), 10);
  assert.strictEqual(A.payoutFor(120, 'nonsense'), 0);
  assert.strictEqual(A.payoutFor(0, 'standard'), 0);
  step('credits are the base for the length times what the video says');
}

// ---- links belong to the app whose button was pressed ----
{
  const ok = (p, u, key) => { const r = A.checkLink(p, u); assert.ok(r.ok, p + ' ' + u + ' -> ' + JSON.stringify(r)); if (key) assert.strictEqual(r.key, key); return r; };
  const no = (p, u) => assert.ok(A.checkLink(p, u).error, p + ' ' + u + ' should be refused');
  ok('youtube', yt('dQw4w9WgXcQ'), 'yt:dQw4w9WgXcQ');
  ok('youtube', 'https://youtu.be/dQw4w9WgXcQ?si=abc', 'yt:dQw4w9WgXcQ');
  ok('youtube', 'm.youtube.com/shorts/dQw4w9WgXcQ', 'yt:dQw4w9WgXcQ');
  ok('tiktok', 'https://www.tiktok.com/@ada.cat/video/7300000000000000001?is_from_webapp=1', 'tt:7300000000000000001');
  ok('tiktok', 'https://vm.tiktok.com/ZMabc123/', 'tt:ZMabc123');
  ok('instagram', 'https://www.instagram.com/reel/C1a2B3c4D5e/', 'ig:C1a2B3c4D5e');
  ok('instagram', 'https://instagram.com/ada/p/C1a2B3c4D5e/?utm_source=x', 'ig:C1a2B3c4D5e');
  ok('twitch', 'https://www.twitch.tv/videos/1234567890', 'tw:v1234567890');
  ok('twitch', 'https://clips.twitch.tv/FunnyClipSlug-abc123', 'tw:FunnyClipSlug-abc123');
  ok('x', 'https://x.com/ada/status/1700000000000000000', 'x:1700000000000000000');
  ok('facebook', 'https://fb.watch/abc123xyz/', 'fb:abc123xyz');
  ok('facebook', 'https://www.facebook.com/watch/?v=123456789012', 'fb:123456789012');
  ok('snapchat', 'https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYc2h5', 'sc:W7_EDlXWTBiXAEEniNoMPwAAYc2h5');
  ok('kick', 'https://kick.com/ada/clips/clip_01HABCDEFGHJKMNPQRST', 'ki:clip_01HABCDEFGHJKMNPQRST');

  assert.strictEqual(ok('youtube', yt('dQw4w9WgXcQ') + '&utm_source=x&list=PL1#t=5').url, yt('dQw4w9WgXcQ'), 'tracking and the # part are dropped');
  assert.strictEqual(ok('tiktok', 'http://tiktok.com/@a/video/12345678?x=1').url, 'https://tiktok.com/@a/video/12345678');

  no('tiktok', yt('dQw4w9WgXcQ')); // the wrong app's link
  no('youtube', 'https://www.tiktok.com/@ada/video/7300000000000000001');
  no('youtube', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'); // the real name is only the start of the host
  no('youtube', 'https://evilyoutube.com/watch?v=dQw4w9WgXcQ');
  no('youtube', 'https://youtube.com@evil.example/watch?v=dQw4w9WgXcQ');
  no('youtube', 'https://user:pw@youtube.com/watch?v=dQw4w9WgXcQ');
  no('youtube', 'https://youtube.com:8443/watch?v=dQw4w9WgXcQ');
  no('youtube', 'javascript:alert(1)');
  no('youtube', 'ftp://youtube.com/watch?v=dQw4w9WgXcQ');
  no('youtube', 'https://www.youtube.com/@ada'); // a channel, not a video
  no('youtube', 'https://www.youtube.com/');
  no('instagram', 'https://www.instagram.com/ada/'); // a profile
  no('x', 'https://x.com/ada');
  no('youtube', '');
  no('youtube', 'x'.repeat(400));
  no('myspace', yt('dQw4w9WgXcQ')); // not a button
  step('a link must be a video on the app that was picked, and is cleaned up');
}

// ---- names for links ----
{
  assert.strictEqual(A.cleanSlug('  Ada-Cat  ').slug, 'ada-cat');
  for (const bad of ['', 'ab', 'a'.repeat(25), '-ada', 'ada-', 'a--b', 'ada cat', 'ada_cat', 'ada/cat', 'ada.cat', 'admin', 'API', 'Payments', 'aduna', 'clips']) assert.ok(A.cleanSlug(bad).error, JSON.stringify(bad));
  assert.ok(A.cleanSlug('adacat1').ok && A.cleanSlug('123').ok);
  step('link names are short lowercase words, and real pages are not available');
}

// ---- sending ----
const send = (rec, uid, over, records, at = T0) => A.submit(rec, uid, { platform: 'youtube', url: yt('dQw4w9WgXcQ'), seconds: 60, slug: 'ada-cat', ...over }, records, at);
{
  let r = send(null, 'u1', {}, []);
  assert.ok(r.ok);
  assert.deepStrictEqual([r.rec.status, r.rec.slug, r.rec.videos.length, r.video.status], ['pending', 'ada-cat', 1, 'pending']);
  const ada = r.rec;

  assert.strictEqual(send(null, 'u2', { slug: 'Ada-Cat' }, [ada]).status, 409, 'a name is taken whatever its case');
  assert.strictEqual(send(null, 'u2', {}, [ada]).status, 409, 'the same name, and the same video');
  assert.strictEqual(send(null, 'u2', { slug: 'bob' }, [ada]).status, 409, 'the same video cannot be sent twice');
  assert.ok(send(null, 'u2', { slug: 'bob', url: yt('aaaaaaaaaaa') }, [ada]).ok);
  assert.strictEqual(send(null, 'u1', { slug: 'x' }, []).status, 400, 'a name too short');
  for (const bad of [0, -5, 1.5, '60', null, 3 * 3600 + 1]) assert.strictEqual(send(null, 'u3', { seconds: bad, slug: 'cara' }, []).status, 400, 'length ' + bad);
  assert.strictEqual(send(null, 'u3', { platform: 'tiktok', slug: 'cara' }, []).status, 400, 'a YouTube link on the TikTok button');
  assert.strictEqual(ada.videos.length, 1, 'a refused video changes nothing');

  // limits: 3 waiting at once, 3 a month
  const two = send(ada, 'u1', { url: yt('bbbbbbbbbbb') }, [ada]); assert.ok(two.ok);
  const three = send(ada, 'u1', { url: yt('ccccccccccc') }, [ada]); assert.ok(three.ok);
  assert.strictEqual(send(ada, 'u1', { url: yt('ddddddddddd') }, [ada]).status, 429, 'three waiting is the most');

  // taking one back frees a place
  assert.ok(A.withdraw(ada, two.video.id).ok);
  assert.strictEqual(A.withdraw(ada, two.video.id).status, 404);
  assert.ok(send(ada, 'u1', { url: yt('ddddddddddd') }, [ada]).ok);
  assert.strictEqual(send(ada, 'u1', { url: yt('eeeeeeeeeee') }, [ada]).status, 429);
  step('sending is checked and limited, and a refused video changes nothing');
}

// ---- reviewing and paying ----
{
  const mk = () => send(null, 'u1', { seconds: 120 }, []).rec;
  let ada = mk();
  const vid = ada.videos[0].id;
  assert.strictEqual(A.review(ada, vid, 'u1', { action: 'approve', quality: 'standard' }, T0).status, 403, 'nobody reviews their own');
assert.strictEqual(A.review(ada, vid, 'u1', { action: 'maybe' }, T0, { allowOwn: true }).status, 400, 'allowOwn gets past the own-video check');
  assert.strictEqual(A.review(ada, vid, 'm1', { action: 'reject' }, T0).status, 400, 'a rejection needs a reason');
  assert.strictEqual(A.review(ada, vid, 'm1', { action: 'approve' }, T0).status, 400, 'an approval needs what the video says');
  assert.strictEqual(A.review(ada, vid, 'm1', { action: 'approve', quality: 'huge' }, T0).status, 400);
  assert.strictEqual(A.review(ada, vid, 'm1', { action: 'maybe' }, T0).status, 400);
  assert.strictEqual(A.review(ada, 'nope', 'm1', { action: 'approve', quality: 'standard' }, T0).status, 404);
  assert.strictEqual(ada.status, 'pending');

  let r = A.review(ada, vid, 'm1', { action: 'reject', note: 'Please show the link.' }, T0 + DAY);
  assert.ok(r.ok && r.credits === 0);
  assert.deepStrictEqual([ada.status, ada.earned, ada.videos[0].status], ['pending', 0, 'rejected'], 'a rejection does not make an affiliate');
  assert.strictEqual(A.review(ada, vid, 'm1', { action: 'approve', quality: 'standard' }, T0).status, 409, 'a video is reviewed once');

  // sending the rejected video again replaces its line; the reviewer's length can differ from what was typed
  const again = send(ada, 'u1', { seconds: 100 }, [ada], T0 + 2 * DAY);
  assert.ok(again.ok); assert.strictEqual(again.rec.videos.length, 1);
  r = A.review(ada, again.video.id, 'm1', { action: 'approve', quality: 'showcase', seconds: 100, note: 'Nice.' }, T0 + 3 * DAY);
  assert.deepStrictEqual([r.ok, r.credits, r.becameAffiliate], [true, 150, true]);
  assert.deepStrictEqual([ada.status, ada.earned, ada.approvedAt, A.tierOf(ada)], ['approved', 150, T0 + 3 * DAY, 'affiliate']);
  assert.strictEqual(A.review(ada, again.video.id, 'm1', { action: 'reject', note: 'x' }, T0).status, 409);

  const next = send(ada, 'u1', { url: yt('bbbbbbbbbbb'), slug: 'changed', seconds: 400 }, [ada], T0 + 4 * DAY);
  assert.strictEqual(ada.slug, 'ada-cat', 'the name is fixed once they are an affiliate');
  r = A.review(ada, next.video.id, 'm1', { action: 'approve', quality: 'tutorial' }, T0 + 5 * DAY);
  assert.deepStrictEqual([r.credits, r.becameAffiliate, ada.earned], [300, false, 450]);

  const fakeLength = send(ada, 'u1', { url: yt('ccccccccccc'), seconds: 5 }, [ada], T0 + 6 * DAY);
  r = A.review(ada, fakeLength.video.id, 'm1', { action: 'approve', quality: 'standard', seconds: 700 }, T0 + 6 * DAY);
  assert.strictEqual(r.credits, 150, 'the reviewer length counts, not the typed one');

  const v = A.view(ada);
  assert.deepStrictEqual([v.status, v.slug, v.tier, v.earned, v.videos.length], ['approved', 'ada-cat', 'silver', 600, 3]);
  assert.ok(v.videos.every((x) => !('reviewedBy' in x) && !('key' in x)), 'the person does not see who reviewed or the internal key');

  A.revoke(ada);
  assert.strictEqual(A.tierOf(ada), null);
  assert.strictEqual(send(ada, 'u1', { url: yt('zzzzzzzzzzz') }, [ada], T0 + 7 * DAY).status, 403);
  step('approving pays by length and quality, the first approval makes an affiliate, and rejecting pays nothing');
}

// ---- tiers and the ledger ----
{
  const rec = { status: 'approved', videos: [] };
  const n = (k) => { rec.videos = Array.from({ length: k }, () => ({ status: 'approved' })); return A.tierOf(rec); };
  assert.deepStrictEqual([n(0), n(1), n(2), n(3), n(9), n(10), n(30)], [null, 'affiliate', 'affiliate', 'silver', 'silver', 'gold', 'gold']);
  const u = { id: 'u1', createdAt: T0 };
  assert.strictEqual(C.grant(u, 150, 'affiliate', { note: 'Video review', now: T0 }), 150);
  assert.deepStrictEqual([u.credits.ledger[0].reason, u.credits.ledger[0].amount], ['affiliate', 150]);
  step('tiers follow approved videos, and credits go to the normal ledger');
}

console.log('affiliate: all good');
