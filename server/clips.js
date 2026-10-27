// Clips (short vertical videos): the rules, with no Express and no database, so clips-logic-test.js can test them alone.
//
// Storage plan (Cloudflare R2's free tier is 10 GB in total):
//   - everything that is not a clip (profile pictures, banners, emoji, attachments) is capped by STORAGE_LIMIT_GB, default 4 (see db.js)
//   - clips are capped by CLIPS_LIMIT_GB, default 5, and live in their OWN bucket (CLIPS_R2_BUCKET), so the two never eat each other's room
//   - a clip's video and poster are deleted after CLIPS_TTL_DAYS (default 7). The record stays, with its numbers (views, likes, reports,
//     size, length, who posted it and when), so there is still proof of what happened. Only the bytes go.
//
// A clip record (kept in store.db.clips, sealed in Postgres like everything else):
//   { id, owner, caption, state, key, posterKey, size, posterSize, seconds, width, height,
//     createdAt, liveAt, expiresAt, purgedAt, views, likes, likedBy, reports, reportCount, hold, credits, why }
// state: 'pending'  the upload link was handed out, the bytes are not checked yet (holds its declared size in the cap)
//        'live'     checked, in the feed
//        'hidden'   enough reports came in; out of the feed until a moderator looks (still holds storage)
//        'removed'  the owner or a moderator took it down (bytes deleted)
//        'rejected' the upload never arrived or failed the checks (bytes deleted)
//        'expired'  past its time limit (bytes deleted)
const listing = require('./listing');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DAY = 24 * 3600 * 1000;
const HOLDING = new Set(['pending', 'live', 'hidden']); // states that hold bytes in the bucket
const MAX_POSTER = 200 * 1024;
const POSTER_TYPES = ['image/jpeg', 'image/webp', 'image/png'];
const MIN_VIDEO = 1024;
const MAX_CAPTION = 150;
const FIRST_BYTES = 256 * 1024; // how much of the start of a video is read to find its header (the index must be up front)

const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
function settings(env = process.env) {
  return {
    maxBytes: num(env.CLIP_MAX_MB, 8) * MB,
    maxSeconds: num(env.CLIP_MAX_SECONDS, 30),
    limitBytes: num(env.CLIPS_LIMIT_GB, 5) * GB,
    ttlMs: num(env.CLIPS_TTL_DAYS, 7) * DAY,
    dailyLimit: num(env.CLIP_DAILY_LIMIT, 5),
    credits: Math.max(0, Math.floor(Number(env.CLIP_UPLOAD_CREDITS) || 0)), // 0 = uploads are free
    reportsToHide: num(env.CLIP_REPORTS_TO_HIDE, listing.LISTING.reportsToHide),
    publicUrl: String(env.CLIPS_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    maxPending: 2,           // upload links a person can hold open at once
    pendingMs: 15 * 60_000,  // an upload that is not finished by then is dropped
  };
}

// ---------- the request ----------
// What the app says it is about to upload. These numbers are only claims (the bytes are checked after the upload), but a
// request that is already over the limits is refused before any link is handed out.
function checkRequest(body, cfg, words = []) {
  const b = body && typeof body === 'object' ? body : {};
  const int = (v) => (Number.isInteger(v) ? v : NaN);
  const size = int(b.size), posterSize = int(b.posterSize);
  if (!(size >= MIN_VIDEO)) return { error: 'Choose a video first' };
  if (size > cfg.maxBytes) return { error: `Clips can be at most ${Math.round(cfg.maxBytes / MB * 10) / 10} MB` };
  if (!(posterSize > 0) || posterSize > MAX_POSTER) return { error: 'The cover picture is missing or too big' };
  const posterType = b.posterType === undefined ? 'image/jpeg' : String(b.posterType);
  if (!POSTER_TYPES.includes(posterType)) return { error: 'The cover picture must be a JPEG, WebP or PNG' };
  const seconds = Number(b.seconds);
  if (!(seconds > 0)) return { error: 'Choose a video first' };
  if (seconds > cfg.maxSeconds) return { error: `Clips can be at most ${cfg.maxSeconds} seconds` };
  const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 4096 ? v : null);
  const width = dim(b.width), height = dim(b.height);
  if (!width || !height) return { error: 'The size of the video is missing' };
  if (Math.max(width, height) > 1280) return { error: 'Clips are 720p at most (1280 on the long side)' };
  if (height <= width) return { error: 'Clips must be portrait (taller than wide)' };
  const caption = String(b.caption ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CAPTION + 1);
  if (caption.length > MAX_CAPTION) return { error: `Captions can be at most ${MAX_CAPTION} characters` };
  if (listing.hasLink(caption)) return { error: 'Captions cannot contain links' };
  if (listing.blockedWord(caption, words)) return { error: 'The caption contains words that are not allowed' };
  return { value: { size, posterSize, posterType, seconds: Math.round(seconds * 10) / 10, width, height, caption } };
}

// ---------- the bytes ----------
// Reads the start of an MP4 file: the "ftyp" signature, then the "moov" box, which has to come BEFORE the video data
// (that is what lets a clip start playing before it has finished downloading). Returns { seconds } or { error }.
const BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'mmp4', '3gp4', '3gp5', '3gp6']);
function sniffMp4(buf) {
  const bad = (error) => ({ error });
  if (!Buffer.isBuffer(buf) || buf.length < 32 || buf.toString('latin1', 4, 8) !== 'ftyp') return bad('That is not an MP4 video');
  if (!BRANDS.has(buf.toString('latin1', 8, 12))) return bad('That is not an MP4 video');
  let pos = 0, moov = -1;
  while (pos + 8 <= buf.length) {
    let size = buf.readUInt32BE(pos), head = 8;
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (size === 1) { if (pos + 16 > buf.length) break; size = Number(buf.readBigUInt64BE(pos + 8)); head = 16; }
    if (type === 'moov') { moov = pos + head; break; }
    if (type === 'mdat') return bad('The video must have its index at the start (fast start)');
    if (size < head) return bad('That is not an MP4 video');
    pos += size;
  }
  if (moov < 0) return bad('The video must have its index at the start (fast start)');
  for (let p = moov; p + 8 <= buf.length;) {
    const size = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'mvhd') {
      const v1 = buf[p + 8] === 1;
      if (p + (v1 ? 40 : 28) > buf.length) break;
      const scale = buf.readUInt32BE(p + (v1 ? 28 : 20));
      const dur = v1 ? Number(buf.readBigUInt64BE(p + 32)) : buf.readUInt32BE(p + 24);
      if (!scale || !Number.isFinite(dur)) return bad('That is not an MP4 video');
      return { seconds: dur / scale };
    }
    if (size < 8) break;
    p += size;
  }
  return bad('That is not an MP4 video');
}

// ---------- room ----------
const holding = (c) => HOLDING.has(c.state) && !c.purgedAt;
const usedBytes = (clips, exceptId) => clips.reduce((n, c) => (holding(c) && c.id !== exceptId ? n + (c.size || 0) + (c.posterSize || 0) : n), 0);
const hasRoom = (clips, bytes, cfg, exceptId) => usedBytes(clips, exceptId) + bytes <= cfg.limitBytes;
const dayStart = (now) => now - (now % DAY); // UTC midnight
const uploadsToday = (clips, uid, now) => clips.filter((c) => c.owner === uid && c.createdAt >= dayStart(now)).length;
const pendingOf = (clips, uid) => clips.filter((c) => c.owner === uid && c.state === 'pending').length;

// ---------- what to clean up ----------
// expire: past their time. abandoned: an upload nobody finished. retry: taken down earlier, but the bytes could not be deleted then.
function due(clips, now, cfg) {
  const out = { expire: [], abandoned: [], retry: [] };
  for (const c of clips) {
    if (c.state === 'pending' && now - c.createdAt >= cfg.pendingMs) out.abandoned.push(c);
    else if ((c.state === 'live' || c.state === 'hidden') && c.expiresAt <= now) out.expire.push(c);
    else if ((c.state === 'removed' || c.state === 'rejected' || c.state === 'expired') && (c.key || c.posterKey)) out.retry.push(c);
  }
  return out;
}
// Call once the bytes are gone. Keeps every number; drops the file names and the list of who liked it.
function purge(c, state, now) {
  c.state = state;
  c.purgedAt = c.purgedAt || now;
  c.key = null; c.posterKey = null;
  c.likedBy = [];
  return c;
}
const objectsOf = (c) => [c.key, c.posterKey].filter(Boolean);

// ---------- reports, likes ----------
function addReport(c, uid, reason, details, now) {
  c.reports = (c.reports || []).filter((r) => r.by !== uid);
  c.reports.push({ by: uid, reason, details, at: now, caption: c.caption });
  if (c.reports.length > 200) c.reports = c.reports.slice(-200);
  c.reportCount = (c.reportCount || 0) + 1; // never goes down, even when a moderator clears the list
}
const shouldHide = (c, users, now, cfg) => c.state === 'live' && !c.hold && listing.countedReports(c.reports, users, now) >= cfg.reportsToHide;
function toggleLike(c, uid) {
  c.likedBy = c.likedBy || [];
  const i = c.likedBy.indexOf(uid);
  if (i >= 0) c.likedBy.splice(i, 1); else c.likedBy.push(uid);
  c.likes = c.likedBy.length;
  return i < 0;
}

// ---------- what clients see ----------
const isLive = (c, now) => c.state === 'live' && !c.purgedAt && c.expiresAt > now;
function view(c, users, uid, cfg) {
  const o = users[c.owner];
  return {
    id: c.id, caption: c.caption || '',
    owner: { id: c.owner, username: o ? o.username : null, avatarImage: o ? o.avatarImage || null : null },
    url: `${cfg.publicUrl}/${c.key}`, poster: `${cfg.publicUrl}/${c.posterKey}`,
    seconds: c.seconds, width: c.width, height: c.height,
    views: c.views || 0, likes: c.likes || 0, liked: (c.likedBy || []).includes(uid), mine: c.owner === uid,
    createdAt: c.liveAt || c.createdAt, expiresAt: c.expiresAt,
  };
}
// the poster's own numbers, kept after the video is gone (no file names, no list of who liked it)
function ownerView(c) {
  return {
    id: c.id, caption: c.caption || '', state: c.state, why: c.why || null, seconds: c.seconds, size: c.size,
    views: c.views || 0, likes: c.likes || 0, reports: c.reportCount || 0,
    createdAt: c.createdAt, liveAt: c.liveAt || null, expiresAt: c.expiresAt || null, purgedAt: c.purgedAt || null,
    available: !c.purgedAt && (c.state === 'live' || c.state === 'hidden'),
  };
}
// sort 'new' pages with `before` (the liveAt of the last clip seen); sort 'top' pages with `offset`
function feed(clips, users, { uid, sort = 'new', before, offset = 0, limit = 10, now = Date.now() }, cfg) {
  let list = clips.filter((c) => isLive(c, now) && users[c.owner]);
  if (sort === 'top') {
    list.sort((a, b) => (b.likes || 0) * 5 + (b.views || 0) - ((a.likes || 0) * 5 + (a.views || 0)) || b.liveAt - a.liveAt);
    list = list.slice(Math.max(0, offset));
  } else {
    list.sort((a, b) => b.liveAt - a.liveAt);
    if (before > 0) list = list.filter((c) => c.liveAt < before);
  }
  const page = list.slice(0, Math.min(Math.max(1, limit), 20));
  return page.map((c) => view(c, users, uid, cfg));
}

module.exports = {
  MB, GB, DAY, MAX_POSTER, POSTER_TYPES, MAX_CAPTION, FIRST_BYTES, HOLDING,
  settings, checkRequest, sniffMp4, usedBytes, hasRoom, uploadsToday, pendingOf, due, purge, objectsOf,
  addReport, shouldHide, toggleLike, isLive, view, ownerView, feed,
};
