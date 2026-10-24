// Credits rules, quests and Stripe handling, without a database: node server/credits-logic-test.js
const assert = require('assert');
const crypto = require('crypto');
const C = require('./credits');

const MIN = 60_000, T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const user = (id = 'u1', extra = {}) => ({ id, createdAt: T0 - 24 * 60 * MIN, bio: '', ...extra });
const server = { id: 's1', members: ['u1', 'u2', 'u3'] };
const chan = { id: 'c1', type: 'text' };
const good = (n) => ({ t: n + 5, p: 0, ms: n * 150, ev: n, j: 60 }); // a plausible typing proof for n chars
const MSG = 'I finally got around to fixing the garden fence yesterday';
const step = (m) => console.log('✓', m);
const fresh = () => { C._reset(); };

// ---- balance ----
{
  const u = user();
  assert.strictEqual(C.acct(u).balance, 0);
  assert.strictEqual(C.grant(u, 50, 'quest', { now: T0 }), 50);
  assert.strictEqual(C.spend(u, 80, 'x'), false, 'cannot overspend');
  assert.strictEqual(u.credits.balance, 50, 'a refused spend changes nothing');
  assert.strictEqual(C.spend(u, 20, 'x', { now: T0 }), true);
  assert.strictEqual(u.credits.balance, 30);
  assert.throws(() => C.grant(u, -5, 'x'), /positive/);
  assert.throws(() => C.grant(u, 1.5, 'x'), /positive/);
  assert.throws(() => C.spend(u, 0, 'x'), /positive/);
  C.claw(u, 100, 'refund', { now: T0 });
  assert.strictEqual(u.credits.balance, -70, 'a refund can push the balance below zero');
  assert.strictEqual(C.spend(u, 1, 'x'), false, 'and then nothing can be spent');
  step('grant / spend / claw, no overspending, only whole positive amounts');
}

// ---- what counts as a real message ----
{
  assert.strictEqual(C.quality(C.normalize(MSG)), null);
  assert.strictEqual(C.quality(C.normalize('lol')), 'short');
  assert.strictEqual(C.quality(C.normalize('ok ok ok ok ok ok ok ok ok ok ok ok')), 'repetitive');
  assert.strictEqual(C.quality(C.normalize('aaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbb cccc dddd')), 'repetitive');
  assert.strictEqual(C.quality(C.normalize('asdkjhfgs qwrtpzxcv bnmkhgfd lkjhgfdsa')), 'gibberish', 'keyboard mashing');
  assert.strictEqual(C.quality(C.normalize('<:party:0123456789abcdef> <@0123456789abcdef> https://example.com/aaaaaaaaaaaaaaaa')), 'short', 'emoji, mentions and links do not count as words');
  assert.strictEqual(C.quality(C.normalize('😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀')), 'short', 'emoji only');
  assert.strictEqual(C.quality(C.normalize('今日は友達と一緒に新しいカフェに行きました')), null, 'Japanese works without spaces');
  assert.strictEqual(C.quality(C.normalize('Das Wetter war gestern wirklich wunderschön hier')), null);
  assert.ok(C.similar(C.normalize(MSG), C.normalize(MSG.toUpperCase() + '!!!')), 'case / punctuation changes are not a new message');
  assert.ok(C.similar(C.normalize(MSG), C.normalize('I finally got around to fixing the garden fence yesterday, finally')), 'a small tweak is not a new message');
  assert.ok(!C.similar(C.normalize(MSG), C.normalize('Does anyone know a good recipe for lemon cake with poppy seeds')));
  step('quality: short, repeated, mashed, emoji-only and link-only text is rejected; CJK and accents are fine');
}

// ---- typing proof ----
{
  const n = 40;
  assert.strictEqual(C.typingProblem(good(n), n), null);
  assert.strictEqual(C.typingProblem(undefined, n), 'no typing proof');
  assert.strictEqual(C.typingProblem({ ...good(n), p: 30 }, n), 'pasted');
  assert.strictEqual(C.typingProblem({ ...good(n), t: 5 }, n), 'not typed');
  assert.strictEqual(C.typingProblem({ ...good(n), ms: 300 }, n), 'too fast');
  assert.strictEqual(C.typingProblem({ ...good(n), j: 1 }, n), 'robotic', 'perfectly even key gaps');
  assert.strictEqual(C.typingProblem({ ...good(n), ev: 5, j: 0 }, n), null, 'few events: no spread check');
  assert.strictEqual(C.typingProblem({ ...good(n), t: NaN }, n), 'bad typing proof');
  assert.strictEqual(C.typingProblem({ ...good(n), ms: -1 }, n), 'bad typing proof');
  step('typing proof: paste, too fast, too little typed, robotic rhythm and junk values rejected');
}

// ---- rewardMessage ----
{
  fresh();
  const u = user(), other = user('u2');
  const send = (content, at, over = {}) => C.rewardMessage({ user: u, content, proof: good(C.normalize(content).length), server, channel: chan, now: at, ...over });
  C.noteChannelMessage(chan.id, 'u2', T0 - MIN);

  let r = send(MSG, T0);
  assert.deepStrictEqual([r.ok, r.amount, u.credits.balance], [true, 2, 2], 'a real message pays');

  r = send('Honestly the tomato plants are doing better than I expected this year', T0 + 10_000);
  assert.deepStrictEqual([r.ok, r.reason], [false, 'cooldown'], 'one rewarded message per 45 s');

  r = send(MSG, T0 + 2 * MIN);
  assert.deepStrictEqual([r.ok, r.reason], [false, 'repeat'], 'the same message again pays nothing');
  r = send(MSG.replace('fence', 'gate'), T0 + 3 * MIN);
  assert.deepStrictEqual([r.ok, r.reason], [false, 'repeat'], 'a near copy pays nothing');

  r = send('Honestly the tomato plants are doing better than I expected this year', T0 + 4 * MIN);
  assert.deepStrictEqual([r.ok, r.reason], [false, 'repeat'], 'a message that was already seen (even if the cooldown blocked it) is remembered');
  r = send('Does anyone know a good recipe for lemon cake with poppy seeds', T0 + 5 * MIN);
  assert.strictEqual(r.ok, true, 'a genuinely different message pays once the cooldown is over');
  step('pays once per cooldown; repeats and near-copies never pay');
}
{
  fresh();
  const u = user();
  C.noteChannelMessage(chan.id, 'u2', T0 - MIN);
  const texts = ['Planning a long weekend trip to the mountains with some friends', 'Remember to bring warm jackets because evenings get really cold up there', 'My neighbour baked an enormous pile of cinnamon rolls this morning', 'Learning to play the cello is harder than anybody warned me about', 'We should organise a proper picnic before the weather turns rainy', 'A completely different message about cooking pasta tonight for dinner', 'Another totally separate sentence regarding old railway timetables today', 'Finally someone fixed the broken streetlight outside the bakery'];
  let k = 0;
  const go = (over = {}) => { const text = texts[k++]; return C.rewardMessage({ user: u, server, channel: chan, now: T0, content: text, proof: good(C.normalize(text).length), ...over }); };

  assert.strictEqual(go({ channel: { id: 'c9', type: 'voice' } }).reason, 'channel type');
  assert.strictEqual(go({ channel: { id: 'c9', type: 'announcements' } }).reason, 'channel type');
  assert.strictEqual(go({ server: { id: 's', members: ['u1', 'u2'] } }).reason, 'small server');
  assert.strictEqual(go({ user: user('u1', { createdAt: T0 - 5 * MIN }) }).reason, 'new account');
  assert.strictEqual(go({ proof: undefined }).reason, 'no typing proof');
  assert.strictEqual(go({ proof: { ...good(40), p: 12 } }).reason, 'pasted');
  assert.strictEqual(go({ channel: { id: 'quiet', type: 'text' } }).reason, 'nobody to talk to', 'talking to yourself pays nothing');
  { const r = go(); assert.strictEqual(r.ok, true, 'and with everything in order the same account does get paid: ' + r.reason); }
  step('no pay in voice/announcement channels, tiny servers, brand-new accounts, without typing proof, pasted, or in an empty channel');
}
{
  fresh();
  const a = user('u1'), b = user('u2'), text = 'Does anyone want to join the hiking trip next Saturday morning';
  C.noteChannelMessage(chan.id, 'u3', T0 - MIN);
  const n = C.normalize(text).length;
  assert.strictEqual(C.rewardMessage({ user: a, content: text, proof: good(n), server, channel: chan, now: T0 }).ok, true);
  assert.strictEqual(C.rewardMessage({ user: b, content: text, proof: good(n), server, channel: chan, now: T0 + 5 * MIN }).reason, 'copied', 'another account pasting the same text gets nothing');
  assert.strictEqual(C.rewardMessage({ user: b, content: text, proof: good(n), server, channel: chan, now: T0 + 90 * MIN }).reason, 'repeat', 'and it never pays later either');
  step('the same text sent by a second account is treated as copied');
}
{
  fresh();
  const u = user(); C.noteChannelMessage(chan.id, 'u2', T0);
  // 24 sentences that share no words: pronounceable made-up words (consonant+vowel syllables)
  const syl = [...'bdgklmnp'].flatMap((c) => [...'aeiou'].map((v) => c + v));
  const word = (n) => syl[n % 40] + syl[Math.floor(n / 40) % 40] + syl[(n * 13 + 5) % 40];
  const sentence = (i) => [0, 1, 2, 3, 4].map((j) => word(i * 5 + j + 1)).join(' ');
  let paid = 0, at = T0;
  for (let i = 0; i < 24; i++) {
    at += 50_000;
    const text = sentence(i);
    const r = C.rewardMessage({ user: u, content: text, proof: good(C.normalize(text).length), server, channel: chan, now: at });
    if (r.ok) paid++; else assert.strictEqual(r.reason, 'daily cap');
  }
  assert.strictEqual(paid, 20, 'daily cap of 40 credits = 20 messages');
  assert.strictEqual(u.credits.today.msg, 40);
  const next = sentence(24);
  C.noteChannelMessage(chan.id, 'u2', at + 24 * 60 * MIN - MIN);
  assert.strictEqual(C.rewardMessage({ user: u, content: next, proof: good(C.normalize(next).length), server, channel: chan, now: at + 24 * 60 * MIN }).ok, true, 'the cap resets the next UTC day');
  assert.strictEqual(u.credits.ledger.filter((l) => l.reason === 'message').length <= 2, true, 'message rewards collapse into one ledger line per day');
  step('daily cap holds at 40 credits and resets at midnight UTC; ledger stays compact');
}

// ---- reactions + quests ----
{
  fresh();
  const u = user(), db = { users: { u1: u }, servers: { s1: { ...server, ownerId: 'u2' } }, emojis: {}, friendships: {}, payments: {} };
  assert.strictEqual(C.noteReaction(u, 'm1', 'u1', T0), false, 'own messages do not count');
  assert.strictEqual(C.noteReaction(u, 'm1', 'u2', T0), true);
  assert.strictEqual(C.noteReaction(u, 'm1', 'u2', T0), false, 'the same message twice does not count');
  const q = (id) => C.questList(u, db, T0).find((x) => x.id === id);
  assert.deepStrictEqual([q('react').have, q('react').done], [1, false]);
  assert.strictEqual(C.claimQuest(u, 'react', db, T0).status, 400, 'cannot claim an unfinished quest');
  C.noteReaction(u, 'm2', 'u2', T0); C.noteReaction(u, 'm3', 'u3', T0);
  assert.strictEqual(q('react').done, true);
  let r = C.claimQuest(u, 'react', db, T0);
  assert.deepStrictEqual([r.ok, r.amount], [true, 6]);
  assert.strictEqual(C.claimQuest(u, 'react', db, T0).status, 409, 'no double claim');
  assert.strictEqual(C.claimQuest(u, 'react', db, T0 + 24 * 60 * MIN).status, 400, 'next day it starts over');
  assert.strictEqual(C.claimQuest(u, 'nope', db, T0).status, 404);

  // one-time quests read real state
  assert.strictEqual(q('avatar').done, false); u.avatarImage = 'img1';
  assert.strictEqual(C.claimQuest(u, 'avatar', db, T0).amount, 20);
  assert.strictEqual(C.claimQuest(u, 'avatar', db, T0 + 48 * 60 * MIN).status, 409, 'one-time quests stay claimed');
  u.bio = 'short'; assert.strictEqual(q('bio').done, false); u.bio = 'I like long walks and short emails';
  assert.strictEqual(C.claimQuest(u, 'bio', db, T0).amount, 10);
  assert.strictEqual(q('join').have, 1); db.servers.s2 = { id: 's2', ownerId: 'u1', members: ['u1'] };
  assert.strictEqual(C.claimQuest(u, 'join', db, T0).amount, 15);
  assert.strictEqual(C.claimQuest(u, 'server', db, T0).amount, 25, 'owning a server finishes "start your own server"');
  assert.strictEqual(q('friend').done, false); db.friendships['u1:u2'] = { status: 'pending' };
  assert.strictEqual(q('friend').done, false, 'a pending request is not a friend'); db.friendships['u1:u2'].status = 'friends';
  assert.strictEqual(C.claimQuest(u, 'friend', db, T0).amount, 20);
  db.emojis.e1 = { ownerId: 'u1', disabled: true }; assert.strictEqual(q('emoji').done, false, 'a disabled emoji does not count');
  db.emojis.e1.disabled = false; assert.strictEqual(C.claimQuest(u, 'emoji', db, T0).amount, 20);
  const fresh2 = user('u9', { createdAt: T0 - 5 * MIN }); fresh2.avatarImage = 'x';
  const rr = C.claimQuest(fresh2, 'avatar', db, T0);
  assert.strictEqual(rr.status, 403, 'brand-new accounts cannot claim yet'); assert.ok(rr.unlocksAt > T0);
  step('quests: progress comes from real state, no double claims, daily reset, new-account lock');
}

// ---- check-in streak ----
{
  const u = user(), db = { users: {}, servers: {}, emojis: {}, friendships: {}, payments: {} };
  const DAY = 24 * 60 * MIN;
  const got = [];
  for (const d of [0, 1, 2, 3]) got.push(C.claimQuest(u, 'checkin', db, T0 + d * DAY).amount);
  assert.deepStrictEqual(got, [10, 12, 24, 16], 'each consecutive day adds 2, and day 3 pays the +10 milestone');
  assert.strictEqual(C.claimQuest(u, 'checkin', db, T0 + 3 * DAY).status, 409);
  assert.strictEqual(C.claimQuest(u, 'checkin', db, T0 + 6 * DAY).amount, 10, 'a missed day resets the streak');
  const u2 = user(); const amounts = []; for (let d = 0; d < 9; d++) amounts.push(C.claimQuest(u2, 'checkin', db, T0 + d * DAY).amount);
  assert.deepStrictEqual(amounts, [10, 12, 24, 16, 18, 20, 50, 20, 20], 'daily bonus tops out at +10; day 3 pays +10 and day 7 pays +30 extra');
  step('check-in streak: +2 per consecutive day up to +10, milestone bonuses, resets after a missed day');
}

// ---- streak milestones and what the page shows ----
{
  const u = user(), db = { users: {}, servers: {}, emojis: {}, friendships: {}, payments: {} };
  const DAY = 24 * 60 * MIN;
  let r;
  for (let d = 0; d < 7; d++) r = C.claimQuest(u, 'checkin', db, T0 + d * DAY);
  assert.strictEqual(r.milestone, 30, 'the 7th day reports its milestone');
  assert.strictEqual(r.streak, 7);
  const info = C.streakView(C.acct(u), T0 + 6 * DAY);
  assert.strictEqual(info.current, 7); assert.strictEqual(info.best, 7); assert.strictEqual(info.checkedInToday, true);
  assert.deepStrictEqual(info.next, { days: 14, bonus: 60, left: 7 }, 'the next milestone is shown');
  assert.strictEqual(info.milestones.filter((m) => m.reached).length, 2, '3 and 7 days are reached');
  const tomorrow = C.streakView(C.acct(u), T0 + 7 * DAY);
  assert.strictEqual(tomorrow.atRisk, true, 'checked in yesterday but not today: the streak is at risk');
  assert.strictEqual(C.questList(u, db, T0 + 7 * DAY).find((q) => q.id === 'checkin').reward, 10 + 10, "tomorrow's check-in preview includes the streak bonus");
  const gone = C.streakView(C.acct(u), T0 + 9 * DAY);
  assert.strictEqual(gone.current, 0, 'two missed days end the streak'); assert.strictEqual(gone.best, 7, 'but the best run is remembered');
  step('streak milestones: reported on claim, next one previewed, best run kept');
}

// ---- Stripe signature ----
const SECRET = 'whsec_test';
const sign = (body, t, secret = SECRET) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
{
  const body = Buffer.from('{"id":"evt_1"}'), now = 1_800_000_000;
  assert.strictEqual(C.verifyStripeSignature(body, sign(body, now), SECRET, now), true);
  assert.strictEqual(C.verifyStripeSignature(body, sign(body, now, 'other'), SECRET, now), false, 'wrong secret');
  assert.strictEqual(C.verifyStripeSignature(Buffer.from('{"id":"evt_2"}'), sign(body, now), SECRET, now), false, 'changed body');
  assert.strictEqual(C.verifyStripeSignature(body, sign(body, now - 3600), SECRET, now), false, 'old timestamp (replay)');
  assert.strictEqual(C.verifyStripeSignature(body, undefined, SECRET, now), false);
  assert.strictEqual(C.verifyStripeSignature(body, 't=abc,v1=zz', SECRET, now), false);
  assert.strictEqual(C.verifyStripeSignature(body, sign(body, now), '', now), false, 'no secret configured');
  assert.strictEqual(C.verifyStripeSignature(body.toString(), sign(body, now), SECRET, now), false, 'must be the raw bytes');
  assert.strictEqual(C.verifyStripeSignature(body, `v1=bad,${sign(body, now)}`, SECRET, now), true, 'any matching v1 is enough');
  step('Stripe signature: good one accepted; wrong secret, edited body, replay and missing header refused');
}

// ---- Stripe events ----
{
  const u = user('u1'), db = { users: { u1: u }, payments: {} };
  const session = (over = {}) => ({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 999, currency: 'usd', payment_intent: 'pi_1', metadata: { userId: 'u1', packId: 'p1200' }, ...over } } });
  assert.strictEqual(C.handleStripeEvent(session({ payment_status: 'unpaid' }), db, T0), null, 'unpaid sessions pay nothing yet');
  assert.strictEqual(C.handleStripeEvent(session({ amount_total: 100 }), db, T0), null, 'wrong amount: nothing credited');
  assert.strictEqual(C.handleStripeEvent(session({ currency: 'eur' }), db, T0), null, 'wrong currency: nothing credited');
  assert.strictEqual(C.handleStripeEvent(session({ metadata: { userId: 'u1', packId: 'p999999' } }), db, T0), null, 'unknown pack');
  assert.strictEqual(C.handleStripeEvent(session({ metadata: { userId: 'ghost', packId: 'p1200' } }), db, T0), null, 'unknown user');
  assert.strictEqual(u.credits, undefined, 'none of those touched the balance');

  const r = C.handleStripeEvent(session(), db, T0);
  assert.deepStrictEqual(r, { uid: 'u1', delta: 1200, reason: 'purchase' });
  assert.strictEqual(u.credits.balance, 1200); assert.strictEqual(u.credits.bought, 1200);
  assert.strictEqual(C.handleStripeEvent(session(), db, T0 + 1000), null, 'Stripe retry: credited once');
  assert.strictEqual(u.credits.balance, 1200);
  assert.ok(db.payments.cs_1, 'payment recorded');

  const async = { ...session({ id: 'cs_2', payment_intent: 'pi_2', payment_status: 'paid' }), type: 'checkout.session.async_payment_succeeded' };
  assert.strictEqual(C.handleStripeEvent(async, db, T0).delta, 1200); assert.strictEqual(u.credits.balance, 2400);

  const partial = { type: 'charge.refunded', data: { object: { refunded: false, payment_intent: 'pi_1' } } };
  assert.strictEqual(C.handleStripeEvent(partial, db, T0), null, 'partial refunds are ignored');
  C.spend(u, 2000, 'x', { now: T0 });
  const refund = { type: 'charge.refunded', data: { object: { refunded: true, payment_intent: 'pi_1' } } };
  assert.deepStrictEqual(C.handleStripeEvent(refund, db, T0), { uid: 'u1', delta: -1200, reason: 'refund' });
  assert.strictEqual(u.credits.balance, 400 - 1200, 'refund takes the credits back even if spent');
  assert.strictEqual(C.handleStripeEvent(refund, db, T0), null, 'refund applied once');
  const dispute = { type: 'charge.dispute.created', data: { object: { payment_intent: 'pi_2' } } };
  assert.strictEqual(C.handleStripeEvent(dispute, db, T0).delta, -1200);
  assert.strictEqual(C.handleStripeEvent({ type: 'customer.created', data: { object: {} } }, db, T0), null);
  step('Stripe events: paid once per session, amount/currency/pack checked, async payments, refunds and chargebacks reverse once');
}

// ---- routes, with a tiny fake app ----
(async () => {
  const routes = {};
  const app = { get: (p, ...h) => (routes['GET ' + p] = h), post: (p, ...h) => (routes['POST ' + p] = h) };
  const u = user('u1'), db = { users: { u1: u }, servers: {}, emojis: {}, friendships: {}, payments: {} };
  const pushed = []; let saved = 0; const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ url: 'https://checkout.stripe.test/c/pay_1' }) }; };
  C.register(app, { auth: (req, _res, next) => { req.user = u; next(); }, ah: (fn) => fn, db: () => db, save: () => saved++, notify: (id, p) => pushed.push([id, p]), fetchImpl: fakeFetch });
  const run = async (key, req) => { let out = { status: 200 }; const res = { status: (s) => { out.status = s; return res; }, json: (b) => { out.body = b; return res; } }; const h = routes[key]; await h[h.length - 1]({ headers: {}, params: {}, body: {}, get: () => 'aduna.test', protocol: 'https', ...req, user: u }, res); return out; };

  delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET;
  assert.strictEqual((await run('GET /api/credits', {})).body.purchases, false, 'purchases are off without Stripe keys');
  assert.strictEqual((await run('POST /api/credits/checkout', { body: { packId: 'p500' } })).status, 503);
  assert.strictEqual(calls.length, 0, 'no Stripe call without keys');

  process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  assert.strictEqual((await run('GET /api/credits', {})).body.purchases, true);
  assert.strictEqual((await run('POST /api/credits/checkout', { body: { packId: 'bogus' } })).status, 400);
  assert.strictEqual((await run('POST /api/credits/checkout', { body: { packId: 'p500', cents: 1 } })).body.url, 'https://checkout.stripe.test/c/pay_1');
  const sent = new URLSearchParams(calls[0].init.body);
  assert.strictEqual(sent.get('line_items[0][price_data][unit_amount]'), '499', 'price comes from the server pack, never from the request');
  assert.strictEqual(sent.get('metadata[userId]'), 'u1'); assert.strictEqual(sent.get('metadata[packId]'), 'p500');
  assert.strictEqual(sent.get('success_url'), 'https://aduna.test/app?credits=paid');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer sk_test_x');
  assert.strictEqual(sent.get('managed_payments[enabled]'), 'false', 'opts out of Managed Payments (no tax codes are sent)');
  process.env.STRIPE_MANAGED_PAYMENTS = 'on'; await run('POST /api/credits/checkout', { body: { packId: 'p500' } });
  assert.strictEqual(new URLSearchParams(calls[1].init.body).has('managed_payments[enabled]'), false, 'STRIPE_MANAGED_PAYMENTS=on leaves it to the account'); delete process.env.STRIPE_MANAGED_PAYMENTS;
  assert.strictEqual(sent.has('customer_email'), false, 'no email on file: nothing pre-filled');
  u.email = 'buyer@example.com'; await run('POST /api/credits/checkout', { body: { packId: 'p500' } });
  assert.strictEqual(new URLSearchParams(calls.at(-1).init.body).get('customer_email'), 'buyer@example.com', 'the email from signup pre-fills Stripe checkout and receipts'); delete u.email;
  process.env.PUBLIC_URL = 'https://aduna.onrender.com/'; await run('POST /api/credits/checkout', { body: { packId: 'p500' } });
  assert.strictEqual(new URLSearchParams(calls.at(-1).init.body).get('cancel_url'), 'https://aduna.onrender.com/app?credits=cancelled'); delete process.env.PUBLIC_URL;
  for (let i = 0; i < 5; i++) await run('POST /api/credits/checkout', { body: { packId: 'p500' } });
  assert.strictEqual((await run('POST /api/credits/checkout', { body: { packId: 'p500' } })).status, 429, 'checkout is rate limited');

  // webhook
  const evt = { id: 'evt_9', type: 'checkout.session.completed', data: { object: { id: 'cs_77', payment_status: 'paid', amount_total: 1999, currency: 'usd', metadata: { userId: 'u1', packId: 'p2600' } } } };
  const raw = Buffer.from(JSON.stringify(evt)), t = Math.floor(Date.now() / 1000);
  assert.strictEqual((await run('POST /api/credits/webhook', { rawBody: raw, body: evt, headers: { 'stripe-signature': sign(raw, t, 'wrong') } })).status, 400);
  assert.strictEqual(u.credits?.balance || 0, 0, 'a forged webhook credits nothing');
  assert.strictEqual((await run('POST /api/credits/webhook', { rawBody: raw, body: evt, headers: { 'stripe-signature': sign(raw, t) } })).status, 200);
  assert.strictEqual(u.credits.balance, 2600); assert.ok(saved >= 1);
  assert.deepStrictEqual(pushed.at(-1), ['u1', { balance: 2600, delta: 2600, reason: 'purchase' }]);
  await run('POST /api/credits/webhook', { rawBody: raw, body: evt, headers: { 'stripe-signature': sign(raw, t) } });
  assert.strictEqual(u.credits.balance, 2600, 'a replayed webhook pays nothing more');

  // quest claim route
  const before = saved;
  const claim = await run('POST /api/credits/quests/:id/claim', { params: { id: 'checkin' } });
  assert.strictEqual(claim.body.amount, 10); assert.strictEqual(claim.body.balance, 2610); assert.ok(saved > before);
  assert.strictEqual((await run('POST /api/credits/quests/:id/claim', { params: { id: 'checkin' } })).status, 409);
  step('routes: checkout uses the server-side price, is off without keys and rate limited; webhook verifies, credits once, notifies; claim saves and notifies');

  console.log('\nAll credits logic checks passed.');
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
