const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const store = require('./db');
const { sniffImage, cleanGif } = require('./images');
const credits = require('./credits');
const artistsLib = require('./artists'); // artists: apply, get reviewed, sell badges in the shop (see the "artists" block below)
const security = require('./security');
const totp = require('./totp');
const devicelogin = require('./devicelogin');
const passkeys = require('./passkeys');
const mailer = require('./mailer');
const webpush = require('web-push');
const { createPush, cleanPrefs } = require('./push');
const { createFcm } = require('./fcm');
const np = require('./notifprefs');
const listing = require('./listing');
const activityLib = require('./activity');
const clipsLib = require('./clips'); // clips: short vertical videos (see the "clips" block below)
const screenLib = require('./screen'); // clip screening: OpenAI moderation of frames, music recognition, re-post matching (see POST /api/clips/:id/complete)
const polls = require('./polls');
const calllog = require('./calllog');
const groupsLib = require('./groups');
const gallery = require('./themegallery');
const botsLib = require('./bots');
const botrun = require('./botrun');
const botstate = require('./botstate');
const botfetch = require('./botfetch');
const linkpreview = require('./linkpreview');
const { createBotHost } = require('./bothost');
const { createIce } = require('./turn');
const sandbox = require('./sandbox'); // starts its worker threads on first use, not at boot (each holds a WebAssembly runtime)

const PORT = process.env.PORT || 3000;
const MAX_MSG = 2000;
const MAX_PINS = 50; // pinned messages per channel
const MAX_CIPHER = 12000;

// ---------- secret ----------
// JWT_SECRET from the environment, otherwise a random secret kept (encrypted) in the database.
// It is filled in by start(), before the server accepts connections.
let SECRET = null;

// ---------- helpers ----------
const db = () => store.db;
// drop uploaded images that no profile points at (e.g. left over from a crash mid-upload)
const referencedImages = () => new Set([
  ...Object.values(store.db.users).flatMap((u) => [u.avatarImage, u.bannerImage]),
  ...Object.values(store.db.users).flatMap((u) => (u.clipCreator && u.clipCreator.profile ? [u.clipCreator.profile.avatarImage, u.clipCreator.profile.bannerImage] : [])), // a Clips creator's own icon and banner
  ...Object.values(store.db.servers).flatMap((sv) => [sv.iconImage, sv.bannerImage]), // server icon + banner
  ...Object.values(store.db.bots || {}).map((b) => b.avatarImage), // bot pictures (the bot's account points at the same image)
  ...Object.values(store.db.emojis).map((e) => e.imageId), // custom emoji pictures live in the same table
  ...Object.values(store.db.badges || {}).map((b) => b.image), // badge pictures (creator badges and artists' items); without this the startup cleanup deleted them
  ...Object.values(store.db.artists || {}).flatMap((a) => (Array.isArray(a.pieces) ? a.pieces : [])), // the pieces of art in an artist application
].filter(Boolean));
const now = () => Date.now();
const MAX_FILE = 20 * 1024 * 1024;          // largest file a person can attach
const FILE_SLACK = 4096;                    // DM files are encrypted in the browser, which adds a few bytes
// How long attachments are kept: files up to LARGE_ATTACHMENT_MB (default 10) for ATTACHMENT_TTL_DAYS (default 14),
// bigger files for LARGE_ATTACHMENT_TTL_DAYS (default 5) so they don't fill the storage.
const posNum = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback);
const ATTACH_RULES = {
  smallMs: posNum(process.env.ATTACHMENT_TTL_DAYS, 14) * 24 * 3600 * 1000,
  largeMs: posNum(process.env.LARGE_ATTACHMENT_TTL_DAYS, 5) * 24 * 3600 * 1000,
  thresholdBytes: posNum(process.env.LARGE_ATTACHMENT_MB, 10) * 1024 * 1024,
};
const MAX_ATTACH = 4;
// Types the client may render inline (as <img>, <video>, <audio> from a blob). Everything else is a download.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/webm']);
const GIPHY_KEY = process.env.GIPHY_API_KEY || '';
const isGifUrl = (u) => {
  try { const x = new URL(u); return x.protocol === 'https:' && /^(media\d*|i)\.giphy\.com$/.test(x.hostname) && String(u).length < 500; } catch { return false; }
};
const dim = (n) => (Number.isInteger(n) && n > 0 && n <= 20000 ? n : undefined);
const referencedFiles = () => new Set([
  ...Object.values(store.db.messages).flatMap((m) => (m.attachments || []).map((a) => a.id)),
  ...Object.values(store.db.dms).flatMap((m) => m.files || []),
  ...groups.referencedFiles(),
].filter(Boolean));

// Attachments are deleted after ATTACH_RULES (14 days, or 5 days for files over 10 MB) to keep storage small.
// The message stays; channel attachments are flagged `expired` so clients show a placeholder
// (DM clients see a 404 for the file and show the same placeholder).
async function expireOldAttachments() {
  const gone = new Set(await store.expireFiles(ATTACH_RULES));
  if (!gone.size) return 0;
  const changed = [];
  for (const m of Object.values(store.db.messages)) {
    let hit = false;
    for (const a of m.attachments || []) if (a.id && gone.has(a.id) && !a.expired) { a.expired = true; hit = true; }
    if (hit) changed.push(m);
  }
  if (changed.length) store.save();
  for (const m of changed) io.to('channel:' + m.channelId).emit('message:edited', { kind: 'channel', message: m });
  return gone.size;
}
const runCleanup = async () => { try { await store.pruneFiles(referencedFiles()); await expireOldAttachments(); } catch (e) { console.error(e); } };
const hex = /^#[0-9a-fA-F]{6}$/;
const clip = (s, n) => String(s ?? '').slice(0, n);

// ---------- roles & permissions ----------
// server.roles = [{ id, name, color, perms: [] }] ordered from highest to lowest (index 0 is the top role).
// server.everyone = perms every member has (the implicit @everyone role). server.memberRoles = { userId: [roleId] }.
// The owner always has every permission; a member with `administrator` has every permission too.
// Hierarchy: you can only change roles, and the members who hold them, that sit strictly below your own top role,
// and you can only hand out permissions you hold yourself. Servers saved before roles existed have none of these
// fields and behave exactly as before: only the owner can manage anything.
const PERMS = ['administrator', 'manageServer', 'manageRoles', 'manageChannels', 'manageMessages', 'kickMembers', 'mentionEveryone', 'postAnnouncements'];
const MAX_ROLES = 25;
const roleById = (s, id) => (s.roles || []).find((r) => r.id === id);
const heldRoleIds = (s, uid) => ((s.memberRoles || {})[uid] || []).filter((id) => roleById(s, id));
function permsOf(s, uid) {
  if (uid === s.ownerId) return new Set(PERMS);
  const set = new Set(s.everyone || []);
  for (const id of heldRoleIds(s, uid)) for (const p of roleById(s, id).perms) set.add(p);
  return set.has('administrator') ? new Set(PERMS) : set;
}
const can = (s, uid, perm) => !!s && s.members.includes(uid) && permsOf(s, uid).has(perm);
// position in the hierarchy: -1 owner, 0 top role ... Infinity = no role. Lower = more powerful.
function rankOf(s, uid) {
  if (uid === s.ownerId) return -1;
  const idx = heldRoleIds(s, uid).map((id) => s.roles.findIndex((r) => r.id === id));
  return idx.length ? Math.min(...idx) : Infinity;
}
// Bots sit in a server's member list, but they are not people: they do not count towards size, popularity, credits or "alone".
const humansOf = (s) => s.members.filter((id) => !db().users[id]?.bot);
const humanCount = (s) => humansOf(s).length;
const roleIndex = (s, id) => (s.roles || []).findIndex((r) => r.id === id);

// ---------- mentions ----------
// The client turns a typed @username into the token <@userId> before sending. The server only trusts a token when that
// user is a member of the server, and honours a plain "@everyone" only when the author has the mentionEveryone permission. Channel messages
// carry the result (mentions: [userId], everyone: bool) so every client can highlight and badge them. DMs are end-to-end
// encrypted, so the server never looks inside them; their mentions are drawn by the clients alone.
const MENTION_TOKEN = /<@([0-9a-f]{16})>/g;
const EVERYONE = /(?<![\w<@])@everyone(?![\w])/;
const MAX_MENTIONS = 50;
function parseMentions(content, server, authorId) {
  const found = new Set();
  for (const m of content.matchAll(MENTION_TOKEN)) {
    if (server.members.includes(m[1])) found.add(m[1]);
    if (found.size >= MAX_MENTIONS) break;
  }
  return { mentions: [...found], everyone: can(server, authorId, 'mentionEveryone') && EVERYONE.test(content) };
}

// ----- the creator account and badges -----
// An account whose VERIFIED email is one of CREATOR_EMAILS (default adunachatapp@gmail.com and nathankennethvc2@gmail.com) is a creator: it gets the Creator badge, a developer account and
// the Badges settings tab. Any number of accounts can use that address (see emailClaimed / emailTaken); each one still has to prove it can read the mailbox
// with the emailed code before it counts, so typing the address into a sign-up form gives nobody anything.
const CREATOR_KEYS = new Set(String(process.env.CREATOR_EMAILS || 'adunachatapp@gmail.com,nathankennethvc2@gmail.com').split(',').map((e) => security.cleanEmail(e)).filter(Boolean).map((e) => security.emailKey(e)));
const isCreatorEmail = (email) => !!email && CREATOR_KEYS.has(security.emailKey(email));
const isCreator = (u) => !!u && !u.bot && u.emailVerified === true && isCreatorEmail(u.email);
const CREATOR_BADGE = { id: 'creator', name: 'Creator', builtin: true, image: null, emoji: '', color: '' };
// The Artist badge: automatic once an artist's first item has been approved (db().artists[id].badge, see the artists block). The client draws it
// from /badges/artist.png as a mask in the surrounding text colour (`glyph`), so it is white on dark themes and dark on light ones.
const ARTIST_BADGE = { id: 'artist', name: 'Artist', glyph: 'artist', image: null, emoji: '', color: '' };
// Every badge a person owns (the Creator badge, the Artist badge, ones a creator gave, event badges and shop badges).
function allBadgeViews(u) {
  const out = [];
  if (isCreator(u)) out.push(CREATOR_BADGE);
  if (!u.bot && artistsLib.isArtist(db().artists && db().artists[u.id])) out.push(ARTIST_BADGE); // an approved artist wears the Artist badge
  for (const id of Array.isArray(u.badges) ? u.badges : []) {
    const b = db().badges && db().badges[id];
    if (b && b.kind !== 'frame') out.push({ id: b.id, name: b.name, image: b.image || null, emoji: b.emoji || '', color: b.color || '#8c6b4f' }); // frames are worn around the avatar, not next to the name (see wornFrame)
  }
  out.push(...credits.events.badgeViews(u)); // Trick or Treater, Santa's Helper (earned from the Halloween / Christmas events)
  out.push(...credits.shop.badgeViews(u));   // badges bought in the credits shop
  return out;
}
// A person can take badges off (Settings > Profile): u.hiddenBadges holds the ids they are not wearing. Everyone else only ever sees what is worn.
const hiddenBadgeIds = (u) => new Set(Array.isArray(u.hiddenBadges) ? u.hiddenBadges : []);
function badgeViews(u) {
  const hide = hiddenBadgeIds(u), all = allBadgeViews(u);
  return hide.size ? all.filter((b) => !hide.has(b.id)) : all;
}
// What the owner sees in Settings: everything they own, each marked worn or not.
function ownedBadgeViews(u) {
  const hide = hiddenBadgeIds(u);
  return allBadgeViews(u).map((b) => ({ ...b, worn: !hide.has(b.id) }));
}
// A profile frame (an artist's ring around the avatar) is bought like a badge (its id is in u.badges) and worn one at a time (u.frame).
// What everybody sees is the picture id of the worn frame, or null when none is worn or it is not valid any more.
const ownsBadge = (u, id) => Array.isArray(u.badges) && u.badges.includes(id);
function frameOf(id) { const b = id && db().badges && Object.prototype.hasOwnProperty.call(db().badges, id) ? db().badges[id] : null; return b && b.kind === 'frame' && b.image && artistsLib.listed(b) ? b : null; }
const wornFrame = (u) => { const b = u.frame && ownsBadge(u, u.frame) ? frameOf(u.frame) : null; return b ? b.image : null; };
// the frames a person owns, for Settings: each marked worn or not
const ownedFrameViews = (u) => (Array.isArray(u.badges) ? u.badges : []).map(frameOf).filter(Boolean).map((b) => ({ id: b.id, name: b.name, image: b.image, worn: u.frame === b.id && wornFrame(u) === b.image }));
// A username is taken when an account has it OR another Clips creator uses it as their Clips name (u.clipCreator.profile.username), so nobody can
// register or rename into someone's Clips name. `exceptId` is the person asking (their own names never clash with each other).
function usernameTaken(name, exceptId) {
  const l = String(name).toLowerCase();
  return Object.values(db().users).some((x) => x.id !== exceptId && (String(x.username).toLowerCase() === l || String((x.clipCreator && x.clipCreator.profile && x.clipCreator.profile.username) || '').toLowerCase() === l));
}
// A Clips creator can switch on a link to their Clips page (/clips/user/<id>) from the creator dashboard. It is off until they do,
// and only while it is on does their profile carry it (publicUser.clipsPage); null otherwise.
const clipsPageOf = (u) => (u && !u.bot && u.clipCreator && u.clipCreator.pageLink === true ? '/clips/user/' + u.id : null);
// The game someone is playing right now (server/activity.js). Memory only: it is not saved, and a restart simply forgets it.
const activities = new Map(); // userId -> { name, source, since, seen, changedAt }
const activityOf = (u) => activityLib.view(u, activityLib.current(activities, u.id, now()), isOnline(u.id) && u.status !== 'invisible');
function publicUser(u) {
  return {
    id: u.id,
    creator: isCreator(u),
    clipsPage: clipsPageOf(u),
    activity: activityOf(u), // { name, since, source } or null: "Playing ..." on the profile (hidden when the person turned it off, is offline or Invisible)
    badges: badgeViews(u),
    frame: wornFrame(u),
    username: u.username,
    displayName: u.displayName,
    bio: u.bio,
    avatarColor: u.avatarColor,
    avatarEmoji: u.avatarEmoji,
    avatarLogo: !!u.avatarLogo,
    links: Array.isArray(u.links) ? u.links : [],
    usernameChangedAt: u.usernameChangedAt || null,
    bannerColor: u.bannerColor,
    avatarImage: u.avatarImage || null,
    bannerImage: u.bannerImage || null,
    accentColor: u.accentColor,
    profileTheme: credits.pthemes.wornId(u), // a gradient profile theme (see profilethemes.js), or null
    profileGradient: credits.pthemes.customOf(u), // the colours and angle when that theme is the person's own custom gradient
    status: u.status === 'invisible' ? 'offline' : u.status, // other people never learn that someone chose Invisible (ownUser / selfView carry the real value)
    publicKey: u.publicKey,
    createdAt: u.createdAt,
    bot: !!u.bot, // a bot account (see the bots runtime block): shown with a BOT tag
  };
}

// What the signed-in person gets about themselves: the public profile plus their private email.
// Never use this for anything other people receive (user:update events, member lists, other people's profiles).
const selfView = (u) => ({ ...publicUser(u), status: u.status }); // the person's own copy keeps the real status (Invisible included)
const ownUser = (u) => ({ ...selfView(u), ownedBadges: ownedBadgeViews(u), ownedFrames: ownedFrameViews(u), email: u.email || null, emailVerified: !needsVerify(u), twoFactor: !!(u.totp && u.totp.enabled), developer: !!u.developer || isCreator(u), seasonTest: credits.events.testMode(u, !!u.developer || isCreator(u)), recoveryKey: !!u.recovery, passkeyCount: (u.passkeys || []).length, emailRecovery: !!u.emailRecovery, emailRecoveryAvailable: emailRecoveryPossible(u), codeSent: !!(u.verify && u.verify.expires > now()), notifPrefs: cleanPrefs(u.notifPrefs), showActivity: u.showActivity !== false, lang: LANGS.includes(u.lang) ? u.lang : null, needsSetup: !!u.setupPending, reviewer: isReviewer(u), admin: isAdmin(u), artist: artistsLib.isArtist(db().artists && db().artists[u.id]) });

// ---------- email verification ----------
// On when RESEND_API_KEY is set. New accounts (and accounts that change their email) get a 6-digit code by email and
// are locked out of everything except the verification endpoints until they enter it. That includes accounts created
// before verification existed (no `emailVerified` flag): they are asked at their next sign-in, and those with no email
// on file are asked to add one. Only a hash of the code is stored.
const CODE_TTL_MS = 15 * 60_000, CODE_COOLDOWN_MS = 60_000, CODE_MAX_TRIES = 5;
const needsVerify = (u) => mailer.enabled() && u.emailVerified !== true;
// Best-effort heads-up about a security change, only to an address that was verified. Never blocks or fails the request.
function notifyByEmail(u, subject, text) {
  if (!mailer.enabled() || u.emailVerified !== true || !u.email) return;
  mailer.sendSecurityNotice(u.email, subject, text).catch((e) => console.error('security notice failed:', e.message));
}
const codeHash = (uid, code) => crypto.createHash('sha256').update(uid + ':' + code).digest('hex');
const resends = new security.RateWindow(5, 3600_000); // emails per account per hour
async function issueCode(u) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  u.verify = { hash: codeHash(u.id, code), expires: now() + CODE_TTL_MS, tries: 0, sentAt: now() };
  store.save();
  // If a VERIFIED account already owns this address, the mailbox gets a "you already have an account" notice instead of a code (the code
  // stored above is never sent, so nothing can be verified). Everything the caller sees is the same either way, which is what stops
  // sign-up and email change from revealing which addresses are registered. Notices are limited per address so this cannot be used to spam someone.
  if (emailClaimed(u.email, u.id)) {
    if (notices.allow(security.emailKey(u.email))) await mailer.sendAccountExists(u.email);
    return;
  }
  await mailer.sendVerificationCode(u.email, code, u.username);
}
const notices = new security.RateWindow(3, 3600_000); // "account already exists" emails per address per hour
const resetMails = new security.RateWindow(3, 3600_000); // password-reset links per account per hour
// Email addresses are unique among VERIFIED accounts (proved by receiving the code); an unverified claim blocks nobody, so nobody can squat on
// someone else's address. Without an email provider nothing can be verified, so then uniqueness is checked immediately (see emailTaken).
const emailClaimed = (email, exceptId) => {
  if (isCreatorEmail(email)) return false; // the creator address can back any number of accounts
  const key = security.emailKey(email);
  return Object.values(db().users).some((x) => x.id !== exceptId && x.emailVerified === true && x.email && security.emailKey(x.email) === key);
};
const emailTaken = (email, exceptId) => {
  if (isCreatorEmail(email)) return false;
  const key = security.emailKey(email);
  return Object.values(db().users).some((x) => x.id !== exceptId && x.email && security.emailKey(x.email) === key);
};

const convoKey = (a, b) => [a, b].sort().join(':');
// Tokens carry the account's tokenVersion, so "log out everywhere" (POST /api/me/logout-all) can revoke them all (see security.js).
const sessions = security.createSessions({ jwt, getSecret: () => SECRET });
const signToken = (u) => sessions.sign(u);
const userFromToken = (token) => sessions.user(token, (uid) => { const u = db().users[uid]; return u && !u.bot && !u.deleted && !u.suspended ? u : undefined; }); // a bot account has no password and no session, whatever token is presented; a suspended or deleted account (see the admin page) is signed out everywhere

// The web app is logged in by an httpOnly cookie (see security.js). The token is still accepted in an Authorization header (older apps,
// the tests, scripts), and still returned in the JSON unless the caller sends "X-Session: cookie", which the web app always does:
// then no script ever sees it.
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';
const secureReq = (req) => security.isSecure(req.headers, req.socket && req.socket.encrypted, TRUST_PROXY);
function startSession(req, res, u) {
  const token = signToken(u);
  res.append('Set-Cookie', security.sessionCookie(token, { secure: secureReq(req) }));
  return req.get('x-session') === 'cookie' ? undefined : token;
}

function serverView(s) {
  return {
    id: s.id,
    name: s.name,
    ownerId: s.ownerId,
    inviteCode: s.inviteCode,
    iconImage: s.iconImage || null,
    bannerImage: s.bannerImage || null,
    theme: s.theme || null, // { dark, bg, accent } or null: members see the app fade to it on this server
    categories: s.categories || [],
    visibility: s.visibility || null, // null = not published (the invite code still works, same as unlisted)
    description: s.description || '',
    tags: s.tags || [],
    roles: s.roles || [],
    everyone: s.everyone || [],
    memberRoles: s.memberRoles || {},
    onboarding: s.onboarding || null,
    bots: (s.installedBots || []).map((i) => ({ botId: i.botId, userId: i.userId, channels: Array.isArray(i.channels) ? i.channels : null })),
    channels: s.channels,
    members: s.members.map((m) => db().users[m]).filter(Boolean).map(publicUser),
  };
}

const online = new Map(); // userId -> socket count
const isOnline = (uid) => (online.get(uid) || 0) > 0;

// ---------- app ----------
const app = express();
// Express 4 does not catch rejected promises from async handlers; this passes them to the error handler.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Behind Render's (or any) reverse proxy, req.ip must be the visitor, not the proxy, or rate limits would be shared by everyone.
if (TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(security.securityHeaders()); // CSP, clickjacking, nosniff, referrer, permissions, HSTS over HTTPS (see security.js)
app.use('/api', security.csrfGuard()); // a request from another site that carries the login cookie is refused (see security.js)
app.get('/healthz', (_req, res) => res.type('text').send('ok')); // for Render's health check

// Android app updates: the app asks which build is newest. Source, in order: updates/latest.json on this site (like the desktop feed), else android-latest.json in the DOWNLOAD_BASE_URL bucket (written by ZipPush), else the latest GitHub Release of GITHUB_REPO (the Android workflow
// publishes one per build, tag android-<versionCode>, with the .apk attached; the repo must be public), or set
// APP_LATEST_VERSION_CODE + APP_APK_URL (+ APP_LATEST_VERSION_NAME) by hand. Cached for 10 minutes.
let appVersionCache = { at: 0, data: null };
// The Android feed, same idea as the desktop's updates/latest.yml: client/public/updates/latest.json = { "versionCode": 12, "versionName": "1.0.12", "file": "Aduna.apk" }.
// The file is looked up in DOWNLOAD_BASE_URL when that is set, else next to the feed in /updates/. Returns { versionCode, versionName, url } or null.
const apkFeedEntry = (j, req) => {
  const code = Number(j && j.versionCode);
  const file = String((j && j.file) || 'Aduna.apk');
  if (!(code > 0) || !/^[\w.-]+\.apk$/i.test(file)) return null;
  const base = String(process.env.DOWNLOAD_BASE_URL || '').trim().replace(/\/+$/, '');
  const origin = `${req.protocol}://${req.get('host')}`;
  // An APK that ships with the site (build-apk.bat copies it into client/public/updates) wins over the bucket, so ONE deploy updates the site and the app.
  // With neither, offer nothing: the phone would be sent the app's home page (the catch-all route) and fail with "problem parsing the package".
  const onSite = fs.existsSync(path.join(__dirname, '..', 'client', 'dist', 'updates', file));
  if (!onSite && !base) return null;
  return { versionCode: code, versionName: String((j && j.versionName) || ''), url: onSite ? `${origin}/updates/${file}` : `${base}/${file}` };
};
const readApkFeed = (req) => {
  try { return apkFeedEntry(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'client', 'dist', 'updates', 'latest.json'), 'utf8')), req); } catch { return null; }
};
app.get('/updates/latest.json', (req, res) => { // what the phone app reads; no login, never cached
  const e = readApkFeed(req);
  if (!e) return res.status(404).json({ error: 'No update available' });
  res.set('Cache-Control', 'no-cache').json(e);
});
// Which build of the SITE is running: a hash of the built index.html (its script names change with every code change). The page asks now and then and
// offers a reload when the answer differs from the one it loaded with, so phones and open tabs notice a deploy without anyone sending a link.
const BUILD_ID = (() => { try { return require('crypto').createHash('sha1').update(fs.readFileSync(path.join(__dirname, '..', 'client', 'dist', 'index.html'))).digest('hex').slice(0, 12); } catch { return 'dev'; } })();
app.get('/api/build', (_req, res) => res.set('Cache-Control', 'no-store').json({ build: BUILD_ID }));
app.get('/api/app-version', ah(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const local = readApkFeed(req); // updates/latest.json on this site wins over every other source
  if (local) return res.json(local);
  const dl = String(process.env.DOWNLOAD_BASE_URL || '').trim().replace(/\/+$/, '');
  if (dl) { // ZipPush uploads Aduna.apk and android-latest.json to the downloads bucket
    if (Date.now() - appVersionCache.at < 5 * 60 * 1000 && appVersionCache.data) return res.json(appVersionCache.data);
    let data = { versionCode: 0 };
    try {
      const r = await fetch(`${dl}/android-latest.json`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j = await r.json();
        const code = Number(j.versionCode);
        const file = String(j.file || 'Aduna.apk');
        if (code > 0 && /^[\w.-]+\.apk$/i.test(file)) data = { versionCode: code, versionName: String(j.versionName || ''), url: `${dl}/${file}` };
      }
    } catch { /* bucket unreachable: no update offered */ }
    if (data.versionCode > 0) { appVersionCache = { at: Date.now(), data }; return res.json(data); }
  }
  if (process.env.APP_LATEST_VERSION_CODE && process.env.APP_APK_URL) {
    return res.json({ versionCode: Number(process.env.APP_LATEST_VERSION_CODE) || 0, versionName: process.env.APP_LATEST_VERSION_NAME || '', url: process.env.APP_APK_URL });
  }
  const repo = String(process.env.GITHUB_REPO || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return res.json({ versionCode: 0 });
  if (Date.now() - appVersionCache.at < 10 * 60 * 1000 && appVersionCache.data) return res.json(appVersionCache.data);
  let data = { versionCode: 0 };
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'aduna-server' }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const rel = await r.json();
      const code = Number(String(rel.tag_name || '').replace(/^\D+/, ''));
      const apk = (rel.assets || []).find((a) => /\.apk$/i.test(a.name || ''));
      if (code > 0 && apk?.browser_download_url) data = { versionCode: code, versionName: `1.0.${code}`, url: apk.browser_download_url };
    }
  } catch { /* GitHub unreachable: keep the empty answer, the app just shows nothing */ }
  appVersionCache = { at: Date.now(), data };
  res.json(data);
}));
app.get('/api/auth-options', (_req, res) => res.json({ emailRecovery: mailer.enabled(), adunaServer: !!defaultServer() })); // sign-up screen: can email recovery be offered (needs a mail provider)?
// Stripe and PayPal sign the exact bytes they send, so the credits webhooks keep the raw body next to the parsed one.
app.use(express.json({ limit: '64kb', verify: (req, _res, buf) => { if (req.originalUrl.startsWith('/api/credits/webhook')) req.rawBody = buf; } }));

// API answers can hold private data (balances, email): browsers and proxies must not keep them.
// Images and files set their own caching below, which overrides this.
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// naive per-IP rate limit for auth endpoints
const AUTH_PER_MINUTE = posNum(process.env.AUTH_PER_MINUTE, 20); // the tests create many accounts from one address and raise this
const authHits = new security.RateWindow(AUTH_PER_MINUTE, 60_000);
function authLimiter(req, res, next) {
  if (!authHits.allow(req.ip)) return res.status(429).json({ error: 'Too many attempts, try again in a minute' });
  next();
}

function authAny(req, res, next) { // signed in, verified or not: only for the email-verification routes
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  const u = userFromToken(bearer || security.readSessionCookie(req.headers, secureReq(req)));
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  req.user = u;
  next();
}
function auth(req, res, next) {
  authAny(req, res, () => {
    if (needsVerify(req.user)) return res.status(403).json({ error: 'Verify your email address first', code: 'email_unverified' });
    next();
  });
}

// ---------- account recovery key ----------
// The browser makes a recovery key (client/src/crypto.js): the identity key wrapped by it (`blob`, opaque to us) and a 256-bit proof `auth` derived
// from the same key. We keep the blob and only a SHA-256 of the proof, so nothing we store can open the blob or pass as the proof. The key
// has 160 random bits, which is why a fast hash is enough here (a password would need a slow one).
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const RECOVERY_AUTH = /^[A-Za-z0-9+/]{43}=?$/; // 32 bytes in base64
function recoveryRecord(r) {
  if (!r || typeof r !== 'object' || !validKeyBlob(r.blob) || typeof r.auth !== 'string' || !RECOVERY_AUTH.test(r.auth)) return null;
  return { blob: { salt: r.blob.salt, iv: r.blob.iv, data: r.blob.data }, verifier: sha256(r.auth), createdAt: now() };
}
// Asking to reset must not reveal whether a name has a recovery key (or exists): unknown names and accounts without a key get a decoy blob
// of the same shape, derived from the server secret so the same name always gets the same one. Opening it fails on the device, like a wrong key.
function decoyRecoveryBlob(username) {
  const mac = (i) => crypto.createHmac('sha256', String(SECRET)).update(`recovery-decoy:${i}:${String(username).toLowerCase()}`).digest();
  const bytes = Buffer.concat([mac(0), mac(1), mac(2), mac(3), mac(4), mac(5), mac(6), mac(7)]); // 256 bytes
  return { salt: bytes.subarray(0, 16).toString('base64'), iv: bytes.subarray(16, 28).toString('base64'), data: bytes.subarray(28, 220).toString('base64') };
}
const validKeyBlob = (b) => b && typeof b === 'object' && ['salt', 'iv', 'data'].every((k) => typeof b[k] === 'string' && b[k].length < 4000);

const LANGS = ['en', 'fr', 'es']; // languages the app can be shown in (client/src/i18n.js has the words)
const cleanLang = (v) => (LANGS.includes(v) ? v : 'en');

function defaultServer() {
  const code = String(process.env.DEFAULT_SERVER_INVITE ?? 'aduna').trim().toLowerCase();
  if (!code || code === 'off') return null;
  const all = Object.values(db().servers);
  return all.find((x) => x.inviteCode === code) || all.find((x) => String(x.name).trim().toLowerCase() === 'aduna') || null;
}

const signups = new security.RateWindow(posNum(process.env.SIGNUPS_PER_HOUR, 10), 3600_000); // new accounts per address per hour
const loginGuard = new security.LoginGuard();

// ----- rate limits survive restarts -----
// The limits and the login lockout used to live only in memory, so every restart or redeploy (Render does both on its own) wiped them. The
// five that guard accounts are now saved, sealed, in the meta table: shortly after they change (at most one write every 5 s), and once more
// when the server is told to shut down. At startup the saved state is loaded and anything past its window is dropped. One instance only: two
// running at once would each keep their own counts and overwrite each other's saved copy. The upload/GIF limits stay in memory on purpose
// (short per-user limits, not a security boundary).
const LIMITERS = { authHits, signups, loginGuard, resends, notices, resetMails };
let limitsSaved = '';
async function saveLimits() {
  const now = Date.now();
  const json = JSON.stringify(Object.fromEntries(Object.entries(LIMITERS).map(([k, l]) => [k, l.dump(now)])));
  if (json === limitsSaved) return;
  await store.setMeta('ratelimits', json);
  limitsSaved = json;
}
let limitsTimer = null;
function saveLimitsSoon() {
  if (limitsTimer) return;
  limitsTimer = setTimeout(() => { limitsTimer = null; saveLimits().catch((e) => console.error('Could not save rate limits:', e.message)); }, 5000);
  limitsTimer.unref();
}
async function loadLimits() {
  try {
    const raw = await store.getMeta('ratelimits');
    if (raw) { const data = JSON.parse(raw); for (const [k, l] of Object.entries(LIMITERS)) l.restore(data[k]); }
  } catch (e) { console.error('Could not load rate limits (starting empty):', e.message); }
  for (const l of Object.values(LIMITERS)) l.onChange = saveLimitsSoon;
}
const DUMMY_HASH = bcrypt.hashSync('aduna-not-a-real-password', 10); // so a wrong username takes as long as a wrong password

app.post('/api/register', authLimiter, async (req, res) => {
  const { username, password, publicKey, encPrivKey } = req.body || {};
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores' });
  const email = security.cleanEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Enter a valid email address' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const weak = process.env.NODE_ENV === 'test' ? null : security.weakPassword(password, { username, email });
  if (weak) return res.status(400).json({ error: weak });
  if (typeof publicKey !== 'string' || publicKey.length > 2000) return res.status(400).json({ error: 'Missing public key' });
  if (!validKeyBlob(encPrivKey)) return res.status(400).json({ error: 'Missing key backup' });
  const recovery = req.body?.recovery == null ? null : recoveryRecord(req.body.recovery);
  if (req.body?.recovery != null && !recovery) return res.status(400).json({ error: 'Bad recovery key backup' });
  if (usernameTaken(username)) return res.status(409).json({ error: 'Username already taken' });
  // With email verification on, a taken address is NOT reported here (that would reveal who is registered): the account is created unverified
  // and uniqueness is decided when the address is verified. With it off nothing can be verified, so the check has to happen now.
  if (!mailer.enabled() && emailTaken(email)) return res.status(409).json({ error: 'An account with this email already exists' });
  if (!isCreatorEmail(email) && !signups.allow(req.ip)) return res.status(429).json({ error: 'Too many accounts were created from this connection. Try again later.' });

  const hues = ['#8c6b4f', '#b4553d', '#5f7a55', '#a67c1f', '#4b6a88', '#7a5a7d', '#2a251e'];
  const user = {
    id: store.id(),
    username,
    passHash: await bcrypt.hash(password, 10),
    displayName: username,
    email, // private: never part of publicUser(); stored encrypted like every other record
    bio: '',
    avatarColor: hues[Math.floor(Math.random() * hues.length)],
    avatarEmoji: '',
    bannerColor: '#e3dccb',
    accentColor: '#2a251e',
    status: 'online',
    publicKey,
    encPrivKey,
    ...(recovery ? { recovery } : {}),
    ...(req.body?.emailRecovery === true && mailer.enabled() ? { emailRecovery: true } : {}), // chosen at sign-up; only takes effect once the address is verified (emailRecoveryPossible)
    lang: cleanLang(req.body?.lang),
    // The app's sign-up sends setup:true: the person then picks a language and whether to join the Aduna server on the setup screen
    // (POST /api/me/setup). Other callers keep the old behaviour of joining it straight away.
    ...(req.body?.setup === true ? { setupPending: true, joinAduna: false } : {}),
    createdAt: now(),
  };
  db().users[user.id] = user;

  if (!needsVerify(user) && user.joinAduna !== false) joinDefaultServer(user);
  store.save();
  if (needsVerify(user)) {
    try { await issueCode(user); } catch (e) { console.error('verification email failed:', e.message); } // they can press "resend"
  }
  res.json({ token: startSession(req, res, user), user: ownUser(user) });
});

// Everyone starts in the official Aduna server. It is found by invite code (DEFAULT_SERVER_INVITE, default "aduna"),
// else by the name "Aduna". Set DEFAULT_SERVER_INVITE=off to disable. Unverified accounts join once they verify.
function joinDefaultServer(user) {
  const dflt = defaultServer();
  if (dflt && !dflt.members.includes(user.id)) {
    dflt.members.push(user.id);
    (dflt.joinedAt = dflt.joinedAt || {})[user.id] = Date.now();
    io.to('server:' + dflt.id).emit('server:update', serverView(dflt));
  }
}

// The one-time setup screen after sign-up: language, and whether to join the official Aduna server.
// Works before the email is verified; if it is not yet verified the join happens when it is (see verify-email).
app.post('/api/me/setup', authAny, (req, res) => {
  const u = req.user;
  if (!u.setupPending) return res.json({ user: ownUser(u) });
  const b = req.body || {};
  if (b.lang !== undefined) u.lang = cleanLang(b.lang);
  u.joinAduna = b.joinAduna === true;
  delete u.setupPending;
  if (u.joinAduna && !needsVerify(u)) joinDefaultServer(u);
  store.save();
  res.json({ user: ownUser(u) });
});

app.post('/api/me/verify-email', authLimiter, authAny, (req, res) => {
  const u = req.user;
  if (!needsVerify(u)) return res.json({ user: ownUser(u) });
  const v = u.verify;
  const code = String(req.body?.code ?? '').replace(/\s/g, '');
  if (!v || v.expires < now()) return res.status(400).json({ error: 'That code has expired. Request a new one.' });
  if (v.tries >= CODE_MAX_TRIES) return res.status(429).json({ error: 'Too many wrong codes. Request a new one.' });
  const a = Buffer.from(codeHash(u.id, code)), b = Buffer.from(v.hash);
  if (!/^\d{6}$/.test(code) || !crypto.timingSafeEqual(a, b)) {
    v.tries += 1; store.save();
    return res.status(400).json({ error: 'That code is not right.' });
  }
  if (emailClaimed(u.email, u.id)) { // someone else verified this address first: only a person who can read this mailbox ever gets here
    delete u.verify; store.save();
    return res.status(409).json({ error: 'Another account already uses this email address. Choose “Wrong email?” and use a different one.' });
  }
  u.emailVerified = true;
  if (isCreatorEmail(u.email) && !u.developer) u.developer = { at: now() }; // the creator is also a developer
  delete u.verify;
  if (u.joinAduna !== false) joinDefaultServer(u);
  store.save();
  res.json({ user: ownUser(u) });
});

app.post('/api/me/resend-verification', authLimiter, authAny, async (req, res) => {
  const u = req.user;
  if (!needsVerify(u)) return res.json({ ok: true, retryAfter: 0 });
  if (!u.email) return res.status(400).json({ error: 'Add your email address first.' });
  const wait = (u.verify?.sentAt || 0) + CODE_COOLDOWN_MS - now();
  if (wait > 0) return res.status(429).json({ error: `Wait ${Math.ceil(wait / 1000)}s before requesting another code.`, retryAfter: Math.ceil(wait / 1000) });
  if (!resends.allow(u.id)) return res.status(429).json({ error: 'Too many emails sent. Try again later.', retryAfter: 3600 });
  try { await issueCode(u); } catch (e) { console.error('verification email failed:', e.message); return res.status(502).json({ error: 'The email could not be sent. Check the address and try again.' }); }
  res.json({ ok: true, retryAfter: CODE_COOLDOWN_MS / 1000 });
});

// ----- two-factor helpers -----
// u.totp = { secret, enabled, lastStep, recovery: [sha256 of each unused recovery code] }; u.totpPending = a secret not yet confirmed.
// True if `raw` is a valid authenticator code (each time step usable once) or an unused recovery code (burned on use). No 2FA: true.
function secondFactorOk(u, raw) {
  const t = u.totp;
  if (!t || !t.enabled) return true;
  const code = totp.normRecovery(raw);
  if (/^\d{6}$/.test(code)) {
    const stepHit = totp.verify(t.secret, code, { lastStep: Number.isInteger(t.lastStep) ? t.lastStep : -1 });
    if (stepHit === null) return false;
    t.lastStep = stepHit;
    store.save();
    return true;
  }
  const i = Array.isArray(t.recovery) ? t.recovery.indexOf(totp.hashRecovery(code)) : -1;
  if (i < 0) return false;
  t.recovery.splice(i, 1);
  store.save();
  return true;
}
// Re-checks the password for a sensitive action. Wrong guesses count toward the login lockout. Sends the error itself and returns false.
async function passwordOk(req, res, u, password) {
  const lock = loginGuard.check(u.username, req.ip);
  if (lock.blocked) {
    res.set('Retry-After', String(lock.retryAfterSec));
    res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(lock.retryAfterSec / 60)} minute${lock.retryAfterSec > 90 ? 's' : ''}.` });
    return false;
  }
  if (!(await bcrypt.compare(String(password || ''), u.passHash))) {
    loginGuard.fail(u.username, req.ip);
    res.status(400).json({ error: 'That password is not right.' });
    return false;
  }
  return true;
}
// Same, for a one-time code; the wrong ones feed the same lockout.
function codeOk(req, res, u, code) {
  if (secondFactorOk(u, code)) return true;
  loginGuard.fail(u.username, req.ip);
  res.status(400).json({ error: 'That code is not right.', code: '2fa_invalid' });
  return false;
}
// Revokes every login token of the account, drops its push registrations, stores that, and closes every open connection
// (the other devices are told to sign out). Used by "log out everywhere" and by changing the password.
async function revokeAllSessions(u, keepSocketId = '') {
  sessions.bump(u);
  u.pushSubs = [];
  store.save();
  await store.flush(); // the revocation must be stored before the answer, or a restart could bring old tokens back
  for (const s of userSockets(u.id)) {
    if (s.id !== keepSocketId) s.emit('session:revoked');
    s.disconnect(true);
  }
}

app.post('/api/login', authLimiter, ah(async (req, res) => {
  const { username, password } = req.body || {};
  const name = String(username || '');
  const lock = loginGuard.check(name, req.ip);
  if (lock.blocked) {
    res.set('Retry-After', String(lock.retryAfterSec));
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(lock.retryAfterSec / 60)} minute${lock.retryAfterSec > 90 ? 's' : ''}.` });
  }
  const user = Object.values(db().users).find((u) => !u.bot && !u.deleted && u.username.toLowerCase() === name.toLowerCase());
  const ok = await bcrypt.compare(String(password || ''), user ? user.passHash : DUMMY_HASH); // always one comparison: no timing hint about which names exist
  if (!user || !ok) { loginGuard.fail(name, req.ip); return res.status(401).json({ error: 'Invalid username or password' }); }
  // a moderator suspended this account (admin page): only someone who knows the password is told, so names cannot be probed
  if (user.suspended) return res.status(403).json({ error: user.suspended.reason ? `This account has been suspended: ${user.suspended.reason}` : 'This account has been suspended.', code: 'suspended' });
  // Two-factor: the password was right, so say a code is needed (nothing is issued yet). Wrong codes feed the same lockout, and the
  // lockout is only cleared after the code passes too, or a correct password would reset the counter on every guess.
  if (user.totp && user.totp.enabled) {
    const code = String(req.body?.code ?? '').trim();
    if (!code) return res.status(401).json({ error: 'Enter the 6-digit code from your authenticator app.', code: '2fa_required' });
    if (!secondFactorOk(user, code)) { loginGuard.fail(name, req.ip); return res.status(401).json({ error: 'That code is not right.', code: '2fa_invalid' }); }
  }
  loginGuard.success(name, req.ip);
  res.json({ token: startSession(req, res, user), user: ownUser(user), encPrivKey: user.encPrivKey });
}));

// Ends the browser's session: the cookie is httpOnly, so only the server can remove it. Needs no login (clearing is always safe).
app.post('/api/logout', (req, res) => {
  for (const c of security.clearedSessionCookies({ secure: secureReq(req) })) res.append('Set-Cookie', c);
  res.json({ ok: true });
});
// One-time move for people who were logged in before cookies existed: the old app sends the token it kept in localStorage,
// gets the cookie, and deletes its copy.
app.post('/api/session', authAny, (req, res) => {
  startSession(req, res, req.user);
  res.json({ ok: true });
});

// ----- sign in on a new device by approving it from one that is signed in (server/devicelogin.js explains the idea) -----
// The new device is signed out, so its two calls (start, poll) carry no login; the secret request id is what ties them together. The
// signed-in device finds the request by its short code, and answering needs the password again (and the two-factor code if it is on),
// like the other sensitive actions: whoever approves hands over the account AND the key that opens its messages.
const deviceLogins = new devicelogin.DeviceLogins();
const deviceStarts = new security.RateWindow(10, 10 * 60_000); // requests per address per 10 minutes
const devicePolls = new security.RateWindow(150, 60_000);       // polls per address per minute (one every 2 s is 30)
const deviceLooks = new security.RateWindow(12, 60_000);        // code lookups and answers per account per minute: typing a code is not a guessing game
app.post('/api/device-login/start', authLimiter, (req, res) => {
  if (!deviceStarts.allow(req.ip)) return res.status(429).json({ error: 'Too many sign-in requests. Try again in a few minutes.' });
  const r = deviceLogins.start({ publicKey: req.body?.publicKey, ua: req.get('user-agent'), ip: req.ip });
  if (r.error === 'bad') return res.status(400).json({ error: 'Bad request' });
  if (r.error) return res.status(503).json({ error: 'Busy right now. Try again in a minute.' });
  res.json(r);
});
app.post('/api/device-login/poll', ah(async (req, res) => {
  if (!devicePolls.allow(req.ip)) return res.status(429).json({ error: 'Too many requests. Slow down.' });
  const id = req.body?.id;
  const p = deviceLogins.poll(id);
  if (p.status !== 'approved') return res.json(p);
  const got = deviceLogins.take(id);
  const user = got && db().users[got.uid];
  if (!user || user.bot || user.deleted) return res.json({ status: 'expired' });
  if (user.suspended) return res.status(403).json({ error: user.suspended.reason ? `This account has been suspended: ${user.suspended.reason}` : 'This account has been suspended.', code: 'suspended' });
  res.json({ status: 'approved', token: startSession(req, res, user), user: ownUser(user), sealed: got.sealed });
}));
// What is asking, so the person can tell it is the device in front of them: its name, how long ago, and whether it is on the same network.
app.post('/api/me/device-login/lookup', auth, (req, res) => {
  if (!deviceLooks.allow(req.user.id)) return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
  const r = deviceLogins.find(req.body?.request);
  if (!r) return res.status(404).json({ error: 'That code is not right, or it has expired. Ask the other device for a new one.' });
  res.json({ device: r.device, minutesAgo: Math.max(0, Math.floor((now() - r.createdAt) / 60_000)), sameNetwork: !!r.ip && r.ip === req.ip, publicKey: r.publicKey });
});
app.post('/api/me/device-login/approve', auth, ah(async (req, res) => {
  const u = req.user;
  if (!deviceLooks.allow(u.id)) return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
  if (!devicelogin.cleanSealed(req.body?.sealed)) return res.status(400).json({ error: 'Bad request' }); // before the password, so a bad request does not burn a 2FA code
  if (!deviceLogins.find(req.body?.request)) return res.status(404).json({ error: 'That sign-in request has expired. Ask the other device for a new code.' });
  if (!(await passwordOk(req, res, u, req.body?.password))) return;
  if (u.totp && u.totp.enabled && !codeOk(req, res, u, req.body?.code)) return;
  loginGuard.success(u.username, req.ip);
  const r = deviceLogins.approve(req.body?.request, u.id, req.body.sealed);
  if (r !== 'ok') return res.status(404).json({ error: 'That sign-in request has expired. Ask the other device for a new code.' });
  notifyByEmail(u, 'A new device was signed in to your Aduna account', 'A device was just signed in to your Aduna account by approving it from one that was already signed in. If this was not you, change your password in Settings > Security and use "Log out of all devices".');
  res.json({ ok: true });
}));
app.post('/api/me/device-login/deny', auth, (req, res) => {
  if (!deviceLooks.allow(req.user.id)) return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
  res.json({ ok: deviceLogins.deny(req.body?.request) });
});

// ----- passkeys (server/passkeys.js explains the idea) -----
// A passkey signs a one-time challenge instead of typing the password, and (through the browser's "prf" extension) unlocks the same
// end-to-end encryption key the password does: `wrapped` is that key locked by the passkey, opaque to us. Adding or removing one needs the
// password (and the two-factor code if it is on), because a passkey is a way into the account AND the key that opens its messages.
// Signing in with one needs no password and no code: the device already asked for a fingerprint, face or PIN (we insist on it).
const passkeyChallenges = new passkeys.Challenges();
const passkeyHits = new security.RateWindow(30, 60_000); // challenges and answers per address per minute
const MAX_PASSKEYS = 10;
// The site the browser sees: PUBLIC_URL when it is set (same as the payment return addresses), else the address of this request.
function passkeyRp(req) {
  try { const u = new URL(String(process.env.PUBLIC_URL || '').trim() || `${req.protocol}://${req.get('host')}`); return { origin: u.origin, id: u.hostname }; }
  catch { return { origin: '', id: '' }; }
}
const passkeyHandle = (u) => crypto.createHash('sha256').update('aduna passkey user:' + u.id).digest('base64url'); // what the passkey stores as "who": nothing readable
const passkeyList = (u) => (u.passkeys || []).map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt || null }));
const cleanPasskeyName = (v) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || 'Passkey';
const passkeyBusy = (res) => res.status(429).json({ error: 'Too many tries. Wait a minute.' });

app.get('/api/me/passkeys', auth, (req, res) => res.json({ passkeys: passkeyList(req.user) }));

app.post('/api/me/passkeys/options', auth, (req, res) => {
  const u = req.user, rp = passkeyRp(req);
  if (!passkeyHits.allow(req.ip)) return passkeyBusy(res);
  if (!rp.id) return res.status(503).json({ error: 'Passkeys are not available at this address.' });
  if ((u.passkeys || []).length >= MAX_PASSKEYS) return res.status(409).json({ error: `You can have up to ${MAX_PASSKEYS} passkeys. Remove one first.` });
  const c = passkeyChallenges.issue({ kind: 'create', uid: u.id });
  if (!c) return res.status(503).json({ error: 'Busy right now. Try again in a minute.' });
  res.json({
    challengeId: c.id,
    publicKey: {
      rp: { id: rp.id, name: 'Aduna' },
      user: { id: passkeyHandle(u), name: u.username, displayName: u.username },
      challenge: c.challenge,
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' }, // "required" so the username is not needed to sign in
      attestation: 'none',
      timeout: 120000,
      excludeCredentials: (u.passkeys || []).map((p) => ({ type: 'public-key', id: p.id })),
    },
  });
});
app.post('/api/me/passkeys/finish', auth, ah(async (req, res) => {
  const u = req.user, b = req.body || {}, rp = passkeyRp(req);
  if (!passkeyHits.allow(req.ip)) return passkeyBusy(res);
  if ((u.passkeys || []).length >= MAX_PASSKEYS) return res.status(409).json({ error: `You can have up to ${MAX_PASSKEYS} passkeys. Remove one first.` });
  const wrapped = passkeys.cleanWrap(b.wrapped);
  if (!wrapped) return res.status(400).json({ error: 'Bad request' }); // before the password, so a bad request does not burn a 2FA code
  const challenge = passkeyChallenges.peek(b.challengeId, 'create', u.id);
  if (!challenge) return res.status(400).json({ error: 'That took too long. Start again.' });
  let reg;
  try { reg = passkeys.verifyRegistration({ clientDataJSON: b.clientDataJSON, attestationObject: b.attestationObject, challenge, origin: rp.origin, rpId: rp.id }); }
  catch { return res.status(400).json({ error: 'That passkey could not be verified. Try again.' }); }
  if (Object.values(db().users).some((x) => Array.isArray(x.passkeys) && x.passkeys.some((p) => p.id === reg.id))) return res.status(409).json({ error: 'That passkey is already registered.' });
  if (!(await passwordOk(req, res, u, b.password))) return;
  if (u.totp && u.totp.enabled && !codeOk(req, res, u, b.code)) return;
  if (!passkeyChallenges.take(b.challengeId, 'create', u.id)) return res.status(400).json({ error: 'That took too long. Start again.' });
  loginGuard.success(u.username, req.ip);
  if (!Array.isArray(u.passkeys)) u.passkeys = [];
  u.passkeys.push({ id: reg.id, spki: reg.spki, alg: reg.alg, signCount: reg.signCount, name: cleanPasskeyName(b.name), createdAt: now(), lastUsedAt: null, wrapped });
  store.save();
  notifyByEmail(u, 'A passkey was added to your Aduna account', 'A passkey was just added to your Aduna account. It can now be used to log in without your password. If this was not you, change your password in Settings > Security, remove the passkey and use "Log out of all devices".');
  res.json({ passkeys: passkeyList(u), user: ownUser(u) });
}));
app.post('/api/me/passkeys/remove', auth, ah(async (req, res) => {
  const u = req.user;
  if (!passkeyHits.allow(req.ip)) return passkeyBusy(res);
  const i = (u.passkeys || []).findIndex((p) => p.id === req.body?.id);
  if (i < 0) return res.status(404).json({ error: 'That passkey is already gone.' });
  if (!(await passwordOk(req, res, u, req.body?.password))) return;
  if (u.totp && u.totp.enabled && !codeOk(req, res, u, req.body?.code)) return;
  loginGuard.success(u.username, req.ip);
  u.passkeys.splice(i, 1);
  if (!u.passkeys.length) delete u.passkeys;
  store.save();
  notifyByEmail(u, 'A passkey was removed from your Aduna account', 'A passkey was just removed from your Aduna account. If this was not you, change your password in Settings > Security and use "Log out of all devices".');
  res.json({ passkeys: passkeyList(u), user: ownUser(u) });
}));

// Signing in. The first call needs no login (nobody is signed in) and hands out a one-time challenge; the second checks the device's answer.
// The account is found from the passkey itself, so the person does not even type a username.
app.post('/api/passkey/login/options', authLimiter, (req, res) => {
  const rp = passkeyRp(req);
  if (!rp.id) return res.status(503).json({ error: 'Passkeys are not available at this address.' });
  const c = passkeyChallenges.issue({ kind: 'get' });
  if (!c) return res.status(503).json({ error: 'Busy right now. Try again in a minute.' });
  res.json({ challengeId: c.id, publicKey: { challenge: c.challenge, rpId: rp.id, userVerification: 'required', timeout: 120000 } });
});
app.post('/api/passkey/login/finish', authLimiter, ah(async (req, res) => {
  const b = req.body || {}, rp = passkeyRp(req);
  const fail = () => res.status(401).json({ error: 'That passkey could not be used. Try again, or log in with your password.', code: 'passkey_invalid' }); // one answer for every reason
  const challenge = passkeyChallenges.take(b.challengeId, 'get'); // spent whatever happens next
  if (!challenge || typeof b.id !== 'string' || b.id.length > 1400) return fail();
  let owner = null, cred = null;
  for (const x of Object.values(db().users)) {
    const p = !x.bot && !x.deleted && Array.isArray(x.passkeys) ? x.passkeys.find((q) => q.id === b.id) : null;
    if (p) { owner = x; cred = p; break; }
  }
  if (!owner) return fail();
  if (typeof b.userHandle === 'string' && b.userHandle && b.userHandle !== passkeyHandle(owner)) return fail();
  let out;
  try { out = passkeys.verifyAssertion({ clientDataJSON: b.clientDataJSON, authenticatorData: b.authenticatorData, signature: b.signature, challenge, origin: rp.origin, rpId: rp.id, credential: cred }); }
  catch { return fail(); }
  if (owner.suspended) return res.status(403).json({ error: owner.suspended.reason ? `This account has been suspended: ${owner.suspended.reason}` : 'This account has been suspended.', code: 'suspended' });
  cred.signCount = out.signCount;
  cred.lastUsedAt = now();
  store.save();
  res.json({ token: startSession(req, res, owner), user: ownUser(owner), wrapped: cred.wrapped });
}));

// "Log out everywhere": every other token and open connection of this account stops working, and its push registrations are
// dropped (the device that asked registers itself again). The password is asked again so a stolen token alone cannot be used
// to lock the owner out, and wrong guesses count toward the same lockout as logging in (5 per address, 25 overall, 15 minutes), which
// is why the general per-address auth limiter is not needed here. Returns a fresh token for this device.
app.post('/api/me/logout-all', authAny, ah(async (req, res) => {
  const u = req.user;
  if (!(await passwordOk(req, res, u, req.body?.password))) return;
  loginGuard.success(u.username, req.ip);
  await revokeAllSessions(u, typeof req.body?.socketId === 'string' ? req.body.socketId : '');
  res.json({ token: startSession(req, res, u) });
}));

// Change the password. The password also wraps the end-to-end encryption key, so the browser unwraps the key with the old password,
// wraps it again with the new one and sends the new blob along; the server only ever sees ciphertext. Asks for the current password
// (and the 2FA code if it is on), then revokes every other session, because a leaked password is the usual reason to do this.
app.post('/api/me/password', auth, ah(async (req, res) => {
  const u = req.user;
  const { currentPassword, newPassword, encPrivKey, code } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (newPassword.length > 200) return res.status(400).json({ error: 'That password is too long' });
  if (u.encPrivKey && !validKeyBlob(encPrivKey)) return res.status(400).json({ error: 'Missing key backup' });
  // Everything that does not need the login checks goes first, so a rejected new password does not use up the person's 2FA code.
  if (newPassword === currentPassword) return res.status(400).json({ error: 'Choose a different password from the current one.' });
  const weak = process.env.NODE_ENV === 'test' ? null : security.weakPassword(newPassword, { username: u.username, email: u.email });
  if (weak) return res.status(400).json({ error: weak });
  if (!(await passwordOk(req, res, u, currentPassword))) return;
  if (u.totp && u.totp.enabled && !codeOk(req, res, u, code)) return;
  loginGuard.success(u.username, req.ip);
  u.passHash = await bcrypt.hash(newPassword, 10);
  if (u.encPrivKey) u.encPrivKey = encPrivKey;
  await revokeAllSessions(u, typeof req.body?.socketId === 'string' ? req.body.socketId : '');
  res.json({ ok: true, token: startSession(req, res, u) });
}));

// ----- recovery key (forgotten password) -----
// Set or replace it: the password is asked again (and the 2FA code if it is on). Replacing it kills the old key, because only the new proof is kept.
app.put('/api/me/recovery', auth, ah(async (req, res) => {
  const u = req.user;
  const rec = recoveryRecord(req.body?.recovery);
  if (!rec) return res.status(400).json({ error: 'Bad recovery key backup' });
  if (!(await passwordOk(req, res, u, req.body?.password))) return;
  if (u.totp && u.totp.enabled && !codeOk(req, res, u, req.body?.code)) return;
  loginGuard.success(u.username, req.ip);
  u.recovery = rec;
  store.save();
  notifyByEmail(u, 'A new recovery key was created for your Aduna account', 'A recovery key was created or replaced on your Aduna account. Any earlier recovery key no longer works.');
  res.json({ user: ownUser(u) });
}));

// Step 1 of a reset: the wrapped identity key for this name (or a decoy, see decoyRecoveryBlob). The device opens it with the recovery key.
app.post('/api/recover/start', authLimiter, (req, res) => {
  const name = String(req.body?.username || '').trim();
  const u = name && Object.values(db().users).find((x) => !x.bot && x.username.toLowerCase() === name.toLowerCase());
  res.json({ blob: u && u.recovery ? u.recovery.blob : decoyRecoveryBlob(name) });
});

// Step 2: proof of the key + the new password (already wrapped around the identity key by the device). Same lockout as logging in, because a
// wrong proof is a wrong guess. With 2FA on a code is still needed: a recovery key alone does not skip the second factor. Success sets
// the new password, signs every other device out, and logs this one in (like /api/login, minus the password check that just happened).
app.post('/api/recover/finish', authLimiter, ah(async (req, res) => {
  const { username, auth: proof, newPassword, encPrivKey, code } = req.body || {};
  const name = String(username || '').trim();
  const lock = loginGuard.check(name, req.ip);
  if (lock.blocked) {
    res.set('Retry-After', String(lock.retryAfterSec));
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(lock.retryAfterSec / 60)} minute${lock.retryAfterSec > 90 ? 's' : ''}.` });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (newPassword.length > 200) return res.status(400).json({ error: 'That password is too long' });
  if (!validKeyBlob(encPrivKey)) return res.status(400).json({ error: 'Missing key backup' });
  const u = name && Object.values(db().users).find((x) => !x.bot && x.username.toLowerCase() === name.toLowerCase());
  // Compare in constant time, and always do one comparison, whether or not the account (or its key) exists.
  const have = Buffer.from(u && u.recovery ? u.recovery.verifier : sha256('no such recovery key'), 'hex');
  const given = Buffer.from(typeof proof === 'string' && RECOVERY_AUTH.test(proof) ? sha256(proof) : sha256(''), 'hex');
  const match = crypto.timingSafeEqual(have, given) && !!(u && u.recovery) && typeof proof === 'string' && RECOVERY_AUTH.test(proof);
  if (!match) { loginGuard.fail(name, req.ip); return res.status(401).json({ error: 'That recovery key is not right.', code: 'recovery_invalid' }); }
  const weak = process.env.NODE_ENV === 'test' ? null : security.weakPassword(newPassword, { username: u.username, email: u.email });
  if (weak) return res.status(400).json({ error: weak });
  if (u.totp && u.totp.enabled) {
    const c = String(code ?? '').trim();
    if (!c) return res.status(401).json({ error: 'Enter the 6-digit code from your authenticator app.', code: '2fa_required' });
    if (!secondFactorOk(u, c)) { loginGuard.fail(name, req.ip); return res.status(401).json({ error: 'That code is not right.', code: '2fa_invalid' }); }
  }
  loginGuard.success(name, req.ip);
  u.passHash = await bcrypt.hash(newPassword, 10);
  u.encPrivKey = encPrivKey;
  await revokeAllSessions(u);
  notifyByEmail(u, 'Your Aduna password was reset', 'The password on your Aduna account was just reset with your recovery key, and every device was signed out. If this was not you, your recovery key may be compromised: log in, create a new recovery key and change your password.');
  res.json({ token: startSession(req, res, u), user: ownUser(u), encPrivKey: u.encPrivKey });
}));


// ----- email recovery (opt-in) -----
// A second way back in for people who lost their recovery key (or never made one), for accounts that switched it on in Settings. A link goes to the
// VERIFIED address. The catch is end-to-end encryption: the server never has the encryption key, so an email cannot bring it back. This path therefore
// gives the account a NEW encryption key (made on the device) and a NEW recovery key; messages sent before can no longer be read by anyone. The person must
// say they understand that (`newKey: true`). Everything else is as strict as the recovery key: the same lockout as login, two-factor still required,
// every session revoked, the owner emailed, and the answer to "send a code" is identical whether or not the account exists or has this on.
const emailRecoveryPossible = (u) => mailer.enabled() && u.emailVerified === true && !!u.email;
const RESET_TTL_MS = 30 * 60_000, RESET_COOLDOWN_MS = 60_000;

app.put('/api/me/email-recovery', auth, ah(async (req, res) => {
  const u = req.user;
  const on = req.body?.enabled === true;
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Say whether to turn it on or off.' });
  if (on && !emailRecoveryPossible(u)) return res.status(409).json({ error: 'Verify your email address first (and email must be set up on this server).' });
  if (!(await passwordOk(req, res, u, req.body?.password))) return;
  if (u.totp && u.totp.enabled && !codeOk(req, res, u, req.body?.code)) return;
  loginGuard.success(u.username, req.ip);
  if (on) u.emailRecovery = true; else { delete u.emailRecovery; delete u.emailReset; }
  store.save();
  notifyByEmail(u, on ? 'Email recovery was turned on for your Aduna account' : 'Email recovery was turned off for your Aduna account',
    on ? 'Email recovery was turned on. If you ever forget your password and have no recovery key, a link sent to this address can reset it, but the reset also replaces your encryption key, so older messages become unreadable. If this was not you, log in and turn it off.'
       : 'Email recovery was turned off. A forgotten password can now only be reset with your recovery key.');
  res.json({ user: ownUser(u) });
}));

// Always the same answer. The link is sent after the answer, so timing does not tell either.
// The email holds a link (<site>/reset#<token>), not a code: see security.js "password-reset links". Only the token's hash is stored.
app.post('/api/recover/email/start', authLimiter, (req, res) => {
  res.json({ ok: true });
  const name = String(req.body?.username || '').trim();
  const u = name && Object.values(db().users).find((x) => !x.bot && x.username.toLowerCase() === name.toLowerCase());
  if (!u || !u.emailRecovery || !emailRecoveryPossible(u)) return;
  if (u.emailReset && now() - u.emailReset.sentAt < RESET_COOLDOWN_MS) return;
  if (!resetMails.allow(u.id)) return;
  const token = security.newResetToken();
  u.emailReset = { hash: security.resetTokenHash(token), expires: now() + RESET_TTL_MS, sentAt: now() }; // a newer link replaces the older one
  store.save();
  const link = security.resetLink(security.siteOrigin({ protocol: req.protocol, host: req.get('host') }), token);
  mailer.sendResetLink(u.email, link, u.username, Math.round(RESET_TTL_MS / 60_000)).catch((e) => console.error('reset email failed:', e.message));
});

// Who a reset link belongs to (null when it is unknown, used, replaced or expired). The token is 256 random bits, so there is nothing to
// guess; the per-address limiter still caps how fast anyone can try. Compared as hashes in constant time.
function userForResetToken(token) {
  if (!security.validResetToken(token)) return null;
  const given = Buffer.from(security.resetTokenHash(token), 'hex');
  for (const u of Object.values(db().users)) {
    const r = u.emailReset;
    if (!r || u.bot || typeof r.hash !== 'string' || r.hash.length !== 64) continue;
    if (!crypto.timingSafeEqual(Buffer.from(r.hash, 'hex'), given)) continue;
    return u.emailRecovery && emailRecoveryPossible(u) && r.expires >= now() ? u : null;
  }
  return null;
}
const resetLinkBad = (res) => res.status(401).json({ error: 'This reset link is not valid any more. Ask for a new one.', code: 'reset_link_invalid' });

// The reset page calls this when it opens, so it can say "expired" at once and ask for the two-factor code up front. Changes nothing.
app.post('/api/recover/email/check', authLimiter, (req, res) => {
  const u = userForResetToken(req.body?.token);
  if (!u) return resetLinkBad(res);
  res.json({ ok: true, username: u.username, twoFactor: !!(u.totp && u.totp.enabled) });
});

app.post('/api/recover/email/finish', authLimiter, ah(async (req, res) => {
  const { token, newPassword, publicKey, encPrivKey, newKey } = req.body || {};
  if (newKey !== true) return res.status(400).json({ error: 'Confirm that you understand your older messages will become unreadable.' });
  if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (newPassword.length > 200) return res.status(400).json({ error: 'That password is too long' });
  if (typeof publicKey !== 'string' || publicKey.length > 2000 || !validKeyBlob(encPrivKey)) return res.status(400).json({ error: 'Missing encryption key' });
  const recovery = recoveryRecord(req.body?.recovery);
  if (!recovery) return res.status(400).json({ error: 'Bad recovery key backup' });
  const u = userForResetToken(token);
  if (!u) return resetLinkBad(res);
  // Past this point the link is valid, so what can still be guessed is the two-factor code: that is what the lockout protects (same counters as login).
  const lock = loginGuard.check(u.username, req.ip);
  if (lock.blocked) {
    res.set('Retry-After', String(lock.retryAfterSec));
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(lock.retryAfterSec / 60)} minute${lock.retryAfterSec > 90 ? 's' : ''}.` });
  }
  const weak = process.env.NODE_ENV === 'test' ? null : security.weakPassword(newPassword, { username: u.username, email: u.email });
  if (weak) return res.status(400).json({ error: weak });
  if (u.totp && u.totp.enabled) {
    const c = String(req.body?.twoFactorCode ?? '').trim();
    if (!c) return res.status(401).json({ error: 'Enter the 6-digit code from your authenticator app.', code: '2fa_required' });
    if (!secondFactorOk(u, c)) { loginGuard.fail(u.username, req.ip); return res.status(401).json({ error: 'That code is not right.', code: '2fa_invalid' }); }
  }
  loginGuard.success(u.username, req.ip);
  delete u.emailReset; // a link works once
  u.passHash = await bcrypt.hash(newPassword, 10);
  u.publicKey = publicKey;
  u.encPrivKey = encPrivKey;
  u.recovery = recovery; // the old recovery key opened the old identity: it is replaced along with it
  delete u.passkeys;     // so did every passkey's locked copy of it: they would sign in but open nothing, so they are removed (add them again)
  await revokeAllSessions(u);
  emitUserUpdate(u); // friends and server mates pick up the new public key (their copy of the old conversation key no longer fits)
  notifyByEmail(u, 'Your Aduna password was reset by email', 'The password on your Aduna account was just reset with a link sent to this address, and a new encryption key was created, so older direct messages can no longer be read. Every device was signed out. If this was not you, someone has access to this mailbox: log in, change your password and turn email recovery off.');
  res.json({ token: startSession(req, res, u), user: ownUser(u), encPrivKey: u.encPrivKey });
}));

// ----- two-factor (authenticator app) -----
// setup: password -> a new secret (not active yet). enable: a code from the app proves it works -> turns on, returns recovery codes ONCE.
// disable: password + a code. While it is on, login also needs a code; a recovery code works once in place of one.
app.post('/api/me/2fa/setup', auth, ah(async (req, res) => {
  const u = req.user;
  if (u.totp && u.totp.enabled) return res.status(409).json({ error: 'Two-factor is already on.' });
  if (!(await passwordOk(req, res, u, req.body?.password))) return;
  loginGuard.success(u.username, req.ip);
  u.totpPending = totp.newSecret();
  store.save();
  res.json({ secret: u.totpPending, uri: totp.otpauthUri({ secret: u.totpPending, account: u.username }) });
}));
app.post('/api/me/2fa/enable', auth, (req, res) => {
  const u = req.user;
  if (u.totp && u.totp.enabled) return res.status(409).json({ error: 'Two-factor is already on.' });
  if (!u.totpPending) return res.status(400).json({ error: 'Start the setup first.' });
  const lock = loginGuard.check(u.username, req.ip);
  if (lock.blocked) { res.set('Retry-After', String(lock.retryAfterSec)); return res.status(429).json({ error: 'Too many wrong codes. Try again later.' }); }
  const stepHit = totp.verify(u.totpPending, req.body?.code);
  if (stepHit === null) { loginGuard.fail(u.username, req.ip); return res.status(400).json({ error: 'That code is not right. Check the time on your phone and try again.', code: '2fa_invalid' }); }
  const codes = totp.newRecoveryCodes();
  u.totp = { secret: u.totpPending, enabled: true, lastStep: stepHit, recovery: codes.map(totp.hashRecovery) };
  delete u.totpPending;
  store.save();
  res.json({ recoveryCodes: codes });
});
app.post('/api/me/2fa/disable', auth, ah(async (req, res) => {
  const u = req.user;
  if (!u.totp || !u.totp.enabled) return res.status(409).json({ error: 'Two-factor is not on.' });
  if (!(await passwordOk(req, res, u, req.body?.password))) return;
  if (!codeOk(req, res, u, req.body?.code)) return;
  loginGuard.success(u.username, req.ip);
  delete u.totp;
  delete u.totpPending;
  store.save();
  res.json({ ok: true });
}));

app.get('/api/me', authAny, (req, res) => res.json({ user: ownUser(req.user), encPrivKey: req.user.encPrivKey }));

app.put('/api/me/keys', auth, (req, res) => {
  const { publicKey, encPrivKey } = req.body || {};
  if (req.user.publicKey || req.user.encPrivKey) return res.status(409).json({ error: 'Keys already set' });
  if (typeof publicKey !== 'string' || publicKey.length > 2000 || !validKeyBlob(encPrivKey)) return res.status(400).json({ error: 'Bad keys' });
  req.user.publicKey = publicKey;
  req.user.encPrivKey = encPrivKey;
  store.save();
  emitUserUpdate(req.user);
  res.json({ user: ownUser(req.user) });
});

const USERNAME_COOLDOWN_MS = 7 * 24 * 3600 * 1000; // a username can be changed once a week
const MAX_LINKS = 5;

// Returns a cleaned list of { label, url }, or throws an Error with a user-facing message.
function cleanLinks(input) {
  if (!Array.isArray(input)) throw new Error('Links must be a list');
  if (input.length > MAX_LINKS) throw new Error(`You can add up to ${MAX_LINKS} links`);
  const out = [];
  for (const item of input) {
    let raw = String(item?.url ?? '').trim();
    if (!raw) continue;
    if (raw.length > 200) throw new Error('A link is too long (max 200 characters)');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = 'https://' + raw; // "twitter.com/me" -> https://twitter.com/me
    let url;
    try { url = new URL(raw); } catch { throw new Error(`"${raw}" is not a valid link`); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Links must start with http:// or https://');
    if (!url.hostname.includes('.')) throw new Error(`"${raw}" is not a valid link`);
    const label = clip(item?.label, 24).trim() || url.hostname.replace(/^www\./, '');
    out.push({ label, url: url.href });
  }
  return out;
}

app.patch('/api/me', authAny, async (req, res) => {
  const u = req.user;
  const b = req.body || {};

  // Validate everything that can fail first so a rejected request changes nothing.
  let newLinks;
  if (b.links !== undefined) {
    try { newLinks = cleanLinks(b.links); } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  let newHidden; // the badges the person is not wearing: only ids they really own are kept
  if (b.hiddenBadges !== undefined) {
    if (!Array.isArray(b.hiddenBadges) || b.hiddenBadges.length > 500) return res.status(400).json({ error: 'Badges must be a list' });
    const mine = new Set(allBadgeViews(u).map((x) => x.id));
    newHidden = [...new Set(b.hiddenBadges.filter((id) => typeof id === 'string' && mine.has(id)))];
  }
  let newFrame; // wear one of the profile frames the person owns (null or '' = take it off)
  if (b.frame !== undefined) {
    if (b.frame === null || b.frame === '') newFrame = null;
    else if (typeof b.frame === 'string' && ownsBadge(u, b.frame) && frameOf(b.frame)) newFrame = b.frame;
    else return res.status(400).json({ error: 'You can only wear a frame you own' });
  }
  let newTheme, newGradient; // a gradient profile theme: a free one, one the person bought, or their own custom gradient (undefined = unchanged, null = take it off)
  if (b.profileTheme !== undefined) {
    const copy = { profileThemes: u.profileThemes, profileGradient: u.profileGradient };
    const t = credits.pthemes.wear(copy, b.profileTheme, b.profileGradient); // a dry run on a copy, so a rejected request changes nothing
    if (!t.ok) return res.status(t.status).json({ error: t.error });
    newTheme = b.profileTheme || null;
    if (newTheme === credits.pthemes.CUSTOM_ID) newGradient = copy.profileGradient; // the cleaned colours and angle
  }
  let newUsername;
  if (b.username !== undefined && String(b.username).trim() !== u.username) {
    newUsername = String(b.username).trim().replace(/^@/, '');
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(newUsername)) return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores' });
    const wait = (u.usernameChangedAt || 0) + USERNAME_COOLDOWN_MS - now();
    if (wait > 0) {
      const when = new Date(u.usernameChangedAt + USERNAME_COOLDOWN_MS).toISOString();
      return res.status(429).json({ error: 'You can only change your username once every 7 days', availableAt: when });
    }
    if (usernameTaken(newUsername, u.id)) return res.status(409).json({ error: 'Username already taken' });
  }

  let newEmail;
  if (b.email !== undefined && String(b.email).trim().toLowerCase() !== (u.email || '')) {
    newEmail = security.cleanEmail(b.email); // an account that has an email cannot clear it
    if (!newEmail) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!mailer.enabled() && emailTaken(newEmail, u.id)) return res.status(409).json({ error: 'An account with this email already exists' }); // see register: with verification on, the answer must not depend on who is registered
  }

  if (newEmail && security.emailKey(newEmail) !== security.emailKey(u.email || '')) { delete u.emailRecovery; delete u.emailReset; } // a changed address must not inherit email recovery: turn it on again with the password
  if (newEmail) { u.email = newEmail; if (mailer.enabled()) u.emailVerified = false; } // a new address must be verified again
  if (newUsername !== undefined) {
    // Someone who never picked a display name keeps showing their username.
    if (u.displayName === u.username && (b.displayName === undefined || b.displayName === u.displayName)) { u.displayName = newUsername; delete b.displayName; }
    u.username = newUsername;
    u.usernameChangedAt = now();
  }
  if (newLinks !== undefined) u.links = newLinks;
  if (newTheme !== undefined) { if (newTheme) u.profileTheme = newTheme; else delete u.profileTheme; }
  if (newGradient) u.profileGradient = newGradient; // kept when they switch to a preset, so their own design is still there next time
  if (newHidden !== undefined) { if (newHidden.length) u.hiddenBadges = newHidden; else delete u.hiddenBadges; }
  if (newFrame !== undefined) { if (newFrame) u.frame = newFrame; else delete u.frame; }
  if (b.avatarLogo !== undefined) u.avatarLogo = !!b.avatarLogo;
  if (b.displayName !== undefined) u.displayName = clip(b.displayName, 32).trim() || u.username;
  if (b.lang !== undefined && LANGS.includes(b.lang)) u.lang = b.lang;
  if (b.bio !== undefined) u.bio = clip(b.bio, 190);
  if (b.avatarEmoji !== undefined) u.avatarEmoji = clip(b.avatarEmoji, 8);
  for (const k of ['avatarColor', 'bannerColor', 'accentColor']) if (b[k] !== undefined && hex.test(b[k])) u[k] = b[k];
  if (b.status !== undefined && ['online', 'idle', 'dnd', 'invisible'].includes(b.status)) u.status = b.status;
  if (b.showActivity !== undefined) { // "Show what I'm playing": off removes the game straight away and nothing is shown or stored while it stays off
    if (b.showActivity === false) { u.showActivity = false; activityLib.clear(activities, u.id); } else delete u.showActivity;
  }
  store.save();
  emitUserUpdate(u);
  broadcastPresence(u.id);
  let mailFailed = false;
  if (newEmail && needsVerify(u)) { try { await issueCode(u); } catch (e) { mailFailed = true; console.error('verification email failed:', e.message); } }
  res.json({ user: ownUser(u), mailFailed });
});

// ----- profile images (avatar / banner) -----
// The browser resizes and re-encodes the picture before upload; the server still checks the real
// file signature and dimensions, never the Content-Type header. Images are stored encrypted in the
// database and served from an unguessable URL, so they work in plain <img> tags.
const IMAGE_RULES = {
  avatar: { field: 'avatarImage', maxDim: 500 },
  banner: { field: 'bannerImage', maxDim: 4096 },
};
const uploadHits = new Map();
function uploadLimiter(req, res, next) {
  const t = now();
  const arr = (uploadHits.get(req.user.id) || []).filter((x) => t - x < 60_000);
  if (arr.length >= 10) return res.status(429).json({ error: 'Too many uploads, try again in a minute' });
  arr.push(t);
  uploadHits.set(req.user.id, arr);
  next();
}
const rawImage = express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '1mb' });

async function setProfileImage(u, field, buf) {
  const old = u[field];
  u[field] = buf ? await store.putImage(buf) : null;
  await store.flush(); // make sure the profile points at the new image before the old one is deleted
  await store.deleteImage(old);
  emitUserUpdate(u);
  return selfView(u);
}

for (const [kind, rule] of Object.entries(IMAGE_RULES)) {
  app.put(`/api/me/${kind}`, auth, uploadLimiter, rawImage, ah(async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Choose a PNG, JPEG or WebP image' });
    const info = sniffImage(buf);
    if (!info) return res.status(400).json({ error: 'That file is not a valid PNG, JPEG or WebP image' });
    if (info.width > rule.maxDim || info.height > rule.maxDim) return res.status(400).json({ error: `Image is too large (max ${rule.maxDim}px per side)` });
    res.json({ user: await setProfileImage(req.user, rule.field, buf) });
  }));
  app.delete(`/api/me/${kind}`, auth, ah(async (req, res) => {
    res.json({ user: await setProfileImage(req.user, rule.field, null) });
  }));
}

app.get('/api/images/:id', ah(async (req, res) => {
  const buf = await store.getImage(req.params.id);
  const info = buf && sniffImage(buf);
  if (!info) return res.status(404).json({ error: 'Not found' });
  res.set({
    'Content-Type': info.mime,
    'Cache-Control': 'public, max-age=31536000, immutable', // a new upload gets a new id
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  });
  res.send(buf);
}));

// ----- custom emoji -----
// An emoji is a small picture with a name. db.emojis[id] = { id, name, ownerId, imageId, mime, animated,
// width, height, hash, createdAt, reports: [userId], disabled }. Each user has a library
// (user.emojiLib = [{ id, name }]) of emoji they uploaded or saved from other people. Messages refer
// to an emoji as <:name:id>, reactions as c:id. Pictures are served from an unguessable URL, like
// profile pictures, so they work in plain <img> tags.
const EMOJI = { maxBytes: 256 * 1024, minDim: 16, maxDim: 512, maxRatio: 2, maxOwned: 50, maxLib: 100, reportsToDisable: 3, maxStrikes: 2 };
const EMOJI_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
// Names are checked against this list after removing look-alike characters. Short words only match a
// whole word (so "cucumber" is fine); longer ones match anywhere. Extend it with EMOJI_BLOCKED_WORDS=a,b,c
const BLOCKED_WORDS = ['nazi', 'hitler', 'heil', 'swastika', 'kkk', 'porn', 'nsfw', 'hentai', 'rape', 'rapist', 'nude', 'nudes', 'cum', 'dick', 'cock', 'pussy', 'whore', 'slut', 'fag', 'faggot', 'nigger', 'nigga', 'retard', 'kys', 'killyourself', 'suicide',
  ...String(process.env.EMOJI_BLOCKED_WORDS || '').toLowerCase().split(',').map((w) => w.trim()).filter(Boolean)];
function checkEmojiName(name) {
  if (!/^[a-z0-9_]{2,32}$/.test(name)) return 'Names are 2-32 characters: lowercase letters, numbers and underscores';
  const fold = (s) => s.replace(/0/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/7/g, 't');
  const tokens = name.split('_').map(fold);
  const joined = tokens.join('');
  for (const w of BLOCKED_WORDS) if (tokens.includes(w) || (w.length >= 5 && joined.includes(w))) return 'That name is not allowed';
  return null;
}
const liveEmoji = (id) => { const e = db().emojis[id]; return e && !e.disabled ? e : null; };
const ownedBy = (uid) => Object.values(db().emojis).filter((e) => e.ownerId === uid);
const emojiView = (e, uid, alias) => ({ id: e.id, name: alias || e.name, animated: e.animated, w: e.width, h: e.height, mine: e.ownerId === uid });
const libOf = (u) => (u.emojiLib || (u.emojiLib = []));
const rawEmoji = express.raw({ type: EMOJI_TYPES, limit: EMOJI.maxBytes });

app.get('/api/emoji/mine', auth, (req, res) => {
  const lib = libOf(req.user);
  const keep = lib.filter((x) => liveEmoji(x.id)); // drop entries whose emoji was deleted or removed after reports
  if (keep.length !== lib.length) { req.user.emojiLib = keep; store.save(); }
  res.json({ emoji: keep.map((x) => emojiView(db().emojis[x.id], req.user.id, x.name)), limits: { owned: EMOJI.maxOwned, library: EMOJI.maxLib, bytes: EMOJI.maxBytes } });
});

// Every check runs here: the browser's own checks are only for quick feedback.
app.put('/api/emoji', auth, uploadLimiter, rawEmoji, ah(async (req, res) => {
  const u = req.user;
  const fail = (status, error, extra = {}) => res.status(status).json({ error, ...extra });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return fail(400, 'Choose a PNG, JPEG, WebP or GIF image');
  const name = String(req.query.name || '').trim().toLowerCase();
  const nameErr = checkEmojiName(name);
  if (nameErr) return fail(400, nameErr);
  const mine = ownedBy(u.id);
  if (mine.filter((e) => e.disabled).length >= EMOJI.maxStrikes) return fail(403, 'Uploads are turned off for your account because your emoji were reported');
  if (mine.filter((e) => !e.disabled).length >= EMOJI.maxOwned) return fail(400, `You can upload up to ${EMOJI.maxOwned} emoji`);
  if (libOf(u).length >= EMOJI.maxLib) return fail(400, `Your emoji list is full (${EMOJI.maxLib})`);
  if (libOf(u).some((x) => x.name === name)) return fail(409, `You already have an emoji named :${name}:`);

  let data = buf, info;
  const gif = buf.toString('latin1', 0, 3) === 'GIF';
  if (gif) {
    info = cleanGif(buf);
    if (!info) return fail(400, 'That GIF is damaged or has too many frames (max 150)');
    data = info.buf;
    info.mime = 'image/gif';
  } else {
    info = sniffImage(buf);
    if (!info) return fail(400, 'That file is not a valid PNG, JPEG, WebP or GIF image');
  }
  if (info.width < EMOJI.minDim || info.height < EMOJI.minDim) return fail(400, `Too small: emoji must be at least ${EMOJI.minDim}x${EMOJI.minDim} pixels`);
  if (info.width > EMOJI.maxDim || info.height > EMOJI.maxDim) return fail(400, `Too large: emoji can be at most ${EMOJI.maxDim}x${EMOJI.maxDim} pixels`);
  if (Math.max(info.width, info.height) / Math.min(info.width, info.height) > EMOJI.maxRatio) return fail(400, 'Emoji should be roughly square (no more than twice as wide as tall)');
  if (data.length > EMOJI.maxBytes) return fail(400, 'Emoji is too large (max 256 KB)');

  const hash = crypto.createHash('sha256').update(data).digest('hex');
  const same = Object.values(db().emojis).find((e) => e.hash === hash);
  if (same?.disabled) return fail(400, 'This image was removed after reports and cannot be uploaded again');
  if (same) return fail(409, 'Someone already uploaded this exact image', { existing: emojiView(same, u.id), alreadySaved: libOf(u).some((x) => x.id === same.id) });

  const imageId = await store.putImage(data);
  const dup = Object.values(db().emojis).find((e) => e.hash === hash); // someone may have uploaded it while we were saving
  if (dup) { await store.deleteImage(imageId); return fail(409, 'Someone already uploaded this exact image', { existing: emojiView(dup, u.id), alreadySaved: libOf(u).some((x) => x.id === dup.id) }); }
  const e = { id: store.id(), name, ownerId: u.id, imageId, mime: info.mime, animated: gif && info.frames > 1,
    width: info.width, height: info.height, hash, createdAt: now(), reports: [], disabled: false };
  db().emojis[e.id] = e;
  libOf(u).push({ id: e.id, name });
  await store.flush();
  res.json({ emoji: emojiView(e, u.id) });
}));

app.post('/api/emoji/:id/save', auth, (req, res) => {
  const e = liveEmoji(req.params.id);
  if (!e) return res.status(404).json({ error: 'That emoji is no longer available' });
  const lib = libOf(req.user);
  const have = lib.find((x) => x.id === e.id);
  if (have) return res.json({ emoji: emojiView(e, req.user.id, have.name) });
  if (lib.length >= EMOJI.maxLib) return res.status(400).json({ error: `Your emoji list is full (${EMOJI.maxLib})` });
  let name = e.name, n = 2; // keep names unique inside your own list
  while (lib.some((x) => x.name === name)) name = e.name.slice(0, 29) + '_' + n++;
  lib.push({ id: e.id, name });
  store.save();
  res.json({ emoji: emojiView(e, req.user.id, name) });
});

// the owner deletes the emoji for everyone; anyone else just removes it from their own list
app.delete('/api/emoji/:id', auth, ah(async (req, res) => {
  const e = db().emojis[req.params.id];
  if (!e) return res.json({ ok: true });
  if (e.ownerId === req.user.id && !e.disabled) {
    delete db().emojis[e.id];
    await store.deleteImage(e.imageId);
    for (const x of Object.values(db().users)) if (x.emojiLib) x.emojiLib = x.emojiLib.filter((l) => l.id !== e.id);
  } else req.user.emojiLib = libOf(req.user).filter((l) => l.id !== e.id);
  store.save();
  res.json({ ok: true });
}));

// Enough different people reporting an emoji switches it off for everyone. The picture is deleted but
// its fingerprint is kept, so the same image cannot be uploaded again.
app.post('/api/emoji/:id/report', auth, ah(async (req, res) => {
  const e = db().emojis[req.params.id];
  if (!e) return res.status(404).json({ error: 'Not found' });
  if (e.ownerId === req.user.id) return res.status(400).json({ error: 'You cannot report your own emoji' });
  if (!e.reports.includes(req.user.id)) e.reports.push(req.user.id);
  req.user.emojiLib = libOf(req.user).filter((l) => l.id !== e.id);
  if (!e.disabled && e.reports.length >= EMOJI.reportsToDisable) {
    e.disabled = true;
    const gone = e.imageId;
    e.imageId = null;
    await store.deleteImage(gone);
    for (const x of Object.values(db().users)) if (x.emojiLib) x.emojiLib = x.emojiLib.filter((l) => l.id !== e.id);
  }
  store.save();
  res.json({ ok: true, disabled: e.disabled });
}));

// ----- theme gallery (rules in themegallery.js) -----
// A theme is three values (light/dark, background, accent), so publishing one cannot carry code or pictures. A person uses a gallery theme
// as their own look (stored on their device, like any custom theme) or an owner applies one to a server through the ordinary server theme.
const themesList = () => Object.values(db().themes);
const liveTheme = (id) => { const t = db().themes[id]; return t && !t.hidden ? t : null; };
app.get('/api/themes', auth, (req, res) => {
  const q = req.query || {};
  res.json(gallery.list(themesList(), db().users, { sort: q.sort === 'new' ? 'new' : 'popular', mode: q.mode, q: String(q.q || ''), offset: q.offset, uid: req.user.id }));
});
app.get('/api/themes/mine', auth, (req, res) => {
  const mine = themesList().filter((t) => t.ownerId === req.user.id && !t.hidden).sort((a, b) => b.createdAt - a.createdAt);
  res.json({ themes: mine.map((t) => gallery.view(t, req.user.id, db().users)), limits: { owned: gallery.THEME.maxOwned } });
});
app.put('/api/themes', auth, (req, res) => {
  const checked = gallery.checkPublish(req.body, BLOCKED_WORDS);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const { name, description, seed } = checked.ok;
  const limit = gallery.publishLimit(themesList(), req.user.id, seed, now());
  if (limit) return res.status(429).json({ error: limit });
  const t = { id: store.id(), name, description, seed, ownerId: req.user.id, createdAt: now(), uses: 0, reports: [], hidden: false };
  db().themes[t.id] = t;
  store.save();
  res.json({ theme: gallery.view(t, req.user.id, db().users) });
});
// counts one use per person (the theme itself is applied by the client: on the device, or through the server settings)
app.post('/api/themes/:id/use', auth, (req, res) => {
  const t = liveTheme(req.params.id);
  if (!t) return res.status(404).json({ error: 'That theme is no longer available' });
  const used = req.user.themeUses || (req.user.themeUses = []);
  if (!used.includes(t.id) && t.ownerId !== req.user.id) {
    used.push(t.id);
    if (used.length > 300) used.splice(0, used.length - 300);
    t.uses = (t.uses || 0) + 1;
    store.save();
  }
  res.json({ theme: gallery.view(t, req.user.id, db().users) });
});
app.delete('/api/themes/:id', auth, (req, res) => {
  const t = db().themes[req.params.id];
  if (!t) return res.json({ ok: true });
  if (t.ownerId !== req.user.id) return res.status(403).json({ error: 'Only the person who published a theme can delete it' });
  delete db().themes[t.id]; // people already using its colours keep them: those are stored on their device or on their server
  store.save();
  res.json({ ok: true });
});
app.post('/api/themes/:id/report', auth, (req, res) => {
  const t = db().themes[req.params.id];
  if (!t || t.hidden) return res.status(404).json({ error: 'Not found' });
  if (t.ownerId === req.user.id) return res.status(400).json({ error: 'You cannot report your own theme' });
  gallery.addReport(t, req.user.id, now());
  if (gallery.shouldHide(t, db().users, now())) t.hidden = true;
  store.save();
  res.json({ ok: true });
});

app.get('/api/emoji/:id/image', ah(async (req, res) => {
  const e = liveEmoji(req.params.id);
  const buf = e && await store.getImage(e.imageId);
  if (!buf) return res.status(404).json({ error: 'Not found' });
  res.set({ 'Content-Type': e.mime, 'Cache-Control': 'public, max-age=604800, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
  res.send(buf);
}));

// ----- message attachments -----
// Files are uploaded first (raw bytes), then referenced by id when the message is sent. For DMs the
// browser encrypts the bytes with the conversation key, so the server only ever holds ciphertext.
const fileHits = new Map();
function fileLimiter(req, res, next) {
  const t = now();
  const arr = (fileHits.get(req.user.id) || []).filter((x) => t - x < 60_000);
  if (arr.length >= 20) return res.status(429).json({ error: 'Too many uploads, try again in a minute' });
  arr.push(t);
  fileHits.set(req.user.id, arr);
  next();
}
// scope string a user may upload to / read from, or null
function fileScope(uid, kind, target) {
  if (kind === 'channel') {
    const f = findChannel(target);
    return f && f.server.members.includes(uid) ? 'channel:' + f.channel.id : null;
  }
  if (kind === 'dm') return db().users[target] && target !== uid && areFriends(uid, target) ? 'dm:' + convoKey(uid, target) : null;
  if (kind === 'group') { const g = groups.memberOf(target, uid); return g ? 'group:' + g.id : null; }
  return null;
}
function canReadScope(uid, scope) {
  const [kind, rest] = String(scope).split(/:(.*)/s);
  if (kind === 'channel') { const f = findChannel(rest); return !!f && f.server.members.includes(uid); }
  if (kind === 'dm') return rest.split(':').includes(uid);
  if (kind === 'group') return !!groups.memberOf(rest, uid);
  return false;
}
app.post('/api/files', auth, fileLimiter, express.raw({ type: '*/*', limit: MAX_FILE + FILE_SLACK }), ah(async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Choose a file to send' });
  const scope = fileScope(req.user.id, req.query.kind, String(req.query.target || ''));
  if (!scope) return res.status(403).json({ error: 'You cannot send files here' });
  if (req.query.kind !== 'dm' && buf.length > MAX_FILE) return res.status(413).json({ error: 'File is too large (max 20 MB)' });
  const fid = await store.putFile(buf, { owner: req.user.id, scope, size: buf.length });
  res.json({ id: fid });
}));
app.get('/api/files/:id', auth, ah(async (req, res) => {
  const meta = await store.fileMeta(req.params.id);
  if (!meta || !canReadScope(req.user.id, meta.scope) || (!meta.attached && meta.owner !== req.user.id)) return res.status(404).json({ error: 'Not found' });
  res.set({
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'private, max-age=86400, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    'Content-Disposition': 'attachment',
  });
  const bytes = await store.getFileBytes(req.params.id);
  if (!bytes) return res.status(404).json({ error: 'Not found' });
  res.send(bytes);
}));
app.delete('/api/files/:id', auth, ah(async (req, res) => { // discard an upload that was never sent
  const meta = await store.fileMeta(req.params.id);
  if (meta && meta.owner === req.user.id && !meta.attached) await store.deleteFiles([req.params.id]);
  res.json({ ok: true });
}));

// GIF search is proxied so the API key stays on the server. Enabled by setting GIPHY_API_KEY.
const gifHits = new Map();
app.get('/api/gifs/config', auth, (_req, res) => res.json({ enabled: !!GIPHY_KEY }));
app.get('/api/gifs', auth, async (req, res) => {
  if (!GIPHY_KEY) return res.status(503).json({ error: 'GIF search is not configured' });
  const t = now();
  const arr = (gifHits.get(req.user.id) || []).filter((x) => t - x < 60_000);
  if (arr.length >= 90) return res.status(429).json({ error: 'Slow down' }); // scrolling loads a page at a time
  arr.push(t); gifHits.set(req.user.id, arr);
  const q = clip(req.query.q, 60).trim();
  const offset = Math.min(450, Math.max(0, parseInt(req.query.offset, 10) || 0)); // GIPHY allows paging to 499
  const limit = 24;
  const url = `https://api.giphy.com/v1/gifs/${q ? 'search' : 'trending'}?api_key=${encodeURIComponent(GIPHY_KEY)}&limit=${limit}&offset=${offset}&rating=pg-13${q ? '&q=' + encodeURIComponent(q) : ''}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('bad status');
    const body = await r.json();
    const raw = body.data || [];
    const gifs = raw.map((g) => {
      const im = g.images?.fixed_height || {};
      return { id: String(g.id), title: clip(g.title, 80), url: im.url, w: Number(im.width), h: Number(im.height) };
    }).filter((g) => isGifUrl(g.url) && g.w > 0 && g.h > 0);
    const total = Number(body.pagination?.total_count) || 0;
    const reached = offset + raw.length;
    res.json({ gifs, next: raw.length === limit && reached < Math.min(total || Infinity, 500) ? reached : null });
  } catch { res.status(502).json({ error: 'Could not reach the GIF service' }); }
});

app.get('/api/users/:id', auth, (req, res) => {
  const u = db().users[req.params.id];
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ user: u.id === req.user.id ? selfView(u) : publicUser(u) });
});

// ----- friends -----
// db.friendships[convoKey(a, b)] = { from, to, status: 'pending' | 'friends', createdAt }
const friendship = (a, b) => db().friendships[convoKey(a, b)];
const areFriends = (a, b) => friendship(a, b)?.status === 'friends';
const notifyFriends = (...ids) => ids.forEach((id) => io.to('user:' + id).emit('friends:changed'));

function friendsView(uid) {
  const out = { friends: [], incoming: [], outgoing: [] };
  for (const f of Object.values(db().friendships)) {
    if (f.from !== uid && f.to !== uid) continue;
    const other = db().users[f.from === uid ? f.to : f.from];
    if (!other) continue;
    if (f.status === 'friends') out.friends.push(publicUser(other));
    else if (f.to === uid) out.incoming.push({ user: publicUser(other), createdAt: f.createdAt });
    else out.outgoing.push({ user: publicUser(other), createdAt: f.createdAt });
  }
  out.friends.sort((a, b) => a.displayName.localeCompare(b.displayName));
  out.incoming.sort((a, b) => b.createdAt - a.createdAt);
  out.outgoing.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

app.get('/api/friends', auth, (req, res) => res.json(friendsView(req.user.id)));

app.post('/api/friends/request', auth, (req, res) => {
  const me = req.user;
  const name = String(req.body?.username || '').trim().replace(/^@/, '').toLowerCase();
  if (!name) return res.status(400).json({ error: 'Enter a username' });
  const target = Object.values(db().users).find((u) => !u.bot && u.username.toLowerCase() === name);
  if (!target) return res.status(404).json({ error: "We couldn't find anyone with that username" });
  if (target.id === me.id) return res.status(400).json({ error: "You can't add yourself" });

  const f = friendship(me.id, target.id);
  if (f?.status === 'friends') return res.status(400).json({ error: `You're already friends with ${target.displayName}` });
  if (f && f.from === me.id) return res.status(400).json({ error: 'You already sent them a request' });
  if (f) { // they already asked you: that's a yes
    f.status = 'friends';
    store.save();
    notifyFriends(me.id, target.id);
    introduce(me.id, target.id);
    return res.json({ result: 'friends', user: publicUser(target) });
  }
  const pendingOut = Object.values(db().friendships).filter((x) => x.from === me.id && x.status === 'pending').length;
  if (pendingOut >= 50) return res.status(400).json({ error: 'Too many pending requests' });
  db().friendships[convoKey(me.id, target.id)] = { from: me.id, to: target.id, status: 'pending', createdAt: now() };
  store.save();
  notifyFriends(me.id, target.id);
  introduce(me.id, target.id);
  pushSafe(target.id, 'friend', { title: me.displayName, body: 'sent you a friend request', url: '/app?n=f', tag: 'friend:' + me.id, sender: me.displayName, icon: imgPath(me.avatarImage) });
  res.json({ result: 'sent', user: publicUser(target) });
});

app.post('/api/friends/:id/accept', auth, (req, res) => {
  const f = friendship(req.user.id, req.params.id);
  if (!f || f.status !== 'pending' || f.to !== req.user.id) return res.status(404).json({ error: 'No request from that user' });
  f.status = 'friends';
  store.save();
  notifyFriends(f.from, f.to);
  res.json({ ok: true });
});

// decline an incoming request, cancel an outgoing one, or remove a friend
app.delete('/api/friends/:id', auth, (req, res) => {
  const key = convoKey(req.user.id, req.params.id);
  const f = db().friendships[key];
  if (!f) return res.status(404).json({ error: 'Not found' });
  delete db().friendships[key];
  store.save();
  notifyFriends(f.from, f.to);
  res.json({ ok: true });
});

// ----- servers & channels -----
const myServers = (uid) => Object.values(db().servers).filter((s) => s.members.includes(uid));

app.get('/api/servers', auth, (req, res) => res.json({ servers: myServers(req.user.id).map(serverView) }));

app.post('/api/servers', auth, (req, res) => {
  const name = clip(req.body?.name, 40).trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const s = { id: store.id(), name, ownerId: req.user.id, inviteCode: store.inviteCode(), members: [req.user.id],
    channels: [{ id: store.id(), name: 'general', type: 'text' }] };
  db().servers[s.id] = s;
  store.save();
  joinRooms(req.user.id);
  res.json({ server: serverView(s) });
});

// Publishing: a server must have enough channels before it can pick a visibility.
//   private  = only the users the owner lists can join (with the invite code)
//   unlisted = anyone with the invite code (also how a server that was never published behaves)
//   public   = anyone with the code, and it is meant to show in the server explorer (not built yet)
const PUBLISH_REQ = { text: 3, voice: 2 };            // needed for any visibility
const PUBLIC_REQ = { rules: 1, announcements: 1 };    // public servers also need these
const VISIBILITIES = ['private', 'unlisted', 'public'];
const MAX_ALLOWED = 100, MAX_DESC = 200;
const canJoin = (s, uid) => s.visibility !== 'private' || (s.allowed || []).includes(uid);
function publishCounts(s) {
  const n = { text: 0, voice: 0, rules: 0, announcements: 0 };
  for (const c of s.channels) n[typeOf(c)]++;
  return n;
}
const KIND_WORD = { text: 'text channel', voice: 'voice channel', rules: 'rules channel', announcements: 'announcements channel' };
function publishMissing(s, vis) {
  const n = publishCounts(s), need = vis === 'public' ? { ...PUBLISH_REQ, ...PUBLIC_REQ } : PUBLISH_REQ;
  return Object.entries(need).filter(([k, v]) => n[k] < v).map(([k, v]) => `${v - n[k]} more ${KIND_WORD[k]}${v - n[k] === 1 ? '' : 's'}`);
}

app.post('/api/servers/join', auth, (req, res) => {
  const code = String(req.body?.code || '').trim().toLowerCase();
  const s = Object.values(db().servers).find((x) => x.inviteCode === code);
  if (!s) return res.status(404).json({ error: 'Invalid invite code' });
  if (!s.members.includes(req.user.id) && !canJoin(s, req.user.id)) return res.status(403).json({ error: 'This server is private. Ask the owner to add you.' });
  if (!s.members.includes(req.user.id)) {
    s.members.push(req.user.id);
    (s.joinedAt = s.joinedAt || {})[req.user.id] = Date.now();
    if (s.onboarded) delete s.onboarded[req.user.id]; // coming back means answering again
    store.save();
    joinRooms(req.user.id);
    io.to('server:' + s.id).emit('server:update', serverView(s));
    for (const m of s.members) introduce(req.user.id, m);
    broadcastPresence(req.user.id);
    dispatchBots(s, 'memberJoin', { user: req.user });
  }
  res.json({ server: serverView(s) });
});

// Channel presets. Channels saved before presets existed have no type and count as text.
const CHANNEL_TYPES = ['text', 'voice', 'rules', 'announcements'];
const typeOf = (c) => c.type || 'text';
const MAX_RULES = 25, MAX_RULE = 300;

app.post('/api/servers/:id/channels', auth, (req, res) => {
  const s = db().servers[req.params.id];
  if (!s || !can(s, req.user.id, 'manageChannels')) return res.status(403).json({ error: 'You need the Manage channels permission to add channels' });
  const name = clip(req.body?.name, 30).toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name) return res.status(400).json({ error: 'Invalid channel name' });
  if (s.channels.length >= 30) return res.status(400).json({ error: 'Channel limit reached' });
  const type = req.body?.type === undefined ? 'text' : req.body.type;
  if (!CHANNEL_TYPES.includes(type)) return res.status(400).json({ error: 'Unknown channel type' });
  const channel = { id: store.id(), name, type };
  if (type === 'rules') channel.rules = [];
  const categoryId = req.body?.categoryId;
  if (categoryId) {
    if (!(s.categories || []).some((c) => c.id === categoryId)) return res.status(400).json({ error: 'That category does not exist' });
    channel.categoryId = categoryId;
  }
  s.channels.push(channel);
  store.save();
  s.members.forEach(joinRooms); // members' open sockets must join the new channel's room or they miss its live messages
  io.to('server:' + s.id).emit('server:update', serverView(s));
  res.json({ server: serverView(s) });
});

// Rules channel: a list the owner builds up with +. Stored on the channel and sent with the server.
function rulesChannel(req, res) {
  const s = db().servers[req.params.id];
  if (!s || !can(s, req.user.id, 'manageChannels')) { res.status(403).json({ error: 'You need the Manage channels permission to edit rules' }); return null; }
  const c = s.channels.find((x) => x.id === req.params.cid);
  if (!c || typeOf(c) !== 'rules') { res.status(404).json({ error: 'Rules channel not found' }); return null; }
  c.rules = c.rules || [];
  return { s, c };
}
function rulesDone(s, res) {
  store.save();
  io.to('server:' + s.id).emit('server:update', serverView(s));
  res.json({ server: serverView(s) });
}
app.post('/api/servers/:id/channels/:cid/rules', auth, (req, res) => {
  const f = rulesChannel(req, res); if (!f) return;
  const text = clip(req.body?.text, MAX_RULE).trim();
  if (!text) return res.status(400).json({ error: 'Rule text required' });
  if (f.c.rules.length >= MAX_RULES) return res.status(400).json({ error: `Rule limit reached (${MAX_RULES})` });
  f.c.rules.push({ id: store.id(), text });
  rulesDone(f.s, res);
});
app.patch('/api/servers/:id/channels/:cid/rules/:rid', auth, (req, res) => {
  const f = rulesChannel(req, res); if (!f) return;
  const r = f.c.rules.find((x) => x.id === req.params.rid);
  const text = clip(req.body?.text, MAX_RULE).trim();
  if (!r) return res.status(404).json({ error: 'Rule not found' });
  if (!text) return res.status(400).json({ error: 'Rule text required' });
  r.text = text;
  rulesDone(f.s, res);
});
app.delete('/api/servers/:id/channels/:cid/rules/:rid', auth, (req, res) => {
  const f = rulesChannel(req, res); if (!f) return;
  if (!f.c.rules.some((x) => x.id === req.params.rid)) return res.status(404).json({ error: 'Rule not found' });
  f.c.rules = f.c.rules.filter((x) => x.id !== req.params.rid);
  rulesDone(f.s, res);
});

// Categories split the channel list into groups. Channels without a categoryId stay in the ungrouped list at the top.
app.post('/api/servers/:id/categories', auth, (req, res) => {
  const s = db().servers[req.params.id];
  if (!s || !can(s, req.user.id, 'manageChannels')) return res.status(403).json({ error: 'You need the Manage channels permission to add categories' });
  const name = clip(req.body?.name, 30).trim();
  if (!name) return res.status(400).json({ error: 'Category name required' });
  s.categories = s.categories || [];
  if (s.categories.length >= 20) return res.status(400).json({ error: 'Category limit reached' });
  if (s.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: 'You already have a category with that name' });
  s.categories.push({ id: store.id(), name });
  store.save();
  io.to('server:' + s.id).emit('server:update', serverView(s));
  res.json({ server: serverView(s) });
});

// ----- edit / delete / reorder channels and categories (Manage channels) -----
function ownerOf(req, res) { // publishing and who may join stay with the owner
  const s = db().servers[req.params.id];
  if (!s || s.ownerId !== req.user.id) { res.status(403).json({ error: 'Only the server owner can do that' }); return null; }
  return s;
}
function permOf(perm, what) {
  return (req, res) => {
    const s = db().servers[req.params.id];
    if (!s || !s.members.includes(req.user.id)) { res.status(404).json({ error: 'Not found' }); return null; }
    if (!can(s, req.user.id, perm)) { res.status(403).json({ error: `You need the ${what} permission to do that` }); return null; }
    return s;
  };
}
const channelsOf = permOf('manageChannels', 'Manage channels');
const cleanChannelName = (v) => clip(v, 30).toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
const pushServer = (s, res) => { store.save(); io.to('server:' + s.id).emit('server:update', serverView(s)); res.json({ server: serverView(s) }); };

app.patch('/api/servers/:id/channels/:cid', auth, (req, res) => {
  const s = channelsOf(req, res); if (!s) return;
  const c = s.channels.find((x) => x.id === req.params.cid);
  if (!c) return res.status(404).json({ error: 'Channel not found' });
  const name = cleanChannelName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Invalid channel name' });
  c.name = name;
  pushServer(s, res);
});

app.delete('/api/servers/:id/channels/:cid', auth, (req, res) => {
  const s = channelsOf(req, res); if (!s) return;
  const c = s.channels.find((x) => x.id === req.params.cid);
  if (!c) return res.status(404).json({ error: 'Channel not found' });
  if (s.channels.length <= 1) return res.status(400).json({ error: 'A server needs at least one channel' });
  if (s.visibility) { // a published server must keep meeting the publish requirements
    const rest = { ...s, channels: s.channels.filter((x) => x.id !== c.id) };
    const missing = publishMissing(rest, s.visibility);
    if (missing.length) return res.status(400).json({ error: `This server is published and needs its channels. Unpublish it first, or add ${missing.join(' and ')} before deleting this one.` });
  }
  // everything in the channel goes with it, including uploaded files
  const gone = Object.values(db().messages).filter((m) => m.channelId === c.id);
  const fileIds = gone.flatMap((m) => (m.attachments || []).map((a) => a.id).filter(Boolean));
  for (const m of gone) delete db().messages[m.id];
  s.channels = s.channels.filter((x) => x.id !== c.id);
  const room = voice.get(c.id);
  if (room) { for (const sid of room.values()) io.to(sid).emit('voice:kicked', { channelId: c.id }); voice.delete(c.id); }
  io.in('channel:' + c.id).socketsLeave('channel:' + c.id);
  store.deleteFiles(fileIds).catch((e) => console.error(e));
  pushServer(s, res);
});

app.patch('/api/servers/:id/categories/:catid', auth, (req, res) => {
  const s = channelsOf(req, res); if (!s) return;
  const cat = (s.categories || []).find((x) => x.id === req.params.catid);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const name = clip(req.body?.name, 30).trim();
  if (!name) return res.status(400).json({ error: 'Category name required' });
  if (s.categories.some((x) => x.id !== cat.id && x.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: 'You already have a category with that name' });
  cat.name = name;
  pushServer(s, res);
});

// Deleting a category keeps its channels; they move to the ungrouped list at the top.
app.delete('/api/servers/:id/categories/:catid', auth, (req, res) => {
  const s = channelsOf(req, res); if (!s) return;
  if (!(s.categories || []).some((x) => x.id === req.params.catid)) return res.status(404).json({ error: 'Category not found' });
  s.categories = s.categories.filter((x) => x.id !== req.params.catid);
  for (const c of s.channels) if (c.categoryId === req.params.catid) delete c.categoryId;
  pushServer(s, res);
});

// One call saves a whole drag-and-drop result: the order of the categories, and the order of the channels with
// the category each one now sits in (null = ungrouped). It must list exactly the channels and categories that exist.
app.put('/api/servers/:id/layout', auth, (req, res) => {
  const s = channelsOf(req, res); if (!s) return;
  const cats = req.body?.categories, chans = req.body?.channels;
  const same = (given, have) => Array.isArray(given) && given.length === have.length && new Set(given).size === given.length && have.every((x) => given.includes(x));
  if (!same(cats, (s.categories || []).map((c) => c.id))) return res.status(400).json({ error: 'Category list is out of date, reload and try again' });
  if (!Array.isArray(chans) || !same(chans.map((c) => c?.id), s.channels.map((c) => c.id))) return res.status(400).json({ error: 'Channel list is out of date, reload and try again' });
  if (chans.some((c) => c.categoryId !== null && !cats.includes(c.categoryId))) return res.status(400).json({ error: 'That category does not exist' });
  const byId = new Map(s.channels.map((c) => [c.id, c]));
  s.channels = chans.map((x) => { const c = byId.get(x.id); if (x.categoryId) c.categoryId = x.categoryId; else delete c.categoryId; return c; });
  const catById = new Map((s.categories || []).map((c) => [c.id, c]));
  s.categories = cats.map((id) => catById.get(id));
  pushServer(s, res);
});

// ----- publish settings (owner only) -----
function publishView(s) {
  return {
    requirements: PUBLISH_REQ, publicRequirements: PUBLIC_REQ, counts: publishCounts(s),
    met: publishMissing(s).length === 0, metPublic: publishMissing(s, 'public').length === 0,
    visibility: s.visibility || null, description: s.description || '',
    review: s.listingHold ? s.listingHold.state : null, // 'hidden' (under review after reports) | 'removed' (taken down): only the owner sees this
    allowed: (s.allowed || []).map((id) => db().users[id]).filter(Boolean).map(publicUser),
  };
}
app.get('/api/servers/:id/publish', auth, (req, res) => {
  const s = ownerOf(req, res); if (!s) return;
  res.json({ publish: publishView(s) });
});
app.put('/api/servers/:id/publish', auth, (req, res) => {
  const s = ownerOf(req, res); if (!s) return;
  const v = req.body?.visibility;
  if (v === null) { delete s.visibility; } // unpublish; the allowed list and description are kept for next time
  else {
    if (!VISIBILITIES.includes(v)) return res.status(400).json({ error: 'Pick private, unlisted or public' });
    const missing = publishMissing(s, v);
    if (missing.length) return res.status(400).json({ error: `Add ${missing.join(' and ')} before publishing` });
    const desc = req.body?.description === undefined ? (s.description || '') : clip(req.body.description, MAX_DESC).trim();
    if (v === 'public' && !desc) return res.status(400).json({ error: 'Write a short description so people know what your public server is about' });
    if (v === 'public') {
      if (s.listingHold) return res.status(400).json({ error: s.listingHold.state === 'removed' ? 'This server was removed from the public listing after reports. You can still use it as private or unlisted.' : 'This server\'s public listing is under review after reports. It cannot be changed until the review is done.' });
      const problem = listing.listingProblem({ name: s.name, description: desc, tags: s.tags }, BLOCKED_WORDS);
      if (problem) return res.status(400).json({ error: problem });
    }
    s.description = desc;
    s.visibility = v;
    s.publishedAt = s.publishedAt || now();
  }
  store.save();
  io.to('server:' + s.id).emit('server:update', serverView(s));
  res.json({ publish: publishView(s), server: serverView(s) });
});
app.post('/api/servers/:id/publish/allowed', auth, (req, res) => {
  const s = ownerOf(req, res); if (!s) return;
  const name = String(req.body?.username || '').trim().replace(/^@/, '').toLowerCase();
  const target = Object.values(db().users).find((u) => !u.bot && u.username.toLowerCase() === name);
  if (!name || !target) return res.status(404).json({ error: "We couldn't find anyone with that username" });
  if (target.id === s.ownerId) return res.status(400).json({ error: 'You own this server, so you can always join it' });
  s.allowed = s.allowed || [];
  if (s.allowed.includes(target.id)) return res.status(400).json({ error: 'That person is already on the list' });
  if (s.allowed.length >= MAX_ALLOWED) return res.status(400).json({ error: `The list is limited to ${MAX_ALLOWED} people` });
  s.allowed.push(target.id);
  store.save();
  res.json({ publish: publishView(s) });
});
app.delete('/api/servers/:id/publish/allowed/:uid', auth, (req, res) => {
  const s = ownerOf(req, res); if (!s) return;
  s.allowed = (s.allowed || []).filter((id) => id !== req.params.uid);
  store.save();
  res.json({ publish: publishView(s) });
});

// ----- roles (Manage roles) -----
const rolesOf = permOf('manageRoles', 'Manage roles');
const cleanColor = (c) => (c === null || c === '' ? null : hex.test(c) ? c.toLowerCase() : undefined);
const cleanPerms = (p) => (Array.isArray(p) && p.every((x) => PERMS.includes(x)) ? [...new Set(p)] : undefined);
// the person may only switch on or off permissions they hold themselves (the owner holds all of them)
const permsAllowed = (s, uid, before, after) => {
  const mine = permsOf(s, uid);
  return [...new Set([...before, ...after])].filter((p) => before.includes(p) !== after.includes(p)).every((p) => mine.has(p));
};
// can this person change this role? it must sit strictly below their top role
const belowMe = (s, uid, roleId) => uid === s.ownerId || roleIndex(s, roleId) > rankOf(s, uid);

app.post('/api/servers/:id/roles', auth, (req, res) => {
  const s = rolesOf(req, res); if (!s) return;
  s.roles = s.roles || [];
  if (s.roles.length >= MAX_ROLES) return res.status(400).json({ error: `Role limit reached (${MAX_ROLES})` });
  if (req.user.id !== s.ownerId && rankOf(s, req.user.id) === Infinity) return res.status(403).json({ error: 'You need a role of your own before you can create roles below it' });
  const name = clip(req.body?.name, 30).trim() || 'new role';
  const color = req.body?.color === undefined ? null : cleanColor(req.body.color);
  const perms = req.body?.perms === undefined ? [] : cleanPerms(req.body.perms);
  if (color === undefined) return res.status(400).json({ error: 'Invalid colour' });
  if (!perms) return res.status(400).json({ error: 'Unknown permission' });
  if (!permsAllowed(s, req.user.id, [], perms)) return res.status(403).json({ error: 'You can only give permissions you have yourself' });
  s.roles.push({ id: store.id(), name, color, perms }); // new roles start at the bottom
  pushServer(s, res);
});

app.patch('/api/servers/:id/roles/:rid', auth, (req, res) => {
  const s = rolesOf(req, res); if (!s) return;
  const r = roleById(s, req.params.rid);
  if (!r) return res.status(404).json({ error: 'Role not found' });
  if (!belowMe(s, req.user.id, r.id)) return res.status(403).json({ error: 'That role is above your own' });
  const b = req.body || {};
  if (b.name !== undefined) { const name = clip(b.name, 30).trim(); if (!name) return res.status(400).json({ error: 'Name required' }); r.name = name; }
  if (b.color !== undefined) { const color = cleanColor(b.color); if (color === undefined) return res.status(400).json({ error: 'Invalid colour' }); r.color = color; }
  if (b.perms !== undefined) {
    const perms = cleanPerms(b.perms);
    if (!perms) return res.status(400).json({ error: 'Unknown permission' });
    if (!permsAllowed(s, req.user.id, r.perms, perms)) return res.status(403).json({ error: 'You can only change permissions you have yourself' });
    r.perms = perms;
  }
  pushServer(s, res);
});

app.delete('/api/servers/:id/roles/:rid', auth, (req, res) => {
  const s = rolesOf(req, res); if (!s) return;
  const r = roleById(s, req.params.rid);
  if (!r) return res.status(404).json({ error: 'Role not found' });
  if (!belowMe(s, req.user.id, r.id)) return res.status(403).json({ error: 'That role is above your own' });
  s.roles = s.roles.filter((x) => x.id !== r.id);
  for (const q of s.onboarding?.questions || []) for (const o of q.options) o.roles = o.roles.filter((id) => id !== r.id);
  for (const uid of Object.keys(s.memberRoles || {})) {
    s.memberRoles[uid] = s.memberRoles[uid].filter((id) => id !== r.id);
    if (!s.memberRoles[uid].length) delete s.memberRoles[uid];
  }
  pushServer(s, res);
});

// new order, highest first; you can only move roles below your own top role
app.put('/api/servers/:id/roles-order', auth, (req, res) => {
  const s = rolesOf(req, res); if (!s) return;
  const ids = req.body?.ids;
  const cur = (s.roles || []).map((r) => r.id);
  if (!Array.isArray(ids) || ids.length !== cur.length || new Set(ids).size !== ids.length || !ids.every((id) => cur.includes(id))) return res.status(400).json({ error: 'Send every role once' });
  const rank = rankOf(s, req.user.id);
  if (req.user.id !== s.ownerId && !cur.slice(0, rank + 1).every((id, i) => ids[i] === id)) return res.status(403).json({ error: 'You cannot move roles at or above your own' });
  s.roles = ids.map((id) => roleById(s, id));
  pushServer(s, res);
});

// what every member can do, whatever their roles
app.put('/api/servers/:id/everyone', auth, (req, res) => {
  const s = rolesOf(req, res); if (!s) return;
  const perms = cleanPerms(req.body?.perms);
  if (!perms) return res.status(400).json({ error: 'Unknown permission' });
  if (perms.includes('administrator') && req.user.id !== s.ownerId) return res.status(403).json({ error: 'Only the owner can give administrator to everyone' });
  if (!permsAllowed(s, req.user.id, s.everyone || [], perms)) return res.status(403).json({ error: 'You can only change permissions you have yourself' });
  s.everyone = perms;
  pushServer(s, res);
});

// give someone roles (replaces their list); only roles below yours may be added or removed, and only to people below you
app.put('/api/servers/:id/members/:uid/roles', auth, (req, res) => {
  const s = rolesOf(req, res); if (!s) return;
  const uid = req.params.uid;
  if (!s.members.includes(uid)) return res.status(404).json({ error: 'Not a member' });
  if (uid === s.ownerId) return res.status(400).json({ error: 'The owner already has every permission' });
  const want = req.body?.roles;
  if (!Array.isArray(want) || !want.every((id) => roleById(s, id))) return res.status(400).json({ error: 'Unknown role' });
  if (req.user.id !== s.ownerId && uid !== req.user.id && rankOf(s, uid) <= rankOf(s, req.user.id)) return res.status(403).json({ error: 'That member is at or above your own role' });
  const have = heldRoleIds(s, uid);
  const changed = [...new Set([...have, ...want])].filter((id) => have.includes(id) !== want.includes(id));
  if (!changed.every((id) => belowMe(s, req.user.id, id))) return res.status(403).json({ error: 'You can only give or take roles below your own' });
  s.memberRoles = s.memberRoles || {};
  const next = s.roles.map((r) => r.id).filter((id) => want.includes(id));
  if (next.length) s.memberRoles[uid] = next; else delete s.memberRoles[uid];
  pushServer(s, res);
});

app.post('/api/servers/:id/members/:uid/kick', auth, (req, res) => {
  const s = db().servers[req.params.id];
  if (!s || !s.members.includes(req.user.id)) return res.status(404).json({ error: 'Not found' });
  if (!can(s, req.user.id, 'kickMembers')) return res.status(403).json({ error: 'You need the Kick members permission to do that' });
  const uid = req.params.uid;
  if (!s.members.includes(uid)) return res.status(404).json({ error: 'Not a member' });
  if (db().users[uid]?.bot) return res.status(400).json({ error: 'That is a bot. Remove it from Server settings > Bots.' });
  if (uid === s.ownerId) return res.status(400).json({ error: 'The owner cannot be kicked' });
  if (uid === req.user.id) return res.status(400).json({ error: 'Use Leave server to leave' });
  if (req.user.id !== s.ownerId && rankOf(s, uid) <= rankOf(s, req.user.id)) return res.status(403).json({ error: 'That member is at or above your own role' });
  s.members = s.members.filter((m) => m !== uid);
  if (s.memberRoles) delete s.memberRoles[uid];
  if (s.onboarded) delete s.onboarded[uid];
  if (s.joinedAt) delete s.joinedAt[uid];
  s.allowed = (s.allowed || []).filter((id) => id !== uid); // a kicked member of a private server must be added again to return
  forgetNotes(db().users[uid], s);
  store.save();
  for (const sock of userSockets(uid)) {
    voiceLeave(uid, sock.id);
    sock.emit('server:removed', { serverId: s.id });
    sock.leave('server:' + s.id); s.channels.forEach((c) => sock.leave('channel:' + c.id));
  }
  pushServer(s, res);
  if (db().users[uid]) dispatchBots(s, 'memberLeave', { user: db().users[uid], reason: 'kicked' });
});

// ----- onboarding (questions at join that hand out roles) -----
// Config lives on the server record: s.onboarding = { enabled, required, welcome, startedAt, questions: [{ id, title, multi, required,
// options: [{ id, label, emoji, roles: [roleId] }] }] }. What each member answered lives in s.onboarded[userId] = { at, skipped, answers, granted }
// (granted = the roles the answers gave them, so a retake can take back exactly those and leave roles given by hand alone).
// Anyone can pick any answer, so an answer may only hand out roles that carry no permissions (a look-and-channel-access role, never power).
// "Required" only holds back people who joined after it was switched on (s.joinedAt); existing members are asked but may skip.
// Nothing hides channels yet: until per-channel permissions exist the roles are for colour, grouping and later channel access.
const ONB = { questions: 5, options: 8, roles: 5, title: 120, label: 60, welcome: 500 };
const plainRole = (s, id) => { const r = roleById(s, id); return !!r && r.perms.length === 0; };
const hexId = /^[0-9a-f]{16}$/;

function cleanOnboarding(s, uid, b) {
  if (!b || typeof b !== 'object') return { error: 'Invalid onboarding' };
  const old = s.onboarding || { questions: [] };
  const oldRoles = new Map(); // option id -> roles it already gave (an unchanged role above the editor is not their change)
  for (const q of old.questions) for (const o of q.options) oldRoles.set(o.id, o.roles);
  const qs = b.questions === undefined ? old.questions : b.questions;
  if (!Array.isArray(qs) || qs.length > ONB.questions) return { error: `Use at most ${ONB.questions} questions` };
  const seen = new Set();
  const fresh = () => { let id; do id = store.id(); while (seen.has(id)); seen.add(id); return id; };
  const idOf = (v) => (typeof v === 'string' && hexId.test(v) && !seen.has(v) ? (seen.add(v), v) : fresh());
  const questions = [];
  for (const q of qs) {
    const title = clip(q?.title, ONB.title).trim();
    if (!title) return { error: 'Every question needs some text' };
    if (!Array.isArray(q.options) || q.options.length < 1 || q.options.length > ONB.options) return { error: `Every question needs 1 to ${ONB.options} answers` };
    const options = [];
    for (const o of q.options) {
      const label = clip(o?.label, ONB.label).trim();
      if (!label) return { error: 'Every answer needs some text' };
      const rs = o.roles === undefined ? [] : o.roles;
      if (!Array.isArray(rs) || rs.length > ONB.roles || new Set(rs).size !== rs.length) return { error: `An answer can give at most ${ONB.roles} roles` };
      const before = oldRoles.get(o.id) || [];
      for (const rid of rs) {
        if (!roleById(s, rid)) return { error: 'Unknown role' };
        if (!plainRole(s, rid)) return { error: `"${roleById(s, rid).name}" has permissions, so an answer cannot give it. Pick a role with no permissions.` };
        if (!before.includes(rid) && !belowMe(s, uid, rid)) return { error: `"${roleById(s, rid).name}" is above your own role` };
      }
      options.push({ id: idOf(o.id), label, emoji: clip(o.emoji, 8).trim() || '', roles: [...rs] });
    }
    questions.push({ id: idOf(q.id), title, multi: !!q.multi, required: !!q.required, options });
  }
  const enabled = b.enabled === undefined ? !!old.enabled : !!b.enabled;
  if (enabled && !questions.length) return { error: 'Add at least one question before turning onboarding on' };
  return {
    value: {
      enabled,
      required: b.required === undefined ? !!old.required : !!b.required,
      welcome: b.welcome === undefined ? old.welcome || '' : clip(b.welcome, ONB.welcome).trim(),
      startedAt: enabled && !old.enabled ? Date.now() : old.startedAt || 0, // "required" applies to people who join after this
      questions,
    },
  };
}

const onbDone = (s, uid) => !!s.onboarded?.[uid];
function onbBlocking(s, uid) {
  const c = s.onboarding;
  return !!(c?.enabled && c.required && !onbDone(s, uid) && uid !== s.ownerId && (s.joinedAt?.[uid] || 0) >= (c.startedAt || 0) && s.joinedAt?.[uid]);
}
function onbState(s, uid) {
  const rec = s.onboarded?.[uid];
  return { done: !!rec, skipped: !!rec?.skipped, answers: rec?.answers || {}, blocking: onbBlocking(s, uid) };
}

app.get('/api/servers/:id/onboarding', auth, (req, res) => {
  const s = db().servers[req.params.id];
  if (!s || !s.members.includes(req.user.id)) return res.status(404).json({ error: 'Not found' });
  res.json(onbState(s, req.user.id));
});

app.put('/api/servers/:id/onboarding', auth, (req, res) => {
  const s = ownedServer(req, res); if (!s) return;
  const r = cleanOnboarding(s, req.user.id, req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  s.onboarding = r.value;
  pushServer(s, res);
});

// the member's answers: { answers: { questionId: [optionId] } } or { skip: true }
app.post('/api/servers/:id/onboarding/answers', auth, (req, res) => {
  const s = db().servers[req.params.id];
  if (!s || !s.members.includes(req.user.id)) return res.status(404).json({ error: 'Not found' });
  const cfg = s.onboarding;
  if (!cfg?.enabled) return res.status(400).json({ error: 'This server has no onboarding' });
  const uid = req.user.id;
  s.onboarded = s.onboarded || {};
  if (req.body?.skip) {
    if (onbBlocking(s, uid)) return res.status(400).json({ error: 'The owner requires you to answer these first' });
    s.onboarded[uid] = { at: Date.now(), skipped: true, answers: {}, granted: s.onboarded[uid]?.granted || [] };
    store.save();
    return res.json({ ...onbState(s, uid), server: serverView(s) });
  }
  const given = req.body?.answers;
  if (!given || typeof given !== 'object' || Array.isArray(given)) return res.status(400).json({ error: 'Send your answers' });
  const answers = {}, wanted = new Set();
  for (const q of cfg.questions) {
    const raw = given[q.id] === undefined ? [] : given[q.id];
    if (!Array.isArray(raw) || new Set(raw).size !== raw.length || !raw.every((id) => q.options.some((o) => o.id === id))) return res.status(400).json({ error: 'Unknown answer' });
    if (!q.multi && raw.length > 1) return res.status(400).json({ error: 'Pick one answer for each single-choice question' });
    if (q.required && !raw.length) return res.status(400).json({ error: `Answer "${q.title}"` });
    if (raw.length) answers[q.id] = raw;
    for (const oid of raw) for (const rid of q.options.find((o) => o.id === oid).roles) if (plainRole(s, rid)) wanted.add(rid);
  }
  // swap the roles the previous answers gave for the new ones; roles given by hand stay as they are
  const prev = new Set(s.onboarded[uid]?.granted || []);
  const held = new Set(heldRoleIds(s, uid));
  const heldBefore = new Set(held);
  for (const id of prev) held.delete(id);
  for (const id of wanted) held.add(id);
  const granted = [...wanted].filter((id) => prev.has(id) || !heldBefore.has(id));
  if (uid !== s.ownerId) { // the owner already has everything and holds no roles
    s.memberRoles = s.memberRoles || {};
    const next = s.roles.map((r) => r.id).filter((id) => held.has(id));
    if (next.length) s.memberRoles[uid] = next; else delete s.memberRoles[uid];
  }
  s.onboarded[uid] = { at: Date.now(), skipped: false, answers, granted: uid === s.ownerId ? [] : granted };
  store.save();
  io.to('server:' + s.id).emit('server:update', serverView(s));
  res.json({ ...onbState(s, uid), server: serverView(s) });
});

// Removes a server and everything that belongs to it: messages, uploaded files, icon + banner, voice rooms, every member's settings and
// read positions. Members' open connections are told (`server:removed` with reason 'deleted') and leave the rooms.
function destroyServer(s) {
  const chanIds = new Set(s.channels.map((c) => c.id));
  const gone = Object.values(db().messages).filter((m) => chanIds.has(m.channelId));
  const fileIds = gone.flatMap((m) => (m.attachments || []).map((a) => a.id).filter(Boolean));
  for (const m of gone) delete db().messages[m.id];
  for (const cid of chanIds) {
    const room = voice.get(cid);
    if (room) { for (const sid of room.values()) io.to(sid).emit('voice:kicked', { channelId: cid }); voice.delete(cid); }
  }
  for (const uid of s.members) {
    forgetNotes(db().users[uid], s);
    for (const sock of userSockets(uid)) {
      sock.emit('server:removed', { serverId: s.id, reason: 'deleted', name: s.name });
      sock.leave('server:' + s.id); s.channels.forEach((c) => sock.leave('channel:' + c.id));
    }
  }
  for (const i of s.installedBots || []) { const bt = db().bots[i.botId]; if (bt) bt.installs = (bt.installs || []).filter((id) => id !== s.id); }
  delete db().servers[s.id];
  store.save();
  store.deleteFiles(fileIds).catch((e) => console.error(e));
  store.deleteImage(s.iconImage).catch(() => {});
  store.deleteImage(s.bannerImage).catch(() => {});
}

// The owner cannot just walk away: ownership never passes to "whoever is first in the list". They hand it to a chosen member first
// (POST .../transfer) or delete the server (DELETE /api/servers/:id). The one exception is an owner who is alone: leaving then deletes it.
app.post('/api/servers/:id/leave', auth, (req, res) => {
  const s = db().servers[req.params.id];
  if (!s || !s.members.includes(req.user.id)) return res.status(404).json({ error: 'Not found' });
  if (s.ownerId === req.user.id) {
    if (humanCount(s) > 1) return res.status(400).json({ error: 'You own this server. Transfer ownership to another member first, or delete the server.', code: 'owner_must_transfer' });
    destroyServer(s);
    return res.json({ ok: true, deleted: true });
  }
  s.members = s.members.filter((m) => m !== req.user.id);
  if (s.memberRoles) delete s.memberRoles[req.user.id];
  if (s.onboarded) delete s.onboarded[req.user.id];
  if (s.joinedAt) delete s.joinedAt[req.user.id];
  forgetNotes(req.user, s);
  store.save();
  for (const sock of userSockets(req.user.id)) { voiceLeave(req.user.id, sock.id); sock.leave('server:' + s.id); s.channels.forEach((c) => sock.leave('channel:' + c.id)); } // voiceLeave: someone who leaves must not stay in the server's voice call (kick already did this)
  io.to('server:' + s.id).emit('server:update', serverView(s));
  res.json({ ok: true });
  dispatchBots(s, 'memberLeave', { user: req.user, reason: 'left' });
});

// Owner-only, irreversible actions: both re-check the password (and the 2FA code when it is on). Wrong guesses feed the login lockout.
async function ownerConfirmed(req, res) {
  const s = db().servers[req.params.id];
  if (!s || !s.members.includes(req.user.id)) { res.status(404).json({ error: 'Not found' }); return null; }
  if (s.ownerId !== req.user.id) { res.status(403).json({ error: 'Only the server owner can do that' }); return null; }
  const u = req.user;
  if (!(await passwordOk(req, res, u, req.body?.password))) return null;
  if (u.totp && u.totp.enabled && !codeOk(req, res, u, req.body?.code)) return null;
  loginGuard.success(u.username, req.ip);
  return s;
}

app.post('/api/servers/:id/transfer', auth, ah(async (req, res) => {
  const target = typeof req.body?.userId === 'string' ? req.body.userId : '';
  const peek = db().servers[req.params.id];
  // cheap checks first so a typo in the target does not use up the person's 2FA code
  if (peek && peek.ownerId === req.user.id) {
    if (target === req.user.id) return res.status(400).json({ error: 'You already own this server' });
    if (!peek.members.includes(target) || db().users[target]?.bot) return res.status(400).json({ error: 'Pick a current member of the server' });
  }
  const s = await ownerConfirmed(req, res); if (!s) return;
  if (!s.members.includes(target) || target === s.ownerId || db().users[target]?.bot) return res.status(400).json({ error: 'Pick a current member of the server' }); // re-checked after the awaits
  const old = s.ownerId;
  s.ownerId = target;
  // the owner holds no roles (they have every permission), and the previous owner becomes an ordinary member
  if (s.memberRoles) delete s.memberRoles[target];
  if (s.visibility === 'private') { // on a private server the old owner must stay allowed, or they could never rejoin
    s.allowed = (s.allowed || []).filter((id) => id !== target);
    if (!s.allowed.includes(old)) s.allowed.push(old);
  }
  store.save();
  io.to('server:' + s.id).emit('server:update', serverView(s));
  res.json({ server: serverView(s) });
}));

app.delete('/api/servers/:id', auth, ah(async (req, res) => {
  const peek = db().servers[req.params.id];
  if (peek && peek.ownerId === req.user.id && String(req.body?.name || '').trim() !== peek.name) return res.status(400).json({ error: 'Type the server name exactly to confirm' });
  const s = await ownerConfirmed(req, res); if (!s) return;
  destroyServer(s);
  res.json({ ok: true });
}));

// ----- server settings (owner only): name, icon, banner, theme -----
const SERVER_IMAGE_RULES = {
  icon: { field: 'iconImage', maxDim: 512 },
  banner: { field: 'bannerImage', maxDim: 4096 },
};
// A server theme is just the three seeds themes.js builds a whole palette from.
function cleanServerTheme(t) {
  if (t === null) return null;
  if (!t || typeof t !== 'object' || typeof t.dark !== 'boolean' || !hex.test(t.bg) || !hex.test(t.accent)) return undefined;
  return { dark: t.dark, bg: t.bg.toLowerCase(), accent: t.accent.toLowerCase() };
}
const ownedServer = (req, res) => {
  const s = db().servers[req.params.id];
  if (!s || !s.members.includes(req.user.id)) { res.status(404).json({ error: 'Not found' }); return null; }
  if (!can(s, req.user.id, 'manageServer')) { res.status(403).json({ error: 'You need the Manage server permission to change server settings' }); return null; }
  return s;
};
const broadcastServer = (s) => { const view = serverView(s); io.to('server:' + s.id).emit('server:update', view); return view; };

// Custom invite codes: 3-32 letters, numbers, - or _, stored lowercase and unique across all servers.
const INVITE_RE = /^[a-z0-9_-]{3,32}$/;
const cleanInvite = (c) => String(c ?? '').trim().toLowerCase();
const inviteTaken = (code, exceptId) => Object.values(db().servers).some((x) => x.inviteCode === code && x.id !== exceptId);
function inviteProblem(code, exceptId) {
  if (!INVITE_RE.test(code)) return 'Use 3 to 32 letters, numbers, - or _';
  if (inviteTaken(code, exceptId)) return 'That code is already taken';
  return null;
}

// live check used by the invite field in server settings
app.get('/api/servers/:id/invite-check', auth, (req, res) => {
  const s = ownedServer(req, res);
  if (!s) return;
  const code = cleanInvite(req.query.code);
  const problem = inviteProblem(code, s.id);
  res.json({ code, available: !problem, current: code === s.inviteCode, reason: problem });
});

// what an invite card shows: public details of the server a code points to
// Open to people who are not signed in: the page at /invite/<code> shows this box to a visitor before they have an account.
// A signed-in token is still honoured so members and listed people of a private server get the card.
app.get('/api/invites/:code', (req, res) => {
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  const me = userFromToken(bearer || security.readSessionCookie(req.headers, secureReq(req))); // the web app is signed in by cookie
  if (!me) return authLimiter(req, res, () => sendInvite(req, res, null));
  sendInvite(req, res, me);
});
function sendInvite(req, res, me) {
  const s = Object.values(db().servers).find((x) => x.inviteCode === cleanInvite(req.params.code));
  if (!s) return res.status(404).json({ error: 'This invite is no longer valid' });
  if (!(me && s.members.includes(me.id)) && !canJoin(s, me?.id)) return res.status(403).json({ error: 'This server is private. Ask the owner to add you.' });
  res.json({ invite: { code: s.inviteCode, serverId: s.id, name: s.name, iconImage: s.iconImage || null, bannerImage: s.bannerImage || null, theme: s.theme || null, memberCount: humanCount(s) } });
}

// Tags help people find a public server. Up to 5, each 2-20 characters of a-z 0-9 and -, stored lowercase.
const MAX_TAGS = 5;
function cleanTags(v) {
  if (!Array.isArray(v)) return 'Tags must be a list';
  const out = [];
  for (const raw of v) {
    const t = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '-').replace(/^#/, '');
    if (!/^[a-z0-9][a-z0-9-]{0,18}[a-z0-9]$/.test(t)) return `"${clip(raw, 24)}" is not a valid tag. Use 2 to 20 letters, numbers or dashes.`;
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TAGS) return `You can use up to ${MAX_TAGS} tags`;
  return out;
}

// ----- reports on public listings -----
// Anyone signed in can report a public server (reason + optional details). Each person has one report per server (a new one replaces
// the old). When REPORTS_TO_HIDE different established accounts (older than a day) have reported it, the listing is hidden from the
// explorer and the owner cannot republish it until a moderator has looked. Moderators are the usernames in ADMIN_USERNAMES.
// The owner never sees who reported.
const reportHits = new security.RateWindow(listing.LISTING.perHour, 3600_000);
const REPORTS_TO_HIDE = posNum(process.env.LISTING_REPORTS_TO_HIDE, listing.LISTING.reportsToHide);
const ADMINS = new Set(String(process.env.ADMIN_USERNAMES || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean));
// An admin is a creator account, a name in ADMIN_USERNAMES, or an account a creator made an admin on the /admin page (u.admin = { at, by }).
const isEnvAdmin = (u) => !!u && ADMINS.has(String(u.username).toLowerCase());
const isAdmin = (u) => !!u && !u.bot && !u.deleted && !u.suspended && (isEnvAdmin(u) || !!u.admin || isCreator(u));

app.post('/api/servers/:id/report', auth, (req, res) => {
  const s = db().servers[req.params.id];
  const isPublic = !!s && s.visibility === 'public';
  // a public listing can be reported by anyone signed in; any other server only by one of its own members (from inside the server)
  if (!s || (!isPublic && !(s.members || []).includes(req.user.id))) return res.status(404).json({ error: 'That server is not listed publicly' });
  if (s.ownerId === req.user.id) return res.status(400).json({ error: 'You cannot report your own server' });
  const reason = String(req.body?.reason || '');
  if (!listing.REASONS.includes(reason)) return res.status(400).json({ error: 'Pick a reason' });
  const details = clip(req.body?.details, listing.LISTING.maxDetails).trim();
  if (reason === 'other' && !details) return res.status(400).json({ error: 'Tell us what is wrong' });
  if (!reportHits.allow(req.user.id)) return res.status(429).json({ error: 'You have sent a lot of reports. Try again later.' });
  s.reports = (s.reports || []).filter((r) => r.by !== req.user.id);
  s.reports.push({ by: req.user.id, reason, details, at: now(), name: s.name, description: s.description || '', tags: s.tags || [] }); // a copy of what was reported, in case it is edited after
  if (s.reports.length > 200) s.reports = s.reports.slice(-200);
  if (isPublic && !s.listingHold && listing.countedReports(s.reports, db().users, now()) >= REPORTS_TO_HIDE) s.listingHold = { state: 'hidden', at: now() };
  store.save();
  res.json({ ok: true });
});

function adminOnly(req, res, next) { if (!isAdmin(req.user)) return res.status(404).json({ error: 'Not found' }); next(); }
app.get('/api/admin/listing-reports', auth, adminOnly, (_req, res) => {
  const rows = Object.values(db().servers).filter((s) => (s.reports || []).length || s.listingHold).map((s) => ({
    serverId: s.id, name: s.name, description: s.description || '', tags: s.tags || [], visibility: s.visibility || null, members: humanCount(s),
    owner: db().users[s.ownerId]?.username || null, hold: s.listingHold || null, counted: listing.countedReports(s.reports, db().users, now()),
    reports: (s.reports || []).map((r) => ({ by: db().users[r.by]?.username || null, reason: r.reason, details: r.details, at: r.at })),
  })).sort((a, b) => b.reports.length - a.reports.length);
  res.json({ servers: rows, toHide: REPORTS_TO_HIDE });
});
// restore = put it back in the explorer and clear the reports; dismiss = clear the reports only; remove = take it off the public listing for good
app.post('/api/admin/servers/:id/listing', auth, adminOnly, (req, res) => {
  const s = db().servers[req.params.id];
  if (!s) return res.status(404).json({ error: 'Not found' });
  const action = req.body?.action;
  if (action === 'restore' || action === 'dismiss') { delete s.listingHold; s.reports = []; }
  else if (action === 'remove') { s.listingHold = { state: 'removed', at: now() }; if (s.visibility === 'public') delete s.visibility; }
  else return res.status(400).json({ error: 'action must be restore, dismiss or remove' });
  store.save();
  io.to('server:' + s.id).emit('server:update', serverView(s));
  res.json({ ok: true, hold: s.listingHold || null });
});

// ----- clips: short vertical videos -----
// The flow: the app asks for upload links (POST /api/clips/upload-url), PUTs the video and its cover picture straight to the clips R2 bucket
// (so Render never carries the video), then says it is done (POST /api/clips/:id/complete). Only then does the server look at what arrived
// (size, type, the MP4 header, the real length), and only a clip that passes goes live. R2's signed links cannot cap an upload's size, so a
// clip that is too big is deleted at that point, and an upload nobody finishes is deleted by the sweep a few minutes later.
// Storage: clips have their own bucket and their own cap (CLIPS_LIMIT_GB, default 5). They are deleted after CLIPS_TTL_DAYS (default 7);
// the record stays with its numbers (views, likes, reports) and only the video and cover are gone. Rules and limits: clips.js.
const clipsOn = () => !!(store.clipsR2 && clipsLib.settings().publicUrl);
const needClips = (_req, res, next) => (clipsOn() ? next() : res.status(503).json({ error: 'Clips are not set up on this server' }));
// Anyone signed in can watch, like and report. Posting needs a clips creator registration (accepting the creator terms on /dashboard).
// This is NOT the same as the site's own "creator" (the people who make Aduna, see isCreator above): their accounts register as clips creators like everyone else.
const isClipCreator = (u) => !!u && !!u.clipCreator;
const needClipCreator = (req, res, next) => (isClipCreator(req.user) ? next() : res.status(403).json({ error: 'Become a Clips creator first: accept the creator terms on your dashboard', code: 'not_clip_creator' }));
const CLIP_TERMS_VERSION = 1;
const clipUploadHits = new security.RateWindow(20, 3600_000);      // upload links per person per hour (the daily limit is separate)
const clipActHits = new security.RateWindow(240, 60_000);          // feed pages, views and likes per person per minute
const clipReportHits = new security.RateWindow(listing.LISTING.perHour, 3600_000);
const clipViewSeen = new security.RateWindow(1, 24 * 3600_000);    // one counted view per person per clip per day
const clipsScreening = new Set();                                  // ids of clips being screened right now (a second "complete" for one of them waits)
const clipList = () => Object.values(db().clips);
const clipsFull = 'Clips are full right now. Older clips are removed every day, so try again later.';

// delete a clip's video and cover from R2; false (and the keys stay, so the sweep tries again) if R2 would not
async function dropClipBytes(c) {
  const b = store.clipsR2;
  if (!b) return false;
  try { for (const k of clipsLib.objectsOf(c)) await b.del(k); return true; }
  catch (e) { console.error('Clip cleanup failed (will retry):', e.message); return false; }
}
// credits taken for an upload that never went live are given back
function refundClip(c) {
  if (!(c.credits > 0)) return;
  const u = db().users[c.owner];
  if (u) credits.grant(u, c.credits, 'clip refund', { note: 'Clip not posted' });
  c.credits = 0;
}
// take a clip down: out of the feed at once, bytes deleted, numbers kept
async function endClip(c, state, why) {
  c.state = state;
  if (why) c.why = why;
  if (await dropClipBytes(c)) clipsLib.purge(c, state, now());
  store.save();
}
// delete what has expired or was never finished. Runs at start and every ten minutes.
async function sweepClips() {
  const out = { expired: 0, abandoned: 0, retried: 0 };
  if (!store.clipsR2) return out;
  const t = now();
  const d = clipsLib.due(clipList(), t, clipsLib.settings());
  for (const c of d.abandoned) if (await dropClipBytes(c)) { refundClip(c); c.why = 'The upload was never finished'; clipsLib.purge(c, 'rejected', t); out.abandoned++; }
  for (const c of d.expire) if (await dropClipBytes(c)) { clipsLib.purge(c, 'expired', t); out.expired++; }
  for (const c of d.retry) if (await dropClipBytes(c)) { clipsLib.purge(c, c.state, t); out.retried++; }
  if (out.expired + out.abandoned + out.retried) store.save();
  return out;
}

// creator registration: ask whether you are one, and become one by accepting the terms
app.get('/api/clips/creator', auth, (req, res) => res.json({ creator: isClipCreator(req.user), since: req.user.clipCreator ? req.user.clipCreator.at : null, terms: CLIP_TERMS_VERSION, followers: req.user.clipFollowerCount || 0, pageLink: !!clipsPageOf(req.user), page: '/clips/user/' + req.user.id, profile: isClipCreator(req.user) ? creatorProfileView(req.user) : null, setupPending: !!(req.user.clipCreator && req.user.clipCreator.setupPending) }));
// a creator's own page (/clips/user/<id>): who they are, how many follow them, and whether you do. Anyone signed in can look.
app.get('/api/clips/creator/:userId', auth, needClips, (req, res) => {
  const u = db().users[req.params.userId];
  if (!u || u.bot) return res.status(404).json({ error: 'That page was not found' });
  if (!clipActHits.allow(req.user.id)) return res.status(429).json({ error: 'Slow down' });
  const who = clipsLib.identity(u); // a creator's own Clips name, display name, icon and banner when they set them
  const likes = clipList().reduce((n, c) => (c.owner === u.id ? n + (c.likes || 0) : n), 0); // every like on their clips (the numbers stay after a clip expires)
  res.json({ user: { id: u.id, username: who.username, displayName: who.displayName, avatarImage: who.avatarImage, bannerImage: who.bannerImage, followers: u.clipFollowerCount || 0, likes, creator: isClipCreator(u), following: (req.user.clipFollowing || []).includes(u.id), mine: u.id === req.user.id,
    // their Aduna profile theme, so their Clips page can wear the same colours
    profileTheme: credits.pthemes.wornId(u), profileGradient: credits.pthemes.customOf(u), accentColor: u.accentColor || null, bannerColor: u.bannerColor || null } });
});
// follow or unfollow a creator (a second call undoes the first). Only the number of followers is ever shown, never who they are.
const clipFollowHits = new security.RateWindow(60, 3600_000);
app.post('/api/clips/follow/:userId', auth, needClips, (req, res) => {
  const target = db().users[req.params.userId];
  if (!target || !isClipCreator(target)) return res.status(404).json({ error: 'That creator was not found' });
  if (!clipFollowHits.allow(req.user.id)) return res.status(429).json({ error: 'Slow down' });
  const r = clipsLib.toggleFollow(req.user, target);
  if (r.error) return res.status(400).json({ error: r.error });
  store.save();
  res.json(r);
});
app.post('/api/clips/creator/join', auth, (req, res) => {
  if (req.body?.accept !== true) return res.status(400).json({ error: 'Please accept the creator terms' });
  if (!req.user.clipCreator) { req.user.clipCreator = { at: now(), terms: CLIP_TERMS_VERSION, setupPending: true }; store.save(); } // setupPending: the dashboard offers the customize-your-creator-profile popup once
  res.json({ creator: true, since: req.user.clipCreator.at });
});
// a creator switches the link to their Clips page on or off (off by default). While it is on, their profile shows it; the page itself is unchanged.
app.post('/api/clips/creator/page-link', auth, needClipCreator, (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Say whether the link should be on or off' });
  if ((req.user.clipCreator.pageLink === true) !== req.body.enabled) {
    if (req.body.enabled) req.user.clipCreator.pageLink = true; else delete req.user.clipCreator.pageLink;
    store.save();
    emitUserUpdate(req.user); // profile cards other people have open pick the change up
  }
  res.json({ pageLink: !!clipsPageOf(req.user), page: '/clips/user/' + req.user.id });
});

// ----- a creator's own Clips identity -----
// On joining, the creator is offered a popup (setupPending) to pick a username, display name, icon and banner that are used on Clips INSTEAD of their
// Aduna profile (clips.js identity()). Skipping it, or "Use my Aduna profile" on the dashboard's Profile page, leaves them showing as themselves.
// u.clipCreator.profile = { username, displayName, avatarImage, bannerImage, usernameChangedAt }. Rules mirror the Aduna profile: 3-20 letters, numbers or
// underscores, not taken by any account or other creator, changeable once a week; display name up to 32 characters.
function creatorProfileView(u) {
  const who = clipsLib.identity(u), p = u.clipCreator && u.clipCreator.profile;
  return {
    custom: !!p, username: who.username, displayName: who.displayName, avatarImage: who.avatarImage, bannerImage: who.bannerImage,
    usernameChangedAt: (p && p.usernameChangedAt) || null, accountUsername: u.username, // the Aduna username, shown to the person themself as the starting point
  };
}
app.patch('/api/clips/creator/profile', auth, needClipCreator, (req, res) => {
  const u = req.user, c = u.clipCreator, b = req.body || {}, cur = c.profile || null;
  const want = String(b.username ?? (cur ? cur.username : u.username)).trim().replace(/^@/, '');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(want)) return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores' });
  const renamed = !!cur && want.toLowerCase() !== cur.username.toLowerCase();
  if (renamed) {
    const wait = (cur.usernameChangedAt || 0) + USERNAME_COOLDOWN_MS - now();
    if (wait > 0) return res.status(429).json({ error: 'You can only change your Clips username once every 7 days', availableAt: new Date(cur.usernameChangedAt + USERNAME_COOLDOWN_MS).toISOString() });
  }
  if ((!cur || renamed) && usernameTaken(want, u.id)) return res.status(409).json({ error: 'Username already taken' });
  const p = cur || {};
  const oldName = p.username;
  p.username = want;
  if (renamed) p.usernameChangedAt = now();
  if (b.displayName !== undefined) p.displayName = clip(b.displayName, 32).trim() || want;
  else if (!cur || (renamed && p.displayName === oldName)) p.displayName = want; // never picked one: it follows the username
  c.profile = p;
  delete c.setupPending;
  store.save();
  res.json({ profile: creatorProfileView(u) });
});
async function setCreatorImage(u, field, buf) {
  const p = u.clipCreator.profile, old = p[field];
  if (buf) p[field] = await store.putImage(buf); else delete p[field];
  await store.flush(); // the profile must point at the new picture before the old one is deleted
  await store.deleteImage(old);
  return creatorProfileView(u);
}
for (const [kind, rule] of Object.entries(IMAGE_RULES)) {
  app.put(`/api/clips/creator/profile/${kind}`, auth, needClipCreator, uploadLimiter, rawImage, ah(async (req, res) => {
    if (!req.user.clipCreator.profile) return res.status(400).json({ error: 'Choose your Clips username first' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Choose a PNG, JPEG or WebP image' });
    const info = sniffImage(buf);
    if (!info) return res.status(400).json({ error: 'That file is not a valid PNG, JPEG or WebP image' });
    if (info.width > rule.maxDim || info.height > rule.maxDim) return res.status(400).json({ error: `Image is too large (max ${rule.maxDim}px per side)` });
    res.json({ profile: await setCreatorImage(req.user, rule.field, buf) });
  }));
  app.delete(`/api/clips/creator/profile/${kind}`, auth, needClipCreator, ah(async (req, res) => {
    if (!req.user.clipCreator.profile) return res.json({ profile: creatorProfileView(req.user) });
    res.json({ profile: await setCreatorImage(req.user, rule.field, null) });
  }));
}
// back to showing the Aduna profile on Clips: the Clips identity and its pictures are deleted
app.delete('/api/clips/creator/profile', auth, needClipCreator, ah(async (req, res) => {
  const c = req.user.clipCreator, p = c.profile;
  delete c.profile;
  delete c.setupPending;
  store.save();
  await store.flush();
  if (p) { await store.deleteImage(p.avatarImage); await store.deleteImage(p.bannerImage); }
  res.json({ profile: creatorProfileView(req.user) });
}));
// "Skip" on the popup: keep showing the Aduna profile, and do not ask again
app.post('/api/clips/creator/setup-done', auth, needClipCreator, (req, res) => {
  if (req.user.clipCreator.setupPending) { delete req.user.clipCreator.setupPending; store.save(); }
  res.json({ setupPending: false });
});

app.post('/api/clips/upload-url', auth, needClips, needClipCreator, ah(async (req, res) => {
  const cfg = clipsLib.settings();
  const boss = isCreator(req.user); // the site's creator accounts post without the daily / open-uploads / hourly limits and without paying credits (the storage cap still applies)
  if (!boss && !clipUploadHits.allow(req.user.id)) return res.status(429).json({ error: 'Slow down. Try again in a little while.' });
  if (req.body?.rights !== true) return res.status(400).json({ error: 'Confirm that you made this clip or have permission to post it' });
  const r = clipsLib.checkRequest(req.body, cfg, BLOCKED_WORDS);
  if (r.error) return res.status(400).json({ error: r.error });
  const all = clipList(), t = now();
  if (!boss && clipsLib.uploadsToday(all, req.user.id, t) >= cfg.dailyLimit) return res.status(429).json({ error: `You can post ${cfg.dailyLimit} clips a day. Try again tomorrow.`, code: 'daily_limit' });
  if (!boss && clipsLib.pendingOf(all, req.user.id) >= cfg.maxPending) return res.status(429).json({ error: 'Let your other uploads finish first.' });
  if (!clipsLib.hasRoom(all, r.value.size + r.value.posterSize, cfg)) return res.status(507).json({ error: clipsFull, code: 'clips_full' });
  if (!boss && cfg.credits && !credits.spend(req.user, cfg.credits, 'clip', { note: 'Posted a clip' })) return res.status(402).json({ error: `Posting a clip costs ${cfg.credits} credits`, code: 'not_enough_credits' });
  const c = {
    id: store.id(), owner: req.user.id, caption: r.value.caption, state: 'pending',
    key: `clips/${crypto.randomBytes(16).toString('hex')}.mp4`, posterKey: `posters/${crypto.randomBytes(16).toString('hex')}`,
    size: r.value.size, posterSize: r.value.posterSize, seconds: r.value.seconds, width: r.value.width, height: r.value.height,
    createdAt: t, views: 0, likes: 0, likedBy: [], reports: [], reportCount: 0, credits: boss ? 0 : cfg.credits,
    rightsAt: t, // the poster confirmed they own it or have permission, and accepted the creator terms (version in their account)
  };
  let video, poster;
  try {
    [video, poster] = await Promise.all([store.clipsR2.presignPut(c.key, 600), store.clipsR2.presignPut(c.posterKey, 600)]);
  } catch (e) {
    refundClip(c); store.save();
    console.error('Could not sign a clip upload:', e.message);
    return res.status(502).json({ error: 'Uploads are not available right now. Try again soon.' });
  }
  db().clips[c.id] = c;
  store.save();
  res.json({
    id: c.id, expiresIn: 600,
    video: { url: video, method: 'PUT', headers: { 'Content-Type': 'video/mp4' } },
    poster: { url: poster, method: 'PUT', headers: { 'Content-Type': r.value.posterType } },
  });
}));

app.post('/api/clips/:id/complete', auth, needClips, needClipCreator, ah(async (req, res) => {
  const cfg = clipsLib.settings();
  const c = db().clips[req.params.id];
  if (!c || c.owner !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (c.state === 'live') return res.json({ clip: clipsLib.view(c, db().users, req.user.id, cfg) }); // asked twice
  if (c.state === 'hidden' && !c.purgedAt && c.hold && c.hold.by === 'screening') return res.json({ clip: clipsLib.ownerView(c), held: true, message: 'Your clip is waiting for a moderator to check it before it goes live.' }); // asked twice, held by the automatic check
  if (c.state !== 'pending') return res.status(409).json({ error: 'This upload is no longer open', why: c.why || null });
  const b = store.clipsR2;
  const reject = async (status, message) => { if (c.state === 'pending') { refundClip(c); await endClip(c, 'rejected', message); } return res.status(status).json({ error: message }); };
  let vh, ph;
  try { [vh, ph] = await Promise.all([b.head(c.key), b.head(c.posterKey)]); }
  catch (e) { console.error('Clip check failed:', e.message); return res.status(502).json({ error: 'Could not check the upload. Try again.' }); }
  if (!vh || !ph) return res.status(409).json({ error: 'The upload has not arrived yet', code: 'not_uploaded' }); // still pending: the app can ask again
  if (vh.size < 1024 || vh.size > cfg.maxBytes) return reject(413, `Clips can be at most ${Math.round(cfg.maxBytes / clipsLib.MB * 10) / 10} MB`);
  if (vh.type !== 'video/mp4') return reject(400, 'That is not an MP4 video');
  if (ph.size < 1 || ph.size > clipsLib.MAX_POSTER || !clipsLib.POSTER_TYPES.includes(ph.type)) return reject(400, 'The cover picture is missing or too big');
  let head, pic;
  try { [head, pic] = await Promise.all([b.first(c.key, clipsLib.FIRST_BYTES), b.first(c.posterKey, clipsLib.MAX_POSTER)]); }
  catch (e) { console.error('Clip check failed:', e.message); return res.status(502).json({ error: 'Could not check the upload. Try again.' }); }
  const mp4 = clipsLib.sniffMp4(head);
  if (mp4.error) return reject(400, mp4.error);
  if (mp4.seconds > cfg.maxSeconds + 1) return reject(400, `Clips can be at most ${cfg.maxSeconds} seconds`);
  if (!pic || !sniffImage(pic)) return reject(400, 'The cover picture is not a valid image');
  if (c.state !== 'pending') return res.status(409).json({ error: 'This upload is no longer open' }); // the sweep dropped it while we were looking
  if (!clipsLib.hasRoom(clipList(), vh.size + ph.size, cfg, c.id)) return reject(507, clipsFull);
  const facts = { size: vh.size, posterSize: ph.size, seconds: Math.round(mp4.seconds * 10) / 10 };
  // The automatic checks before it goes live (screen.js): OpenAI moderation of frames and cover, music recognition, re-post matching.
  // Nothing is checked until OPENAI_API_KEY and/or AUDD_API_TOKEN is set, so without them this behaves exactly as before.
  // block -> rejected (refunded, bytes deleted); review -> hidden with hold.by 'screening' until a moderator looks; pass -> live.
  let held = null;
  const scfg = screenLib.settings();
  if (scfg.on) {
    if (clipsScreening.has(c.id)) return res.status(409).json({ error: 'Your clip is still being checked', code: 'screening' }); // the app asked again while the first check still runs
    clipsScreening.add(c.id);
    try {
      let video = null, poster = null;
      try { [video, poster] = await Promise.all([b.get(c.key, cfg.maxBytes), b.get(c.posterKey, clipsLib.MAX_POSTER)]); }
      catch (e) { console.error('Clip screening could not read the upload:', e.message); }
      const found = video
        ? await screenLib.screenClip({ video, seconds: facts.seconds, poster: poster ? { buf: poster, type: ph.type } : null, known: { clips: clipList(), ownerId: c.owner, selfId: c.id } }, scfg)
        : { mod: null, music: null, dupe: null, hashes: [], errors: ['video: could not be read back from storage'] };
      if (c.state !== 'pending') return res.status(409).json({ error: 'This upload is no longer open' }); // the sweep dropped it while it was being checked
      const d = screenLib.decide(found, scfg);
      c.screen = screenLib.record(found, d, now()); // kept for moderators (and its picture fingerprints for matching later re-posts); never sent to the poster
      if (d.verdict === 'block') return await reject(422, d.message);
      if (d.verdict === 'review') held = d;
    } finally { clipsScreening.delete(c.id); }
  }
  const t = now();
  Object.assign(c, facts, held
    ? { state: 'hidden', hold: { state: 'hidden', by: 'screening', at: t }, expiresAt: t + cfg.ttlMs }
    : { state: 'live', liveAt: t, expiresAt: t + cfg.ttlMs });
  store.save();
  if (held) return res.json({ clip: clipsLib.ownerView(c), held: true, message: held.message });
  res.json({ clip: clipsLib.view(c, db().users, req.user.id, cfg) });
}));

app.get('/api/clips', auth, needClips, (req, res) => {
  if (!clipActHits.allow(req.user.id)) return res.status(429).json({ error: 'Slow down' });
  const cfg = clipsLib.settings();
  const clips = clipsLib.feed(clipList(), db().users, {
    uid: req.user.id, sort: req.query.sort === 'top' ? 'top' : req.query.sort === 'following' ? 'following' : 'new', before: Number(req.query.before) || 0,
    owner: typeof req.query.owner === 'string' ? req.query.owner.slice(0, 80) : '',
    offset: parseInt(req.query.offset, 10) || 0, limit: parseInt(req.query.limit, 10) || 10, now: now(),
  }, cfg);
  res.json({
    clips,
    limits: { maxSeconds: cfg.maxSeconds, maxMb: Math.round(cfg.maxBytes / clipsLib.MB * 10) / 10, dailyLimit: cfg.dailyLimit, unlimited: isCreator(req.user), left: Math.max(0, cfg.dailyLimit - clipsLib.uploadsToday(clipList(), req.user.id, now())), credits: isCreator(req.user) ? 0 : cfg.credits, keepDays: Math.round(cfg.ttlMs / clipsLib.DAY * 10) / 10 },
  });
});
// your own clips, including the ones whose video has expired (the numbers stay). A clip you deleted from your list (dismissed) is not shown again.
app.get('/api/clips/mine', auth, (req, res) => {
  const mine = clipList().filter((c) => c.owner === req.user.id && !c.dismissed).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(clipsLib.ownerView);
  res.json({ clips: mine });
});
// search creators (by name) and clips (by caption or poster's name) for the Clips website's search button
app.get('/api/clips/search', auth, needClips, (req, res) => {
  if (!clipActHits.allow(req.user.id)) return res.status(429).json({ error: 'Slow down' });
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
  res.json(clipsLib.search(clipList(), db().users, { uid: req.user.id, q, now: now() }, clipsLib.settings()));
});
// one clip, for its own page (/clips/:id). Only a live clip can be opened; after it expires or is taken down the link says "gone".
app.get('/api/clips/:id', auth, needClips, (req, res) => {
  if (!clipActHits.allow(req.user.id)) return res.status(429).json({ error: 'Slow down' });
  const c = liveClipOr404(req, res);
  if (!c || !db().users[c.owner]) return c ? res.status(404).json({ error: 'That clip is gone' }) : undefined;
  res.json({ clip: clipsLib.view(c, db().users, req.user.id, clipsLib.settings()) });
});
function liveClipOr404(req, res) {
  const c = db().clips[req.params.id];
  if (!c || !clipsLib.isLive(c, now())) { res.status(404).json({ error: 'That clip is gone' }); return null; }
  return c;
}
app.post('/api/clips/:id/view', auth, needClips, (req, res) => {
  const c = liveClipOr404(req, res);
  if (!c) return;
  if (!clipActHits.allow(req.user.id)) return res.status(429).json({ error: 'Slow down' });
  if (c.owner !== req.user.id && clipViewSeen.allow(req.user.id + ':' + c.id)) { clipsLib.addView(c, now()); store.save(); }
  res.json({ views: c.views || 0 });
});
app.post('/api/clips/:id/like', auth, needClips, (req, res) => {
  const c = liveClipOr404(req, res);
  if (!c) return;
  if (!clipActHits.allow(req.user.id)) return res.status(429).json({ error: 'Slow down' });
  const liked = clipsLib.toggleLike(c, req.user.id);
  store.save();
  res.json({ liked, likes: c.likes });
});
// comments: anyone signed in can read and write them on a live clip; you can delete your own, and the poster can delete any on their clip
const clipCommentHits = new security.RateWindow(30, 3600_000);     // comments per person per hour
const clipShareSeen = new security.RateWindow(1, 24 * 3600_000);   // one counted share per person per clip per day
app.get('/api/clips/:id/comments', auth, needClips, (req, res) => {
  const c = liveClipOr404(req, res);
  if (!c) return;
  if (!clipActHits.allow(req.user.id)) return res.status(429).json({ error: 'Slow down' });
  res.json({ comments: clipsLib.commentViews(c, db().users, req.user.id), total: c.commentCount || 0 });
});
app.post('/api/clips/:id/comments', auth, needClips, (req, res) => {
  const c = liveClipOr404(req, res);
  if (!c) return;
  const r = clipsLib.checkComment(req.body?.text, BLOCKED_WORDS);
  if (r.error) return res.status(400).json({ error: r.error });
  if (!clipCommentHits.allow(req.user.id)) return res.status(429).json({ error: 'You are commenting a lot. Try again in a little while.' });
  clipsLib.addComment(c, req.user.id, r.value, now(), store.id());
  store.save();
  res.json({ comments: clipsLib.commentViews(c, db().users, req.user.id), total: c.commentCount || 0 });
});
app.delete('/api/clips/:id/comments/:cid', auth, needClips, (req, res) => {
  const c = liveClipOr404(req, res);
  if (!c) return;
  const done = clipsLib.removeComment(c, req.params.cid, req.user.id);
  if (done === false) return res.status(404).json({ error: 'That comment is gone' });
  if (done === null) return res.status(403).json({ error: 'You can only delete your own comments' });
  store.save();
  res.json({ comments: clipsLib.commentViews(c, db().users, req.user.id), total: c.commentCount || 0 });
});
// someone copied or sent the link: counts once per person per clip per day
app.post('/api/clips/:id/share', auth, needClips, (req, res) => {
  const c = liveClipOr404(req, res);
  if (!c) return;
  if (!clipActHits.allow(req.user.id)) return res.status(429).json({ error: 'Slow down' });
  if (clipShareSeen.allow(req.user.id + ':' + c.id)) { clipsLib.addShare(c); store.save(); }
  res.json({ shares: c.shares || 0 });
});
app.post('/api/clips/:id/report', auth, needClips, (req, res) => {
  const c = db().clips[req.params.id];
  if (!c || !(c.state === 'live' || c.state === 'hidden') || c.purgedAt) return res.status(404).json({ error: 'That clip is gone' });
  if (c.owner === req.user.id) return res.status(400).json({ error: 'You cannot report your own clip' });
  const reason = String(req.body?.reason || '');
  if (!listing.REASONS.includes(reason)) return res.status(400).json({ error: 'Pick a reason' });
  const details = clip(req.body?.details, listing.LISTING.maxDetails).trim();
  if (reason === 'other' && !details) return res.status(400).json({ error: 'Tell us what is wrong' });
  if (!clipReportHits.allow(req.user.id)) return res.status(429).json({ error: 'You have sent a lot of reports. Try again later.' });
  clipsLib.addReport(c, req.user.id, reason, details, now());
  if (clipsLib.shouldHide(c, db().users, now(), clipsLib.settings())) { c.state = 'hidden'; c.hold = { state: 'hidden', at: now() }; }
  store.save();
  res.json({ ok: true });
});
// the poster takes their own clip down. A live, hidden or unfinished clip is taken down first (the video is deleted). Then it is dropped from the poster's list,
// so a clip that was already removed (or expired, or not posted) can be deleted from the list too. The record itself stays on the server, with its numbers, as proof of what happened.
app.delete('/api/clips/:id', auth, ah(async (req, res) => {
  const c = db().clips[req.params.id];
  if (!c || c.owner !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (clipsLib.HOLDING.has(c.state) && !c.purgedAt) {
    if (c.state === 'pending') refundClip(c);
    await endClip(c, 'removed', 'Removed by the poster');
  }
  c.dismissed = now();
  store.save();
  res.json({ ok: true });
}));

// moderators: what is reported or hidden, how full the storage is, and what to do about it
app.get('/api/admin/clips', auth, adminOnly, ah(async (_req, res) => {
  const cfg = clipsLib.settings(), all = clipList(), users = db().users;
  const other = store.usingR2 ? await store.r2BytesUsed() : 0, otherMax = store.storageLimitBytes();
  const rows = all.filter((c) => (c.reports || []).length || c.state === 'hidden').sort((a, b) => (b.reports || []).length - (a.reports || []).length).map((c) => ({
    id: c.id, state: c.state, caption: c.caption, owner: users[c.owner]?.username || null, views: c.views || 0, likes: c.likes || 0,
    url: c.key && cfg.publicUrl ? `${cfg.publicUrl}/${c.key}` : null, poster: c.posterKey && cfg.publicUrl ? `${cfg.publicUrl}/${c.posterKey}` : null,
    counted: listing.countedReports(c.reports, users, now()), hold: c.hold || null,
    screen: c.screen ? { verdict: c.screen.verdict, summary: c.screen.summary, reasons: c.screen.reasons || [], at: c.screen.at } : null, // what the automatic check found (moderators only)
    reports: (c.reports || []).map((r) => ({ by: users[r.by]?.username || null, reason: r.reason, details: r.details, at: r.at })),
  }));
  res.json({
    usage: { clipsBytes: clipsLib.usedBytes(all), clipsLimit: cfg.limitBytes, otherBytes: other, otherLimit: otherMax, live: all.filter((c) => clipsLib.isLive(c, now())).length, total: all.length },
    toHide: cfg.reportsToHide, clips: rows,
  });
}));
// restore = back in the feed, reports cleared; dismiss = clear the reports only; remove = delete the video for good (the numbers stay)
app.post('/api/admin/clips/:id', auth, adminOnly, ah(async (req, res) => {
  const c = db().clips[req.params.id];
  if (!c) return res.status(404).json({ error: 'Not found' });
  const action = req.body?.action;
  if (action === 'restore') { if (c.state === 'hidden' && !c.purgedAt) { c.state = 'live'; if (!c.liveAt) c.liveAt = now(); } delete c.hold; c.reports = []; } // a clip held by screening has no liveAt yet
  else if (action === 'dismiss') c.reports = [];
  else if (action === 'remove') { if (c.state === 'pending') refundClip(c); if (!c.purgedAt) { c.takedown = { at: now(), by: 'moderator' }; await endClip(c, 'removed', 'Removed by a moderator'); } } // takedown: the screening refuses a re-post of it
  else return res.status(400).json({ error: 'action must be restore, dismiss or remove' });
  store.save();
  res.json({ ok: true, state: c.state });
}));

// ----- bots: developer accounts, bot records, the explorer's Bots tab -----
// Anyone can turn on a developer account (Settings > Developer, POST /api/developer/join). A developer writes bots (JavaScript, see bots.js)
// that are private (only they can install them) or public (listed in the explorer, anyone who manages a server can add them).
// Public bots follow the same text rules and reporting as public servers. The sandbox, bot accounts, installing and events are in the
// "bots, part 3" block below.
const botSaves = new security.RateWindow(60, 3600_000);
const myBots = (uid) => Object.values(db().bots).filter((b) => b.ownerId === uid);
const developerOnly = (req, res, next) => (req.user.developer || isCreator(req.user) ? next() : res.status(403).json({ error: 'Turn on your developer account first', code: 'not_developer' }));
const viewBot = (b, uid) => botsLib.botView(b, uid, db().users);

app.get('/api/developer', auth, (req, res) => res.json({ developer: !!req.user.developer || isCreator(req.user), bots: req.user.developer || isCreator(req.user) ? myBots(req.user.id).map((b) => ownBotView(b, req.user.id)) : [], limits: { ...botsLib.LIMITS, ...botrun.LIMITS, state: botstate.LIMITS, fetch: botfetch.LIMITS }, fetchHosts: fetcher.hosts }));
app.post('/api/developer/join', auth, (req, res) => {
  if (req.body?.accept !== true) return res.status(400).json({ error: 'Please accept the developer terms' });
  if (!req.user.developer) { req.user.developer = { at: now() }; store.save(); }
  res.json({ developer: true, user: ownUser(req.user) });
});

app.post('/api/bots', auth, developerOnly, (req, res) => {
  if (myBots(req.user.id).length >= botsLib.LIMITS.perDeveloper) return res.status(400).json({ error: `You can have up to ${botsLib.LIMITS.perDeveloper} bots` });
  if (!botSaves.allow(req.user.id)) return res.status(429).json({ error: 'You are saving bots too fast. Try again later.' });
  const r = botsLib.checkBot(req.body, { words: BLOCKED_WORDS });
  if (r.error) return res.status(400).json({ error: r.error });
  const b = { id: store.id(), ownerId: req.user.id, tags: [], installs: [], reports: [], createdAt: now(), updatedAt: now(), ...r.value };
  db().bots[b.id] = b;
  store.save();
  res.json({ bot: ownBotView(b, req.user.id) });
});
app.get('/api/bots/:id', auth, (req, res) => {
  const b = db().bots[req.params.id];
  if (!b || (b.ownerId !== req.user.id && (b.visibility !== 'public' || b.listingHold))) return res.status(404).json({ error: 'Bot not found' });
  res.json({ bot: viewBot(b, req.user.id) });
});
app.patch('/api/bots/:id', auth, developerOnly, (req, res) => {
  const b = db().bots[req.params.id];
  if (!b || b.ownerId !== req.user.id) return res.status(404).json({ error: 'Bot not found' });
  if (b.listingHold && (req.body?.visibility === 'public' || (b.visibility === 'public' && ['name', 'description', 'tags'].some((k) => req.body?.[k] !== undefined)))) {
    return res.status(400).json({ error: b.listingHold.state === 'removed' ? 'This bot was removed from the public listing after reports.' : 'This bot\'s public listing is under review after reports. It cannot be changed until the review is done.' });
  }
  if (!botSaves.allow(req.user.id)) return res.status(429).json({ error: 'You are saving bots too fast. Try again later.' });
  const r = botsLib.checkBot(req.body, { current: b, words: BLOCKED_WORDS });
  if (r.error) return res.status(400).json({ error: r.error });
  const wasPublic = b.visibility === 'public';
  Object.assign(b, r.value, { updatedAt: now() });
  if (r.value.code !== undefined) guard.resume(b.id); // new code lifts a pause
  syncBotUser(b);
  // a bot that goes private only stays where its developer manages the server: strangers installed it while it was public
  if (wasPublic && b.visibility === 'private') removeEverywhere(b, (sv) => can(sv, b.ownerId, 'manageServer'));
  store.save();
  res.json({ bot: ownBotView(b, req.user.id) });
});
app.delete('/api/bots/:id', auth, (req, res) => {
  const b = db().bots[req.params.id];
  if (!b || b.ownerId !== req.user.id) return res.status(404).json({ error: 'Bot not found' });
  removeEverywhere(b); // a deleted bot leaves every server it was in (its account stays on record so old messages keep the name)
  guard.forget(b.id);
  delete db().bots[b.id];
  store.save();
  res.json({ ok: true });
});

// Bot picture: PNG, JPEG or WebP up to 500 px, checked like profile pictures. The bot's account shows the same image in member lists and next
// to its messages. While a listing is under review or removed the developer cannot change it (same as the other public details).
async function setBotAvatar(b, buf) {
  const old = b.avatarImage || null;
  b.avatarImage = buf ? await store.putImage(buf) : null;
  const u = b.userId && db().users[b.userId];
  if (u) { u.avatarImage = b.avatarImage; emitUserUpdate(u); }
  await store.flush(); // everything points at the new image before the old one is deleted
  if (old && old !== b.avatarImage) await store.deleteImage(old);
  tellDeveloper(b);
}
const ownBotForImage = (req, res) => {
  const b = botById(req.params.id);
  if (!b || b.ownerId !== req.user.id) { res.status(404).json({ error: 'Bot not found' }); return null; }
  if (b.listingHold) { res.status(400).json({ error: 'This bot\'s public listing is under review or was removed. Its picture cannot be changed now.' }); return null; }
  return b;
};
app.put('/api/bots/:id/avatar', auth, developerOnly, uploadLimiter, rawImage, ah(async (req, res) => {
  const b = ownBotForImage(req, res); if (!b) return;
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Choose a PNG, JPEG or WebP image' });
  const info = sniffImage(buf);
  if (!info) return res.status(400).json({ error: 'That file is not a valid PNG, JPEG or WebP image' });
  if (info.width > 500 || info.height > 500) return res.status(400).json({ error: 'Image is too large (max 500px per side)' });
  await setBotAvatar(b, buf);
  res.json({ bot: ownBotView(b, req.user.id) });
}));
app.delete('/api/bots/:id/avatar', auth, developerOnly, ah(async (req, res) => {
  const b = ownBotForImage(req, res); if (!b) return;
  await setBotAvatar(b, null);
  res.json({ bot: ownBotView(b, req.user.id) });
}));

// ----- badges (creator accounts only) -----
// A creator makes badges (a name plus a picture, or an emoji on a colour) and gives them to people by username. The Creator badge itself is automatic.
const creatorOnly = (req, res, next) => (isCreator(req.user) ? next() : res.status(403).json({ error: 'Only the creator account can manage badges', code: 'not_creator' }));
const BADGE_LIMITS = { name: 24, total: 200, perUser: 12, desc: 80 };
const badgeOwnView = (b) => ({
  id: b.id, name: b.name, emoji: b.emoji || '', color: b.color || '#8c6b4f', image: b.image || null,
  desc: b.desc || '', price: Number.isInteger(b.price) && b.price > 0 ? b.price : null, // a price puts the badge on sale in the credits shop
  shopEnds: Number.isFinite(b.shopEnds) && b.shopEnds > 0 ? b.shopEnds : null, // when it leaves the shop; pinned = always shown; daily = takes part in the daily shop (see shop.js)
  pinned: b.pinned === true, daily: b.daily === true,
  holders: Object.values(db().users).filter((u) => Array.isArray(u.badges) && u.badges.includes(b.id)).map((u) => ({ id: u.id, username: u.username, displayName: u.displayName })),
});
const badgeById = (id) => (db().badges && db().badges[id]) || null;
function cleanBadgeFields(body, partial) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name || Array.from(name).length > BADGE_LIMITS.name) return { error: `A badge name is 1-${BADGE_LIMITS.name} characters` };
    out.name = name;
  }
  if (body.emoji !== undefined) {
    const emoji = String(body.emoji ?? '').trim();
    if (Array.from(emoji).length > 4) return { error: 'Use a single emoji' };
    out.emoji = emoji;
  }
  if (body.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(String(body.color))) return { error: 'Colour must look like #8c6b4f' };
    out.color = String(body.color).toLowerCase();
  }
  if (body.desc !== undefined) {
    const desc = String(body.desc ?? '').trim().replace(/\s+/g, ' ');
    if (Array.from(desc).length > BADGE_LIMITS.desc) return { error: `A description is at most ${BADGE_LIMITS.desc} characters` };
    out.desc = desc;
  }
  if (body.price !== undefined) {
    if (body.price === null || body.price === '') out.price = null; // off sale
    else {
      const p = Number(body.price);
      if (!Number.isInteger(p) || p < 1 || p > credits.shop.MAX_PRICE) return { error: `The price is a whole number of credits from 1 to ${credits.shop.MAX_PRICE.toLocaleString('en-US')}` };
      out.price = p;
    }
  }
  if (body.shopEnds !== undefined) {
    if (body.shopEnds === null || body.shopEnds === '') out.shopEnds = null; // no end date
    else {
      const t = Number(body.shopEnds);
      if (!Number.isFinite(t) || t <= now()) return { error: 'Pick an end date that is still to come' };
      if (t > now() + 5 * 365 * 86_400_000) return { error: 'That end date is too far away' };
      out.shopEnds = Math.round(t);
    }
  }
  if (body.pinned !== undefined) out.pinned = body.pinned === true;
  if (body.daily !== undefined) out.daily = body.daily === true;
  return { out };
}
const badgeNameTaken = (name, exceptId) => ['creator', 'artist'].includes(name.toLowerCase()) || Object.values(db().badges).some((b) => b.id !== exceptId && b.name.toLowerCase() === name.toLowerCase());
const tellHolders = (id) => { for (const u of Object.values(db().users)) if (Array.isArray(u.badges) && u.badges.includes(id)) emitUserUpdate(u); };
app.get('/api/badges', auth, creatorOnly, (_req, res) => res.json({ badges: Object.values(db().badges).map(badgeOwnView), limits: BADGE_LIMITS }));
app.post('/api/badges', auth, creatorOnly, (req, res) => {
  if (Object.keys(db().badges).length >= BADGE_LIMITS.total) return res.status(400).json({ error: `At most ${BADGE_LIMITS.total} badges` });
  const { out, error } = cleanBadgeFields(req.body || {}, false);
  if (error) return res.status(400).json({ error });
  if (badgeNameTaken(out.name)) return res.status(409).json({ error: 'A badge with that name already exists' });
  const b = { id: store.id(), name: out.name, emoji: out.emoji || '', color: out.color || '#8c6b4f', image: null, desc: out.desc || '', price: out.price ?? null, shopEnds: out.shopEnds ?? null, pinned: out.pinned === true, daily: out.daily === true, createdBy: req.user.id, createdAt: now() };
  db().badges[b.id] = b; store.save();
  res.json({ badge: badgeOwnView(b) });
});
app.patch('/api/badges/:id', auth, creatorOnly, (req, res) => {
  const b = badgeById(req.params.id); if (!b) return res.status(404).json({ error: 'Badge not found' });
  const { out, error } = cleanBadgeFields(req.body || {}, true);
  if (error) return res.status(400).json({ error });
  if (out.name && badgeNameTaken(out.name, b.id)) return res.status(409).json({ error: 'A badge with that name already exists' });
  Object.assign(b, out); store.save(); tellHolders(b.id);
  res.json({ badge: badgeOwnView(b) });
});
app.delete('/api/badges/:id', auth, creatorOnly, ah(async (req, res) => {
  const b = badgeById(req.params.id); if (!b) return res.status(404).json({ error: 'Badge not found' });
  const holders = Object.values(db().users).filter((u) => Array.isArray(u.badges) && u.badges.includes(b.id));
  for (const u of holders) u.badges = u.badges.filter((x) => x !== b.id);
  const img = b.image; delete db().badges[b.id];
  for (const u of holders) emitUserUpdate(u);
  await store.flush();
  if (img) await store.deleteImage(img);
  res.json({ ok: true });
}));
app.put('/api/badges/:id/image', auth, creatorOnly, uploadLimiter, rawImage, ah(async (req, res) => {
  const b = badgeById(req.params.id); if (!b) return res.status(404).json({ error: 'Badge not found' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Choose a PNG, JPEG or WebP image' });
  const info = sniffImage(buf);
  if (!info) return res.status(400).json({ error: 'That file is not a valid PNG, JPEG or WebP image' });
  if (info.width > 512 || info.height > 512) return res.status(400).json({ error: 'Image is too large (max 512px per side)' });
  const old = b.image || null;
  b.image = await store.putImage(buf);
  await store.flush(); tellHolders(b.id);
  if (old && old !== b.image) await store.deleteImage(old);
  res.json({ badge: badgeOwnView(b) });
}));
app.delete('/api/badges/:id/image', auth, creatorOnly, ah(async (req, res) => {
  const b = badgeById(req.params.id); if (!b) return res.status(404).json({ error: 'Badge not found' });
  const old = b.image || null; b.image = null;
  await store.flush(); tellHolders(b.id);
  if (old) await store.deleteImage(old);
  res.json({ badge: badgeOwnView(b) });
}));
const userByName = (name) => { const n = String(name || '').trim().replace(/^@/, '').toLowerCase(); return n ? Object.values(db().users).find((x) => !x.bot && x.username.toLowerCase() === n) : null; };
app.post('/api/badges/:id/give', auth, creatorOnly, (req, res) => {
  const b = badgeById(req.params.id); if (!b) return res.status(404).json({ error: 'Badge not found' });
  const u = userByName(req.body?.username); if (!u) return res.status(404).json({ error: 'No account with that username' });
  u.badges = Array.isArray(u.badges) ? u.badges : [];
  if (!u.badges.includes(b.id)) {
    if (u.badges.length >= BADGE_LIMITS.perUser) return res.status(400).json({ error: `Nobody can hold more than ${BADGE_LIMITS.perUser} badges` });
    u.badges.push(b.id); store.save(); emitUserUpdate(u);
  }
  res.json({ badge: badgeOwnView(b) });
});
app.delete('/api/badges/:id/give/:username', auth, creatorOnly, (req, res) => {
  const b = badgeById(req.params.id); if (!b) return res.status(404).json({ error: 'Badge not found' });
  const u = userByName(req.params.username); if (!u) return res.status(404).json({ error: 'No account with that username' });
  if (Array.isArray(u.badges) && u.badges.includes(b.id)) { u.badges = u.badges.filter((x) => x !== b.id); store.save(); emitUserUpdate(u); }
  res.json({ badge: badgeOwnView(b) });
});

// ----- artists: apply, get reviewed, sell badges in the shop -----
// The rules (statuses, limits, the artist's cut) are in artists.js; read the flow at the top of that file. Routes:
//   GET    /api/artists/me                          the person's application, their items, the limits, and whether they can review
//   PUT    /api/artists/pieces/:slot  (0-3)         put a piece of art in the draft application (replaces what was in that slot)
//   DELETE /api/artists/pieces/:slot                take one out of the draft
//   POST   /api/artists/apply { note }              send the draft in (needs all four pieces)
//   POST/PATCH/DELETE /api/artists/items[/:id]      an approved artist's shop items; PUT .../image; POST .../submit sends one for review
//   GET    /api/artists/review                      moderators: the applications and items waiting
//   POST   /api/artists/review/applications/:uid and /review/items/:id   { action: 'approve' | 'reject', note }
// Moderators are creator accounts and the usernames in ADMIN_USERNAMES. Nobody can review their own application or items.
const isReviewer = (u) => isCreator(u) || isAdmin(u);
const reviewerOnly = (req, res, next) => (isReviewer(req.user) ? next() : res.status(404).json({ error: 'Not found' }));
const artistSaves = new security.RateWindow(60, 3600_000);
const artistRec = (uid) => (db().artists && db().artists[uid]) || null;
const artistOnly = (req, res, next) => (!req.user.bot && artistsLib.isArtist(artistRec(req.user.id)) ? next() : res.status(403).json({ error: 'Only approved artists can do that', code: 'not_artist' }));
const myItems = (uid) => Object.values(db().badges).filter((b) => b.artistId === uid);
const ownersOf = (id) => Object.values(db().users).filter((u) => Array.isArray(u.badges) && u.badges.includes(id)).length;
const itemView = (b) => ({
  id: b.id, kind: artistsLib.kindOf(b), name: b.name, desc: b.desc || '', price: Number.isInteger(b.price) && b.price > 0 ? b.price : null, image: b.image || null,
  status: b.status || 'draft', reviewNote: b.status === 'rejected' || b.status === 'approved' ? b.reviewNote || '' : '', sold: ownersOf(b.id),
});
const personOf = (uid) => { const u = db().users[uid]; return { userId: uid, username: u ? u.username : null, displayName: u ? u.displayName : null }; };
const ownItem = (req, res) => {
  const b = badgeById(req.params.id);
  if (!b || b.artistId !== req.user.id) { res.status(404).json({ error: 'Item not found' }); return null; }
  return b;
};
// a PNG, JPEG or WebP the browser sent, checked like the other pictures: { buf } or { error }
function readPicture(req, maxSide) {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return { error: 'Choose a PNG, JPEG or WebP image' };
  const info = sniffImage(buf);
  if (!info) return { error: 'That file is not a valid PNG, JPEG or WebP image' };
  if (info.width > maxSide || info.height > maxSide) return { error: `Image is too large (max ${maxSide}px per side)` };
  return { buf, info };
}

app.get('/api/artists/me', auth, (req, res) => {
  const rec = artistRec(req.user.id), reviewer = isReviewer(req.user);
  res.json({
    application: artistsLib.view(rec, now()),
    items: artistsLib.isArtist(rec) ? myItems(req.user.id).map(itemView) : [],
    limits: { ...artistsLib.LIMITS, cutPercent: artistsLib.CUT_PERCENT },
    reviewer,
    ...(reviewer ? { waiting: { applications: Object.values(db().artists).filter((r) => r.status === 'pending').length, items: Object.values(db().badges).filter((b) => artistsLib.isItem(b) && b.status === 'pending').length } } : {}),
  });
});

app.put('/api/artists/pieces/:slot', auth, uploadLimiter, rawImage, ah(async (req, res) => {
  const slot = artistsLib.validSlot(req.params.slot);
  if (slot < 0) return res.status(400).json({ error: 'Pieces are numbered 0 to 3' });
  const pic = readPicture(req, artistsLib.LIMITS.maxSide);
  if (pic.error) return res.status(400).json({ error: pic.error });
  const o = artistsLib.open(artistRec(req.user.id), req.user.id, now()); // a person who was rejected starts a fresh draft once the wait is over
  if (!o.ok) return res.status(o.status).json({ error: o.error });
  if (!artistSaves.allow(req.user.id)) return res.status(429).json({ error: 'You are saving too fast. Try again later.' });
  const rec = o.rec; db().artists[req.user.id] = rec;
  const old = rec.pieces[slot] || null;
  const id = await store.putImage(pic.buf);
  if (rec.status !== 'draft') { await store.deleteImage(id); return res.status(409).json({ error: 'Your application was already sent' }); } // sent while the picture was uploading
  rec.pieces[slot] = id;
  await store.flush(); // the draft points at the new picture before the old ones are deleted
  for (const gone of [...o.dropped, old]) if (gone && gone !== id) await store.deleteImage(gone);
  res.json({ application: artistsLib.view(rec, now()) });
}));
app.delete('/api/artists/pieces/:slot', auth, ah(async (req, res) => {
  const slot = artistsLib.validSlot(req.params.slot);
  if (slot < 0) return res.status(400).json({ error: 'Pieces are numbered 0 to 3' });
  const rec = artistRec(req.user.id);
  if (!rec || rec.status !== 'draft') return res.status(409).json({ error: 'Only a draft can be changed' });
  const old = rec.pieces[slot] || null; rec.pieces[slot] = null;
  await store.flush();
  if (old) await store.deleteImage(old);
  res.json({ application: artistsLib.view(rec, now()) });
}));
app.post('/api/artists/apply', auth, (req, res) => {
  if (req.user.bot) return res.status(403).json({ error: 'Bots cannot apply' });
  const rec = artistRec(req.user.id);
  const r = artistsLib.submit(rec, req.body && req.body.note, now());
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  store.save();
  res.json({ application: artistsLib.view(rec, now()) });
});

app.post('/api/artists/items', auth, artistOnly, (req, res) => {
  if (!artistsLib.itemRoom(myItems(req.user.id))) return res.status(400).json({ error: `You can have up to ${artistsLib.LIMITS.items} items` });
  if (Object.keys(db().badges).length >= BADGE_LIMITS.total) return res.status(400).json({ error: 'The shop is full right now' });
  const { out, error } = artistsLib.cleanItem(req.body, false);
  if (error) return res.status(400).json({ error });
  if (badgeNameTaken(out.name)) return res.status(409).json({ error: 'A badge with that name already exists' });
  if (!artistSaves.allow(req.user.id)) return res.status(429).json({ error: 'You are saving too fast. Try again later.' });
  const b = { id: store.id(), kind: out.kind, name: out.name, emoji: '', color: '#8c6b4f', image: null, desc: out.desc || '', price: out.price, shopEnds: null, pinned: false, daily: false, artistId: req.user.id, status: 'draft', createdBy: req.user.id, createdAt: now() };
  db().badges[b.id] = b; store.save();
  res.json({ item: itemView(b) });
});
app.patch('/api/artists/items/:id', auth, artistOnly, (req, res) => {
  const b = ownItem(req, res); if (!b) return;
  const r = artistsLib.editItem(b, req.body);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  if (r.out.name && badgeNameTaken(r.out.name, b.id)) return res.status(409).json({ error: 'A badge with that name already exists' });
  if (!artistSaves.allow(req.user.id)) return res.status(429).json({ error: 'You are saving too fast. Try again later.' });
  artistsLib.applyEdit(b, r.out); store.save();
  res.json({ item: itemView(b) });
});
app.put('/api/artists/items/:id/image', auth, artistOnly, uploadLimiter, rawImage, ah(async (req, res) => {
  const b = ownItem(req, res); if (!b) return;
  if (b.status === 'approved') return res.status(409).json({ error: 'An approved item’s picture cannot be changed. Make a new item instead.' });
  const pic = readPicture(req, 512);
  if (pic.error) return res.status(400).json({ error: pic.error });
  if (artistsLib.isFrame(b) && (pic.info.width !== pic.info.height || pic.info.width < artistsLib.FRAME.minSide)) return res.status(400).json({ error: `A frame picture is a square, at least ${artistsLib.FRAME.minSide}px. Use the template.` });
  const id = await store.putImage(pic.buf);
  if (b.status === 'approved' || !badgeById(b.id)) { await store.deleteImage(id); return res.status(409).json({ error: 'This item can no longer be changed' }); } // approved or deleted while uploading
  const old = b.image || null; b.image = id; artistsLib.applyEdit(b, {}); // a changed picture takes the item back to a draft
  await store.flush();
  if (old && old !== id) await store.deleteImage(old);
  res.json({ item: itemView(b) });
}));
app.post('/api/artists/items/:id/submit', auth, artistOnly, (req, res) => {
  const b = ownItem(req, res); if (!b) return;
  const r = artistsLib.submitItem(b, now());
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  store.save();
  res.json({ item: itemView(b) });
});
app.delete('/api/artists/items/:id', auth, artistOnly, ah(async (req, res) => {
  const b = ownItem(req, res); if (!b) return;
  if (ownersOf(b.id)) return res.status(409).json({ error: 'People own this badge, so it cannot be deleted. Set its price to nothing to take it off sale.' });
  const img = b.image; delete db().badges[b.id];
  await store.flush();
  if (img) await store.deleteImage(img);
  res.json({ ok: true });
}));

app.get('/api/artists/review', auth, reviewerOnly, (req, res) => {
  const applications = Object.values(db().artists).filter((r) => r.status === 'pending').sort((a, b) => (a.appliedAt || 0) - (b.appliedAt || 0))
    .map((r) => ({ ...personOf(r.id), note: r.note || '', pieces: artistsLib.pieceIds(r), appliedAt: r.appliedAt || null, own: r.id === req.user.id }));
  const items = Object.values(db().badges).filter((b) => artistsLib.isItem(b) && b.status === 'pending').sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0))
    .map((b) => ({ id: b.id, kind: artistsLib.kindOf(b), name: b.name, desc: b.desc || '', price: b.price, image: b.image || null, artist: personOf(b.artistId), submittedAt: b.submittedAt || null, own: b.artistId === req.user.id }));
  res.json({ applications, items });
});
app.post('/api/artists/review/applications/:uid', auth, reviewerOnly, (req, res) => {
  if (req.params.uid === req.user.id) return res.status(403).json({ error: 'Someone else has to review your own application' });
  const rec = artistRec(req.params.uid);
  const r = artistsLib.decide(rec, req.body && req.body.action, req.body && req.body.note, req.user.id, now());
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  store.save();
  if (rec.status === 'approved') { const au = db().users[req.params.uid]; if (au) emitUserUpdate(au); } // the Artist badge shows as soon as they are approved
  res.json({ ok: true, status: rec.status });
});
app.post('/api/artists/review/items/:id', auth, reviewerOnly, (req, res) => {
  const b = badgeById(req.params.id);
  if (b && b.artistId === req.user.id) return res.status(403).json({ error: 'Someone else has to review your own items' });
  const r = artistsLib.decideItem(b, req.body && req.body.action, req.body && req.body.note, req.user.id, now());
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const rec = artistRec(b.artistId);
  if (b.status === 'approved' && artistsLib.isArtist(rec) && rec.badge !== true) { // their first approved item earns the Artist badge
    rec.badge = true;
    const u = db().users[b.artistId]; if (u) emitUserUpdate(u);
  }
  store.save();
  res.json({ ok: true, status: b.status });
});

// Test run: the developer's own code (a saved bot's, or a draft sent as `code`) against a made-up event, so they can see what it would
// do. Nothing is sent anywhere: the actions come back as a list. Same sandbox and limits as the real thing.
// Event shape (part 3 will send the same): message = { id, channelId, serverId, text, mentions: [userId], author: { id, username, displayName, bot }, createdAt }
const botTests = new security.RateWindow(30, 60_000);
app.post('/api/developer/test', auth, developerOnly, ah(async (req, res) => {
  if (!sandbox.available()) return res.status(503).json({ error: 'The bot sandbox is not installed on this server', code: 'sandbox_missing' });
  const b = req.body || {};
  let code = typeof b.code === 'string' ? b.code : null;
  if (code === null && typeof b.botId === 'string') {
    const bot = db().bots[b.botId];
    if (!bot || bot.ownerId !== req.user.id) return res.status(404).json({ error: 'Bot not found' });
    code = bot.code;
  }
  if (code === null) return res.status(400).json({ error: 'Send the bot code or a botId' });
  const bad = botsLib.checkBot({ name: 'test', code }, {});
  if (bad.error) return res.status(400).json({ error: bad.error });
  if (!botTests.allow(req.user.id)) return res.status(429).json({ error: 'Too many test runs. Wait a moment.' });
  const text = clip(b.text, 2000);
  const u = req.user;
  const TEST_EVENTS = ['message', 'messageEdit', 'memberJoin', 'memberLeave', 'install', 'timer', 'fetch'];
  const event = TEST_EVENTS.includes(b.event) ? b.event : 'message';
  // The chat simulator (client/src/BotSim.jsx) acts as one of two made-up people or as the developer, and hands the saved data and timers of
  // the run before back in `state`, so a conversation builds up like it would in a real server. Without those it is a single fresh run.
  const SIM_BOT = 'b07000000000b001';
  const SIM_PEOPLE = { alex: { id: 'a1e0000000000001', username: 'alex', displayName: 'Alex' }, sam: { id: 'a5a0000000000002', username: 'sam', displayName: 'Sam' } };
  const who = Object.prototype.hasOwnProperty.call(SIM_PEOPLE, b.as) ? SIM_PEOPLE[b.as] : u;
  const msgId = typeof b.messageId === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(b.messageId) ? b.messageId : 'test-message';
  // the same shapes the real events have, against a made-up server with one text channel
  const fake = { id: 'test-server', name: 'Test server', members: [u.id, ...Object.values(SIM_PEOPLE).map((p) => p.id)], channels: [{ id: 'test-channel', name: 'general' }] };
  const fakeMsg = { id: msgId, channelId: 'test-channel', serverId: 'test-server', content: text, mentions: b.mentionBot === true ? [SIM_BOT] : [], createdAt: now(), editedAt: event === 'messageEdit' ? now() : null };
  const timerKind = ['after', 'every', 'daily'].includes(b.kind) ? b.kind : 'after';
  const timerData = typeof b.data === 'string' && b.data.length <= botstate.LIMITS.timerDataBytes ? b.data : null;
  const payload = event === 'memberJoin' ? botrun.joinPayload({ server: fake, user: who, install: {} })
    : event === 'memberLeave' ? botrun.leavePayload({ server: fake, user: who, install: {}, reason: 'left' })
    : event === 'install' ? botrun.installPayload({ server: fake, install: {}, by: who })
    : event === 'timer' ? botrun.timerPayload({ server: fake, install: {}, timer: { name: clip(b.name, 32) || 'test', kind: timerKind, data: timerData }, firedAt: now() })
    : event === 'fetch' ? botrun.fetchPayload({ server: fake, install: {}, request: { name: clip(b.name, 32) || 'fetch', url: clip(b.url, 400) || 'https://api.github.com/' }, result: { ok: true, status: 200, text: text || '{}', json: (() => { try { return JSON.parse(text); } catch { return null; } })() } }) // made up: a test never goes out to the network
    : event === 'messageEdit' ? botrun.editPayload({ msg: fakeMsg, author: who, botUserId: SIM_BOT })
    : botrun.messagePayload({ msg: fakeMsg, author: who, botUserId: SIM_BOT });
  // storage, timers, reactions and fetches go through the same checks as real ones, on throw-away copies
  const scratch = botstate.cleanSimState(b.state, now());
  const r = await sandbox.run({ code, event, payload, state: botstate.snapshotFor(scratch) });
  const plan = botrun.planActions({ actions: r.actions, server: fake, install: {}, mentionUserId: who.id, maxText: MAX_MSG, replyOk: (cid, mid) => (mid === msgId ? mid : null) });
  r.dropped = plan.dropped; // what a real server would refuse, e.g. a wrong channel id
  r.dropped.push(...botstate.applyStoreOps(scratch.kv, r.store).dropped, ...botstate.applyTimers(scratch, r.timers, now()).dropped);
  r.dropped.push(...botrun.planReactions({ actions: r.reactions, server: fake, install: {}, messageOf: (id) => (id === msgId ? fakeMsg : null), emojiOk }).dropped);
  r.dropped.push(...botrun.planFetches({ actions: r.fetches, check: fetcher.check }).dropped);
  r.stored = Object.entries(scratch.kv).map(([key, value]) => ({ key, value })); // what the storage would hold afterwards
  r.timersSet = scratch.timers.map((t) => ({ name: t.name, kind: t.kind, everySec: t.everySec, time: t.time, tz: t.tz, at: t.at }));
  r.state = { kv: scratch.kv, timers: scratch.timers }; // for the next run of the simulator (timers keep their data here)
  res.json({ result: r });
}));

app.get('/api/explore/bots', auth, (req, res) => {
  const r = botsLib.exploreBots(Object.values(db().bots), {
    q: clip(req.query.q, 60), sort: ['popular', 'az', 'za', 'new'].includes(req.query.sort) ? req.query.sort : 'popular',
    offset: Math.max(0, parseInt(req.query.offset, 10) || 0), words: BLOCKED_WORDS,
  });
  res.json({ bots: r.page.map((b) => viewBot(b, req.user.id)), total: r.total, next: r.next });
});

// Reports work like server reports: one per person, only public bots, not your own; enough reports from established accounts hide it.
app.post('/api/bots/:id/report', auth, (req, res) => {
  const b = db().bots[req.params.id];
  if (!b || b.visibility !== 'public') return res.status(404).json({ error: 'That bot is not listed publicly' });
  if (b.ownerId === req.user.id) return res.status(400).json({ error: 'You cannot report your own bot' });
  const reason = String(req.body?.reason || '');
  if (!listing.REASONS.includes(reason)) return res.status(400).json({ error: 'Pick a reason' });
  const details = clip(req.body?.details, listing.LISTING.maxDetails).trim();
  if (reason === 'other' && !details) return res.status(400).json({ error: 'Tell us what is wrong' });
  if (!reportHits.allow(req.user.id)) return res.status(429).json({ error: 'You have sent a lot of reports. Try again later.' });
  b.reports = (b.reports || []).filter((r) => r.by !== req.user.id);
  b.reports.push({ by: req.user.id, reason, details, at: now(), name: b.name, description: b.description || '', tags: b.tags || [] });
  if (b.reports.length > 200) b.reports = b.reports.slice(-200);
  if (!b.listingHold && listing.countedReports(b.reports, db().users, now()) >= REPORTS_TO_HIDE) { b.listingHold = { state: 'hidden', at: now() }; tellDeveloper(b); }
  store.save();
  res.json({ ok: true });
});
app.get('/api/admin/bot-reports', auth, adminOnly, (_req, res) => {
  const rows = Object.values(db().bots).filter((b) => (b.reports || []).length || b.listingHold).map((b) => ({
    botId: b.id, name: b.name, description: b.description || '', tags: b.tags || [], visibility: b.visibility, installs: (b.installs || []).length,
    developer: db().users[b.ownerId]?.username || null, hold: b.listingHold || null, counted: listing.countedReports(b.reports, db().users, now()),
    reports: (b.reports || []).map((r) => ({ by: db().users[r.by]?.username || null, reason: r.reason, details: r.details, at: r.at, about: r.about || 'listing', message: r.message || null })),
  })).sort((a, b) => b.reports.length - a.reports.length);
  res.json({ bots: rows, toHide: REPORTS_TO_HIDE });
});
app.post('/api/admin/bots/:id/listing', auth, adminOnly, (req, res) => {
  const b = db().bots[req.params.id];
  if (!b) return res.status(404).json({ error: 'Not found' });
  const action = req.body?.action;
  if (action === 'restore' || action === 'dismiss') { delete b.listingHold; b.reports = []; }
  else if (action === 'remove') { b.listingHold = { state: 'removed', at: now() }; b.visibility = 'private'; removeEverywhere(b); } // removed for good: it stops running and leaves every server
  else return res.status(400).json({ error: 'action must be restore, dismiss or remove' });
  store.save();
  tellDeveloper(b);
  res.json({ ok: true, hold: b.listingHold || null });
});

// ----- reports from inside the app: a person, a bot account, a message -----
// (A server is reported with POST /api/servers/:id/report above; it now also accepts members of a private server.)
// Same rules as the listing reports: one per person per thing, never your own, a reason (and details for "other"), a rate limit, and the
// reported person is never told who reported. These do not hide or remove anything by themselves: moderators read them
// (GET /api/admin/user-reports, plus the bot and server lists above) and decide. A report keeps a copy of what was reported,
// in case it is edited or deleted afterwards.
function readReport(req, res) {
  const reason = String(req.body?.reason || '');
  if (!listing.REASONS.includes(reason)) { res.status(400).json({ error: 'Pick a reason' }); return null; }
  const details = clip(req.body?.details, listing.LISTING.maxDetails).trim();
  if (reason === 'other' && !details) { res.status(400).json({ error: 'Tell us what is wrong' }); return null; }
  if (!reportHits.allow(req.user.id)) { res.status(429).json({ error: 'You have sent a lot of reports. Try again later.' }); return null; }
  return { reason, details };
}
// a report about a bot account is kept on the bot's own record (the developer's), about anyone else on that person's record
const reportHolder = (u) => (u.bot && u.botId && db().bots[u.botId] ? db().bots[u.botId] : u);
function addAccountReport(holder, entry) {
  const key = entry.message ? entry.message.id : '';
  holder.reports = (holder.reports || []).filter((r) => !(r.by === entry.by && (r.message ? r.message.id : '') === key));
  holder.reports.push(entry);
  if (holder.reports.length > 200) holder.reports = holder.reports.slice(-200);
}
app.post('/api/users/:id/report', auth, (req, res) => {
  const u = db().users[req.params.id];
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot report yourself' });
  const holder = reportHolder(u);
  if (holder.ownerId === req.user.id) return res.status(400).json({ error: 'You cannot report your own bot' });
  const r = readReport(req, res);
  if (!r) return;
  addAccountReport(holder, { by: req.user.id, reason: r.reason, details: r.details, at: now(), about: 'account', name: u.displayName || u.username });
  store.save();
  res.json({ ok: true });
});
app.post('/api/messages/:id/report', auth, (req, res) => {
  const m = db().messages[req.params.id];
  const f = m && m.channelId ? findChannel(m.channelId) : null;
  if (!f || !f.server.members.includes(req.user.id)) return res.status(404).json({ error: 'Not found' }); // only a message you can see
  if (m.authorId === req.user.id) return res.status(400).json({ error: 'You cannot report your own message' });
  const author = db().users[m.authorId];
  if (!author) return res.status(404).json({ error: 'Not found' });
  const holder = reportHolder(author);
  if (holder.ownerId === req.user.id) return res.status(400).json({ error: 'You cannot report your own bot' });
  const r = readReport(req, res);
  if (!r) return;
  addAccountReport(holder, {
    by: req.user.id, reason: r.reason, details: r.details, at: now(), about: 'message', name: author.displayName || author.username,
    message: { id: m.id, channelId: f.channel.id, channel: f.channel.name, server: f.server.name, serverId: f.server.id, sentAt: m.createdAt, content: clip(m.content, 500), attachments: (m.attachments || []).length },
  });
  store.save();
  res.json({ ok: true });
});
app.get('/api/admin/user-reports', auth, adminOnly, (_req, res) => {
  const rows = Object.values(db().users).filter((u) => (u.reports || []).length).map((u) => ({
    userId: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt,
    reports: u.reports.map((r) => ({ by: db().users[r.by]?.username || null, reason: r.reason, details: r.details, at: r.at, about: r.about || 'account', message: r.message || null })),
  })).sort((a, b) => b.reports.length - a.reports.length);
  res.json({ users: rows });
});
app.post('/api/admin/users/:id/reports', auth, adminOnly, (req, res) => {
  const u = db().users[req.params.id];
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (req.body?.action !== 'dismiss') return res.status(400).json({ error: 'action must be dismiss' });
  u.reports = [];
  store.save();
  res.json({ ok: true });
});

// ----- the admin page (/admin): admins, people, reports, moderation -----
// Who can open it: creator accounts, the usernames in ADMIN_USERNAMES, and accounts a creator made admin on the page itself (u.admin = { at, by }).
// Only a creator adds or removes admins. Admins read every report and act on it, suspend or delete accounts, and delete servers or messages, but
// cannot act on a creator or on another admin. Everything they do is written to a short log (meta "adminlog", the newest 300 entries).
// Anyone who is not an admin gets a plain 404 from every route here, so the routes cannot be used to find out who is.
const adminRole = (u) => (isCreator(u) ? 'creator' : isEnvAdmin(u) ? 'config' : u.admin ? 'admin' : null);
const needCreator = (req, res, next) => (isCreator(req.user) ? next() : res.status(403).json({ error: 'Only a creator account can do that' }));
let adminLogChain = Promise.resolve();
function adminLogAdd(by, action, target, note) {
  const entry = { at: now(), by: by.username, action, target: String(target || '').slice(0, 80), note: String(note || '').slice(0, 300) };
  adminLogChain = adminLogChain.then(async () => { // one at a time, so two actions never overwrite each other's entry
    const raw = await store.getMeta('adminlog');
    const list = raw ? JSON.parse(raw) : [];
    list.push(entry);
    await store.setMeta('adminlog', JSON.stringify(list.slice(-300)));
  }).catch((e) => console.error('Could not write the admin log:', e.message));
  return adminLogChain;
}
// The email address is private even from admins, so it is never part of these.
const adminUserRow = (u) => ({
  id: u.id, username: u.username, displayName: u.displayName || u.username, createdAt: u.createdAt || null, role: adminRole(u),
  suspended: u.suspended ? { at: u.suspended.at, reason: u.suspended.reason || '' } : null, deleted: !!u.deleted,
  reports: (u.reports || []).length, avatarImage: u.avatarImage || null, avatarColor: u.avatarColor || '#8c6b4f', avatarEmoji: u.avatarEmoji || '',
});
const adminReportRows = (list) => (list || []).map((r) => ({ by: db().users[r.by]?.username || null, reason: r.reason, details: r.details, at: r.at, about: r.about || 'account', message: r.message || null }));
// the person an action is about; sends the refusal itself. Not yourself, never a creator, and only a creator may act on an admin.
function modTarget(req, res) {
  const u = db().users[req.params.id];
  if (!u || u.bot || u.deleted) { res.status(404).json({ error: 'Not found' }); return null; }
  if (u.id === req.user.id) { res.status(400).json({ error: 'You cannot do that to your own account' }); return null; }
  if (isCreator(u)) { res.status(403).json({ error: 'Creator accounts cannot be moderated here' }); return null; }
  if (adminRole(u) && !isCreator(req.user)) { res.status(403).json({ error: 'Only a creator can do that to an admin' }); return null; }
  return u;
}

app.get('/api/admin/me', auth, adminOnly, (req, res) => res.json({ username: req.user.username, role: adminRole(req.user), canManageAdmins: isCreator(req.user) }));

app.get('/api/admin/summary', auth, adminOnly, (_req, res) => {
  const people = Object.values(db().users).filter((u) => !u.bot);
  res.json({
    users: people.filter((u) => !u.deleted).length, suspended: people.filter((u) => u.suspended).length,
    reports: {
      users: people.filter((u) => (u.reports || []).length).length,
      servers: Object.values(db().servers).filter((s) => (s.reports || []).length || s.listingHold).length,
      bots: Object.values(db().bots).filter((b) => (b.reports || []).length || b.listingHold).length,
      clips: clipList().filter((c) => (c.reports || []).length || c.state === 'hidden').length,
    },
  });
});

// find people by username, display name or id (newest accounts first when nothing is typed); at most 30 come back
app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
  const all = Object.values(db().users).filter((u) => !u.bot && !u.deleted);
  const rank = (u) => (u.username.toLowerCase() === q ? 0 : u.username.toLowerCase().startsWith(q) ? 1 : 2);
  const rows = q
    ? all.filter((u) => u.username.toLowerCase().includes(q) || String(u.displayName || '').toLowerCase().includes(q) || u.id === q).sort((a, b) => rank(a) - rank(b) || a.username.localeCompare(b.username))
    : all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ users: rows.slice(0, 30).map(adminUserRow), total: rows.length });
});

app.get('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  const u = db().users[req.params.id];
  if (!u || u.bot || u.deleted) return res.status(404).json({ error: 'Not found' });
  const mine = myServers(u.id), clips = clipList().filter((c) => c.owner === u.id);
  res.json({
    user: {
      ...adminUserRow(u), bio: u.bio || '', servers: mine.length,
      owned: mine.filter((s) => s.ownerId === u.id).map((s) => ({ id: s.id, name: s.name, members: humanCount(s) })),
      clips: clips.length, liveClips: clips.filter((c) => clipsLib.isLive(c, now())).length, bots: myBots(u.id).length,
      ownsOfficialServer: !!defaultServer() && defaultServer().ownerId === u.id,
      canModerate: u.id !== req.user.id && !isCreator(u) && (!adminRole(u) || isCreator(req.user)),
    },
    reports: adminReportRows(u.reports),
  });
});

// suspend = locked out everywhere right now, nothing is removed, and the username and email stay reserved (so it cannot just sign up again);
// unsuspend = they can sign in again
app.post('/api/admin/users/:id/suspend', auth, adminOnly, ah(async (req, res) => {
  const u = modTarget(req, res); if (!u) return;
  const reason = clip(req.body?.reason, 300).trim();
  u.suspended = { at: now(), by: req.user.id, reason };
  await revokeAllSessions(u);
  adminLogAdd(req.user, 'suspend', u.username, reason);
  res.json({ ok: true, user: adminUserRow(u) });
}));
app.post('/api/admin/users/:id/unsuspend', auth, adminOnly, (req, res) => {
  const u = modTarget(req, res); if (!u) return;
  delete u.suspended;
  store.save();
  adminLogAdd(req.user, 'unsuspend', u.username, '');
  res.json({ ok: true, user: adminUserRow(u) });
});

// Deleting an account turns the record into an empty shell with the same id ("Deleted user", no email, no keys, no password), so old messages, DMs and
// groups still point at something. Everything else of theirs goes: they are signed out everywhere; servers they own are deleted (the others they simply
// leave); friendships, bots, clips and uploaded pictures are removed; and with `purge` their channel messages too. Direct messages are end-to-end
// encrypted and belong to both people, so they stay. The username and email become free to register again (suspend keeps them reserved).
async function deleteAccount(u, { purge }) {
  const id = u.id, out = { servers: 0, serversDeleted: 0, messages: 0, clips: 0, bots: 0 };
  const avatar = u.avatarImage || null, banner = u.bannerImage || null;
  const passHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10); // nobody knows this password
  await revokeAllSessions(u);
  const shell = {
    id, username: 'deleted-' + crypto.randomBytes(4).toString('hex'), passHash, displayName: 'Deleted user', bio: '', avatarColor: '#8c6b4f', avatarEmoji: '',
    bannerColor: '#e3dccb', accentColor: '#2a251e', status: 'offline', publicKey: u.publicKey, tokenVersion: u.tokenVersion, createdAt: u.createdAt, deleted: { at: now() },
  };
  for (const k of Object.keys(u)) delete u[k];
  Object.assign(u, shell);
  if (db().artists && db().artists[id]) delete db().artists[id];
  emitUserUpdate(u); // servers and friends see "Deleted user" straight away (before the memberships below are removed)
  for (const s of myServers(id)) {
    out.servers++;
    if (s.ownerId === id) { destroyServer(s); out.serversDeleted++; continue; }
    s.members = s.members.filter((m) => m !== id);
    if (s.memberRoles) delete s.memberRoles[id];
    if (s.onboarded) delete s.onboarded[id];
    if (s.joinedAt) delete s.joinedAt[id];
    io.to('server:' + s.id).emit('server:update', serverView(s));
  }
  for (const [k, f] of Object.entries(db().friendships)) {
    if (f.from === id || f.to === id) { delete db().friendships[k]; notifyFriends(f.from, f.to); }
  }
  for (const b of myBots(id)) { removeEverywhere(b); guard.forget(b.id); delete db().bots[b.id]; out.bots++; }
  for (const c of clipList().filter((x) => x.owner === id)) {
    try { if (c.state === 'pending') refundClip(c); if (!c.purgedAt) await endClip(c, 'removed', 'Account removed'); out.clips++; } catch (e) { console.error('Could not remove a clip of a deleted account:', e.message); }
  }
  if (purge) {
    const mine = Object.values(db().messages).filter((m) => m.authorId === id);
    for (const m of mine) {
      delete db().messages[m.id];
      io.to('channel:' + m.channelId).emit('message:deleted', { kind: 'channel', messageId: m.id, channelId: m.channelId });
    }
    out.messages = mine.length;
    store.deleteFiles(mine.flatMap((m) => (m.attachments || []).map((a) => a.id).filter(Boolean))).catch((e) => console.error(e));
  }
  store.save();
  await store.flush();
  if (avatar) store.deleteImage(avatar).catch(() => {});
  if (banner) store.deleteImage(banner).catch(() => {});
  return out;
}
app.post('/api/admin/users/:id/delete', auth, adminOnly, ah(async (req, res) => {
  const u = modTarget(req, res); if (!u) return;
  if (String(req.body?.confirm || '').trim().toLowerCase() !== u.username.toLowerCase()) return res.status(400).json({ error: 'Type the username exactly to confirm' });
  const dflt = defaultServer();
  if (dflt && dflt.ownerId === u.id) return res.status(400).json({ error: 'This account owns the official Aduna server. Transfer it first.' });
  const name = u.username;
  const out = await deleteAccount(u, { purge: req.body?.purge !== false });
  adminLogAdd(req.user, 'delete account', name, `${out.serversDeleted} servers, ${out.messages} messages, ${out.clips} clips, ${out.bots} bots removed`);
  res.json({ ok: true, ...out });
}));

// servers: search by name / invite code / id, and delete one for good (the official server is protected)
app.get('/api/admin/servers', auth, adminOnly, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
  const rows = Object.values(db().servers).filter((s) => !q || String(s.name).toLowerCase().includes(q) || s.id === q || String(s.inviteCode).toLowerCase() === q)
    .sort((a, b) => humanCount(b) - humanCount(a)).slice(0, 30)
    .map((s) => ({ id: s.id, name: s.name, owner: db().users[s.ownerId]?.username || null, members: humanCount(s), visibility: s.visibility || null, reports: (s.reports || []).length, hold: s.listingHold || null }));
  res.json({ servers: rows });
});
app.post('/api/admin/servers/:id/delete', auth, adminOnly, (req, res) => {
  const s = db().servers[req.params.id];
  if (!s) return res.status(404).json({ error: 'Not found' });
  const dflt = defaultServer();
  if (dflt && dflt.id === s.id) return res.status(400).json({ error: 'The official Aduna server cannot be deleted here' });
  const owner = db().users[s.ownerId];
  if (owner && isCreator(owner) && !isCreator(req.user)) return res.status(403).json({ error: 'Only a creator can delete a server a creator owns' });
  const name = s.name;
  destroyServer(s);
  adminLogAdd(req.user, 'delete server', name, owner ? 'owner ' + owner.username : '');
  res.json({ ok: true });
});
// a reported channel message (its id is in the report): delete it
app.post('/api/admin/messages/:id/delete', auth, adminOnly, (req, res) => {
  const m = db().messages[req.params.id];
  if (!m) return res.status(404).json({ error: 'That message is already gone' });
  delete db().messages[m.id];
  store.save();
  store.deleteFiles((m.attachments || []).map((a) => a.id).filter(Boolean)).catch((e) => console.error(e));
  io.to('channel:' + m.channelId).emit('message:deleted', { kind: 'channel', messageId: m.id, channelId: m.channelId });
  adminLogAdd(req.user, 'delete message', db().users[m.authorId]?.username || m.authorId, '');
  res.json({ ok: true });
});

// admins: everyone who can open this page. Only a creator adds or removes (accounts listed in ADMIN_USERNAMES and creators cannot be removed here).
app.get('/api/admin/admins', auth, adminOnly, (req, res) => {
  const rows = Object.values(db().users).filter((u) => !u.bot && !u.deleted && adminRole(u))
    .map((u) => ({ ...adminUserRow(u), since: u.admin?.at || null, addedBy: db().users[u.admin?.by]?.username || null }))
    .sort((a, b) => a.username.localeCompare(b.username));
  res.json({ admins: rows, canManage: isCreator(req.user) });
});
app.post('/api/admin/admins', auth, adminOnly, needCreator, (req, res) => {
  const u = db().users[String(req.body?.userId || '')];
  if (!u || u.bot || u.deleted) return res.status(404).json({ error: 'Not found' });
  if (u.suspended) return res.status(400).json({ error: 'That account is suspended' });
  if (adminRole(u)) return res.status(400).json({ error: 'They are already an admin' });
  u.admin = { at: now(), by: req.user.id };
  store.save();
  adminLogAdd(req.user, 'add admin', u.username, '');
  res.json({ ok: true, admin: adminUserRow(u) });
});
app.delete('/api/admin/admins/:id', auth, adminOnly, needCreator, (req, res) => {
  const u = db().users[req.params.id];
  if (!u || !u.admin) return res.status(404).json({ error: 'That account was not made an admin on this page' });
  delete u.admin;
  store.save();
  adminLogAdd(req.user, 'remove admin', u.username, '');
  res.json({ ok: true });
});

app.get('/api/admin/log', auth, adminOnly, ah(async (_req, res) => {
  let list = [];
  try { list = JSON.parse((await store.getMeta('adminlog')) || '[]'); } catch { /* an unreadable log shows as empty */ }
  res.json({ log: list.slice(-100).reverse() });
}));

// ----- bots, part 3: bot accounts, installing a bot in a server, running it on events -----
// A bot gets ONE account (a user record with `bot: true`, username "bot-<hex>", which no person can register because of the dash). It has
// no password and no session: tokens for it are refused (userFromToken), it cannot be found by username for friend requests, DMs or the
// private-server list, and it is shown with a BOT tag. Installing puts that account in the server's member list and records
// s.installedBots = [{ botId, userId, by, at, channels: null | [channelId] }]. People who manage the server (Manage server) install and
// remove bots; a private bot can only be installed by its developer, a public one by anyone with that permission.
// Events: 'message' (a person posted in a text channel the bot may read) and 'memberJoin' (someone joined). Bots never receive events
// caused by bots, so two bots cannot loop. The sandbox collects what the bot wants to say; botrun.planActions() decides what is allowed
// and botrun.Guard keeps the limits (see botrun.js). Bot messages are marked `bot: true`, never earn credits, and never ping anyone
// except the person they answer.
// bothost.js runs events (one at a time per bot per server) and applies what a bot asked for; everything it needs is passed in here.
const fetcher = botfetch.createFetcher();
const emojiOk = (e) => typeof e === 'string' && (/^c:[0-9a-f]{16}$/.test(e) ? !!liveEmoji(e.slice(2)) : e.length > 0 && e.length <= 8 && !/^[\w$]+$/.test(e)); // the same rule as people's reactions
const botHost = createBotHost({ db, store, io: { to: (room) => io.to(room) }, sandbox, fetcher, postMessage: (s, channel, botUser, a) => postBotMessage(s, channel, botUser, a), emojiOk, maxMsg: MAX_MSG });
const guard = botHost.guard;
const installLimit = new security.RateWindow(30, 3600_000);
const botById = (id) => (/^[0-9a-f]{16}$/.test(String(id)) && Object.prototype.hasOwnProperty.call(db().bots, id) ? db().bots[id] : null);
const installOf = (s, botId) => (s.installedBots || []).find((i) => i.botId === botId);
const ownBotView = (b, uid) => ({ ...viewBot(b, uid), ...(b.ownerId === uid ? { pausedUntil: guard.pausedUntil(b.id) || null } : {}) });
const tellDeveloper = (b) => io.to('user:' + b.ownerId).emit('bot:update', ownBotView(b, b.ownerId));

function ensureBotUser(b) {
  const have = b.userId && db().users[b.userId];
  if (have) return have;
  const id = store.id();
  const hues = ['#8c6b4f', '#b4553d', '#5f7a55', '#a67c1f', '#4b6a88', '#7a5a7d', '#2a251e'];
  const u = {
    id, username: 'bot-' + id.slice(0, 12), displayName: b.name, bio: clip(b.description, 200), avatarColor: hues[parseInt(id.slice(0, 2), 16) % hues.length],
    avatarEmoji: '', avatarImage: b.avatarImage || null, bannerColor: '#e3dccb', accentColor: '#2a251e', status: 'online', publicKey: null, links: [], bot: true, botId: b.id, createdAt: now(),
  };
  db().users[id] = u; b.userId = id;
  return u;
}
// The bot's name and description show on its account; keep them in step with the bot record.
function syncBotUser(b) {
  const u = b.userId && db().users[b.userId];
  if (!u || (u.displayName === b.name && u.bio === clip(b.description, 200) && (u.avatarImage || null) === (b.avatarImage || null))) return;
  u.displayName = b.name; u.bio = clip(b.description, 200); u.avatarImage = b.avatarImage || null;
  emitUserUpdate(u);
}
// Takes the bot out of one server (the account stays on record so its old messages keep their name).
function removeInstall(s, inst) {
  s.members = s.members.filter((m) => m !== inst.userId);
  if (s.memberRoles) delete s.memberRoles[inst.userId];
  s.installedBots = (s.installedBots || []).filter((i) => i !== inst);
  const b = db().bots[inst.botId];
  if (b) b.installs = (b.installs || []).filter((id) => id !== s.id);
}
function removeEverywhere(b, keep = () => false) {
  for (const sid of [...(b.installs || [])]) {
    const s = db().servers[sid], inst = s && installOf(s, b.id);
    if (!inst) { b.installs = b.installs.filter((id) => id !== sid); continue; }
    if (keep(s)) continue;
    removeInstall(s, inst);
    io.to('server:' + s.id).emit('server:update', serverView(s));
  }
}
const runnable = (b) => !!b && !(b.listingHold && b.listingHold.state === 'removed');

const manageServerOf = (req, res) => {
  const s = db().servers[req.params.id];
  if (!s || !s.members.includes(req.user.id)) { res.status(404).json({ error: 'Not found' }); return null; }
  if (!can(s, req.user.id, 'manageServer')) { res.status(403).json({ error: 'You need the Manage server permission to do that' }); return null; }
  return s;
};
function cleanInstallChannels(s, v) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > 30) return false;
  const ok = new Set(s.channels.filter((c) => typeOf(c) === 'text').map((c) => c.id));
  const out = [...new Set(v.map(String))];
  return out.every((id) => ok.has(id)) ? out : false;
}

app.post('/api/servers/:id/bots', auth, (req, res) => {
  const s = manageServerOf(req, res); if (!s) return;
  const b = botById(req.body?.botId);
  const mine = b && b.ownerId === req.user.id;
  if (!b || (!mine && (b.visibility !== 'public' || b.listingHold))) return res.status(404).json({ error: 'Bot not found' });
  if (!runnable(b)) return res.status(400).json({ error: 'This bot was removed by moderators and cannot be added' });
  if (installOf(s, b.id)) return res.status(400).json({ error: 'That bot is already in this server' });
  if ((s.installedBots || []).length >= botrun.LIMITS.perServer) return res.status(400).json({ error: `A server can have up to ${botrun.LIMITS.perServer} bots` });
  const channels = cleanInstallChannels(s, req.body?.channels);
  if (channels === false) return res.status(400).json({ error: 'Pick text channels of this server' });
  if (!installLimit.allow(req.user.id)) return res.status(429).json({ error: 'You are adding bots too fast. Try again later.' });
  const u = ensureBotUser(b);
  syncBotUser(b);
  s.members.push(u.id);
  (s.installedBots = s.installedBots || []).push({ botId: b.id, userId: u.id, by: req.user.id, at: now(), channels });
  b.installs = [...new Set([...(b.installs || []), s.id])];
  store.save();
  io.to('server:' + s.id).emit('server:update', serverView(s));
  res.json({ server: serverView(s) });
  botHost.dispatchTo(s, installOf(s, b.id), 'install', { by: req.user }); // after the answer: the bot's first run never slows the install down
});
app.patch('/api/servers/:id/bots/:botId', auth, (req, res) => {
  const s = manageServerOf(req, res); if (!s) return;
  const inst = installOf(s, String(req.params.botId));
  if (!inst) return res.status(404).json({ error: 'That bot is not in this server' });
  const channels = cleanInstallChannels(s, req.body?.channels);
  if (channels === false) return res.status(400).json({ error: 'Pick text channels of this server' });
  inst.channels = channels;
  store.save();
  io.to('server:' + s.id).emit('server:update', serverView(s));
  res.json({ server: serverView(s) });
});
app.delete('/api/servers/:id/bots/:botId', auth, (req, res) => {
  const s = manageServerOf(req, res); if (!s) return;
  const inst = installOf(s, String(req.params.botId));
  if (!inst) return res.status(404).json({ error: 'That bot is not in this server' });
  removeInstall(s, inst);
  store.save();
  io.to('server:' + s.id).emit('server:update', serverView(s));
  res.json({ server: serverView(s) });
});

// ---- running ----
function postBotMessage(s, channel, botUser, { text, replyTo, mentions }) {
  const msg = {
    id: store.id(), channelId: channel.id, serverId: s.id, authorId: botUser.id, bot: true, content: text, attachments: [],
    mentions, everyone: false, replyTo, reactions: {}, createdAt: now(),
  };
  db().messages[msg.id] = msg;
  store.save();
  io.to('channel:' + channel.id).emit('message:new', msg);
  // a ping is a ping: the person's own settings for this server (mute, mentions only, ...) decide whether it alerts them
  const preview = clip(text.replace(MENTION_TOKEN, '@someone'), 120);
  for (const id of mentions) {
    if (!np.decide(uidPrefs(id, s.id), channel.id, 'mention', now()).alert) continue;
    pushSafe(id, 'mention', { title: botUser.displayName, body: `${s.name} \u00b7 #${channel.name} \u00b7 mentioned you\n${preview}`, url: `/app?n=c:${s.id}:${channel.id}`, tag: 'm:' + msg.id,
      sender: botUser.displayName, icon: imgPath(s.iconImage) || imgPath(botUser.avatarImage), theme: s.theme || undefined, serverId: s.id, channelId: channel.id, msgId: msg.id, read: true, reply: 'inline' });
  }
  return msg;
}
// Events from the rest of the server go to botHost.dispatch(server, event, details): 'message', 'messageEdit', 'memberJoin', 'memberLeave'
// ({ user, reason: 'left' | 'kicked' }); botHost.dispatchTo(server, install, 'install', { by }) tells one new bot it was added. Timers and
// fetch answers arrive on their own (botHost.startTimers() in start()).
const dispatchBots = (s, event, a) => botHost.dispatch(s, event, a);

app.get('/api/bots/:id/logs', auth, (req, res) => {
  const b = botById(req.params.id);
  if (!b || b.ownerId !== req.user.id) return res.status(404).json({ error: 'Bot not found' });
  res.json({ logs: guard.logs(b.id), pausedUntil: guard.pausedUntil(b.id) || null, limits: { eventsPerMin: botrun.LIMITS.eventsPerMin, messagesPerMin: botrun.LIMITS.messagesPerMin, cpuMsPerMin: botrun.LIMITS.cpuMsPerMin } });
});

// ----- server explorer: public servers only -----
// sort=popular (default): most members first; when searching, the best match comes first and members break ties.
// A tag that matches counts for the most, then the name, then the description, so tags boost a server in search.
const EXPLORE_PAGE = 24;
function matchScore(s, tokens) {
  const name = s.name.toLowerCase(), desc = (s.description || '').toLowerCase(), tags = s.tags || [];
  let total = 0;
  for (const t of tokens) {
    let sc = 0;
    if (tags.includes(t)) sc = 6;
    else if (tags.some((g) => g.includes(t))) sc = 4;
    if (name.startsWith(t)) sc = Math.max(sc, 5); else if (name.includes(t)) sc = Math.max(sc, 3);
    if (desc.includes(t)) sc = Math.max(sc, 1);
    if (!sc) return 0; // every word must match something
    total += sc;
  }
  return total;
}
app.get('/api/explore', auth, (req, res) => {
  const q = clip(req.query.q, 60).toLowerCase().replace(/^#/, '').trim();
  const tokens = q.split(/\s+/).filter(Boolean).slice(0, 6).map((t) => t.replace(/^#/, ''));
  const sort = ['popular', 'az', 'za'].includes(req.query.sort) ? req.query.sort : 'popular';
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  let list = Object.values(db().servers).filter((s) => s.visibility === 'public' && !s.listingHold && !listing.listingProblem(s, BLOCKED_WORDS)) // (content that predates the checks is kept out too)
    .map((s) => ({ s, score: tokens.length ? matchScore(s, tokens) : 1 })).filter((x) => x.score > 0);
  const byName = (a, b) => a.s.name.localeCompare(b.s.name, undefined, { sensitivity: 'base' });
  if (sort === 'az') list.sort(byName);
  else if (sort === 'za') list.sort((a, b) => byName(b, a));
  else list.sort((a, b) => b.score - a.score || humanCount(b.s) - humanCount(a.s) || byName(a, b));
  const page = list.slice(offset, offset + EXPLORE_PAGE).map(({ s }) => ({
    code: s.inviteCode, serverId: s.id, name: s.name, iconImage: s.iconImage || null, bannerImage: s.bannerImage || null,
    theme: s.theme || null, memberCount: humanCount(s), description: s.description || '', tags: s.tags || [], mine: s.ownerId === req.user.id,
  }));
  res.json({ servers: page, total: list.length, next: offset + EXPLORE_PAGE < list.length ? offset + EXPLORE_PAGE : null });
});

app.patch('/api/servers/:id', auth, (req, res) => {
  const s = ownedServer(req, res);
  if (!s) return;
  const b = req.body || {};
  let newCode = null; // checked before anything is changed so a taken code cannot leave half a save behind
  if (b.inviteCode !== undefined) {
    const code = cleanInvite(b.inviteCode);
    if (code !== s.inviteCode) {
      const problem = inviteProblem(code, s.id);
      if (problem) return res.status(problem === 'That code is already taken' ? 409 : 400).json({ error: problem });
      newCode = code;
    }
  }
  if (b.name !== undefined) {
    const name = clip(b.name, 40).trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    if (s.visibility === 'public') { const problem = listing.textProblem('name', name, BLOCKED_WORDS) || (listing.hasLink(name) ? 'A public server name cannot contain a link.' : null); if (problem) return res.status(400).json({ error: problem }); }
    s.name = name;
  }
  if (b.theme !== undefined) {
    const theme = cleanServerTheme(b.theme);
    if (theme === undefined) return res.status(400).json({ error: 'Invalid theme' });
    s.theme = theme;
  }
  if (b.tags !== undefined) {
    const tags = cleanTags(b.tags);
    if (typeof tags === 'string') return res.status(400).json({ error: tags });
    const bad = listing.textProblem('tags', tags, BLOCKED_WORDS);
    if (bad) return res.status(400).json({ error: bad });
    s.tags = tags;
  }
  if (newCode) s.inviteCode = newCode;
  store.save();
  res.json({ server: broadcastServer(s) });
});

async function setServerImage(s, field, buf) {
  const old = s[field];
  s[field] = buf ? await store.putImage(buf) : null;
  await store.flush(); // the server must point at the new image before the old one is deleted
  await store.deleteImage(old);
  return broadcastServer(s);
}

for (const [kind, rule] of Object.entries(SERVER_IMAGE_RULES)) {
  app.put(`/api/servers/:id/${kind}`, auth, uploadLimiter, rawImage, ah(async (req, res) => {
    const s = ownedServer(req, res);
    if (!s) return;
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Choose a PNG, JPEG or WebP image' });
    const info = sniffImage(buf);
    if (!info) return res.status(400).json({ error: 'That file is not a valid PNG, JPEG or WebP image' });
    if (info.width > rule.maxDim || info.height > rule.maxDim) return res.status(400).json({ error: `Image is too large (max ${rule.maxDim}px per side)` });
    res.json({ server: await setServerImage(s, rule.field, buf) });
  }));
  app.delete(`/api/servers/:id/${kind}`, auth, ah(async (req, res) => {
    const s = ownedServer(req, res);
    if (!s) return;
    res.json({ server: await setServerImage(s, rule.field, null) });
  }));
}

// ----- messages -----
function findChannel(channelId) {
  for (const s of Object.values(db().servers)) {
    const c = s.channels.find((x) => x.id === channelId);
    if (c) return { server: s, channel: c };
  }
  return null;
}

// ---------- server notification settings, read positions, persisted unread / @ counts ----------
// Rules live in notifprefs.js (and are tested there). Per person: user.serverPrefs[serverId] (mute, level, ...),
// user.reads[channelId] (when they last read it) and user.readsFloor (accounts that existed before this feature start at "all read").
const serverPrefsOf = (u, sid) => (u && u.serverPrefs && Object.prototype.hasOwnProperty.call(u.serverPrefs, sid) ? u.serverPrefs[sid] : undefined);
const uidPrefs = (uid, sid) => serverPrefsOf(db().users[uid], sid);

// { 'c:<channelId>': { unread, mentions } } for the given servers, non-zero entries only. One pass over the messages.
function noteCounts(u, servers) {
  const t = now(), info = new Map();
  for (const s of servers) {
    const sp = serverPrefsOf(u, s.id);
    for (const c of s.channels) info.set(c.id, { sp, pos: np.readPosition(u, c.id, s.joinedAt?.[u.id]), msgs: [] });
  }
  for (const m of Object.values(db().messages)) {
    const i = info.get(m.channelId);
    if (i && m.createdAt > i.pos) i.msgs.push(m);
  }
  const out = {};
  for (const [cid, i] of info) {
    if (!i.msgs.length) continue;
    const c = np.countChannel(i.sp, cid, i.msgs, i.pos, u.id, t);
    if (c.unread || c.mentions) out['c:' + cid] = c;
  }
  return out;
}

// Leaving or being removed: drop your settings and read positions for that server.
function forgetNotes(u, s) {
  if (!u) return;
  if (u.serverPrefs) delete u.serverPrefs[s.id];
  if (u.reads) for (const c of s.channels) delete u.reads[c.id];
}

// Housekeeping on the way in: forget settings for servers you left, channels that are gone, and mutes that ended.
function tidyNotes(u) {
  const mine = new Map(myServers(u.id).map((s) => [s.id, s]));
  const chans = new Set([...mine.values()].flatMap((s) => s.channels.map((c) => c.id)));
  let changed = false;
  if (!u.readsFloor) { u.readsFloor = now(); changed = true; }
  if (u.serverPrefs) {
    for (const sid of Object.keys(u.serverPrefs)) if (!mine.has(sid)) { delete u.serverPrefs[sid]; changed = true; }
    for (const [sid, sp] of Object.entries(u.serverPrefs)) { // a deleted channel's setting
      for (const cid of Object.keys(sp.channels || {})) if (!chans.has(cid)) { delete sp.channels[cid]; changed = true; }
    }
    if (np.prune(u.serverPrefs, now())) changed = true;
  }
  if (u.reads) for (const cid of Object.keys(u.reads)) if (!chans.has(cid)) { delete u.reads[cid]; changed = true; }
  if (changed) store.save();
  return mine;
}

app.get('/api/notif-state', auth, (req, res) => {
  const u = req.user, mine = tidyNotes(u);
  res.json({ prefs: u.serverPrefs || {}, counts: noteCounts(u, [...mine.values()]), now: now() });
});

app.put('/api/servers/:id/notifprefs', auth, (req, res) => {
  const s = db().servers[req.params.id];
  if (!s || !s.members.includes(req.user.id)) return res.status(404).json({ error: 'Not found' });
  const clean = np.cleanServerPrefs(req.body, s.channels.map((c) => c.id), now());
  if (!clean) return res.status(400).json({ error: 'Bad notification settings' });
  const u = req.user;
  if (!u.serverPrefs) u.serverPrefs = {};
  if (Object.keys(clean).length) u.serverPrefs[s.id] = clean; else delete u.serverPrefs[s.id];
  store.save();
  const body = { serverId: s.id, prefs: clean, counts: noteCounts(u, [s]) };
  io.to('user:' + u.id).emit('notif:prefs', body); // your other devices follow
  res.json(body);
});

function setRead(u, channelId, at) {
  if (!u.reads) u.reads = {};
  const prev = Object.prototype.hasOwnProperty.call(u.reads, channelId) ? u.reads[channelId] : 0;
  const to = Math.max(prev, Math.min(Number.isFinite(at) ? at : now(), now()));
  if (to === prev && Object.prototype.hasOwnProperty.call(u.reads, channelId)) return prev;
  u.reads[channelId] = to;
  return to;
}

app.post('/api/channels/:id/read', auth, (req, res) => {
  const f = findChannel(req.params.id);
  if (!f || !f.server.members.includes(req.user.id)) return res.status(404).json({ error: 'Not found' });
  const at = setRead(req.user, f.channel.id, Number(req.body?.at));
  store.save();
  io.to('user:' + req.user.id).emit('notif:read', { channelIds: [f.channel.id], at });
  res.json({ ok: true, at });
});

// Reply typed into a phone notification (client/public/sw.js): plain text only, in a text channel. Same rules as a normal send, minus things the
// service worker cannot provide (attachments, the typing proof for credits, per-socket flood control: this has its own limit instead).
const quickReplies = new security.RateWindow(10, 60_000);
app.post('/api/channels/:id/quick-reply', auth, (req, res) => {
  const f = findChannel(req.params.id);
  if (!f || !f.server.members.includes(req.user.id)) return res.status(404).json({ error: 'Not found' });
  if (typeOf(f.channel) !== 'text') return res.status(400).json({ error: 'You can only reply in a text channel' });
  const content = clip(req.body?.content, MAX_MSG).trim();
  if (!content) return res.status(400).json({ error: 'Nothing to send' });
  if (!quickReplies.allow(req.user.id)) return res.status(429).json({ error: 'Slow down' });
  const replyTo = typeof req.body?.replyTo === 'string' ? db().messages[req.body.replyTo] : null;
  const ping = parseMentions(content, f.server, req.user.id);
  const msg = {
    id: store.id(), channelId: f.channel.id, serverId: f.server.id, authorId: req.user.id, content, attachments: [],
    mentions: ping.mentions, everyone: ping.everyone,
    replyTo: replyTo && replyTo.channelId === f.channel.id ? replyTo.id : null,
    reactions: {}, createdAt: now(),
  };
  db().messages[msg.id] = msg;
  setRead(req.user, f.channel.id, now()); // answering it means you have seen it
  store.save();
  io.to('channel:' + f.channel.id).emit('message:new', msg);
  io.to('user:' + req.user.id).emit('notif:read', { channelIds: [f.channel.id], at: now() });
  pushChannelMessage(f, msg, 'text', req.user.id);
  res.json({ ok: true, id: msg.id });
  dispatchBots(f.server, 'message', { channel: f.channel, msg, author: req.user });
});

app.post('/api/servers/:id/read', auth, (req, res) => { // "Mark all as read"
  const s = db().servers[req.params.id];
  if (!s || !s.members.includes(req.user.id)) return res.status(404).json({ error: 'Not found' });
  const at = now();
  for (const c of s.channels) setRead(req.user, c.id, at);
  store.save();
  io.to('user:' + req.user.id).emit('notif:read', { channelIds: s.channels.map((c) => c.id), at });
  res.json({ ok: true, at });
});

app.get('/api/channels/:id/messages', auth, (req, res) => {
  const f = findChannel(req.params.id);
  if (!f || !f.server.members.includes(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  const list = Object.values(db().messages).filter((m) => m.channelId === f.channel.id).sort((a, b) => a.createdAt - b.createdAt).slice(-100);
  res.json({ messages: list });
});

// Pinned messages of a channel, newest pin first. A separate list because a pin can be older than the last 100 messages the history sends.
app.get('/api/channels/:id/pins', auth, (req, res) => {
  const f = findChannel(req.params.id);
  if (!f || !f.server.members.includes(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  const pins = Object.values(db().messages).filter((m) => m.channelId === f.channel.id && m.pinnedAt).sort((a, b) => b.pinnedAt - a.pinnedAt);
  res.json({ messages: pins });
});

app.get('/api/dms', auth, (req, res) => {
  const me = req.user.id;
  const latest = new Map();
  for (const m of Object.values(db().dms)) {
    if (m.from !== me && m.to !== me) continue;
    const other = m.from === me ? m.to : m.from;
    if (!latest.has(other) || latest.get(other).createdAt < m.createdAt) latest.set(other, m);
  }
  const convos = [...latest.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt)
    .map(([uid, last]) => ({ user: publicUser(db().users[uid]), last })).filter((c) => c.user.id);
  res.json({ conversations: convos });
});

app.get('/api/dms/:userId/messages', auth, (req, res) => {
  if (!db().users[req.params.userId]) return res.status(404).json({ error: 'Not found' });
  const key = convoKey(req.user.id, req.params.userId);
  const list = Object.values(db().dms).filter((m) => m.convo === key).sort((a, b) => a.createdAt - b.createdAt).slice(-100);
  res.json({ messages: list });
});

// Finished calls with this person (who called, voice or video, how it ended, how long): the client weaves them into the chat by time.
app.get('/api/dms/:userId/calls', auth, (req, res) => {
  if (!db().users[req.params.userId]) return res.status(404).json({ error: 'Not found' });
  res.json({ calls: calllog.forConvo(db().calllog, convoKey(req.user.id, req.params.userId)) });
});

// Only the people the caller can see anyway: themselves, friends (and pending requests) and people who share a server.
// (This used to list every account, which also handed out every user id.)
app.get('/api/presence', auth, (req, res) => {
  const out = {};
  for (const id of [req.user.id, ...relatedUserIds(req.user.id)]) { const u = db().users[id]; if (u) out[id] = presenceOf(u); }
  res.json({ presence: out });
});

// ICE (STUN/TURN) servers for calls. This must be registered before the /api 404 handler below.
const ice = createIce({ warn: (m) => console.warn(m) });
// `relay` tells the client whether a TURN server is set up, so it can explain a failed call instead of just hanging up.
app.get('/api/call/config', auth, ah(async (req, res) => {
  const { iceServers, relay } = await ice.forUser(req.user.id);
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers, relay });
}));
// Credits (balance, quests, buying). Must be registered before the /api 404 handler below.
credits.register(app, {
  auth, ah, db, save: () => store.save(),
  notify: (uid, payload) => io.to('user:' + uid).emit('credits:update', payload),
  isDev: (u) => !!u.developer || isCreator(u), // may use the Halloween / Christmas test mode
  isCreator: (u) => isCreator(u),              // sees every badge in the shop, with its shop state
  userChanged: (u) => emitUserUpdate(u),       // an event badge was earned
});
// ----- push notifications (installed mobile app / browsers while Aduna is closed) -----
// Keys are generated once and kept in the database (see db.js). The service worker (client/public/sw.js) shows the notification.
let vapidReady = false;
const fcm = createFcm({ raw: process.env.FCM_SERVICE_ACCOUNT }); // Android app (Firebase). Off unless FCM_SERVICE_ACCOUNT is set.
const push = createPush({
  users: () => db().users,
  onError: (e) => console.error('push send failed:', e && e.statusCode, String((e && (e.body || e.message)) || e).slice(0, 200)),
  save: () => store.save(),
  get enabled() { return !!store.vapid && process.env.PUSH !== 'off'; },
  get publicKey() { return store.vapid?.publicKey; },
  sender: (sub, body, opts) => {
    if (sub.fcm) return fcm.send(sub.fcm, body, { ...opts, callUi: !!sub.callUi }); // an Android app device
    if (!vapidReady) {
      webpush.setVapidDetails(process.env.VAPID_SUBJECT || (/^https:/.test(process.env.PUBLIC_URL || '') ? process.env.PUBLIC_URL : 'https://aduna.onrender.com'), store.vapid.publicKey, store.vapid.privateKey);
      vapidReady = true;
    }
    return webpush.sendNotification(sub, body, opts);
  },
});
const pushSafe = (uid, kind, payload) => { push.send(uid, kind, payload).catch((e) => console.error('push failed:', e.message)); };
const cancelRing = (uid, callId) => { push.cancelCall(uid, callId).catch((e) => console.error('call cancel push failed:', e.message)); };
// The Decline button on a phone's ringing screen works with the app closed, so it cannot be signed in: it carries this signature instead,
// made for one call and one person, which only the server can produce.
const declineTokenFor = (callId, uid) => crypto.createHmac('sha256', String(SECRET)).update(`call-decline:${callId}:${uid}`).digest('hex').slice(0, 32);

app.get('/api/push/key', auth, (_req, res) => res.json({ enabled: push.enabled, publicKey: push.publicKey, fcm: fcm.enabled }));
app.post('/api/push/subscribe', auth, (req, res) => {
  if (!push.enabled) return res.status(503).json({ error: 'Push notifications are off on this server' });
  if (!push.add(req.user, req.body?.subscription, req.headers['user-agent'])) return res.status(400).json({ error: 'Bad subscription' });
  res.json({ ok: true });
});
// The Android app registers its Firebase token here (Web Push is not available inside an Android WebView).
app.post('/api/push/fcm', auth, (req, res) => {
  if (!push.enabled || !fcm.enabled) return res.status(503).json({ error: 'Android push is not set up on this server' });
  if (!push.addFcm(req.user, req.body?.token, req.headers['user-agent'], { callUi: req.body?.callUi === true })) return res.status(400).json({ error: 'Bad token' });
  res.json({ ok: true });
});
// The Decline button on the Android ringing screen. Not signed in (the app may be closed), so it is proved by the signature the server put
// in the push for this call and this person. Declining is all it can do.
app.post('/api/call/decline-push', (req, res) => {
  const callId = String(req.body?.callId || ''), tok = String(req.body?.token || '');
  const c = calls.get(callId);
  if (!c || c.state !== 'ringing') return res.json({ ok: true }); // already over: nothing to do
  const want = Buffer.from(declineTokenFor(c.id, c.b)), got = Buffer.from(tok);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return res.status(403).json({ error: 'Not allowed' });
  io.to('user:' + c.b).emit('call:handled', { callId: c.id }); // stop ringing on the person's other devices
  endCall(c, 'declined');
  res.json({ ok: true });
});
const pushTestAt = new Map(); // user id -> last test time (a test is one request per 5 s)
app.post('/api/push/test', auth, async (req, res) => {
  const t = Date.now();
  if (t - (pushTestAt.get(req.user.id) || 0) < 5000) return res.status(429).json({ error: 'Wait a few seconds between tests' });
  pushTestAt.set(req.user.id, t);
  try { res.json(await push.test(req.user.id)); } catch (e) { res.status(500).json({ error: 'Test failed' }); }
});
app.post('/api/push/unsubscribe', auth, (req, res) => {
  if (typeof req.body?.endpoint === 'string') push.remove(req.user, req.body.endpoint);
  res.json({ ok: true });
});
// Which kinds of notification this account gets (on every device).
app.put('/api/me/notifications', auth, (req, res) => {
  req.user.notifPrefs = cleanPrefs(req.body, req.user.notifPrefs);
  store.save();
  res.json({ notifPrefs: req.user.notifPrefs });
});
// "Playing ..." on the profile (server/activity.js). PUT { name, source: 'auto' | 'manual' } sets or refreshes the game; { name: null, source } clears it.
// The desktop app reports a detected game ('auto') about once a minute; Settings > Activity types one ('manual'). While the person has
// "Show what I'm playing" off, nothing is stored or shown and this answers { activity: null, off: true }.
const activityHits = new security.RateWindow(60, 60_000); // changes and refreshes per person per minute
app.put('/api/me/activity', auth, (req, res) => {
  const u = req.user;
  if (u.showActivity === false) return res.json({ activity: null, off: true });
  if (!activityHits.allow(u.id)) return res.status(429).json({ error: 'Too many changes. Try again in a minute.' });
  const source = req.body?.source;
  if (req.body?.name === null || req.body?.name === '') { // clear: the desktop app may only clear what it reported itself
    if (source !== undefined && source !== 'auto' && source !== 'manual') return res.status(400).json({ error: 'Unknown source' });
    if (activityLib.clear(activities, u.id, source)) emitUserUpdate(u);
    return res.json({ activity: activityOf(u) });
  }
  const r = activityLib.set(activities, u.id, req.body?.name, source, now(), BLOCKED_WORDS);
  if (r.error) return res.status(r.wait ? 429 : 400).json({ error: r.error });
  if (r.changed) emitUserUpdate(u);
  res.json({ activity: activityOf(u) });
});
// Encrypted group chats and group calls (server/groups.js). Must be registered before the /api 404 handler below.
const groups = groupsLib.create({
  get io() { return io; }, store, db, now, ah, auth, publicUser, areFriends, pushSafe, isOnline,
  imgPath: (id) => imgPath(id),
});
groups.register(app);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// JSON errors instead of Express's default HTML page (oversized uploads, malformed JSON, ...)
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: req.path.startsWith('/api/emoji') ? 'Emoji is too large (max 256 KB)' : 'File is too large (max 20 MB, or 1 MB for profile pictures)' });
  if (err.code === 'STORAGE_FULL') return res.status(507).json({ error: 'Uploads are paused: the storage limit has been reached. Try again later.' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: 'Bad request' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ----- static client -----
const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  // "/" is the public home page; the app itself lives at /app (and any other path falls through to it).
  const landing = path.join(dist, 'landing.html');
  if (fs.existsSync(landing)) app.get('/', (_req, res) => res.sendFile(landing));
  // /admin is for admins only: anyone else (signed out, or signed in without the role) goes to the home page before any of the page loads.
  // The page checks again through /api/admin/me, and every admin route refuses non-admins on its own.
  app.get(/^\/admin\/?$/, (req, res, next) => {
    const me = userFromToken(security.readSessionCookie(req.headers, secureReq(req)));
    if (!isAdmin(me) || needsVerify(me)) return res.redirect(302, '/');
    res.set('Cache-Control', 'no-store');
    next();
  });
  // Windows installer. By default it is served from this site (client/public/updates/). If DOWNLOAD_BASE_URL is set (the public
  // address of a separate, public Cloudflare R2 bucket), /download and the auto-update feed point there instead, so the
  // 80 MB file never touches this server. The file name always comes from updates/latest.yml, so the link never goes stale.
  const DL_BASE = String(process.env.DOWNLOAD_BASE_URL || '').trim().replace(/\/+$/, '');
  const readFeed = () => { try { return fs.readFileSync(path.join(dist, 'updates', 'latest.yml'), 'utf8'); } catch { return null; } };
  app.get('/download', (_req, res) => res.sendFile(path.join(dist, 'download.html'))); // instructions page; it starts the download
  app.get('/download/file', (_req, res) => {
    const file = ((readFeed() || '').match(/^path:\s*(\S+)\s*$/m) || [])[1];
    if (file && /^[\w.\-]+\.exe$/.test(file) && (DL_BASE || fs.existsSync(path.join(dist, 'updates', file)))) return res.redirect(302, (DL_BASE ? DL_BASE + '/' : '/updates/') + file);
    res.redirect(302, '/app');
  });
  // Android app (Aduna.apk). Put the built APK in client/public/updates/ (or in the DOWNLOAD_BASE_URL bucket) under this exact name.
  app.get('/download/android', (_req, res) => {
    if (DL_BASE || fs.existsSync(path.join(dist, 'updates', 'Aduna.apk'))) return res.redirect(302, (DL_BASE ? DL_BASE + '/' : '/updates/') + 'Aduna.apk');
    res.redirect(302, '/app');
  });
  // The desktop app's update feed. With DOWNLOAD_BASE_URL set, the file addresses inside it are rewritten to point at R2.
  app.get('/updates/latest.yml', (_req, res) => {
    let yml = readFeed();
    if (yml === null) return res.status(404).type('text/plain').send('No update available');
    if (DL_BASE) yml = yml.replace(/^(\s*-\s*url:\s*)(?!https?:\/\/)(\S+)\s*$/gm, (_m, pre, f) => pre + DL_BASE + '/' + f);
    res.set('Cache-Control', 'no-cache').type('text/yaml').send(yml);
  });
  app.get(/^\/updates\/[\w.-]+\.apk$/i, (req, res) => { // the APK, with its real type; a missing one is a 404, never the app's home page
    const f = path.join(dist, 'updates', path.basename(req.path));
    if (!fs.existsSync(f)) return res.status(404).type('text/plain').send('Not found');
    res.set('Cache-Control', 'no-cache').type('application/vnd.android.package-archive').sendFile(f);
  });
  app.use(express.static(dist, { index: false }));
  app.use('/updates', (_req, res) => res.status(404).type('text/plain').send('Not found')); // anything else under /updates that is not a file
  app.get(/^\/(?!api|socket\.io).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ---------- sockets ----------
const httpServer = http.createServer(app);
// A browser always sends Origin on a WebSocket handshake: another site cannot open a connection with the visitor's cookie.
const io = new Server(httpServer, { cors: { origin: false }, allowRequest: (req, cb) => cb(null, security.originAllowed(req.headers.origin, String(req.headers.host || '').toLowerCase())) });

const userSockets = (uid) => [...io.sockets.sockets.values()].filter((s) => s.data.uid === uid);

function joinRooms(uid) {
  for (const sock of userSockets(uid)) {
    sock.join('user:' + uid);
    for (const s of myServers(uid)) {
      sock.join('server:' + s.id);
      s.channels.forEach((c) => sock.join('channel:' + c.id));
    }
  }
}

// ----- who hears about whom -----
// Presence and profile changes go to the person's audience only: themselves, their friends (pending requests count), and everyone who
// shares a server with them. They used to go to every connected user.
const presenceOf = (u) => (u.bot ? 'online' : isOnline(u.id) && u.status !== 'invisible' ? u.status : 'offline'); // a bot is always there (while it is installed)
function relatedUserIds(uid) {
  const out = new Set();
  for (const f of Object.values(db().friendships)) { if (f.from === uid) out.add(f.to); else if (f.to === uid) out.add(f.from); }
  for (const sv of myServers(uid)) for (const m of sv.members) out.add(m);
  for (const m of groups.memberIdsOf(uid)) out.add(m); // people in a group chat with you see your presence and profile changes
  out.delete(uid);
  return out;
}
function toAudience(uid) { // a socket.io broadcast operator for that audience (a socket in several of the rooms still gets one copy)
  let b = io.to('user:' + uid);
  for (const sv of myServers(uid)) b = b.to('server:' + sv.id);
  for (const id of relatedUserIds(uid)) b = b.to('user:' + id);
  return b;
}
function broadcastPresence(uid) {
  const u = db().users[uid];
  if (!u) return;
  toAudience(uid).emit('presence', { userId: uid, status: presenceOf(u) });
}
// The audience sees the public profile (Invisible shows as offline); the person's own devices get the real status.
function emitUserUpdate(u) {
  toAudience(u.id).except('user:' + u.id).emit('user:update', publicUser(u));
  io.to('user:' + u.id).emit('user:update', { ...selfView(u), ownedBadges: ownedBadgeViews(u), ownedFrames: ownedFrameViews(u), showActivity: u.showActivity !== false }); // their own devices also learn which badges they own and wear, and whether their game is shown
}
// Two people just became able to see each other (friend request, joining a server): each learns the other's current presence.
function introduce(a, b) {
  const ua = db().users[a], ub = db().users[b];
  if (!ua || !ub || a === b) return;
  io.to('user:' + a).emit('presence', { userId: b, status: presenceOf(ub) });
  io.to('user:' + b).emit('presence', { userId: a, status: presenceOf(ua) });
}

io.use((socket, next) => {
  const u = userFromToken(socket.handshake.auth?.token || security.readSessionCookie(socket.handshake.headers, security.isSecure(socket.handshake.headers, socket.handshake.secure, TRUST_PROXY)));
  if (!u) return next(new Error('unauthorized'));
  if (needsVerify(u)) return next(new Error('unverified'));
  socket.data.uid = u.id;
  next();
});

// ----- calls (1:1 voice / video in DMs) -----
// The server only rings, tracks who is on a call and relays signalling. Media flows directly between
// the two browsers (WebRTC, encrypted with DTLS-SRTP). The signalling itself (SDP and ICE) is
// encrypted in the browser with the conversation key, so the server cannot read or alter it.
const RING_MS = Number(process.env.CALL_RING_MS) || 45_000;
const calls = new Map(); // callId -> { id, a (caller), b (callee), video, state: 'ringing' | 'active', startedAt, answeredAt, timer }
const callOf = (uid) => [...calls.values()].find((c) => c.a === uid || c.b === uid);
function endCall(c, reason) {
  if (!calls.delete(c.id)) return;
  clearTimeout(c.timer);
  if (c.state === 'ringing') cancelRing(c.b, c.id); // a phone still showing the ringing screen takes it down
  io.to('user:' + c.a).to('user:' + c.b).emit('call:ended', { callId: c.id, reason });
  logCall(c, reason);
}

// Call history (see calllog.js). Kept as a record next to the DMs, because DM text is end-to-end encrypted and the server cannot add a line to it.
// Holds only who, voice or video, when, how it ended and how long. A failure here must never break ending the call itself.
function logCall(c, reason) {
  try {
    const convo = convoKey(c.a, c.b);
    const rec = calllog.makeRecord(c, reason, convo, now());
    db().calllog[rec.id] = rec;
    for (const id of calllog.overflow(db().calllog, convo)) delete db().calllog[id];
    store.save();
    io.to('user:' + c.a).to('user:' + c.b).emit('call:log', rec);
  } catch (e) { console.error('call log failed:', e); }
}

// ----- voice channels -----
// Everyone in the channel connects to everyone else (a mesh, fine for small groups). The server only keeps
// the list of who is in each channel and relays signalling between two members; audio goes browser to browser.
const MAX_VOICE = 8;
const voice = new Map(); // channelId -> Map(userId -> socketId)
const voiceUsers = (cid) => [...(voice.get(cid)?.keys() || [])];
const voiceBroadcast = (cid) => { const f = findChannel(cid); if (f) io.to('server:' + f.server.id).emit('voice:state', { channelId: cid, users: voiceUsers(cid) }); };
function voiceLeave(uid, sid) {
  for (const [cid, room] of voice) {
    if (room.get(uid) !== sid) continue;
    room.delete(uid);
    if (!room.size) voice.delete(cid);
    for (const peer of room.values()) io.to(peer).emit('voice:left', { channelId: cid, userId: uid });
    voiceBroadcast(cid);
  }
}

// Phone / closed-app notifications: only for things aimed at someone (a mention, @everyone, an announcement), never every chat line.
// The notification shows who wrote (title), the server picture, where it was and what was said (body), and Reply / Mark as read buttons
// (client/public/sw.js). `reply: 'inline'` lets the phone answer without opening the app (POST /api/channels/:id/quick-reply).
const imgPath = (id) => (id ? `/api/images/${id}` : undefined);
function pushChannelMessage(f, msg, kind, uid) {
  const author = db().users[uid];
  const preview = clip(msg.content.replace(MENTION_TOKEN, '@someone'), 120) || 'Sent an attachment';
  const url = `/app?n=c:${f.server.id}:${f.channel.id}`;
  const who = author?.displayName || 'Someone';
  const where = `${f.server.name} \u00b7 #${f.channel.name}`;
  const sent = new Set([uid]);
  const look = {
    sender: who, icon: imgPath(f.server.iconImage) || imgPath(author?.avatarImage), theme: f.server.theme || undefined,
    serverId: f.server.id, channelId: f.channel.id, msgId: msg.id, read: true,
    reply: typeOf(f.channel) === 'announcements' ? undefined : 'inline',
  };
  // Each person's own settings for this server decide whether it may alert them (mute, mentions only, @everyone off, ...).
  const to = (id, k, how, what) => {
    if (sent.has(id) || !f.server.members.includes(id)) return;
    if (!np.decide(uidPrefs(id, f.server.id), f.channel.id, how, now()).alert) return;
    sent.add(id); pushSafe(id, k, { title: who, body: `${where}${what}\n${preview}`, url, tag: 'm:' + msg.id, ...look });
  };
  for (const id of msg.mentions || []) to(id, 'mention', 'mention', ' \u00b7 mentioned you');
  if (msg.everyone) for (const id of f.server.members) to(id, 'mention', 'everyone', ' \u00b7 @everyone');
  if (kind === 'announcements') for (const id of f.server.members) to(id, 'announcement', 'announcement', ' \u00b7 announcement');
}

io.on('connection', (socket) => {
  // A bug (or a hostile payload) in one event handler must never take the whole server down: Socket.IO does not catch exceptions
  // thrown inside handlers, and an uncaught one ends the Node process for everybody. Wrap every handler registered below.
  const rawOn = socket.on.bind(socket);
  socket.on = (event, fn) => rawOn(event, (...args) => {
    const fail = (e) => {
      console.error('socket handler failed:', event, e && e.message);
      const ack = args[args.length - 1];
      if (typeof ack === 'function') { try { ack({ error: 'Server error' }); } catch {} }
    };
    try { const r = fn(...args); if (r && typeof r.catch === 'function') r.catch(fail); } catch (e) { fail(e); }
  });
  const uid = socket.data.uid;
  online.set(uid, (online.get(uid) || 0) + 1);
  joinRooms(uid);
  broadcastPresence(uid);
  // a call that is still ringing is shown again if this device connects (or reconnects) after it started
  const ringing = [...calls.values()].find((c) => c.b === uid && c.state === 'ringing');
  if (ringing) socket.emit('call:incoming', { callId: ringing.id, from: ringing.a, video: ringing.video });

  // everyone sees who is in which voice channel
  for (const [cid] of voice) { const f = findChannel(cid); if (f && f.server.members.includes(uid)) socket.emit('voice:state', { channelId: cid, users: voiceUsers(cid) }); }

  // flood control: 8 events / 5s
  let bucket = [];
  const allowed = () => {
    const t = now();
    bucket = bucket.filter((x) => t - x < 5000);
    if (bucket.length >= 8) return false;
    bucket.push(t);
    return true;
  };

  // Checks attachments on a channel message. File ids must be uploads by this user for this channel
  // that no message uses yet; GIFs must come from the GIF host. Returns null if anything is wrong.
  const buildAttachments = async (list, who, scope) => {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.length > MAX_ATTACH) return null;
    const out = [], used = new Set();
    for (const a of list) {
      if (a?.gif) {
        if (!isGifUrl(a.url) || !dim(a.w) || !dim(a.h)) return null;
        out.push({ gif: true, url: a.url, w: a.w, h: a.h, title: clip(a.title, 80) });
        continue;
      }
      const meta = typeof a?.id === 'string' && !used.has(a.id) && await store.fileMeta(a.id);
      if (!meta || meta.owner !== who || meta.scope !== scope || meta.attached) return null;
      used.add(a.id);
      out.push({ id: a.id, name: clip(a.name, 120) || 'file', size: meta.size, type: INLINE_TYPES.has(a.type) ? a.type : 'application/octet-stream', w: dim(a.w), h: dim(a.h) });
    }
    return out;
  };

  const validReply = (collection, replyTo, check) => {
    if (!replyTo) return null;
    const m = collection[replyTo];
    return m && check(m) ? replyTo : null;
  };

  groups.attachSocket(socket, { uid, allowed, validReply, busy: () => !!callOf(uid) }); // group:send, gcall:*, group:typing

  socket.on('message:send', async (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!allowed()) return reply({ error: 'Slow down' });
    const content = clip(p?.content, MAX_MSG).trim();
    const f = findChannel(p?.channelId);
    if (!f || !f.server.members.includes(uid)) return reply({ error: 'Cannot send' });
    const kind = typeOf(f.channel);
    if (kind === 'voice' || kind === 'rules') return reply({ error: 'You cannot send messages in this channel' });
    if (kind === 'announcements' && !can(f.server, uid, 'postAnnouncements')) return reply({ error: 'You do not have permission to post announcements' });
    let atts;
    try { atts = await buildAttachments(p.attachments, uid, 'channel:' + f.channel.id); } catch (e) { console.error(e); return reply({ error: 'Cannot send' }); }
    if (atts === null) return reply({ error: 'Bad attachment' });
    let poll; // optional poll on this message (text and announcement channels), see polls.js
    if (p.poll !== undefined && p.poll !== null) {
      if (kind !== 'text' && kind !== 'announcements') return reply({ error: 'Polls can only be posted in text and announcement channels' });
      const made = polls.cleanPoll(p.poll, now());
      if (made.error) return reply({ error: made.error });
      poll = made.poll;
    }
    if (!content && !atts.length && !poll) return reply({ error: 'Cannot send' });
    try { await store.markAttached(atts.map((a) => a.id).filter(Boolean)); } catch (e) { console.error(e); return reply({ error: 'Cannot send' }); }
    const ping = parseMentions(content, f.server, uid);
    const msg = {
      id: store.id(), channelId: f.channel.id, serverId: f.server.id, authorId: uid, content, attachments: atts,
      mentions: ping.mentions, everyone: ping.everyone, ...(poll ? { poll } : {}),
      replyTo: validReply(db().messages, p.replyTo, (m) => m.channelId === f.channel.id),
      reactions: {}, createdAt: now(),
    };
    db().messages[msg.id] = msg;
    // Credits for real, typed, different messages (see credits.js). Checked before this message counts as "someone spoke".
    const earned = credits.rewardMessage({ user: db().users[uid], content, proof: p.typing, server: f.server, channel: f.channel, humans: humanCount(f.server) });
    credits.noteChannelMessage(f.channel.id, uid);
    store.save();
    if (earned.ok) io.to('user:' + uid).emit('credits:update', { balance: earned.balance, delta: earned.amount, reason: 'message' });
    io.to('channel:' + f.channel.id).emit('message:new', msg);
    // Announcements notify everyone in the server, whichever channel they are looking at.
    if (kind === 'announcements') io.to('server:' + f.server.id).emit('announcement:new', { serverId: f.server.id, channelId: f.channel.id, messageId: msg.id, authorId: uid });
    pushChannelMessage(f, msg, kind, uid);
    reply({ ok: true });
    if (kind === 'text') dispatchBots(f.server, 'message', { channel: f.channel, msg, author: db().users[uid] }); // after the ack: bots never slow a send down
  });

  // DMs: server only ever sees ciphertext + iv
  socket.on('dm:send', async (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!allowed()) return reply({ error: 'Slow down' });
    const to = db().users[p?.to];
    if (!to || to.id === uid) return reply({ error: 'Cannot send' });
    if (!areFriends(uid, to.id)) return reply({ error: 'You can only message friends' });
    if (!to.publicKey) return reply({ error: 'They have not set up encryption yet' });
    if (typeof p.ciphertext !== 'string' || typeof p.iv !== 'string' || !p.ciphertext || p.ciphertext.length > MAX_CIPHER || p.iv.length > 64)
      return reply({ error: 'Bad payload' });
    const key = convoKey(uid, to.id);
    let files = [];
    if (p.files !== undefined) {
      if (!Array.isArray(p.files) || p.files.length > MAX_ATTACH || new Set(p.files).size !== p.files.length) return reply({ error: 'Bad attachment' });
      try {
        for (const fid of p.files) {
          const meta = typeof fid === 'string' && await store.fileMeta(fid);
          if (!meta || meta.owner !== uid || meta.scope !== 'dm:' + key || meta.attached) return reply({ error: 'Bad attachment' });
        }
        files = p.files;
        await store.markAttached(files);
      } catch (e) { console.error(e); return reply({ error: 'Cannot send' }); }
    }
    const msg = {
      id: store.id(), convo: key, from: uid, to: to.id, ciphertext: p.ciphertext, iv: p.iv, files,
      replyTo: validReply(db().dms, p.replyTo, (m) => m.convo === key),
      reactions: {}, createdAt: now(),
    };
    db().dms[msg.id] = msg;
    // The server cannot read an end-to-end encrypted DM, so the browser says whether it said "Trick or Treat" or carried a GIF.
    // That only counts towards an event quest after the checks in events.js (friends, 5 different people, account age, event open).
    if (p.quest === 'trick' || p.quest === 'gif') credits.events.noteDm(db().users[uid], to, p.quest, { dev: !!db().users[uid].developer || isCreator(db().users[uid]), minAgeMs: credits.EARN.minAccountAgeMs });
    store.save();
    io.to('user:' + uid).to('user:' + to.id).emit('dm:new', msg);
    // end-to-end encrypted: the server cannot read it, so the notification only says who wrote
    pushSafe(to.id, 'dm', { title: db().users[uid]?.displayName || 'Someone', body: 'Sent you a message', url: `/app?n=d:${uid}`, tag: 'm:' + msg.id,
      sender: db().users[uid]?.displayName, icon: imgPath(db().users[uid]?.avatarImage), peerId: uid, msgId: msg.id, reply: 'open', read: true });
    reply({ ok: true });
  });

  socket.on('reaction:toggle', (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!allowed()) return reply({ error: 'Slow down' });
    const custom = /^c:[0-9a-f]{16}$/.test(String(p?.emoji));
    const emoji = custom ? p.emoji : clip(p?.emoji, 8);
    if (!emoji || (!custom && /^[\w$]+$/.test(emoji)) || (custom && !liveEmoji(emoji.slice(2)))) return reply({ error: 'Bad emoji' }); // plain ASCII words are never emoji (and would hit Object.prototype names)
    let msg, rooms;
    if (p.kind === 'channel') {
      msg = db().messages[p.messageId];
      const f = msg && findChannel(msg.channelId);
      if (!f || !f.server.members.includes(uid)) return reply({ error: 'Forbidden' });
      rooms = ['channel:' + msg.channelId];
    } else if (p.kind === 'group') {
      const t = groups.actions.reactionTarget(uid, p.messageId);
      if (t.error) return reply({ error: t.error });
      msg = t.msg; rooms = t.rooms;
    } else if (p.kind === 'dm') {
      msg = db().dms[p.messageId];
      if (!msg || (msg.from !== uid && msg.to !== uid)) return reply({ error: 'Forbidden' });
      rooms = ['user:' + msg.from, 'user:' + msg.to];
    } else return reply({ error: 'Bad kind' });

    const list = Object.prototype.hasOwnProperty.call(msg.reactions, emoji) ? msg.reactions[emoji] : (msg.reactions[emoji] = []);
    const i = list.indexOf(uid);
    if (i >= 0) list.splice(i, 1); else list.push(uid);
    const added = i < 0;
    if (!list.length) delete msg.reactions[emoji];
    if (Object.keys(msg.reactions).length > 20) { list.splice(list.indexOf(uid), 1); if (!list.length) delete msg.reactions[emoji]; return reply({ error: 'Too many reactions' }); }
    if (added && !db().users[msg.authorId]?.bot) credits.noteReaction(db().users[uid], msg.id, msg.authorId || msg.from); // counts towards the daily react quest
    if (added && !db().users[msg.authorId]?.bot) { const me = db().users[uid]; credits.events.noteReaction(me, emoji, msg.id, msg.authorId || msg.from, { dev: !!me.developer || isCreator(me), minAgeMs: credits.EARN.minAccountAgeMs }); } // Pumpkin patch / Holiday cheer
    store.save();
    let target = io;
    rooms.forEach((r) => { target = target.to(r); });
    target.emit('reaction:update', { kind: p.kind, messageId: msg.id, reactions: msg.reactions });
    reply({ ok: true });
  });

  // ----- edit / delete (author only; server owners may also delete channel messages) -----
  socket.on('message:edit', (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!allowed()) return reply({ error: 'Slow down' });
    if (p?.kind === 'channel') {
      const msg = db().messages[p.messageId];
      const f = msg && findChannel(msg.channelId);
      if (!f || !f.server.members.includes(uid) || msg.authorId !== uid) return reply({ error: 'Forbidden' });
      const content = clip(p.content, MAX_MSG).trim();
      if (!content && !msg.attachments?.length && !msg.poll) return reply({ error: 'Message cannot be empty' });
      msg.content = content;
      Object.assign(msg, parseMentions(content, f.server, uid)); // an edit refreshes the highlight but never pings again
      msg.editedAt = now();
      store.save();
      io.to('channel:' + msg.channelId).emit('message:edited', { kind: 'channel', message: msg });
      reply({ ok: true });
      if (typeOf(f.channel) === 'text') dispatchBots(f.server, 'messageEdit', { channel: f.channel, msg, author: db().users[uid] });
      return;
    }
    if (p?.kind === 'group') return reply(groups.actions.edit(uid, p));
    if (p?.kind === 'dm') {
      const msg = db().dms[p.messageId];
      if (!msg || msg.from !== uid) return reply({ error: 'Forbidden' });
      if (typeof p.ciphertext !== 'string' || typeof p.iv !== 'string' || !p.ciphertext || p.ciphertext.length > MAX_CIPHER || p.iv.length > 64)
        return reply({ error: 'Bad payload' });
      msg.ciphertext = p.ciphertext;
      msg.iv = p.iv;
      msg.editedAt = now();
      store.save();
      io.to('user:' + msg.from).to('user:' + msg.to).emit('message:edited', { kind: 'dm', message: msg });
      return reply({ ok: true });
    }
    reply({ error: 'Bad kind' });
  });

  // ----- polls (see polls.js) -----
  // Vote: `options` is the full list of option ids you choose now (empty = take your vote back). Everyone in the channel gets the new tallies.
  const pollOf = (id) => {
    const msg = typeof id === 'string' ? db().messages[id] : null;
    const f = msg && msg.poll && findChannel(msg.channelId);
    return f && f.server.members.includes(uid) ? { msg, f } : null;
  };
  socket.on('poll:vote', (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!allowed()) return reply({ error: 'Slow down' });
    const hit = pollOf(p?.messageId);
    if (!hit) return reply({ error: 'Forbidden' });
    const r = polls.castVote(hit.msg.poll, uid, p.options, now());
    if (r.error) return reply({ error: r.error });
    store.save();
    io.to('channel:' + hit.msg.channelId).emit('poll:update', { channelId: hit.msg.channelId, messageId: hit.msg.id, poll: hit.msg.poll });
    reply({ ok: true });
  });
  // End a poll early: whoever posted it, or anyone who may manage messages in the server.
  socket.on('poll:close', (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!allowed()) return reply({ error: 'Slow down' });
    const hit = pollOf(p?.messageId);
    if (!hit || (hit.msg.authorId !== uid && !can(hit.f.server, uid, 'manageMessages'))) return reply({ error: 'Forbidden' });
    const r = polls.closePoll(hit.msg.poll, uid, now());
    if (r.error) return reply({ error: r.error });
    store.save();
    io.to('channel:' + hit.msg.channelId).emit('poll:update', { channelId: hit.msg.channelId, messageId: hit.msg.id, poll: hit.msg.poll });
    reply({ ok: true });
  });

  // Pin / unpin a channel message (whoever may manage messages in the server). Everyone in the channel gets the change as an edit.
  // DMs are end-to-end encrypted, so there are no pins there.
  socket.on('message:pin', (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!allowed()) return reply({ error: 'Slow down' });
    const msg = typeof p?.messageId === 'string' ? db().messages[p.messageId] : null;
    const f = msg && findChannel(msg.channelId);
    if (!f || !f.server.members.includes(uid) || !can(f.server, uid, 'manageMessages')) return reply({ error: 'Forbidden' });
    if (p.pinned === true) {
      if (msg.pinnedAt) return reply({ ok: true });
      const count = Object.values(db().messages).filter((m) => m.channelId === msg.channelId && m.pinnedAt).length;
      if (count >= MAX_PINS) return reply({ error: `A channel can have up to ${MAX_PINS} pinned messages. Unpin one first.` });
      msg.pinnedAt = now(); msg.pinnedBy = uid;
    } else {
      if (!msg.pinnedAt) return reply({ ok: true });
      msg.pinnedAt = null; msg.pinnedBy = null; // null (not deleted) so the clients' merge of the edit clears it
    }
    store.save();
    io.to('channel:' + msg.channelId).emit('message:edited', { kind: 'channel', message: msg });
    reply({ ok: true });
  });

  socket.on('message:delete', async (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!allowed()) return reply({ error: 'Slow down' });
    if (p?.kind === 'channel') {
      const msg = db().messages[p.messageId];
      const f = msg && findChannel(msg.channelId);
      if (!f || !f.server.members.includes(uid)) return reply({ error: 'Forbidden' });
      if (msg.authorId !== uid && !can(f.server, uid, 'manageMessages')) return reply({ error: 'Forbidden' });
      delete db().messages[msg.id];
      store.save();
      store.deleteFiles((msg.attachments || []).map((a) => a.id).filter(Boolean)).catch((e) => console.error(e));
      io.to('channel:' + msg.channelId).emit('message:deleted', { kind: 'channel', messageId: msg.id, channelId: msg.channelId });
      return reply({ ok: true });
    }
    if (p?.kind === 'group') return reply(groups.actions.delete(uid, p));
    if (p?.kind === 'dm') {
      const msg = db().dms[p.messageId];
      if (!msg || msg.from !== uid) return reply({ error: 'Forbidden' });
      delete db().dms[msg.id];
      store.save();
      store.deleteFiles(msg.files).catch((e) => console.error(e));
      io.to('user:' + msg.from).to('user:' + msg.to).emit('message:deleted', { kind: 'dm', messageId: msg.id, convo: msg.convo, from: msg.from, to: msg.to });
      return reply({ ok: true });
    }
    reply({ error: 'Bad kind' });
  });

  // ----- calls -----
  let sigBucket = [];
  const sigAllowed = () => { // ICE candidates arrive in bursts, so signalling has its own, larger budget
    const t = now();
    sigBucket = sigBucket.filter((x) => t - x < 5000);
    if (sigBucket.length >= 80) return false;
    sigBucket.push(t);
    return true;
  };
  const myCall = (callId) => { const c = calls.get(String(callId)); return c && (c.a === uid || c.b === uid) ? c : null; };

  socket.on('call:invite', (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!allowed()) return reply({ error: 'Slow down' });
    const to = db().users[p?.to];
    if (!to || to.id === uid || !areFriends(uid, to.id)) return reply({ error: 'You can only call friends' });
    if (callOf(uid) || groups.callOfUser(uid)) return reply({ error: 'You are already on a call' });
    // someone with the app closed can still be rung through a push notification (the ring is shown when they open it)
    if (!isOnline(to.id) && !(push.enabled && to.pushSubs?.length && push.prefsOf(to).calls && to.status !== 'dnd')) return reply({ error: `${to.displayName} is offline` });
    if (callOf(to.id) || groups.callOfUser(to.id)) return reply({ error: `${to.displayName} is on another call` });
    const c = { id: store.id(), a: uid, b: to.id, video: !!p.video, state: 'ringing', startedAt: now(), answeredAt: null };
    c.timer = setTimeout(() => { if (c.state === 'ringing') endCall(c, 'missed'); }, RING_MS);
    calls.set(c.id, c);
    io.to('user:' + to.id).emit('call:incoming', { callId: c.id, from: uid, video: c.video });
    pushSafe(to.id, 'call', { title: `${db().users[uid]?.displayName || 'Someone'} is calling`, body: `Incoming ${c.video ? 'video' : 'voice'} call`, url: `/app?n=d:${uid}`, tag: 'call', sender: db().users[uid]?.displayName, icon: imgPath(db().users[uid]?.avatarImage), callId: c.id, video: c.video, declineToken: declineTokenFor(c.id, to.id) });
    reply({ ok: true, callId: c.id });
  });

  socket.on('call:accept', (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const c = myCall(p?.callId);
    if (!c || c.b !== uid || c.state !== 'ringing') return reply({ error: 'This call has ended' });
    c.state = 'active';
    c.answeredAt = now();
    clearTimeout(c.timer);
    socket.to('user:' + uid).emit('call:handled', { callId: c.id }); // stop ringing on the callee's other devices
    cancelRing(uid, c.id); // ...including a phone that is showing the ringing screen
    io.to('user:' + c.a).emit('call:accepted', { callId: c.id });
    reply({ ok: true });
  });

  // decline while ringing, cancel (caller), or hang up
  const finish = (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const c = myCall(p?.callId);
    if (!c) return reply({ ok: true });
    if (c.state === 'ringing') {
      if (c.b === uid) socket.to('user:' + uid).emit('call:handled', { callId: c.id });
      endCall(c, uid === c.a ? 'cancelled' : 'declined');
    } else endCall(c, 'hangup');
    reply({ ok: true });
  };
  socket.on('call:decline', finish);
  socket.on('call:hangup', finish);

  socket.on('call:signal', (p) => {
    const c = myCall(p?.callId);
    const d = p?.data;
    if (!c || c.state !== 'active' || !sigAllowed()) return;
    if (!d || typeof d.ciphertext !== 'string' || typeof d.iv !== 'string' || d.ciphertext.length > 20000 || d.iv.length > 64) return;
    io.to('user:' + (uid === c.a ? c.b : c.a)).emit('call:signal', { callId: c.id, data: { ciphertext: d.ciphertext, iv: d.iv } });
  });

  socket.on('typing', (p) => {
    if (p?.channelId) {
      const f = findChannel(p.channelId);
      if (f && f.server.members.includes(uid)) socket.to('channel:' + f.channel.id).emit('typing', { channelId: f.channel.id, userId: uid });
    } else if (p?.to && areFriends(uid, p.to)) {
      io.to('user:' + p.to).emit('typing', { dmWith: uid, userId: uid });
    }
  });

  socket.on('voice:join', (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const f = findChannel(p?.channelId);
    if (!f || !f.server.members.includes(uid) || typeOf(f.channel) !== 'voice') return reply({ error: 'Cannot join' });
    const cid = f.channel.id;
    voiceLeave(uid, socket.id);
    for (const [other, room] of voice) if (other !== cid && room.has(uid)) { // one voice channel at a time, even across tabs
      const old = room.get(uid); room.delete(uid); if (!room.size) voice.delete(other);
      io.to(old).emit('voice:kicked', { channelId: other });
      for (const peer of room.values()) io.to(peer).emit('voice:left', { channelId: other, userId: uid });
      voiceBroadcast(other);
    }
    const room = voice.get(cid) || new Map();
    if (!room.has(uid) && room.size >= MAX_VOICE) return reply({ error: `This channel is full (${MAX_VOICE} people)` });
    const peers = [...room.keys()].filter((x) => x !== uid);
    const prev = room.get(uid);
    if (prev && prev !== socket.id) io.to(prev).emit('voice:kicked', { channelId: cid }); // joined from another tab: move here
    room.set(uid, socket.id);
    voice.set(cid, room);
    voiceBroadcast(cid);
    reply({ ok: true, peers }); // the joiner starts a connection to each of these
  });
  socket.on('voice:leave', () => voiceLeave(uid, socket.id));
  socket.on('voice:signal', (p) => {
    const room = voice.get(p?.channelId);
    const target = room && room.get(uid) === socket.id && room.get(p.to);
    if (!target || p.to === uid) return;
    const d = p.data;
    if (!d || typeof d !== 'object' || JSON.stringify(d).length > 20000) return;
    io.to(target).emit('voice:signal', { channelId: p.channelId, from: uid, data: d });
  });

  socket.on('disconnect', () => {
    voiceLeave(uid, socket.id);
    const n = (online.get(uid) || 1) - 1;
    if (n <= 0) {
      online.delete(uid);
      const c = callOf(uid);
      // A call that is still ringing for this user survives a reload or a short network drop: it is shown
      // again when they reconnect (see the connection handler) and otherwise ends by the ring timeout.
      if (c && !(c.state === 'ringing' && c.b === uid)) endCall(c, 'dropped');
    } else online.set(uid, n);
    broadcastPresence(uid);
  });
});

// Connect to Postgres, load the data, then start serving. `ready` resolves once that is done.
async function start() {
  await store.init();
  SECRET = store.jwtSecret;
  await loadLimits();
  store.closeHooks.add(saveLimits);
  await store.pruneImages(referencedImages());   // drop images no profile or emoji points at (left over from a crash mid-upload)
  await store.pruneFiles(referencedFiles());
  await runCleanup(); // also clear out anything that expired while the server was off
  setInterval(runCleanup, 3600_000).unref();
  const clipSweep = async () => { try { await sweepClips(); } catch (e) { console.error('Clip sweep failed:', e.message); } };
  await clipSweep(); // clips that expired while the server was off
  setInterval(clipSweep, 600_000).unref();
  if (process.env.NODE_ENV !== 'test') botHost.startTimers(); // due bot timers are looked for every few seconds (tests call botHost.tick() themselves)
}
const ready = start();

if (require.main === module) {
  ready
    .then(() => httpServer.listen(PORT, () => console.log(`Aduna running on port ${PORT}`)))
    .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
}

module.exports = { httpServer, app, io, expireOldAttachments, sweepClips, ready, loginGuard, store, botHost, fetcher, referencedImages }; // loginGuard, store, referencedImages, sweepClips: for the tests


/* HANDOFF: see HANDOFF.md in the project root for what this server does, what is done, and what is left. */
