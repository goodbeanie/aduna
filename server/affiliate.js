'use strict';
// The affiliate program (the /affiliate page). A creator submits a video about Aduna from a platform (YouTube, TikTok, Instagram and so on) and
// picks the name for their link. A reviewer watches it, sets how good it is, and the first approved video makes the person an affiliate. Every
// approved video pays credits: a base amount for how long it is, times a multiplier for what it says.
//
// Stored in db.affiliates[userId]:
//   { userId, slug, slugKey, status: 'pending' | 'approved' | 'revoked', appliedAt, approvedAt, earned, joined, joins: { day, n }, serverId?,
//     videos: [{ id, platform, url, key, seconds, note, status: 'pending' | 'approved' | 'rejected', quality, credits, reviewNote, at, reviewedAt, reviewedBy }] }
// Once approved, /<slug> is the person's sign-up link (see "people who join through a link" below).
// This file is plain logic (no database, no clock of its own) so it can be tested alone; routes are in index.js.

const crypto = require('crypto');

const LIMITS = {
  slugMin: 3, slugMax: 24, noteMax: 300, urlMax: 300,
  pendingMax: 3,      // videos waiting for review at once
  monthlyMax: 3,      // videos a person can send in one calendar month (rejected ones do not count)
  maxSeconds: 3 * 3600,
  keep: 200,          // videos kept on one person (the oldest rejected ones go first)
};

// What a video earns. Credits for how long it is (a video of exactly 90 seconds counts as the shorter band) ...
const BANDS = [[29, 20], [90, 50], [300, 100], [Infinity, 150]]; // [longest seconds in the band, credits]
const baseFor = (seconds) => BANDS.find(([max]) => seconds <= max)[1];
// ... times what it says. A reviewer picks one; "not approved" is a rejection, not a multiplier.
const QUALITY = {
  mention: { label: 'Mention only', times: 0.5, hint: 'Aduna comes up in passing' },
  standard: { label: 'Standard', times: 1, hint: 'A clear, accurate video about Aduna' },
  showcase: { label: 'Showcase', times: 1.5, hint: 'Walks through real features and shows the link' },
  tutorial: { label: 'Tutorial', times: 2, hint: 'Teaches something useful, like a server or a theme' },
};
const payoutFor = (seconds, quality) => (QUALITY[quality] && Number.isInteger(seconds) && seconds > 0 ? Math.round(baseFor(seconds) * QUALITY[quality].times) : 0);

const TIERS = [[10, 'gold'], [3, 'silver'], [1, 'affiliate']]; // approved videos needed
const tierOf = (rec) => {
  const n = rec ? (rec.videos || []).filter((v) => v.status === 'approved').length : 0;
  const t = TIERS.find(([min]) => n >= min);
  return rec && rec.status === 'approved' && t ? t[1] : null;
};

// ----- links -----
// A link has to belong to the platform whose button was pressed AND look like a video (not a profile or the home page). Short links are allowed
// where the platform has them. The check cannot see the video itself: a reviewer does that.
const id11 = /^[\w-]{11}$/;
const PLATFORMS = [
  { id: 'youtube', name: 'YouTube', hosts: ['youtube.com', 'youtu.be'],
    match: (h, p, q) => {
      if (h === 'youtu.be') { const m = /^\/([\w-]{11})\/?$/.exec(p); return m && { key: 'yt:' + m[1] }; }
      let m = /^\/(?:shorts|live)\/([\w-]{11})\/?$/.exec(p);
      if (m) return { key: 'yt:' + m[1] };
      const v = q.get('v');
      return /^\/watch\/?$/.test(p) && id11.test(v || '') ? { key: 'yt:' + v, keep: ['v'] } : null;
    } },
  { id: 'tiktok', name: 'TikTok', hosts: ['tiktok.com'],
    match: (h, p) => {
      let m = /^\/@[\w.]{1,40}\/video\/(\d{8,25})\/?$/.exec(p);
      if (m) return { key: 'tt:' + m[1] };
      m = /^\/([\w-]{6,16})\/?$/.exec(p);
      return m && (h.startsWith('vm.') || h.startsWith('vt.')) ? { key: 'tt:' + m[1] } : null;
    } },
  { id: 'instagram', name: 'Instagram', hosts: ['instagram.com', 'instagr.am'],
    match: (h, p) => { const m = /^(?:\/[\w.]{1,30})?\/(?:reel|reels|p|tv)\/([\w-]{5,20})\/?$/.exec(p); return m && { key: 'ig:' + m[1] }; } },
  { id: 'twitch', name: 'Twitch', hosts: ['twitch.tv'],
    match: (h, p) => {
      if (h === 'clips.twitch.tv') { const m = /^\/([\w-]{8,100})\/?$/.exec(p); return m && { key: 'tw:' + m[1] }; }
      let m = /^\/videos\/(\d{6,15})\/?$/.exec(p);
      if (m) return { key: 'tw:v' + m[1] };
      m = /^\/\w{2,25}\/clip\/([\w-]{8,100})\/?$/.exec(p);
      return m && { key: 'tw:' + m[1] };
    } },
  { id: 'x', name: 'X', hosts: ['x.com', 'twitter.com'],
    match: (h, p) => { const m = /^\/\w{1,15}\/status\/(\d{5,25})\/?$/.exec(p); return m && { key: 'x:' + m[1] }; } },
  { id: 'facebook', name: 'Facebook', hosts: ['facebook.com', 'fb.watch'],
    match: (h, p, q) => {
      if (h === 'fb.watch') { const m = /^\/([\w-]{5,20})\/?$/.exec(p); return m && { key: 'fb:' + m[1] }; }
      let m = /^\/(?:reel|share\/[vr])\/([\w-]{5,30})\/?$/.exec(p);
      if (m) return { key: 'fb:' + m[1] };
      m = /^\/[\w.-]{1,80}\/videos\/(\d{5,25})\/?$/.exec(p);
      if (m) return { key: 'fb:' + m[1] };
      const v = q.get('v');
      return /^\/watch\/?$/.test(p) && /^\d{5,25}$/.test(v || '') ? { key: 'fb:' + v, keep: ['v'] } : null;
    } },
  { id: 'snapchat', name: 'Snapchat', hosts: ['snapchat.com'],
    match: (h, p) => { const m = /^\/(?:spotlight|t)\/([\w-]{5,80})\/?$/.exec(p); return m && { key: 'sc:' + m[1] }; } },
  { id: 'kick', name: 'Kick', hosts: ['kick.com'],
    match: (h, p) => { const m = /^(?:\/[\w-]{2,25}\/clips\/(clip_\w{10,40})|\/video\/([\w-]{10,50}))\/?$/.exec(p); return m && { key: 'ki:' + (m[1] || m[2]) }; } },
];
const platformById = (id) => PLATFORMS.find((p) => p.id === id) || null;
const platformList = () => PLATFORMS.map((p) => ({ id: p.id, name: p.name }));
const hostIs = (host, domain) => host === domain || host.endsWith('.' + domain);

// { ok: true, url, key } with the link cleaned up (https, no tracking, no #), or { error }. `platform` is the button the person pressed.
function checkLink(platform, raw) {
  const plat = platformById(platform);
  if (!plat) return { error: 'Pick the app the video is on' };
  const text = String(raw || '').trim();
  if (!text) return { error: `Paste the link to your ${plat.name} video` };
  if (text.length > LIMITS.urlMax) return { error: 'That link is too long' };
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : 'https://' + text); } catch { return { error: 'That does not look like a link' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'That does not look like a link' };
  if (u.username || u.password || u.port) return { error: 'That link has parts we do not accept' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!plat.hosts.some((d) => hostIs(host, d))) return { error: `That is not a ${plat.name} link. Use the link from the ${plat.name} app or website.` };
  const m = plat.match(host, u.pathname, u.searchParams);
  if (!m) return { error: `That ${plat.name} link is not a video. Open the video and copy its link.` };
  const keep = new URLSearchParams();
  for (const k of m.keep || []) keep.set(k, u.searchParams.get(k));
  const search = keep.toString();
  return { ok: true, url: `https://${host}${u.pathname}${search ? '?' + search : ''}`, key: m.key };
}

// ----- link names (aduna.dpdns.org/<name>) -----
// Names that are real pages or sound official. The list is on purpose too long rather than too short.
const RESERVED = new Set(('admin api app affiliate affiliates login logout signup register invite invites join payments payment shop store settings profile profiles ' +
  'terms privacy download downloads clips clip creator creators artist artists help support staff team mod mods moderator moderators official aduna security ' +
  'status about blog news press legal contact abuse report reports webhook webhooks bot bots oauth auth static assets public updates favicon robots sitemap ' +
  'www mail email root system null undefined me you everyone here channels servers server dm dms friends groups gift gifts boost boosts plus premium credits ' +
  'reset recover recovery verify forgot password passkey passkeys fonts sounds icons deco badges tossface landing manifest socket').split(/\s+/));
function cleanSlug(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return { error: 'Choose a name for your link' };
  if (text.length < LIMITS.slugMin || text.length > LIMITS.slugMax) return { error: `Your link name needs ${LIMITS.slugMin} to ${LIMITS.slugMax} characters` };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(text)) return { error: 'Use only letters, numbers and single dashes, and start and end with a letter or number' };
  if (RESERVED.has(text)) return { error: 'That name is not available' };
  return { ok: true, slug: text };
}
const slugTaken = (records, slug, exceptUid) => records.some((r) => r.userId !== exceptUid && r.slugKey === slug);

// ----- people who join through a link -----
// A person who signs up after opening /<name> is paid for once their email is verified (or at once when the site has no email check):
// they get newUserPay, and the link's owner gets joinPay for up to dailyMax paid joins a day. Past the cap the new person is still paid and the owner is not.
const REFERRAL = { joinPay: 25, newUserPay: 50, dailyMax: 20, cookieDays: 7 };
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const isApproved = (rec) => !!rec && rec.status === 'approved';
const bySlug = (records, slug) => {
  const key = String(slug || '').toLowerCase();
  return key && !RESERVED.has(key) ? records.find((r) => r.status === 'approved' && r.slugKey === key) || null : null;
};
const joinsToday = (rec, now) => (rec && rec.joins && rec.joins.day === dayKey(now) ? rec.joins.n : 0);

// Counts one verified join on the owner's record. { ok: false } if they are not an approved affiliate (nobody is paid).
function settleJoin(rec, now) {
  if (!isApproved(rec)) return { ok: false, newUser: 0, affiliate: 0 };
  const paid = joinsToday(rec, now) < REFERRAL.dailyMax;
  rec.joined = (rec.joined || 0) + 1;
  if (paid) {
    rec.joins = { day: dayKey(now), n: joinsToday(rec, now) + 1 };
    rec.earned = (rec.earned || 0) + REFERRAL.joinPay;
  }
  return { ok: true, newUser: REFERRAL.newUserPay, affiliate: paid ? REFERRAL.joinPay : 0 };
}

// ----- the creator's server -----
// An approved affiliate can offer one server they own to people who join through their link (a checkbox on the setup screen).
const serverOk = (s, userId) => !!s && s.ownerId === userId && s.visibility !== 'private' && !s.listingHold;
// the server to offer right now, or null (it may have been deleted, handed over or made private since it was picked)
const serverFor = (rec, servers) => {
  const s = isApproved(rec) && rec.serverId && servers ? servers[rec.serverId] : null;
  return serverOk(s, rec && rec.userId) ? s : null;
};
// `server` is the picked server record, or null to stop offering one
function pickServer(rec, server) {
  if (!isApproved(rec)) return { ok: false, status: 403, error: 'You can offer a server once you are an affiliate' };
  if (server === null) { delete rec.serverId; return { ok: true }; }
  if (!serverOk(server, rec.userId)) return { ok: false, status: 400, error: 'Pick a server you own that is not private' };
  rec.serverId = server.id;
  return { ok: true };
}

// ----- sending and reviewing -----
const monthKey = (t) => new Date(t).toISOString().slice(0, 7);
const newId = () => crypto.randomBytes(6).toString('hex');
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);

// Sends a video. `rec` is the person's record or null, `records` all of them (for names and duplicate links). Returns { ok, rec, video } or { ok: false, status, error }.
// The record is only changed when it works, so the caller can drop it in the database as is.
function submit(rec, userId, input, records, now) {
  const fail = (status, error) => ({ ok: false, status, error });
  const body = input || {};
  if (rec && rec.status === 'revoked') return fail(403, 'Your affiliate access was removed. Contact us if you think that is a mistake.');
  const link = checkLink(body.platform, body.url);
  if (!link.ok) return fail(400, link.error);
  const seconds = body.seconds;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > LIMITS.maxSeconds) return fail(400, 'Say how long the video is, from 1 second up to 3 hours');
  const note = clean(body.note, LIMITS.noteMax);
  let slug = rec ? rec.slug : null;
  if (!rec || rec.status === 'pending') { // the name can still change until the first video is approved
    if (body.slug !== undefined || !rec) {
      const s = cleanSlug(body.slug);
      if (!s.ok) return fail(400, s.error);
      if (slugTaken(records, s.slug, userId)) return fail(409, 'Someone already has that name. Try another.');
      slug = s.slug;
    }
  }
  const mine = rec ? rec.videos : [];
  const dupe = records.some((r) => r.videos.some((v) => v.key === link.key && v.status !== 'rejected')); // a rejected link is free to send again
  if (dupe) return fail(409, 'That video was already sent');
  if (mine.filter((v) => v.status === 'pending').length >= LIMITS.pendingMax) return fail(429, `You can have ${LIMITS.pendingMax} videos waiting for review at once`);
  if (mine.filter((v) => v.status !== 'rejected' && monthKey(v.at) === monthKey(now)).length >= LIMITS.monthlyMax) return fail(429, `You can send ${LIMITS.monthlyMax} videos a month`);
  const out = rec || { userId, slug, slugKey: slug, status: 'pending', appliedAt: now, approvedAt: null, earned: 0, videos: [] };
  out.slug = out.slugKey = slug;
  out.videos = out.videos.filter((v) => !(v.key === link.key && v.status === 'rejected')); // sending a rejected video again replaces the old line
  const video = { id: newId(), platform: body.platform, url: link.url, key: link.key, seconds, note, status: 'pending', at: now };
  out.videos.push(video);
  if (out.videos.length > LIMITS.keep) {
    const gone = out.videos.find((v) => v.status === 'rejected');
    if (gone) out.videos.splice(out.videos.indexOf(gone), 1);
  }
  return { ok: true, rec: out, video };
}

// The person takes back a video that has not been looked at.
function withdraw(rec, videoId) {
  const v = rec && rec.videos.find((x) => x.id === videoId);
  if (!v) return { ok: false, status: 404, error: 'Video not found' };
  if (v.status !== 'pending') return { ok: false, status: 409, error: 'That video was already reviewed' };
  rec.videos.splice(rec.videos.indexOf(v), 1);
  return { ok: true };
}

// A reviewer's decision. { action: 'approve', quality, seconds?, note? } or { action: 'reject', note }. On approve, returns the credits to hand over.
// The first approved video makes the person an affiliate. Nobody reviews their own (the caller checks that too).
function review(rec, videoId, reviewerId, input, now) {
  const fail = (status, error) => ({ ok: false, status, error });
  const v = rec && rec.videos.find((x) => x.id === videoId);
  if (!v) return fail(404, 'Video not found');
  if (rec.userId === reviewerId) return fail(403, 'You cannot review your own video');
  if (v.status !== 'pending') return fail(409, 'That video was already reviewed');
  if (rec.status === 'revoked') return fail(409, 'This person is no longer an affiliate');
  const body = input || {};
  const note = clean(body.note, LIMITS.noteMax);
  if (body.action === 'reject') {
    if (!note) return fail(400, 'Say why, so they can fix it');
    Object.assign(v, { status: 'rejected', credits: 0, reviewNote: note, reviewedAt: now, reviewedBy: reviewerId });
    return { ok: true, credits: 0, video: v };
  }
  if (body.action !== 'approve') return fail(400, 'Approve or reject');
  if (!QUALITY[body.quality]) return fail(400, 'Pick what the video says');
  let seconds = v.seconds;
  if (body.seconds !== undefined) { // the reviewer watched it: their length wins over what was typed
    if (!Number.isInteger(body.seconds) || body.seconds < 1 || body.seconds > LIMITS.maxSeconds) return fail(400, 'The length must be from 1 second up to 3 hours');
    seconds = body.seconds;
  }
  const credits = payoutFor(seconds, body.quality);
  Object.assign(v, { status: 'approved', seconds, quality: body.quality, credits, reviewNote: note, reviewedAt: now, reviewedBy: reviewerId });
  rec.earned = (rec.earned || 0) + credits;
  if (rec.status === 'pending') { rec.status = 'approved'; rec.approvedAt = now; }
  return { ok: true, credits, video: v, becameAffiliate: rec.approvedAt === now };
}

// A creator takes affiliate access away. Videos and credits already paid stay as they are.
function revoke(rec) {
  if (!rec) return false;
  rec.status = 'revoked';
  return true;
}

// What the person sees of their own record.
function view(rec, now = Date.now()) {
  if (!rec) return null;
  return {
    status: rec.status, slug: rec.slug, tier: tierOf(rec), earned: rec.earned || 0,
    joined: rec.joined || 0, joinsToday: joinsToday(rec, now), serverId: rec.serverId || null,
    videos: rec.videos.slice().sort((a, b) => b.at - a.at).map((v) => ({
      id: v.id, platform: v.platform, url: v.url, seconds: v.seconds, note: v.note || '', status: v.status, at: v.at,
      ...(v.status === 'approved' ? { quality: v.quality, credits: v.credits } : {}),
      ...(v.status !== 'pending' ? { reviewNote: v.reviewNote || '' } : {}),
    })),
  };
}

module.exports = { LIMITS, BANDS, QUALITY, TIERS, RESERVED, REFERRAL, PLATFORMS, baseFor, payoutFor, tierOf, platformList, platformById, checkLink, cleanSlug, slugTaken, bySlug, isApproved, joinsToday, settleJoin, serverOk, serverFor, pickServer, submit, withdraw, review, revoke, view, monthKey };
