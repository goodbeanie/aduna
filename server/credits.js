// Credits: Aduna's currency. Bought with real money (Stripe Checkout) or earned by chatting and finishing quests.
//
// This file has no Express / Postgres imports on purpose: the rules are plain functions that work on a user
// record (`user.credits`) and the in-memory `db`, so they can be unit tested without a database
// (server/credits-logic-test.js). index.js wires them to the routes, sockets and persistence.
//
// Where the money-safety lives:
//   * Balances are only ever changed by grant() / spend() / claw() below, on the server. The client never sends an amount.
//   * Purchases are credited from Stripe's signed webhook (never from the browser's "success" redirect), once per
//     checkout session id (the `payments` collection), and only when the amount paid matches the pack's price.
//   * Earning is rate limited per account and checked server side (see EARN). The typing "proof" sent by the browser
//     is a speed bump against paste / auto-typing, NOT a guarantee: anything the browser sends can be forged by a
//     determined script. The real limits are the daily cap, cooldown, account age, similarity and conversation checks.
const crypto = require('crypto');

// ---------- tunables ----------
const EARN = {
  msgReward: 2,                    // credits per rewarded message
  msgDailyCap: 40,                 // most credits messaging can pay per UTC day (= 20 messages)
  msgCooldownMs: 45_000,           // at most one rewarded message per this long
  minServerMembers: 3,             // a server with fewer members than this pays nothing (stops solo farming)
  minAccountAgeMs: 30 * 60_000,    // new accounts earn and claim nothing for 30 minutes
  conversationMs: 30 * 60_000,     // someone else must have spoken in the channel within this window
  recentKeep: 20,                  // how many of your last messages new ones are compared with
  similarity: 0.6,                 // trigram overlap at or above this counts as "the same message"
  copiedMs: 60 * 60_000,           // a message another account sent in the last hour counts as copied
  // typing proof (sent by the browser with each message)
  minMsPerChar: 40,                // typing faster than 25 characters per second is not a person
  minTypedRatio: 0.7,              // at least this share of the message must have come from key presses
  jitterMinEvents: 12,             // with this many key events...
  minJitterMs: 8,                  // ...the gaps between them must vary by at least this (robots type evenly)
};

const PACKS = [
  { id: 'p500', credits: 500, cents: 499 },
  { id: 'p1200', credits: 1200, cents: 999 },
  { id: 'p2600', credits: 2600, cents: 1999 },
  { id: 'p7000', credits: 7000, cents: 4999 },
];
const CURRENCY = 'usd';
const LEDGER_KEEP = 40;

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

// ---------- account record ----------
function acct(u) {
  const c = u.credits || (u.credits = {});
  if (!Number.isFinite(c.balance)) c.balance = 0;
  for (const k of ['earned', 'bought', 'spent', 'msgTotal', 'lastMsgAt', 'streak']) if (!Number.isFinite(c[k])) c[k] = 0;
  if (!Array.isArray(c.ledger)) c.ledger = [];
  if (!Array.isArray(c.recent)) c.recent = [];
  if (!c.claimed || typeof c.claimed !== 'object') c.claimed = {};
  if (typeof c.lastCheckin !== 'string') c.lastCheckin = '';
  return c;
}

// the per-day counters; they start from zero when the UTC date changes
function today(c, now) {
  const k = dayKey(now);
  if (!c.today || c.today.day !== k) c.today = { day: k, msg: 0, msgs: 0, react: [], claimed: {} };
  return c.today;
}

function log(c, amount, reason, note, now) {
  const last = c.ledger[0];
  // a run of message rewards on the same day is one line, so chatting cannot push purchases out of the history
  if (reason === 'message' && last && last.reason === 'message' && dayKey(last.t) === dayKey(now)) {
    last.amount += amount; last.n = (last.n || 1) + 1; last.t = now;
    return;
  }
  c.ledger.unshift({ t: now, amount, reason, ...(note ? { note } : {}), ...(reason === 'message' ? { n: 1 } : {}) });
  if (c.ledger.length > LEDGER_KEEP) c.ledger.length = LEDGER_KEEP;
}

// kind: 'earn' | 'buy'
function grant(u, amount, reason, { note, kind = 'earn', now = Date.now() } = {}) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('grant needs a positive whole number');
  const c = acct(u);
  c.balance += amount;
  if (kind === 'buy') c.bought += amount; else c.earned += amount;
  log(c, amount, reason, note, now);
  return c.balance;
}

// false (and nothing changes) if the balance does not cover it
function spend(u, amount, reason, { note, now = Date.now() } = {}) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('spend needs a positive whole number');
  const c = acct(u);
  if (c.balance < amount) return false;
  c.balance -= amount;
  c.spent += amount;
  log(c, -amount, reason, note, now);
  return true;
}

// refunds and chargebacks take credits back even if they were already spent: the balance may go below zero,
// which blocks spending until it is earned back
function claw(u, amount, reason, { note, now = Date.now() } = {}) {
  const c = acct(u);
  c.balance -= amount;
  c.bought = Math.max(0, c.bought - amount);
  log(c, -amount, reason, note, now);
  return c.balance;
}

// ---------- earning by messaging ----------
const STRIP = /<:[a-z0-9_]{2,32}:[0-9a-f]{16}>|<@[0-9a-f]{16}>|https?:\/\/\S+|@everyone/gi;
// what a message "says": no emoji, mentions or links, only lowercase letters and digits
const normalize = (content) => String(content ?? '').replace(STRIP, ' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// null if the text looks like a real sentence, otherwise why not
function quality(norm) {
  const letters = [...norm.replace(/ /g, '')];
  const n = letters.length;
  const cjk = letters.filter((ch) => CJK.test(ch)).length >= n / 2;
  const words = norm.split(' ').filter(Boolean);
  if (cjk ? n < 10 : n < 16 || words.length < 4) return 'short';
  if (new Set(letters).size < (cjk ? 6 : 8)) return 'repetitive';
  if (/(.)\1{5,}/u.test(norm)) return 'repetitive';
  if (!cjk && new Set(words).size / words.length < 0.6) return 'repetitive';
  const latin = letters.filter((ch) => ch >= 'a' && ch <= 'z');
  if (latin.length >= n * 0.6) { // keyboard mashing has almost no vowels (or only vowels)
    const v = latin.filter((ch) => 'aeiouy'.includes(ch)).length / latin.length;
    if (v < 0.2 || v > 0.7) return 'gibberish';
  }
  return null;
}

const trigrams = (s) => { const t = ` ${s} `, out = new Set(); for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3)); return out; };
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}
function similar(a, b) {
  if (a === b) return true;
  if (jaccard(trigrams(a), trigrams(b)) >= EARN.similarity) return true;
  return jaccard(new Set(a.split(' ')), new Set(b.split(' '))) >= 0.8; // same words, shuffled
}

// proof = { t: typed chars, p: pasted/dropped chars, ms: first key press to send, ev: key events, j: spread of gaps between them }
function typingProblem(proof, n) {
  if (!proof || typeof proof !== 'object') return 'no typing proof';
  const { t, p, ms, ev, j } = proof;
  for (const v of [t, p, ms, ev, j]) if (!Number.isFinite(v) || v < 0 || v > 1e9) return 'bad typing proof';
  if (p > 0) return 'pasted';
  if (t < n * EARN.minTypedRatio) return 'not typed';
  if (ms < n * EARN.minMsPerChar) return 'too fast';
  if (ev >= EARN.jitterMinEvents && j < EARN.minJitterMs) return 'robotic';
  return null;
}

// In memory only (reset by a restart, which only makes the checks a little looser for a while)
const spoke = new Map();  // channelId -> Map(userId -> last time)
const seen = new Map();   // hash of a message -> { userId, t }, so one text cannot be pasted around by many accounts

function noteChannelMessage(channelId, userId, now = Date.now()) {
  let m = spoke.get(channelId);
  if (!m) spoke.set(channelId, (m = new Map()));
  m.set(userId, now);
  if (m.size > 200) for (const [k, t] of m) if (now - t > EARN.conversationMs) m.delete(k);
}
function othersSpoke(channelId, userId, now) {
  const m = spoke.get(channelId);
  if (!m) return false;
  for (const [k, t] of m) if (k !== userId && now - t <= EARN.conversationMs) return true;
  return false;
}
// true if a DIFFERENT account sent this same text recently
function remember(norm, userId, now) {
  const h = crypto.createHash('sha1').update(norm).digest('hex');
  const prior = seen.get(h);
  seen.delete(h); seen.set(h, { userId, t: now });
  if (seen.size > 5000) for (const k of seen.keys()) { seen.delete(k); if (seen.size <= 4000) break; }
  return !!prior && prior.userId !== userId && now - prior.t < EARN.copiedMs;
}

// Called for every message sent in a server channel. Returns { ok: true, amount } when it paid, else { ok: false, reason }.
// The reason is for tests and logs; it is not shown to people (it would only teach spammers what to avoid).
function rewardMessage({ user: u, content, proof, server, channel, now = Date.now() }) {
  const no = (reason) => ({ ok: false, reason });
  if ((channel.type || 'text') !== 'text') return no('channel type');
  if (server.members.length < EARN.minServerMembers) return no('small server');
  if (now - (u.createdAt || 0) < EARN.minAccountAgeMs) return no('new account');
  const norm = normalize(content);
  const bad = quality(norm);
  if (bad) return no(bad);

  const c = acct(u), d = today(c, now);
  // every sentence-like message is remembered, paid or not, so repeats and copies never pay later either
  const copied = remember(norm, u.id, now);
  const repeat = c.recent.some((r) => similar(norm, r));
  c.recent.unshift(norm.slice(0, 300));
  if (c.recent.length > EARN.recentKeep) c.recent.length = EARN.recentKeep;
  if (copied) return no('copied');
  if (repeat) return no('repeat');

  if (now - c.lastMsgAt < EARN.msgCooldownMs) return no('cooldown');
  if (d.msg + EARN.msgReward > EARN.msgDailyCap) return no('daily cap');
  const tp = typingProblem(proof, norm.length);
  if (tp) return no(tp);
  if (!othersSpoke(channel.id, u.id, now)) return no('nobody to talk to');

  c.lastMsgAt = now;
  c.msgTotal++;
  d.msg += EARN.msgReward;
  d.msgs++;
  grant(u, EARN.msgReward, 'message', { now });
  return { ok: true, amount: EARN.msgReward, balance: c.balance };
}

// A reaction to someone else's message. Pays nothing itself; it counts towards the daily "react" quest.
function noteReaction(u, messageId, authorId, now = Date.now()) {
  if (authorId === u.id || now - (u.createdAt || 0) < EARN.minAccountAgeMs) return false;
  const d = today(acct(u), now);
  if (d.react.includes(messageId) || d.react.length >= 10) return false;
  d.react.push(messageId);
  return true;
}

// ---------- quests ----------
// progress() reads real state, never anything the client says. Daily quests reset at 00:00 UTC.
const friendCount = (db, uid) => Object.entries(db.friendships || {}).filter(([k, f]) => f.status === 'friends' && k.split(':').includes(uid)).length;
const QUESTS = [
  { id: 'checkin', daily: true, reward: 10, title: 'Daily check-in', desc: 'Stop by once a day. Consecutive days add a streak bonus.', progress: () => ({ have: 1, need: 1 }) },
  { id: 'chat', daily: true, reward: 15, title: 'Have a conversation', desc: 'Send 5 messages that earn credits today.', progress: ({ c, now }) => ({ have: today(c, now).msgs, need: 5 }) },
  { id: 'react', daily: true, reward: 6, title: 'Show some love', desc: 'React to 3 different messages from other people today.', progress: ({ c, now }) => ({ have: today(c, now).react.length, need: 3 }) },
  { id: 'avatar', reward: 20, title: 'Put a face to the name', desc: 'Upload a profile picture.', progress: ({ u }) => ({ have: u.avatarImage ? 1 : 0, need: 1 }) },
  { id: 'bio', reward: 10, title: 'Say something about yourself', desc: 'Write a bio of at least 10 characters.', progress: ({ u }) => ({ have: String(u.bio || '').trim().length >= 10 ? 1 : 0, need: 1 }) },
  { id: 'friend', reward: 20, title: 'Make a friend', desc: 'Be friends with someone on Aduna.', progress: ({ db, u }) => ({ have: Math.min(1, friendCount(db, u.id)), need: 1 }) },
  { id: 'join', reward: 15, title: 'Find another community', desc: 'Be a member of at least two servers.', progress: ({ db, u }) => ({ have: Math.min(2, Object.values(db.servers || {}).filter((s) => s.members.includes(u.id)).length), need: 2 }) },
  { id: 'server', reward: 25, title: 'Start your own server', desc: 'Create a server.', progress: ({ db, u }) => ({ have: Math.min(1, Object.values(db.servers || {}).filter((s) => s.ownerId === u.id).length), need: 1 }) },
  { id: 'emoji', reward: 20, title: 'Make your mark', desc: 'Upload a custom emoji.', progress: ({ db, u }) => ({ have: Math.min(1, Object.values(db.emojis || {}).filter((e) => e.ownerId === u.id && !e.disabled).length), need: 1 }) },
  { id: 'firstmsg', reward: 10, title: 'Break the ice', desc: 'Send your first message that earns credits.', progress: ({ c }) => ({ have: Math.min(1, c.msgTotal), need: 1 }) },
];

const streakBonus = (streak) => Math.min(Math.max(streak - 1, 0), 5) * 2;
const unlocksAt = (u) => (u.createdAt || 0) + EARN.minAccountAgeMs;

function questList(u, db, now = Date.now()) {
  const c = acct(u), d = today(c, now);
  return QUESTS.map((q) => {
    const { have, need } = q.progress({ u, c, db, now });
    const claimed = !!(q.daily ? d.claimed : c.claimed)[q.id];
    let reward = q.reward;
    if (q.id === 'checkin') reward += streakBonus(c.lastCheckin === dayKey(now - 86_400_000) ? c.streak + 1 : 1);
    return { id: q.id, title: q.title, desc: q.desc, daily: !!q.daily, reward, have: Math.min(have, need), need, done: have >= need, claimed };
  });
}

function claimQuest(u, id, db, now = Date.now()) {
  const q = QUESTS.find((x) => x.id === id);
  if (!q) return { status: 404, error: 'Unknown quest' };
  if (now < unlocksAt(u)) return { status: 403, error: 'Rewards unlock 30 minutes after you sign up', unlocksAt: unlocksAt(u) };
  const c = acct(u), d = today(c, now);
  const claimed = q.daily ? d.claimed : c.claimed;
  if (claimed[id]) return { status: 409, error: q.daily ? 'Already claimed today' : 'Already claimed' };
  const { have, need } = q.progress({ u, c, db, now });
  if (have < need) return { status: 400, error: 'Not finished yet' };
  let amount = q.reward;
  if (id === 'checkin') {
    c.streak = c.lastCheckin === dayKey(now - 86_400_000) ? c.streak + 1 : 1;
    c.lastCheckin = dayKey(now);
    amount += streakBonus(c.streak);
  }
  claimed[id] = now; // marked before paying: the check and the payment happen in one synchronous step
  grant(u, amount, 'quest', { note: q.title, now });
  return { ok: true, amount, balance: c.balance };
}

// ---------- what the client sees ----------
function view(u, db, { purchases, now = Date.now() }) {
  const c = acct(u), d = today(c, now);
  return {
    balance: c.balance,
    purchases,
    packs: PACKS.map((p) => ({ ...p, currency: CURRENCY })),
    streak: c.lastCheckin === dayKey(now) || c.lastCheckin === dayKey(now - 86_400_000) ? c.streak : 0,
    unlocksAt: unlocksAt(u) > now ? unlocksAt(u) : null,
    quests: questList(u, db, now),
    messaging: { reward: EARN.msgReward, cap: EARN.msgDailyCap, earnedToday: d.msg, cooldownMs: EARN.msgCooldownMs, nextAt: c.lastMsgAt + EARN.msgCooldownMs, minMembers: EARN.minServerMembers },
    lifetime: { earned: c.earned, bought: c.bought, spent: c.spent },
    ledger: c.ledger.slice(0, 25),
  };
}

// ---------- buying: Stripe Checkout ----------
// Needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (both: taking money without a way to deliver is never OK).
// Set up in the Stripe dashboard: a webhook endpoint <your site>/api/credits/webhook listening for
// checkout.session.completed, checkout.session.async_payment_succeeded, charge.refunded and charge.dispute.created.
const stripeKey = () => process.env.STRIPE_SECRET_KEY || '';
const stripeHook = () => process.env.STRIPE_WEBHOOK_SECRET || '';
const purchasesEnabled = () => !!(stripeKey() && stripeHook());

// header looks like: t=1700000000,v1=<hex hmac>[,v1=...]. The signed text is "<t>.<raw body>".
function verifyStripeSignature(raw, header, secret, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300) {
  if (!Buffer.isBuffer(raw) || !header || !secret) return false;
  const parts = String(header).split(',').map((s) => s.trim().split('='));
  const t = parts.find((p) => p[0] === 't')?.[1];
  const sigs = parts.filter((p) => p[0] === 'v1').map((p) => p[1] || '');
  if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(t + '.').update(raw).digest();
  return sigs.some((s) => /^[0-9a-f]{64}$/i.test(s) && crypto.timingSafeEqual(Buffer.from(s, 'hex'), expected));
}

async function createCheckout({ user, pack, origin, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': CURRENCY,
    'line_items[0][price_data][unit_amount]': String(pack.cents),
    'line_items[0][price_data][product_data][name]': `${pack.credits.toLocaleString('en-US')} Aduna credits`,
    success_url: `${origin}/app?credits=paid`,
    cancel_url: `${origin}/app?credits=cancelled`,
    client_reference_id: user.id,
    'metadata[userId]': user.id,
    'metadata[packId]': pack.id,
  });
  if (user.email) body.set('customer_email', user.email); // pre-fills the checkout page and where Stripe sends the receipt
  // Stripe accounts can have "Managed Payments" (Stripe as seller of record, handles tax) switched on by default; it
  // rejects checkouts whose products have no tax code. Aduna does not send tax codes, so it opts out per session
  // unless STRIPE_MANAGED_PAYMENTS=on is set (then a tax code must be added to the line item first).
  if (process.env.STRIPE_MANAGED_PAYMENTS !== 'on') body.set('managed_payments[enabled]', 'false');
  const r = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + stripeKey(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) throw new Error(`Stripe checkout failed (${r.status}): ${j.error?.message || 'no url'}`);
  return j.url;
}

// Applies one verified Stripe event to `db` (the caller saves). Returns { uid, delta, reason } when a balance changed.
function handleStripeEvent(event, db, now = Date.now()) {
  const obj = event?.data?.object || {};
  if (event?.type === 'checkout.session.completed' || event?.type === 'checkout.session.async_payment_succeeded') {
    if (obj.payment_status !== 'paid') return null; // an async payment: wait for async_payment_succeeded
    if (db.payments[obj.id]) return null;            // Stripe retries and sends duplicates: pay once per session
    const pack = PACKS.find((p) => p.id === obj.metadata?.packId);
    const u = db.users[obj.metadata?.userId];
    if (!pack || !u) { console.error('Credits: paid session', obj.id, 'has an unknown pack or user'); return null; }
    if (obj.amount_total !== pack.cents || String(obj.currency).toLowerCase() !== CURRENCY) {
      console.error('Credits: paid session', obj.id, 'amount does not match the pack; not crediting');
      return null;
    }
    db.payments[obj.id] = { id: obj.id, userId: u.id, packId: pack.id, credits: pack.credits, cents: pack.cents, intent: obj.payment_intent || null, createdAt: now, reversed: false };
    grant(u, pack.credits, 'purchase', { note: `${pack.credits} credits`, kind: 'buy', now });
    return { uid: u.id, delta: pack.credits, reason: 'purchase' };
  }
  const intent = event?.type === 'charge.refunded' && obj.refunded ? obj.payment_intent // fully refunded only
    : event?.type === 'charge.dispute.created' ? obj.payment_intent : null;
  if (intent) {
    const pay = Object.values(db.payments).find((p) => p.intent === intent);
    const u = pay && db.users[pay.userId];
    if (!pay || !u || pay.reversed) return null;
    pay.reversed = true;
    claw(u, pay.credits, event.type === 'charge.refunded' ? 'refund' : 'chargeback', { now });
    return { uid: u.id, delta: -pay.credits, reason: 'refund' };
  }
  return null;
}

// ---------- routes ----------
// d: { auth, ah, db() -> store.db, save(), notify(uid, payload), fetchImpl? }
function register(app, d) {
  const push = (u, delta, reason) => d.notify(u.id, { balance: acct(u).balance, delta, reason });

  app.get('/api/credits', d.auth, (req, res) => res.json(view(req.user, d.db(), { purchases: purchasesEnabled() })));

  app.post('/api/credits/quests/:id/claim', d.auth, (req, res) => {
    const r = claimQuest(req.user, req.params.id, d.db());
    if (!r.ok) return res.status(r.status).json({ error: r.error, unlocksAt: r.unlocksAt });
    d.save();
    push(req.user, r.amount, 'quest');
    res.json({ ...view(req.user, d.db(), { purchases: purchasesEnabled() }), amount: r.amount });
  });

  const tries = new Map();
  app.post('/api/credits/checkout', d.auth, d.ah(async (req, res) => {
    if (!purchasesEnabled()) return res.status(503).json({ error: 'Buying credits is not set up on this server yet' });
    const t = Date.now(), arr = (tries.get(req.user.id) || []).filter((x) => t - x < 60_000);
    if (arr.length >= 5) return res.status(429).json({ error: 'Too many attempts, try again in a minute' });
    arr.push(t); tries.set(req.user.id, arr);
    const pack = PACKS.find((p) => p.id === req.body?.packId);
    if (!pack) return res.status(400).json({ error: 'Unknown credit pack' });
    const origin = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    try { res.json({ url: await createCheckout({ user: req.user, pack, origin, fetchImpl: d.fetchImpl }) }); }
    catch (e) { console.error(e.message); res.status(502).json({ error: 'Could not start checkout. Try again later.' }); }
  }));

  // Stripe calls this. No login: the signature is the proof. index.js keeps the raw body for it (req.rawBody).
  app.post('/api/credits/webhook', (req, res) => {
    if (!verifyStripeSignature(req.rawBody, req.headers['stripe-signature'], stripeHook())) return res.status(400).json({ error: 'Bad signature' });
    let change = null;
    try { change = handleStripeEvent(req.body, d.db()); }
    catch (e) { console.error('Credits webhook error:', e); return res.status(500).json({ error: 'Failed' }); } // Stripe retries
    if (change) { d.save(); const u = d.db().users[change.uid]; if (u) push(u, change.delta, change.reason); }
    res.json({ received: true });
  });
}

module.exports = {
  EARN, PACKS, QUESTS, acct, grant, spend, claw, normalize, quality, similar, typingProblem,
  noteChannelMessage, rewardMessage, noteReaction, questList, claimQuest, view,
  verifyStripeSignature, createCheckout, handleStripeEvent, purchasesEnabled, register,
  _reset: () => { spoke.clear(); seen.clear(); },
};
