// Credits: Aduna's currency. Bought with real money (Stripe Checkout) or earned by chatting and finishing quests.
//
// This file has no Express / Postgres imports on purpose: the rules are plain functions that work on a user
// record (`user.credits`) and the in-memory `db`, so they can be unit tested without a database
// (server/credits-logic-test.js). index.js wires them to the routes, sockets and persistence.
//
// Where the money-safety lives:
//   * Balances are only ever changed by grant() / spend() / claw() below, on the server. The client never sends an amount.
//   * Purchases are credited from Stripe's signed webhook (never from the browser's "success" redirect), once per checkout
//     session (the `payments` collection), and only when the amount paid matches the pack's price.
//   * Earning is rate limited per account and checked server side (see EARN). The typing "proof" sent by the browser
//     is a speed bump against paste / auto-typing, NOT a guarantee: anything the browser sends can be forged by a
//     determined script. The real limits are the daily cap, cooldown, account age, similarity and conversation checks.
const crypto = require('crypto');
const events = require('./events'); // the Halloween / Christmas quests, the Advent calendar and the creator test mode
const shop = require('./shop');     // what credits can be spent on (profile badges)
const artists = require('./artists'); // artists sell badges in the shop and earn a share of each sale (cutFor)
const pthemes = require('./profilethemes'); // gradient profile themes: free for everybody (animated ones can be switched on later)
const ads = require('./ads');       // opt-in "watch a sponsor, earn credits" and the quiet sponsored card (off unless ADS_JSON is set)
const boosts = require('./boosts'); // server boosts: a level 3 server pays more for messages (multiplierOf), the credits are spent through spend() below

// ---------- tunables ----------
const EARN = {
  msgReward: 2,                    // credits per rewarded message
  msgDailyCap: 40,                 // most credits messaging can pay per UTC day (= 20 messages)
  plusMultiplier: 1.5,             // Aduna Plus earns this much more from messages and quests
  plusMsgLimit: 60,                // rewarded messages per UTC day that pay the Plus rate
  plusMsgAfter: 1,                 // what a Plus message pays after that, until the day rolls over
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

// Prices: cadCents is what a Canadian buyer pays in CAD, cents is what a US buyer pays in USD. Both are fixed, and checkout adds no fee line:
// they already include what Stripe takes, rounded up to a .x9 price. CAD covers a Canadian card (2.9% + 30 cents); USD covers a US card,
// which Stripe charges more for (about 5.4% + 30 cents: 2.9% + international card + currency conversion; check the rates on your Stripe Pricing page).
// prevCents / prevCadCents are the prices before that change;
// they only let a checkout that was opened at the old price still be credited (see handleStripeEvent), and can be dropped once none is left.
// A pack's id is its credit amount. Older payments keep the pack id they were bought under
// (their own record says how many credits they gave).
const PACKS = [
  { id: 'p500', credits: 500, cents: 199, cadCents: 239, prevCents: 149, prevCadCents: 199 },
  { id: 'p1000', credits: 1000, cents: 299, cadCents: 399, prevCents: 249, prevCadCents: 349 },
  { id: 'p2500', credits: 2500, cents: 569, cadCents: 759, prevCents: 499, prevCadCents: 699 },
  { id: 'p5000', credits: 5000, cents: 799, cadCents: 1069, prevCents: 719, prevCadCents: 999 },
];
// The packs sold before the price changes. Not offered any more; only so a payment that was started before it still finishes and is credited.
const LEGACY_PACKS = [
  { id: 'p1350', credits: 1350, cents: 559, cadCents: 769 },
  { id: 'p2900', credits: 2900, cents: 1089, cadCents: 1509 },
  { id: 'p6200', credits: 6200, cents: 2139, cadCents: 2979 },
  { id: 'p1200', credits: 1200, cents: 999 },
  { id: 'p2600', credits: 2600, cents: 1999 },
  { id: 'p7000', credits: 7000, cents: 4999 },
];
const packForPayment = (id) => PACKS.find((p) => p.id === id) || LEGACY_PACKS.find((p) => p.id === id);
const CURRENCY = 'usd';
const LEDGER_KEEP = 40;

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

const plusPay = (n, plus) => (plus ? Math.round(n * EARN.plusMultiplier) : n);
const dayPay = (n, u, now) => Math.round(n * events.dayMultiplier(u, now)); // the Advent 1.5x day
// what the next rewarded message pays, given today's counters
const messagePay = (d, plus) => (!plus ? EARN.msgReward : d.msgs < EARN.plusMsgLimit ? plusPay(EARN.msgReward, true) : EARN.plusMsgAfter);

// ---------- account record ----------
function acct(u) {
  const c = u.credits || (u.credits = {});
  if (!Number.isFinite(c.balance)) c.balance = 0;
  for (const k of ['earned', 'bought', 'spent', 'msgTotal', 'lastMsgAt', 'streak', 'bestStreak']) if (!Number.isFinite(c[k])) c[k] = 0;
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

// kind: 'earn' | 'buy' | 'refund' (credits that were spent and come back: they take away from `spent` and count as neither earned nor bought)
function grant(u, amount, reason, { note, kind = 'earn', now = Date.now() } = {}) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('grant needs a positive whole number');
  const c = acct(u);
  c.balance += amount;
  if (kind === 'buy') c.bought += amount;
  else if (kind === 'refund') c.spent = Math.max(0, c.spent - amount);
  else c.earned += amount;
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
const STRIP = /<:[a-z0-9_]{2,32}:[0-9a-f]{16}>|<@[0-9a-f]{16}>|<#[0-9a-f]{16}>|<stk:[0-9a-f]{32}>|https?:\/\/\S+|@everyone/gi;
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
function rewardMessage({ user: u, content, proof, server, channel, humans, plus = false, now = Date.now() }) {
  const no = (reason) => ({ ok: false, reason });
  if ((channel.type || 'text') !== 'text') return no('channel type');
  if ((humans ?? server.members.length) < EARN.minServerMembers) return no('small server');
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
  if (!plus && d.msg + EARN.msgReward > EARN.msgDailyCap) return no('daily cap');
  const tp = typingProblem(proof, norm.length);
  if (tp) return no(tp);
  if (!othersSpoke(channel.id, u.id, now)) return no('nobody to talk to');

  const base = messagePay(d, plus);
  const amount = Math.round(base * boosts.multiplierOf(server, now) * events.dayMultiplier(u, now)); // a level 3 server pays 1.5x, and so does an Advent 1.5x day; the extra does not count against the daily cap
  c.lastMsgAt = now;
  c.msgTotal++;
  d.msg += base;
  d.msgs++;
  grant(u, amount, 'message', { now });
  return { ok: true, amount, balance: c.balance };
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
  // Aduna Plus only: shown to everyone, claimable with Plus
  { id: 'pluschat', daily: true, plusOnly: true, reward: 30, title: 'Keep it going', desc: 'Send 30 messages that earn credits today.', progress: ({ c, now }) => ({ have: today(c, now).msgs, need: 30 }) },
  { id: 'plusreact', daily: true, plusOnly: true, reward: 12, title: 'Spread the love', desc: 'React to 8 different messages from other people today.', progress: ({ c, now }) => ({ have: today(c, now).react.length, need: 8 }) },
  { id: 'plusstreak', plusOnly: true, reward: 50, title: 'A week of Plus', desc: 'Reach a 7-day check-in streak.', progress: ({ c, now }) => ({ have: Math.min(7, streakAlive(c, now) ? c.streak : 0), need: 7 }) },
];

const streakBonus = (streak) => Math.min(Math.max(streak - 1, 0), 5) * 2;
// One-time extra rewards on the day the check-in streak reaches these lengths. Miss a day and the streak starts over,
// so the milestones come around again on the next run.
const STREAK_MILESTONES = [
  { days: 3, bonus: 10 },
  { days: 7, bonus: 30 },
  { days: 14, bonus: 60 },
  { days: 30, bonus: 150 },
  { days: 60, bonus: 300 },
  { days: 100, bonus: 600 },
];
const milestoneBonus = (streak) => STREAK_MILESTONES.find((m) => m.days === streak)?.bonus || 0;
// the streak the next check-in would make
const nextStreak = (c, now) => (c.lastCheckin === dayKey(now - 86_400_000) ? c.streak + 1 : 1);
const unlocksAt = (u) => (u.createdAt || 0) + EARN.minAccountAgeMs;
const streakAlive = (c, now) => c.lastCheckin === dayKey(now) || c.lastCheckin === dayKey(now - 86_400_000);

function questList(u, db, now = Date.now(), plus = false) {
  const c = acct(u), d = today(c, now);
  return QUESTS.map((q) => {
    const { have, need } = q.progress({ u, c, db, now });
    const claimed = !!(q.daily ? d.claimed : c.claimed)[q.id];
    let reward = q.reward;
    if (q.id === 'checkin') { const s = nextStreak(c, now); reward += streakBonus(s) + milestoneBonus(s); }
    return {
      id: q.id, title: q.title, desc: q.desc, daily: !!q.daily, reward: dayPay(plusPay(reward, plus), u, now), have: Math.min(have, need), need, done: have >= need, claimed,
      plusOnly: !!q.plusOnly, locked: !!q.plusOnly && !plus,
    };
  });
}

function claimQuest(u, id, db, now = Date.now(), plus = false) {
  const q = QUESTS.find((x) => x.id === id);
  if (!q) return { status: 404, error: 'Unknown quest' };
  if (q.plusOnly && !plus) return { status: 403, error: 'This quest is for Aduna Plus' };
  if (now < unlocksAt(u)) return { status: 403, error: 'Rewards unlock 30 minutes after you sign up', unlocksAt: unlocksAt(u) };
  const c = acct(u), d = today(c, now);
  const claimed = q.daily ? d.claimed : c.claimed;
  if (claimed[id]) return { status: 409, error: q.daily ? 'Already claimed today' : 'Already claimed' };
  const { have, need } = q.progress({ u, c, db, now });
  if (have < need) return { status: 400, error: 'Not finished yet' };
  let amount = q.reward, milestone = 0;
  if (id === 'checkin') {
    c.streak = nextStreak(c, now);
    c.lastCheckin = dayKey(now);
    if (c.streak > c.bestStreak) c.bestStreak = c.streak;
    milestone = milestoneBonus(c.streak);
    amount += streakBonus(c.streak) + milestone;
  }
  claimed[id] = now; // marked before paying: the check and the payment happen in one synchronous step
  amount = dayPay(plusPay(amount, plus), u, now);
  grant(u, amount, 'quest', { note: milestone ? `${q.title} (${c.streak}-day streak!)` : q.title, now });
  return { ok: true, amount, balance: c.balance, ...(milestone ? { milestone: dayPay(plusPay(milestone, plus), u, now), streak: c.streak } : {}) };
}

// What the Quests page shows for the check-in streak: the current run, the best run, and the next reward waiting at the end of it.
function streakView(c, now, plus = false) {
  const streak = streakAlive(c, now) ? c.streak : 0;
  const next = STREAK_MILESTONES.find((m) => m.days > streak) || null;
  return {
    current: streak,
    best: Math.max(c.bestStreak, streak),
    checkedInToday: c.lastCheckin === dayKey(now),
    atRisk: c.lastCheckin === dayKey(now - 86_400_000) && streak > 0, // checked in yesterday, not yet today: check in today to keep it
    next: next ? { days: next.days, bonus: plusPay(next.bonus, plus), left: next.days - streak } : null,
    milestones: STREAK_MILESTONES.map((m) => ({ ...m, bonus: plusPay(m.bonus, plus), reached: streak >= m.days })),
    dailyBonusMax: plusPay(streakBonus(99), plus),
  };
}

// ---------- what the client sees ----------
function view(u, db, { purchases, paused = false, now = Date.now(), dev = false, creator = false, plus = false, features = {} }) {
  const c = acct(u), d = today(c, now);
  return {
    balance: c.balance,
    purchases,
    paused: !!paused, // purchases are set up but a creator has Payments switched off (/admin > Switches): the client says "paused", not "not set up"
    provider: purchases ? 'stripe' : null,
    regions: purchases ? REG.publicInfo() : null,
    packs: PACKS.map((p) => ({ ...p, currency: CURRENCY })),
    streak: c.lastCheckin === dayKey(now) || c.lastCheckin === dayKey(now - 86_400_000) ? c.streak : 0,
    streakInfo: streakView(c, now, plus),
    ads: ads.view(u, { now, unlocksAt: unlocksAt(u), rewarded: !!features.rewarded, sponsored: !!features.sponsored }), // { enabled: false } unless sponsors are configured AND a feature switch is on for this person; never anything in chat or voice
    unlocksAt: unlocksAt(u) > now ? unlocksAt(u) : null,
    quests: questList(u, db, now, plus),
    event: events.view(u, { now, dev }), // the Halloween / Christmas quests and Advent calendar, or null when no event is on
    shop: shop.view(u, db.badges, { now, all: creator, users: db.users }), // the badges on show today (the creator sees every priced badge, with its state), with what this person already owns marked; an artist's item says who made it
    shopInfo: shop.info(now),                              // the daily shop: how many are shown at once and when today's picks change
    messaging: {
      reward: messagePay(d, plus), cap: plus ? null : EARN.msgDailyCap, earnedToday: d.msg, cooldownMs: EARN.msgCooldownMs, nextAt: c.lastMsgAt + EARN.msgCooldownMs, minMembers: EARN.minServerMembers,
      plus: plus ? { rate: plusPay(EARN.msgReward, true), limit: EARN.plusMsgLimit, after: EARN.plusMsgAfter, messagesToday: d.msgs } : null,
    },
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
const stripeEnabled = () => !!(stripeKey() && stripeHook());

const purchasesEnabled = stripeEnabled;
const REG = require('./regions'); // where Aduna sells and in which currency (server/regions.js)
const PRICES = require('./stripeprices'); // attaches the products you made in the Stripe dashboard (off unless STRIPE_PRODUCTS or STRIPE_PRICES is set)

// Stripe asks for the billing address on its own page and adds the tax for it. Needs Stripe Tax switched on in the dashboard.
const STRIPE_TAX = { 'automatic_tax[enabled]': 'true', billing_address_collection: 'required' };

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

async function stripeRequest(method, path, params, fetchImpl = fetch) {
  const r = await fetchImpl('https://api.stripe.com/v1' + path, {
    method,
    headers: { Authorization: 'Bearer ' + stripeKey(), ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    ...(params ? { body: new URLSearchParams(params) } : {}),
  });
  return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) };
}

// Stripe accounts can have "Managed Payments" (Stripe as seller of record, handles tax) switched on by default; it
// rejects checkouts whose products have no tax code. Aduna does not send tax codes, so it opts out per session
// unless STRIPE_MANAGED_PAYMENTS=on is set (then a tax code must be added to the line item first).
async function createSession(params, fetchImpl = fetch) {
  const body = process.env.STRIPE_MANAGED_PAYMENTS === 'on' ? params : { ...params, 'managed_payments[enabled]': 'false' };
  const r = await stripeRequest('POST', '/checkout/sessions', body, fetchImpl);
  if (!r.ok || !r.j.url) throw new Error(`Stripe checkout failed (${r.status}): ${r.j.error?.message || 'no url'}`);
  return r.j;
}

// The price comes from the pack on the server, never from the browser. The buyer's country picks the currency; Stripe asks for the
// billing address on its own page and works out the tax there (Stripe Tax).
async function createCheckout({ user, pack, origin, buyer = {}, fetchImpl = fetch }) {
  const where = REG.resolve(buyer);
  if (!where.ok) throw Object.assign(new Error(where.error), { forBuyer: true });
  const base = REG.priceIn(pack, where.currency);
  if (!base) throw Object.assign(new Error('This pack is not for sale in ' + where.currency.toUpperCase()), { forBuyer: true });
  // your own Stripe product for this pack when STRIPE_PRODUCTS / STRIPE_PRICES attach one (server/stripeprices.js), else an inline price
  const priceId = await PRICES.priceFor({ item: pack, currency: where.currency, base, request: (m, p) => stripeRequest(m, p, null, fetchImpl) });
  const params = {
    mode: 'payment',
    ...PRICES.line(0, { priceId, currency: where.currency, cents: base, name: `${pack.credits.toLocaleString('en-US')} Aduna credits` }),
    ...STRIPE_TAX,
    success_url: `${origin}/app?credits=paid`,
    cancel_url: `${origin}/app?credits=cancelled`,
    client_reference_id: user.id,
    'metadata[userId]': user.id,
    'metadata[packId]': pack.id,
    'metadata[country]': where.country,
  };
  if (user.email) params.customer_email = user.email; // pre-fills the checkout page and where Stripe sends the receipt
  return (await createSession(params, fetchImpl)).url;
}

// Applies one verified Stripe event to `db` (the caller saves). Returns { uid, delta, reason } when a balance changed.
function handleStripeEvent(event, db, now = Date.now()) {
  const obj = event?.data?.object || {};
  if (event?.type === 'checkout.session.completed' || event?.type === 'checkout.session.async_payment_succeeded') {
    if (obj.mode === 'subscription') return null;   // the storage plan: server/storage.js looks after it
    if (obj.metadata?.kind === 'sponsored') return null; // a sponsored server: server/sponsored.js
    if (obj.payment_status !== 'paid') return null; // an async payment: wait for async_payment_succeeded
    if (db.payments[obj.id]) return null;            // Stripe retries and sends duplicates: pay once per session
    const pack = packForPayment(obj.metadata?.packId);
    const u = db.users[obj.metadata?.userId];
    if (!pack || !u) { console.error('Credits: paid session', obj.id, 'has an unknown pack or user'); return null; }
    const cur = String(obj.currency).toLowerCase(), { country = '', region = '', tax, total } = obj.metadata || {};
    const base = REG.priceIn(pack, cur);
    const paidTax = Number(obj.total_details?.amount_tax) || 0;
    // a checkout opened just before a price change was made at the pack's previous price: which of the two prices this session was for
    const prev = cur === 'cad' ? pack.prevCadCents : pack.prevCents, paid = total !== undefined ? Number(total) : obj.amount_total;
    const bought = [base, prev].find((b) => Number.isInteger(b) && (paid === b || paid === b + paidTax)) || base;
    // a session made before Stripe Tax carries its own total; otherwise the price, plus the tax Stripe added on top of it
    const expected = total !== undefined ? Number(total) : obj.amount_total === bought ? bought : bought + paidTax;
    if (!base || !Number.isInteger(expected) || expected < bought || expected > Math.round(bought * 1.75) || obj.amount_total !== expected || (!!country && REG.currencyOf(country) !== cur)) {
      console.error('Credits: paid session', obj.id, 'amount does not match the pack; not crediting');
      return null;
    }
    const payerCountry = String(obj.customer_details?.address?.country || '').toUpperCase();
    const payerRegion = String(obj.customer_details?.address?.state || '').toUpperCase().slice(0, 3);
    const why = REG.review(country, /^[A-Z]{2}$/.test(payerCountry) ? payerCountry : '');
    if (why) console.warn(`Credits: payment ${obj.id} needs a look (${why}): the buyer said ${country || 'nothing'}, Stripe says ${payerCountry}`);
    db.payments[obj.id] = {
      id: obj.id, userId: u.id, packId: pack.id, credits: pack.credits, cents: expected, currency: cur,
      country: /^[A-Z]{2}$/.test(payerCountry) ? payerCountry : country, region: region || payerRegion, tax: total !== undefined ? Number(tax) || 0 : paidTax,
      ...(why ? { review: why } : {}), intent: obj.payment_intent || null, createdAt: now, reversed: false,
    };
    grant(u, pack.credits, 'purchase', { note: `${pack.credits} credits`, kind: 'buy', now });
    return { uid: u.id, delta: pack.credits, reason: 'purchase' };
  }
  const intent = event?.type === 'charge.refunded' && obj.refunded ? obj.payment_intent // fully refunded only
    : event?.type === 'charge.dispute.created' ? obj.payment_intent : null;
  if (intent) {
    const pay = Object.values(db.payments).find((p) => p.intent === intent);
    const u = pay && db.users[pay.userId];
    if (!pay || pay.kind === 'sponsored' || !u || pay.reversed) return null;
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

  // creator accounts can switch an event on for themselves to test it, see events.js
  const isCreator = (u) => !!(d.isCreator && d.isCreator(u));
  const paymentsOpen = (u) => !d.paymentsOpen || d.paymentsOpen(u); // the Payments switch (index.js); open when nothing says otherwise
  // feature releases (features.js): 'rewarded-ads' and 'sponsored-card' decide whether this person sees the sponsor button and the card
  const featureOn = (id, u) => !!(d.featureOn && d.featureOn(id, u));
  const needRewardedAds = (req, res, next) => (featureOn('rewarded-ads', req.user) ? next() : res.status(404).json({ error: 'Not found' }));
  const isPlus = (u) => !!(d.isPlus && d.isPlus(u));
  const fullView = (u) => view(u, d.db(), {
    purchases: purchasesEnabled() && paymentsOpen(u), paused: purchasesEnabled() && !paymentsOpen(u), dev: isCreator(u), creator: isCreator(u), plus: isPlus(u),
    features: { rewarded: featureOn('rewarded-ads', u), sponsored: featureOn('sponsored-card', u) },
  });

  app.get('/api/credits', d.auth, (req, res) => res.json(fullView(req.user)));

  app.post('/api/credits/quests/:id/claim', d.auth, (req, res) => {
    const r = claimQuest(req.user, req.params.id, d.db(), Date.now(), isPlus(req.user));
    if (!r.ok) return res.status(r.status).json({ error: r.error, unlocksAt: r.unlocksAt });
    d.save();
    push(req.user, r.amount, 'quest');
    res.json({ ...fullView(req.user), amount: r.amount, ...(r.milestone ? { milestone: r.milestone, milestoneStreak: r.streak } : {}) });
  });

  // ----- sponsors: opt-in "watch a sponsor, earn credits". The reward, timer and daily cap all live in ads.js; the browser only starts and finishes a view. -----
  app.post('/api/credits/ads/start', d.auth, needRewardedAds, (req, res) => {
    const r = ads.start(req.user, { unlocksAt: unlocksAt(req.user) });
    if (!r.ok) return res.status(r.status).json({ error: r.error, ...(r.nextAt ? { nextAt: r.nextAt } : {}), ...(r.unlocksAt ? { unlocksAt: r.unlocksAt } : {}) });
    d.save(); // the pending view is remembered, so a restart in the middle just means starting again
    res.json({ token: r.token, ad: r.ad, seconds: r.seconds });
  });
  app.post('/api/credits/ads/complete', d.auth, needRewardedAds, (req, res) => {
    const r = ads.complete(req.user, req.body?.token, { grant, unlocksAt: unlocksAt(req.user) });
    if (!r.ok) { d.save(); return res.status(r.status).json({ error: r.error, ...(r.waitMs ? { waitMs: r.waitMs } : {}) }); }
    d.save();
    push(req.user, r.amount, 'ad');
    res.json({ ...fullView(req.user), amount: r.amount });
  });

  // ----- the shop: spend credits on a badge. The price comes from shop.js; the browser only names the item. -----
  app.post('/api/credits/shop/:id/buy', d.auth, (req, res) => {
    const r = shop.buy(req.user, req.params.id, spend, { badges: d.db().badges });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    // An artist's item pays the artist their share. Same synchronous step as the purchase, so a sale is never half done.
    // Buying your own item pays nothing back (it would only turn credits into credits). A price too small to split pays 0 and is skipped.
    const artist = r.item.artistId && r.item.artistId !== req.user.id ? d.db().users[r.item.artistId] : null;
    const cut = artist ? artists.cutFor(r.item.price) : 0;
    if (artist && cut > 0) grant(artist, cut, 'artist', { note: r.item.name });
    d.save();
    push(req.user, -r.item.price, 'shop');
    if (artist && cut > 0) push(artist, cut, 'artist'); // their balance updates on every device at once
    if (d.userChanged) d.userChanged(req.user); // the new badge shows next to their name right away
    res.json({ ...fullView(req.user), bought: r.item.name });
  });

  // ----- profile themes: the picker's list. They are all free, so there is nothing to buy -----
  app.get('/api/profile-themes', d.auth, (req, res) => res.json({ themes: pthemes.view(req.user) }));

  // ----- seasonal events (Halloween / Christmas) -----
  const seasonPay = (req, res, r) => {
    if (!r.ok) return res.status(r.status).json({ error: r.error, unlocksAt: r.unlocksAt });
    d.save();
    if (!r.test && r.amount) push(req.user, r.amount, 'quest'); // a test claim moves no credits, and a multiplier or boost prize pays none yet
    if (r.badge && d.userChanged) d.userChanged(req.user); // a new badge shows next to their name right away
    res.json({ ...fullView(req.user), ...(r.amount ? { amount: r.amount } : {}), ...(r.prize ? { prize: r.prize } : {}), test: !!r.test, ...(r.badge ? { badge: r.badge } : {}), ...(r.all ? { all: true } : {}) });
  };
  const seasonOpts = (u) => ({ dev: isCreator(u), grant, unlocksAt: unlocksAt(u), minAgeMs: EARN.minAccountAgeMs });
  app.post('/api/credits/season/quests/:id/claim', d.auth, (req, res) => seasonPay(req, res, events.claim(req.user, req.params.id, seasonOpts(req.user))));
  app.post('/api/credits/season/advent/:day/open', d.auth, (req, res) => seasonPay(req, res, events.openDoor(req.user, req.params.day, seasonOpts(req.user))));

  // The free boost from an Advent door: the person names the server, it has to be one they are in. A refusal leaves the prize waiting.
  app.post('/api/credits/season/advent/:day/boost', d.auth, (req, res) => {
    const s = d.db().servers[String(req.body?.serverId || '')];
    if (!s || !s.members.includes(req.user.id)) return res.status(404).json({ error: 'Pick a server you are in' });
    const r = events.useBoost(req.user, req.params.day, s, seasonOpts(req.user));
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    d.save();
    if (d.serverChanged) d.serverChanged(s); // everyone in the server sees the new level and the booster tag right away
    res.json({ ...fullView(req.user), boosted: s.name });
  });

  // Test mode: { mode: 'halloween' | 'christmas' | null }. Creator accounts only; everything claimed in it is a dry run.
  const creatorOnly = (req, res) => { if (isCreator(req.user)) return true; res.status(403).json({ error: 'Test mode is for creator accounts', code: 'not_creator' }); return false; };
  app.post('/api/credits/season/test', d.auth, (req, res) => {
    if (!creatorOnly(req, res)) return;
    const mode = req.body?.mode ?? null;
    if (mode !== null && !events.EVENTS[mode]) return res.status(400).json({ error: 'Choose halloween, christmas or off' });
    events.setTest(req.user, mode);
    d.save();
    res.json({ seasonTest: events.testMode(req.user, true), credits: fullView(req.user) });
  });
  app.post('/api/credits/season/test/reset', d.auth, (req, res) => {
    if (!creatorOnly(req, res)) return;
    events.resetTest(req.user);
    d.save();
    res.json({ seasonTest: events.testMode(req.user, true), credits: fullView(req.user) });
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
    try {
      res.json({ url: await createCheckout({ user: req.user, pack, origin, buyer: req.body, fetchImpl: d.fetchImpl }) });
    }
    catch (e) { if (e.forBuyer) return res.status(400).json({ error: e.message }); console.error(e.message); res.status(502).json({ error: 'Could not start checkout. Try again later.' }); }
  }));

  // Stripe calls this. No login: the signature is the proof. index.js keeps the raw body for it (req.rawBody).
  app.post('/api/credits/webhook', d.ah(async (req, res) => {
    if (!verifyStripeSignature(req.rawBody, req.headers['stripe-signature'], stripeHook())) return res.status(400).json({ error: 'Bad signature' });
    let change = null, storageUid = null, sponsored = null;
    try {
      storageUid = d.storageEvent ? await d.storageEvent(req.body) : null; // subscription and invoice events belong to the storage plan (server/storage.js)
      if (!storageUid) sponsored = d.sponsoredEvent ? d.sponsoredEvent(req.body) : null; // a sponsored server's payment or refund (server/sponsored.js)
      if (!storageUid && !sponsored) change = handleStripeEvent(req.body, d.db());
    } catch (e) { console.error('Credits webhook error:', e); return res.status(500).json({ error: 'Failed' }); } // Stripe retries
    if (storageUid) { d.save(); if (d.storageChanged) d.storageChanged(storageUid); }
    if (sponsored) d.save();
    if (change) { d.save(); const u = d.db().users[change.uid]; if (u) push(u, change.delta, change.reason); }
    res.json({ received: true });
  }));
}

module.exports = {
  EARN, PACKS, QUESTS, acct, grant, spend, claw, normalize, quality, similar, typingProblem,
  noteChannelMessage, rewardMessage, noteReaction, questList, claimQuest, view, events, shop, pthemes, ads, STREAK_MILESTONES, streakView,
  verifyStripeSignature, stripeRequest, createSession, STRIPE_TAX, createCheckout, handleStripeEvent, purchasesEnabled, register,
  _reset: () => { spoke.clear(); seen.clear(); },
};
