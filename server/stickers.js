// Stickers: big pictures sent on their own, bought in the credits shop as packs.
//
// Like shop.js and artists.js this file has no Express / database imports: the rules are plain functions over a pack record and a user record,
// so server/stickers-test.js can run them without a server. index.js wires them to the routes (the "stickers" block, next to the artists block).
//
// A pack is a shop item of kind 'stickers': an ordinary record in db().badges (so the artist flow, the review, the shop, buying and the artist's
// cut are all the code that already exists for badges and profile frames) with a `stickers` list instead of a single picture:
//   { id, kind: 'stickers', name, desc, price, artistId, status, stickers: [{ id, name, animated, w, h }], ... }
// A sticker's id IS the id of its stored picture (the 32 hex characters the image table uses), so the picture is served by the existing
// GET /api/images/:id (add ?still=1 for the first frame of an animated one) and nothing else has to be looked up to draw it.
//
// Buying a pack puts its id in the buyer's `u.badges`, exactly like a frame, but a pack is not worn: it never shows next to a name and does not
// count against the 12 badges a person can hold (shop.js, index.js allBadgeViews).
//
// Sending: a sticker is a message whose whole text is the token `<stk:ID>` (the same idea as `<:name:id>` for custom emoji). In a server channel
// the server checks that the sender owns the pack. Direct messages and group chats are end-to-end encrypted, so the server cannot read the token:
// there the browser only offers the stickers a person owns, and the picture is served to anyone who has its (unguessable) id, like an emoji.
//
// Animated stickers are GIFs. They sit still on their first frame and play while the pointer is over them, like every other animated picture.

const { sniffImage, cleanGif } = require('./images');

const LIMITS = {
  minPack: 3,          // a pack needs at least this many stickers before it can be sent for review
  maxPack: 16,         // and can hold at most this many
  maxBytes: 512 * 1024,
  minSide: 64,         // stickers are big: smaller than this is an emoji
  maxSide: 512,
  maxRatio: 2,         // no wider (or taller) than 2:1
  maxFrames: 150,      // GIFs (cleanGif's limit)
  name: 24,
};
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const ID = /^[0-9a-f]{32}$/;
const ONLY = /^<stk:([0-9a-f]{32})>$/;
const ANY = /<stk:[0-9a-f]{32}>/;
const token = (id) => `<stk:${id}>`;

// the sticker id when the whole message is one sticker token, else null
function idOf(content) {
  const m = ONLY.exec(String(content ?? '').trim());
  return m ? m[1] : null;
}
// does the text contain a sticker token that is not the whole message? (the server refuses those in channels)
const mixed = (content) => ANY.test(String(content ?? '')) && idOf(content) === null;

const isPack = (b) => !!b && b.kind === 'stickers';
const stickersOf = (b) => (isPack(b) && Array.isArray(b.stickers) ? b.stickers : []);
const clean1 = (s, n) => Array.from(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, n).join('');

// A name for a sticker (shown in the picker and as the picture's description): 1-24 characters, no angle brackets.
function cleanName(raw) {
  const name = clean1(String(raw ?? '').replace(/[<>]/g, ''), LIMITS.name + 1);
  if (!name || Array.from(name).length > LIMITS.name) return { error: `A sticker name is 1-${LIMITS.name} characters` };
  return { name };
}

// Checks the bytes of an uploaded sticker. Returns { data, mime, animated, w, h } (data is what to store: a GIF is rebuilt without extensions)
// or { error }.
function check(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { error: 'Choose a PNG, JPEG, WebP or GIF image' };
  let data = buf, info, animated = false;
  if (buf.toString('latin1', 0, 3) === 'GIF') {
    info = cleanGif(buf, LIMITS.maxFrames);
    if (!info) return { error: `That GIF is damaged or has too many frames (max ${LIMITS.maxFrames})` };
    data = info.buf; info = { ...info, mime: 'image/gif' }; animated = info.frames > 1;
  } else {
    info = sniffImage(buf);
    if (!info) return { error: 'That file is not a valid PNG, JPEG, WebP or GIF image' };
  }
  const { width: w, height: h } = info;
  if (Math.min(w, h) < LIMITS.minSide) return { error: `Too small: a sticker is at least ${LIMITS.minSide}x${LIMITS.minSide} pixels` };
  if (Math.max(w, h) > LIMITS.maxSide) return { error: `Too large: a sticker is at most ${LIMITS.maxSide}x${LIMITS.maxSide} pixels` };
  if (Math.max(w, h) / Math.min(w, h) > LIMITS.maxRatio) return { error: 'A sticker should be roughly square (no wider or taller than 2:1)' };
  if (data.length > LIMITS.maxBytes) return { error: `That sticker is too big (max ${LIMITS.maxBytes / 1024} KB)` };
  return { data, mime: info.mime, animated, w, h };
}

// Can another sticker go into this pack? (Only a pack that is not approved yet can change.)
function roomFor(b, name) {
  if (!isPack(b)) return { status: 400, error: 'Stickers go in a sticker pack' };
  if (b.status === 'approved') return { status: 409, error: 'An approved pack cannot be changed. Make a new pack instead.' };
  const list = stickersOf(b);
  if (list.length >= LIMITS.maxPack) return { status: 400, error: `A pack holds up to ${LIMITS.maxPack} stickers` };
  if (list.some((s) => s.name.toLowerCase() === String(name).toLowerCase())) return { status: 409, error: 'Two stickers in a pack cannot share a name' };
  return { ok: true };
}

// Is the pack ready to be sent to the reviewers?
function readyToSend(b) {
  const n = stickersOf(b).length;
  return n >= LIMITS.minPack ? { ok: true } : { status: 400, error: `Add at least ${LIMITS.minPack} stickers first (you have ${n})` };
}

function findSticker(badges, id) {
  if (typeof id !== 'string' || !ID.test(id)) return null;
  for (const b of Object.values(badges || {})) {
    if (!isPack(b)) continue;
    const s = stickersOf(b).find((x) => x.id === id);
    if (s) return { pack: b, sticker: s };
  }
  return null;
}
// May this person send this sticker? They own the pack (its id is in u.badges) and it is still a listed pack, or they made it themselves.
function mayUse(u, badges, id) {
  const hit = findSticker(badges, id);
  if (!hit || !u) return false;
  const { pack } = hit;
  if (pack.artistId && pack.artistId === u.id) return true; // an artist can always use their own work (also while it is a draft: that is how they try it)
  return pack.status === 'approved' && Array.isArray(u.badges) && u.badges.includes(pack.id);
}

// What the shop and the picker show of a pack's stickers
const stickerView = (s) => ({ id: s.id, name: s.name, animated: !!s.animated, w: s.w || null, h: s.h || null });
const stickerViews = (b) => stickersOf(b).map(stickerView);

// The packs a person can send from, for the picker: the ones they bought plus their own, each with its stickers.
function ownedPacks(u, badges) {
  const out = [], seen = new Set();
  const take = (b) => { if (!isPack(b) || seen.has(b.id)) return; seen.add(b.id); out.push({ id: b.id, name: b.name, mine: !!(b.artistId && b.artistId === u.id), stickers: stickerViews(b) }); };
  for (const id of Array.isArray(u.badges) ? u.badges : []) { const b = badges && Object.prototype.hasOwnProperty.call(badges, id) ? badges[id] : null; if (b && b.status === 'approved') take(b); }
  for (const b of Object.values(badges || {})) if (isPack(b) && b.artistId === u.id) take(b);
  return out.filter((p) => p.stickers.length);
}

// The words that stand in for a sticker where only text fits (a notification, a reply preview)
const LABEL = 'Sent a sticker';

module.exports = { LIMITS, TYPES, token, idOf, mixed, isPack, stickersOf, cleanName, check, roomFor, readyToSend, findSticker, mayUse, stickerView, stickerViews, ownedPacks, LABEL };
