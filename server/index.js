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
const security = require('./security');
const mailer = require('./mailer');
const webpush = require('web-push');
const { createPush, cleanPrefs } = require('./push');

const PORT = process.env.PORT || 3000;
const MAX_MSG = 2000;
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
  ...Object.values(store.db.servers).flatMap((sv) => [sv.iconImage, sv.bannerImage]), // server icon + banner
  ...Object.values(store.db.emojis).map((e) => e.imageId), // custom emoji pictures live in the same table
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

function publicUser(u) {
  return {
    id: u.id,
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
    status: u.status,
    publicKey: u.publicKey,
    createdAt: u.createdAt,
  };
}

// What the signed-in person gets about themselves: the public profile plus their private email.
// Never use this for anything other people receive (user:update events, member lists, other people's profiles).
const ownUser = (u) => ({ ...publicUser(u), email: u.email || null, emailVerified: !needsVerify(u), codeSent: !!(u.verify && u.verify.expires > now()), notifPrefs: cleanPrefs(u.notifPrefs) });

// ---------- email verification ----------
// On when RESEND_API_KEY is set. New accounts (and accounts that change their email) get a 6-digit code by email and
// are locked out of everything except the verification endpoints until they enter it. That includes accounts created
// before verification existed (no `emailVerified` flag): they are asked at their next sign-in, and those with no email
// on file are asked to add one. Only a hash of the code is stored.
const CODE_TTL_MS = 15 * 60_000, CODE_COOLDOWN_MS = 60_000, CODE_MAX_TRIES = 5;
const needsVerify = (u) => mailer.enabled() && u.emailVerified !== true;
const codeHash = (uid, code) => crypto.createHash('sha256').update(uid + ':' + code).digest('hex');
const resends = new security.RateWindow(5, 3600_000); // emails per account per hour
async function issueCode(u) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  u.verify = { hash: codeHash(u.id, code), expires: now() + CODE_TTL_MS, tries: 0, sentAt: now() };
  store.save();
  await mailer.sendVerificationCode(u.email, code, u.username);
}
const emailTaken = (email, exceptId) => {
  const key = security.emailKey(email);
  return Object.values(db().users).some((x) => x.id !== exceptId && x.email && security.emailKey(x.email) === key);
};

const convoKey = (a, b) => [a, b].sort().join(':');
const signToken = (u) => jwt.sign({ uid: u.id }, SECRET, { expiresIn: '30d' });

function userFromToken(token) {
  try {
    const { uid } = jwt.verify(token, SECRET);
    return db().users[uid] || null;
  } catch { return null; }
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
if (process.env.TRUST_PROXY !== '0') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(security.securityHeaders()); // CSP, clickjacking, nosniff, referrer, permissions, HSTS over HTTPS (see security.js)
app.get('/healthz', (_req, res) => res.type('text').send('ok')); // for Render's health check
// Stripe signs the exact bytes it sends, so the credits webhook keeps the raw body next to the parsed one.
app.use(express.json({ limit: '64kb', verify: (req, _res, buf) => { if (req.originalUrl === '/api/credits/webhook') req.rawBody = buf; } }));

// API answers can hold private data (balances, email): browsers and proxies must not keep them.
// Images and files set their own caching below, which overrides this.
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// naive per-IP rate limit for auth endpoints
const hits = new Map();
function authLimiter(req, res, next) {
  const k = req.ip;
  const t = now();
  const arr = (hits.get(k) || []).filter((x) => t - x < 60_000);
  if (arr.length >= 20) return res.status(429).json({ error: 'Too many attempts, try again in a minute' });
  arr.push(t);
  hits.set(k, arr);
  next();
}

function authAny(req, res, next) { // signed in, verified or not: only for the email-verification routes
  const h = req.headers.authorization || '';
  const u = userFromToken(h.replace(/^Bearer /, ''));
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

const validKeyBlob = (b) => b && typeof b === 'object' && ['salt', 'iv', 'data'].every((k) => typeof b[k] === 'string' && b[k].length < 4000);

function defaultServer() {
  const code = String(process.env.DEFAULT_SERVER_INVITE ?? 'aduna').trim().toLowerCase();
  if (!code || code === 'off') return null;
  const all = Object.values(db().servers);
  return all.find((x) => x.inviteCode === code) || all.find((x) => String(x.name).trim().toLowerCase() === 'aduna') || null;
}

const signups = new security.RateWindow(posNum(process.env.SIGNUPS_PER_HOUR, 10), 3600_000); // new accounts per address per hour
const loginGuard = new security.LoginGuard();
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
  const taken = Object.values(db().users).some((u) => u.username.toLowerCase() === username.toLowerCase());
  if (taken) return res.status(409).json({ error: 'Username already taken' });
  if (emailTaken(email)) return res.status(409).json({ error: 'An account with this email already exists' });
  if (!signups.allow(req.ip)) return res.status(429).json({ error: 'Too many accounts were created from this connection. Try again later.' });

  const hues = ['#8c6b4f', '#b4553d', '#5f7a55', '#a67c1f', '#4b6a88', '#7a5a7d', '#2a251e'];
  const user = {
    id: store.id(),
    username,
    passHash: bcrypt.hashSync(password, 10),
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
    createdAt: now(),
  };
  db().users[user.id] = user;

  if (!needsVerify(user)) joinDefaultServer(user);
  store.save();
  if (needsVerify(user)) {
    try { await issueCode(user); } catch (e) { console.error('verification email failed:', e.message); } // they can press "resend"
  }
  res.json({ token: signToken(user), user: ownUser(user) });
});

// Everyone starts in the official Aduna server. It is found by invite code (DEFAULT_SERVER_INVITE, default "aduna"),
// else by the name "Aduna". Set DEFAULT_SERVER_INVITE=off to disable. Unverified accounts join once they verify.
function joinDefaultServer(user) {
  const dflt = defaultServer();
  if (dflt && !dflt.members.includes(user.id)) {
    dflt.members.push(user.id);
    io.to('server:' + dflt.id).emit('server:update', serverView(dflt));
  }
}

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
  u.emailVerified = true;
  delete u.verify;
  joinDefaultServer(u);
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

app.post('/api/login', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const name = String(username || '');
  const lock = loginGuard.check(name, req.ip);
  if (lock.blocked) {
    res.set('Retry-After', String(lock.retryAfterSec));
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(lock.retryAfterSec / 60)} minute${lock.retryAfterSec > 90 ? 's' : ''}.` });
  }
  const user = Object.values(db().users).find((u) => u.username.toLowerCase() === name.toLowerCase());
  const ok = bcrypt.compareSync(String(password || ''), user ? user.passHash : DUMMY_HASH); // always one comparison: no timing hint about which names exist
  if (!user || !ok) { loginGuard.fail(name, req.ip); return res.status(401).json({ error: 'Invalid username or password' }); }
  loginGuard.success(name, req.ip);
  res.json({ token: signToken(user), user: ownUser(user), encPrivKey: user.encPrivKey });
});

app.get('/api/me', authAny, (req, res) => res.json({ user: ownUser(req.user), encPrivKey: req.user.encPrivKey }));

app.put('/api/me/keys', auth, (req, res) => {
  const { publicKey, encPrivKey } = req.body || {};
  if (req.user.publicKey || req.user.encPrivKey) return res.status(409).json({ error: 'Keys already set' });
  if (typeof publicKey !== 'string' || publicKey.length > 2000 || !validKeyBlob(encPrivKey)) return res.status(400).json({ error: 'Bad keys' });
  req.user.publicKey = publicKey;
  req.user.encPrivKey = encPrivKey;
  store.save();
  const view = publicUser(req.user);
  io.emit('user:update', view);
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
  let newUsername;
  if (b.username !== undefined && String(b.username).trim() !== u.username) {
    newUsername = String(b.username).trim().replace(/^@/, '');
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(newUsername)) return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores' });
    const wait = (u.usernameChangedAt || 0) + USERNAME_COOLDOWN_MS - now();
    if (wait > 0) {
      const when = new Date(u.usernameChangedAt + USERNAME_COOLDOWN_MS).toISOString();
      return res.status(429).json({ error: 'You can only change your username once every 7 days', availableAt: when });
    }
    const taken = Object.values(db().users).some((x) => x.id !== u.id && x.username.toLowerCase() === newUsername.toLowerCase());
    if (taken) return res.status(409).json({ error: 'Username already taken' });
  }

  let newEmail;
  if (b.email !== undefined && String(b.email).trim().toLowerCase() !== (u.email || '')) {
    newEmail = security.cleanEmail(b.email); // an account that has an email cannot clear it
    if (!newEmail) return res.status(400).json({ error: 'Enter a valid email address' });
    if (emailTaken(newEmail, u.id)) return res.status(409).json({ error: 'An account with this email already exists' });
  }

  if (newEmail) { u.email = newEmail; if (mailer.enabled()) u.emailVerified = false; } // a new address must be verified again
  if (newUsername !== undefined) {
    // Someone who never picked a display name keeps showing their username.
    if (u.displayName === u.username && (b.displayName === undefined || b.displayName === u.displayName)) { u.displayName = newUsername; delete b.displayName; }
    u.username = newUsername;
    u.usernameChangedAt = now();
  }
  if (newLinks !== undefined) u.links = newLinks;
  if (b.avatarLogo !== undefined) u.avatarLogo = !!b.avatarLogo;
  if (b.displayName !== undefined) u.displayName = clip(b.displayName, 32).trim() || u.username;
  if (b.bio !== undefined) u.bio = clip(b.bio, 190);
  if (b.avatarEmoji !== undefined) u.avatarEmoji = clip(b.avatarEmoji, 8);
  for (const k of ['avatarColor', 'bannerColor', 'accentColor']) if (b[k] !== undefined && hex.test(b[k])) u[k] = b[k];
  if (b.status !== undefined && ['online', 'idle', 'dnd', 'invisible'].includes(b.status)) u.status = b.status;
  store.save();
  const view = publicUser(u);
  io.emit('user:update', view);
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
  const view = publicUser(u);
  io.emit('user:update', view);
  return view;
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
  return null;
}
function canReadScope(uid, scope) {
  const [kind, rest] = String(scope).split(/:(.*)/s);
  if (kind === 'channel') { const f = findChannel(rest); return !!f && f.server.members.includes(uid); }
  if (kind === 'dm') return rest.split(':').includes(uid);
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
  res.json({ user: publicUser(u) });
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
  const target = Object.values(db().users).find((u) => u.username.toLowerCase() === name);
  if (!target) return res.status(404).json({ error: "We couldn't find anyone with that username" });
  if (target.id === me.id) return res.status(400).json({ error: "You can't add yourself" });

  const f = friendship(me.id, target.id);
  if (f?.status === 'friends') return res.status(400).json({ error: `You're already friends with ${target.displayName}` });
  if (f && f.from === me.id) return res.status(400).json({ error: 'You already sent them a request' });
  if (f) { // they already asked you: that's a yes
    f.status = 'friends';
    store.save();
    notifyFriends(me.id, target.id);
    return res.json({ result: 'friends', user: publicUser(target) });
  }
  const pendingOut = Object.values(db().friendships).filter((x) => x.from === me.id && x.status === 'pending').length;
  if (pendingOut >= 50) return res.status(400).json({ error: 'Too many pending requests' });
  db().friendships[convoKey(me.id, target.id)] = { from: me.id, to: target.id, status: 'pending', createdAt: now() };
  store.save();
  notifyFriends(me.id, target.id);
  pushSafe(target.id, 'friend', { title: me.displayName, body: 'sent you a friend request', url: '/app?n=f', tag: 'friend:' + me.id });
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
    store.save();
    joinRooms(req.user.id);
    io.to('server:' + s.id).emit('server:update', serverView(s));
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
  const target = Object.values(db().users).find((u) => u.username.toLowerCase() === name);
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
  if (uid === s.ownerId) return res.status(400).json({ error: 'The owner cannot be kicked' });
  if (uid === req.user.id) return res.status(400).json({ error: 'Use Leave server to leave' });
  if (req.user.id !== s.ownerId && rankOf(s, uid) <= rankOf(s, req.user.id)) return res.status(403).json({ error: 'That member is at or above your own role' });
  s.members = s.members.filter((m) => m !== uid);
  if (s.memberRoles) delete s.memberRoles[uid];
  s.allowed = (s.allowed || []).filter((id) => id !== uid); // a kicked member of a private server must be added again to return
  store.save();
  for (const sock of userSockets(uid)) {
    voiceLeave(uid, sock.id);
    sock.emit('server:removed', { serverId: s.id });
    sock.leave('server:' + s.id); s.channels.forEach((c) => sock.leave('channel:' + c.id));
  }
  pushServer(s, res);
});

app.post('/api/servers/:id/leave', auth, (req, res) => {
  const s = db().servers[req.params.id];
  if (!s || !s.members.includes(req.user.id)) return res.status(404).json({ error: 'Not found' });
  s.members = s.members.filter((m) => m !== req.user.id);
  if (s.memberRoles) delete s.memberRoles[req.user.id];
  if (s.ownerId === req.user.id) {
    if (s.members.length) s.ownerId = s.members[0];
    else { delete db().servers[s.id]; store.deleteImage(s.iconImage).catch(() => {}); store.deleteImage(s.bannerImage).catch(() => {}); }
  }
  store.save();
  for (const sock of userSockets(req.user.id)) { sock.leave('server:' + s.id); s.channels.forEach((c) => sock.leave('channel:' + c.id)); }
  if (db().servers[s.id]) io.to('server:' + s.id).emit('server:update', serverView(s));
  res.json({ ok: true });
});

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
  const me = userFromToken((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!me) return authLimiter(req, res, () => sendInvite(req, res, null));
  sendInvite(req, res, me);
});
function sendInvite(req, res, me) {
  const s = Object.values(db().servers).find((x) => x.inviteCode === cleanInvite(req.params.code));
  if (!s) return res.status(404).json({ error: 'This invite is no longer valid' });
  if (!(me && s.members.includes(me.id)) && !canJoin(s, me?.id)) return res.status(403).json({ error: 'This server is private. Ask the owner to add you.' });
  res.json({ invite: { code: s.inviteCode, serverId: s.id, name: s.name, iconImage: s.iconImage || null, bannerImage: s.bannerImage || null, theme: s.theme || null, memberCount: s.members.length } });
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
  let list = Object.values(db().servers).filter((s) => s.visibility === 'public').map((s) => ({ s, score: tokens.length ? matchScore(s, tokens) : 1 })).filter((x) => x.score > 0);
  const byName = (a, b) => a.s.name.localeCompare(b.s.name, undefined, { sensitivity: 'base' });
  if (sort === 'az') list.sort(byName);
  else if (sort === 'za') list.sort((a, b) => byName(b, a));
  else list.sort((a, b) => b.score - a.score || b.s.members.length - a.s.members.length || byName(a, b));
  const page = list.slice(offset, offset + EXPLORE_PAGE).map(({ s }) => ({
    code: s.inviteCode, serverId: s.id, name: s.name, iconImage: s.iconImage || null, bannerImage: s.bannerImage || null,
    theme: s.theme || null, memberCount: s.members.length, description: s.description || '', tags: s.tags || [],
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

app.get('/api/channels/:id/messages', auth, (req, res) => {
  const f = findChannel(req.params.id);
  if (!f || !f.server.members.includes(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  const list = Object.values(db().messages).filter((m) => m.channelId === f.channel.id).sort((a, b) => a.createdAt - b.createdAt).slice(-100);
  res.json({ messages: list });
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

app.get('/api/presence', auth, (req, res) => {
  const out = {};
  for (const u of Object.values(db().users)) out[u.id] = isOnline(u.id) && u.status !== 'invisible' ? u.status : 'offline';
  res.json({ presence: out });
});

// ICE (STUN/TURN) servers for calls. This must be registered before the /api 404 handler below.
app.get('/api/call/config', auth, (_req, res) => res.json({ iceServers: iceServers() }));
// Credits (balance, quests, buying). Must be registered before the /api 404 handler below.
credits.register(app, {
  auth, ah, db, save: () => store.save(),
  notify: (uid, payload) => io.to('user:' + uid).emit('credits:update', payload),
});
// ----- push notifications (installed mobile app / browsers while Aduna is closed) -----
// Keys are generated once and kept in the database (see db.js). The service worker (client/public/sw.js) shows the notification.
let vapidReady = false;
const push = createPush({
  users: () => db().users,
  save: () => store.save(),
  get enabled() { return !!store.vapid && process.env.PUSH !== 'off'; },
  get publicKey() { return store.vapid?.publicKey; },
  sender: (sub, body, opts) => {
    if (!vapidReady) {
      webpush.setVapidDetails(process.env.VAPID_SUBJECT || (/^https:/.test(process.env.PUBLIC_URL || '') ? process.env.PUBLIC_URL : 'https://aduna.onrender.com'), store.vapid.publicKey, store.vapid.privateKey);
      vapidReady = true;
    }
    return webpush.sendNotification(sub, body, opts);
  },
});
const pushSafe = (uid, kind, payload) => { push.send(uid, kind, payload).catch((e) => console.error('push failed:', e.message)); };

app.get('/api/push/key', auth, (_req, res) => res.json({ enabled: push.enabled, publicKey: push.publicKey }));
app.post('/api/push/subscribe', auth, (req, res) => {
  if (!push.enabled) return res.status(503).json({ error: 'Push notifications are off on this server' });
  if (!push.add(req.user, req.body?.subscription, req.headers['user-agent'])) return res.status(400).json({ error: 'Bad subscription' });
  res.json({ ok: true });
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
  // The desktop app's update feed. With DOWNLOAD_BASE_URL set, the file addresses inside it are rewritten to point at R2.
  app.get('/updates/latest.yml', (_req, res) => {
    let yml = readFeed();
    if (yml === null) return res.status(404).type('text/plain').send('No update available');
    if (DL_BASE) yml = yml.replace(/^(\s*-\s*url:\s*)(?!https?:\/\/)(\S+)\s*$/gm, (_m, pre, f) => pre + DL_BASE + '/' + f);
    res.set('Cache-Control', 'no-cache').type('text/yaml').send(yml);
  });
  app.use(express.static(dist, { index: false }));
  app.get(/^\/(?!api|socket\.io).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ---------- sockets ----------
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: false } });

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

function broadcastPresence(uid) {
  const u = db().users[uid];
  if (!u) return;
  io.emit('presence', { userId: uid, status: isOnline(uid) && u.status !== 'invisible' ? u.status : 'offline' });
}

io.use((socket, next) => {
  const u = userFromToken(socket.handshake.auth?.token);
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
const calls = new Map(); // callId -> { id, a (caller), b (callee), video, state: 'ringing' | 'active', timer }
const callOf = (uid) => [...calls.values()].find((c) => c.a === uid || c.b === uid);
function endCall(c, reason) {
  if (!calls.delete(c.id)) return;
  clearTimeout(c.timer);
  io.to('user:' + c.a).to('user:' + c.b).emit('call:ended', { callId: c.id, reason });
}
function iceServers() {
  try { const v = JSON.parse(process.env.ICE_SERVERS || ''); if (Array.isArray(v)) return v; } catch {}
  return [{ urls: 'stun:stun.l.google.com:19302' }];
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

io.on('connection', (socket) => {
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

  // Phone / closed-app notifications: only for things aimed at someone (a mention, @everyone, an announcement), never every chat line.
  const pushChannelMessage = (f, msg, kind) => {
    const author = db().users[uid];
    const preview = clip(msg.content.replace(MENTION_TOKEN, '@someone'), 120) || 'Sent an attachment';
    const url = `/app?n=c:${f.server.id}:${f.channel.id}`;
    const who = author?.displayName || 'Someone';
    const where = `${f.server.name} \u00b7 #${f.channel.name}`;
    const sent = new Set([uid]);
    const to = (id, k, title, body) => { if (sent.has(id) || !f.server.members.includes(id)) return; sent.add(id); pushSafe(id, k, { title, body, url, tag: 'm:' + msg.id }); };
    for (const id of msg.mentions || []) to(id, 'mention', `${who} mentioned you in ${where}`, preview);
    if (msg.everyone) for (const id of f.server.members) to(id, 'mention', `${who} pinged everyone in ${where}`, preview);
    if (kind === 'announcements') for (const id of f.server.members) to(id, 'announcement', where, preview);
  };

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
    if (!content && !atts.length) return reply({ error: 'Cannot send' });
    try { await store.markAttached(atts.map((a) => a.id).filter(Boolean)); } catch (e) { console.error(e); return reply({ error: 'Cannot send' }); }
    const ping = parseMentions(content, f.server, uid);
    const msg = {
      id: store.id(), channelId: f.channel.id, serverId: f.server.id, authorId: uid, content, attachments: atts,
      mentions: ping.mentions, everyone: ping.everyone,
      replyTo: validReply(db().messages, p.replyTo, (m) => m.channelId === f.channel.id),
      reactions: {}, createdAt: now(),
    };
    db().messages[msg.id] = msg;
    // Credits for real, typed, different messages (see credits.js). Checked before this message counts as "someone spoke".
    const earned = credits.rewardMessage({ user: db().users[uid], content, proof: p.typing, server: f.server, channel: f.channel });
    credits.noteChannelMessage(f.channel.id, uid);
    store.save();
    if (earned.ok) io.to('user:' + uid).emit('credits:update', { balance: earned.balance, delta: earned.amount, reason: 'message' });
    io.to('channel:' + f.channel.id).emit('message:new', msg);
    // Announcements notify everyone in the server, whichever channel they are looking at.
    if (kind === 'announcements') io.to('server:' + f.server.id).emit('announcement:new', { serverId: f.server.id, channelId: f.channel.id, messageId: msg.id, authorId: uid });
    pushChannelMessage(f, msg, kind);
    reply({ ok: true });
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
    store.save();
    io.to('user:' + uid).to('user:' + to.id).emit('dm:new', msg);
    // end-to-end encrypted: the server cannot read it, so the notification only says who wrote
    pushSafe(to.id, 'dm', { title: db().users[uid]?.displayName || 'Someone', body: 'Sent you a message', url: `/app?n=d:${uid}`, tag: 'm:' + msg.id });
    reply({ ok: true });
  });

  socket.on('reaction:toggle', (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!allowed()) return reply({ error: 'Slow down' });
    const custom = /^c:[0-9a-f]{16}$/.test(String(p?.emoji));
    const emoji = custom ? p.emoji : clip(p?.emoji, 8);
    if (!emoji || (custom && !liveEmoji(emoji.slice(2)))) return reply({ error: 'Bad emoji' });
    let msg, rooms;
    if (p.kind === 'channel') {
      msg = db().messages[p.messageId];
      const f = msg && findChannel(msg.channelId);
      if (!f || !f.server.members.includes(uid)) return reply({ error: 'Forbidden' });
      rooms = ['channel:' + msg.channelId];
    } else if (p.kind === 'dm') {
      msg = db().dms[p.messageId];
      if (!msg || (msg.from !== uid && msg.to !== uid)) return reply({ error: 'Forbidden' });
      rooms = ['user:' + msg.from, 'user:' + msg.to];
    } else return reply({ error: 'Bad kind' });

    const list = msg.reactions[emoji] || (msg.reactions[emoji] = []);
    const i = list.indexOf(uid);
    if (i >= 0) list.splice(i, 1); else list.push(uid);
    const added = i < 0;
    if (!list.length) delete msg.reactions[emoji];
    if (Object.keys(msg.reactions).length > 20) { list.splice(list.indexOf(uid), 1); if (!list.length) delete msg.reactions[emoji]; return reply({ error: 'Too many reactions' }); }
    if (added) credits.noteReaction(db().users[uid], msg.id, msg.authorId || msg.from); // counts towards the daily react quest
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
      if (!content && !msg.attachments?.length) return reply({ error: 'Message cannot be empty' });
      msg.content = content;
      Object.assign(msg, parseMentions(content, f.server, uid)); // an edit refreshes the highlight but never pings again
      msg.editedAt = now();
      store.save();
      io.to('channel:' + msg.channelId).emit('message:edited', { kind: 'channel', message: msg });
      return reply({ ok: true });
    }
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
    if (callOf(uid)) return reply({ error: 'You are already on a call' });
    // someone with the app closed can still be rung through a push notification (the ring is shown when they open it)
    if (!isOnline(to.id) && !(push.enabled && to.pushSubs?.length && push.prefsOf(to).calls && to.status !== 'dnd')) return reply({ error: `${to.displayName} is offline` });
    if (callOf(to.id)) return reply({ error: `${to.displayName} is on another call` });
    const c = { id: store.id(), a: uid, b: to.id, video: !!p.video, state: 'ringing' };
    c.timer = setTimeout(() => { if (c.state === 'ringing') endCall(c, 'missed'); }, RING_MS);
    calls.set(c.id, c);
    io.to('user:' + to.id).emit('call:incoming', { callId: c.id, from: uid, video: c.video });
    pushSafe(to.id, 'call', { title: `${db().users[uid]?.displayName || 'Someone'} is calling`, body: `Incoming ${c.video ? 'video' : 'voice'} call`, url: `/app?n=d:${uid}`, tag: 'call' });
    reply({ ok: true, callId: c.id });
  });

  socket.on('call:accept', (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const c = myCall(p?.callId);
    if (!c || c.b !== uid || c.state !== 'ringing') return reply({ error: 'This call has ended' });
    c.state = 'active';
    clearTimeout(c.timer);
    socket.to('user:' + uid).emit('call:handled', { callId: c.id }); // stop ringing on the callee's other devices
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
  await store.pruneImages(referencedImages());   // drop images no profile or emoji points at (left over from a crash mid-upload)
  await store.pruneFiles(referencedFiles());
  await runCleanup(); // also clear out anything that expired while the server was off
  setInterval(runCleanup, 3600_000).unref();
}
const ready = start();

if (require.main === module) {
  ready
    .then(() => httpServer.listen(PORT, () => console.log(`Aduna running on port ${PORT}`)))
    .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
}

module.exports = { httpServer, app, io, expireOldAttachments, ready };


/* HANDOFF: see HANDOFF.md in the project root for what this server does, what is done, and what is left. */
