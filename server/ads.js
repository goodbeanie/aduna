// Ads: the opt-in, no-nagging kind.
//
// Two things only, both on the Quests and Shop pages. Nothing in chat, voice, profiles or popups, ever.
//   1. "Watch a sponsor, earn credits": a person taps a button, sees one sponsor card for a few seconds and gets a small reward. A few per day.
//   2. A "Sponsored" card, shown quietly among the quests and in the shop. One card, a picture, no sound, no autoplay.
//
// Like credits.js this file has no Express / database imports: plain functions over a user record (`user.ads`), so they can be unit tested
// (server/ads-logic-test.js). credits.js wires them to the routes and hands in `grant`.
//
// The ads themselves come from the ADS_JSON environment variable (a JSON array), so sponsors can be added without a code change:
//   [{"id":"acme","sponsor":"Acme Games","title":"Try Acme Quest","body":"A free co-op game.","image":"https://example.com/a.png","url":"https://example.com/acme"}]
// With no ADS_JSON, or an empty list, the whole feature is off and nothing is shown. A real ad network can be added later by filling the
// catalog from its server-side callback instead; the rules below (server-side timer, daily cap, one reward per view) stay the same.
//
// Where the safety lives:
//   * The reward amount, the timer and the caps are all decided here on the server. The browser only says "start" and "finish".
//   * A view has to be started (the server remembers when) and finished no sooner than `minViewMs` later. It can only be finished once.
//   * An honest limit: a script can wait the timer out. The daily cap, the cooldown and the new-account wait are what keep that cheap.
const crypto = require('crypto');

const ADS = {
  reward: 8,                 // credits per watched sponsor
  dailyMax: 5,               // most rewarded views per UTC day
  minViewMs: 15_000,         // the earliest a view can be finished
  maxViewMs: 10 * 60_000,    // a view not finished within this long is thrown away
  cooldownMs: 60_000,        // at least this long between two rewarded views
};

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
const httpsUrl = (v) => { try { const u = new URL(String(v)); return u.protocol === 'https:' ? u.toString() : null; } catch { return null; } };
const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

// The sponsors that may be shown. Anything malformed is dropped, so a typo in the config can never break the page or show a bad link.
function catalog(env = process.env) {
  let raw;
  try { raw = JSON.parse(env.ADS_JSON || '[]'); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out = [], ids = new Set();
  for (const a of raw.slice(0, 20)) {
    const id = String(a?.id ?? '');
    const url = httpsUrl(a?.url);
    const image = a?.image ? httpsUrl(a.image) : '';
    const title = clip(a?.title, 60), sponsor = clip(a?.sponsor, 40);
    if (!/^[a-z0-9_-]{1,40}$/.test(id) || ids.has(id) || !url || image === null || !title || !sponsor) continue;
    ids.add(id);
    out.push({ id, sponsor, title, body: clip(a?.body, 140), image: image || '', url });
  }
  return out;
}

// Google AdSense, optional. ADSENSE_CLIENT is the publisher id ("ca-pub-1234567890123456") and ADSENSE_SLOT the ad unit's number.
// Both must look right or AdSense stays off. Used for the display card in the Shop only; security.js opens the CSP for Google when it is set.
function adsenseConfig(env = process.env) {
  const client = String(env.ADSENSE_CLIENT || '').trim(), slot = String(env.ADSENSE_SLOT || '').trim();
  return /^ca-pub-\d{10,20}$/.test(client) && /^\d{5,20}$/.test(slot) ? { client, slot } : null;
}

function rec(u, now) {
  const a = u.ads || (u.ads = {});
  if (!Number.isFinite(a.total)) a.total = 0;
  if (!Number.isFinite(a.lastAt)) a.lastAt = 0;
  if (!a.today || a.today.day !== dayKey(now)) a.today = { day: dayKey(now), watched: 0 };
  if (a.pending && typeof a.pending !== 'object') a.pending = null;
  return a;
}

// One sponsor per person per day for the quiet card, so it does not flicker between visits.
function sponsoredFor(u, now, cat) {
  if (!cat.length) return null;
  const h = crypto.createHash('sha1').update(dayKey(now) + ':' + u.id).digest();
  return cat[h.readUInt32BE(0) % cat.length];
}

const publicAd = (a) => ({ id: a.id, sponsor: a.sponsor, title: a.title, body: a.body, image: a.image, url: a.url });

// What the Quests / Shop pages get. `enabled: false` means show nothing at all.
// `rewarded` and `sponsored` are the two feature switches (server/features.js: 'rewarded-ads' and 'sponsored-card'), already worked out for this person.
function view(u, { now = Date.now(), env = process.env, unlocksAt = 0, rewarded = true, sponsored = true } = {}) {
  const cat = catalog(env), adsense = adsenseConfig(env);
  if ((!cat.length && !adsense) || (!rewarded && !sponsored)) return { enabled: false };
  const a = rec(u, now);
  const left = Math.max(0, ADS.dailyMax - a.today.watched);
  const nextAt = a.lastAt + ADS.cooldownMs;
  return {
    enabled: true,
    rewarded: !!rewarded && cat.length > 0,   // the watch-for-credits button needs our own sponsors (a view is timed and paid here)
    reward: ADS.reward, dailyMax: ADS.dailyMax, watchedToday: a.today.watched, left,
    seconds: Math.round(ADS.minViewMs / 1000),
    nextAt: nextAt > now ? nextAt : null,
    locked: unlocksAt > now,
    sponsored: sponsored && cat.length ? publicAd(sponsoredFor(u, now, cat)) : null,
    adsense: sponsored ? adsense : null,      // { client, slot } or null
  };
}

// Starts a rewarded view. { ok, token, ad, seconds } or { status, error }.
function start(u, { now = Date.now(), env = process.env, unlocksAt = 0 } = {}) {
  const cat = catalog(env);
  if (!cat.length) return { status: 404, error: 'There are no sponsors right now' };
  if (now < unlocksAt) return { status: 403, error: 'Rewards unlock 30 minutes after you sign up', unlocksAt };
  const a = rec(u, now);
  if (a.today.watched >= ADS.dailyMax) return { status: 429, error: 'You have watched all of today’s sponsors. Come back tomorrow.' };
  if (now - a.lastAt < ADS.cooldownMs) return { status: 429, error: 'Give it a minute before the next one', nextAt: a.lastAt + ADS.cooldownMs };
  const ad = cat[crypto.randomInt(cat.length)];
  const token = crypto.randomBytes(16).toString('hex');
  a.pending = { token, adId: ad.id, startedAt: now };
  return { ok: true, token, ad: publicAd(ad), seconds: Math.round(ADS.minViewMs / 1000) };
}

// Finishes a rewarded view and pays once. `grant` is credits.grant. { ok, amount } or { status, error }.
function complete(u, token, { grant, now = Date.now(), env = process.env, unlocksAt = 0 } = {}) {
  if (now < unlocksAt) return { status: 403, error: 'Rewards unlock 30 minutes after you sign up', unlocksAt };
  const a = rec(u, now);
  const p = a.pending;
  if (!p || typeof token !== 'string' || token.length !== 32 || p.token !== token) return { status: 400, error: 'That view is not valid' };
  const age = now - p.startedAt;
  if (age > ADS.maxViewMs) { a.pending = null; return { status: 410, error: 'That view timed out. Start another.' }; }
  if (age < ADS.minViewMs) return { status: 425, error: 'Keep watching a little longer', waitMs: ADS.minViewMs - age };
  const ad = catalog(env).find((x) => x.id === p.adId);
  a.pending = null;                                  // cleared before paying: a view can only ever pay once
  if (a.today.watched >= ADS.dailyMax) return { status: 429, error: 'You have watched all of today’s sponsors. Come back tomorrow.' };
  a.today.watched++; a.total++; a.lastAt = now;
  const amount = ADS.reward;
  const balance = grant(u, amount, 'ad', { note: ad ? ad.sponsor : 'Sponsor', now });
  return { ok: true, amount, balance };
}

module.exports = { ADS, catalog, adsenseConfig, view, start, complete, sponsoredFor };
