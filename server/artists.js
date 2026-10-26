// Artists: people who apply to sell their own profile badges in the credits shop.
//
// Like shop.js and credits.js this file has no Express / database imports: the rules are plain functions over an application record and a
// badge record, so server/artists-test.js can run them without a server. index.js wires them to the routes (the "artists" block).
//
// The flow:
//   1. Application. Anyone can put exactly LIMITS.pieces pieces of their art in a draft (one upload per piece) and send it with an optional
//      note. db().artists[userId] = { id, status, pieces: [imageId x4], note, appliedAt, reviewNote, reviewedAt, reviewedBy, retryAt, badge }.
//      status: draft -> pending -> approved | rejected. A rejection needs a note and starts a cooldown (retryAt) before the person can apply again.
//   2. Review. Moderators (a creator account or a name in ADMIN_USERNAMES) see the pieces and approve or reject. Nobody reviews their own.
//   3. Items. An approved artist makes shop items. An item is an ordinary badge in db().badges (so wearing, hiding and showing it next to a name
//      is the existing badge code) with `artistId` and its own `status`: draft -> pending -> approved | rejected. The shop only lists an artist
//      item once it is approved (shop.js, `listed`). Once approved the picture, name and description are locked (owners are already wearing it);
//      only the price can change, and a price of null takes it off sale.
//   4. Sales. When someone buys an artist item the artist gets `cutFor(price)` credits (CUT_PERCENT of the price, rounded down) in the same
//      synchronous step as the purchase (credits.js), with an "artist" line in their ledger.
//   5. Badge. The Artist badge (rec.badge) is switched on when the artist's first item is approved.

const { MAX_PRICE } = require('./shop');

const DAY_MS = 86_400_000;
const LIMITS = { pieces: 4, note: 300, review: 200, items: 10, minPrice: 10, name: 24, desc: 80, maxSide: 1600 };

const pct = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.floor(n))) : 50; };
// the artist's share of a sale, in percent (env ARTIST_CUT_PERCENT, default 50)
const CUT_PERCENT = process.env.ARTIST_CUT_PERCENT === undefined || process.env.ARTIST_CUT_PERCENT === '' ? 50 : pct(process.env.ARTIST_CUT_PERCENT);
// how long a rejected applicant waits before applying again (env ARTIST_COOLDOWN_DAYS, default 7)
const COOLDOWN_MS = (Number(process.env.ARTIST_COOLDOWN_DAYS) > 0 ? Number(process.env.ARTIST_COOLDOWN_DAYS) : 7) * DAY_MS;

const text = (s, n) => Array.from(String(s ?? '').replace(/\r/g, '').trim()).slice(0, n).join('');
const oneLine = (s, n) => Array.from(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, n).join('');

// What the artist earns from one sale: a whole number of credits, rounded down (0 when the price is too small to split).
function cutFor(price, percent = CUT_PERCENT) {
  if (!Number.isInteger(price) || price <= 0) return 0;
  return Math.floor((price * pct(percent)) / 100);
}

// ---------- the application ----------
const blank = (uid, now = Date.now()) => ({ id: uid, status: 'draft', pieces: Array.from({ length: LIMITS.pieces }, () => null), note: '', createdAt: now });
const pieceIds = (rec) => (rec && Array.isArray(rec.pieces) ? rec.pieces.slice(0, LIMITS.pieces) : []);
const filled = (rec) => pieceIds(rec).filter(Boolean).length;
const cooldownLeft = (rec, now = Date.now()) => (rec && rec.status === 'rejected' && rec.retryAt > now ? rec.retryAt - now : 0);

// Can this person put pieces in a draft right now? Returns { ok, rec, dropped } where `rec` is the draft to use (a new one when there was none,
// or when a rejected person is allowed to try again) and `dropped` are the image ids of the old pieces, which the caller deletes.
function open(rec, uid, now = Date.now()) {
  if (!rec) return { ok: true, rec: blank(uid, now), dropped: [] };
  if (rec.status === 'draft') return { ok: true, rec, dropped: [] };
  if (rec.status === 'rejected') {
    if (rec.retryAt > now) return { status: 429, error: 'You can apply again ' + (rec.retryAt - now > DAY_MS ? 'in ' + Math.ceil((rec.retryAt - now) / DAY_MS) + ' days' : 'later today') };
    return { ok: true, rec: blank(uid, now), dropped: pieceIds(rec).filter(Boolean) };
  }
  return { status: 409, error: rec.status === 'pending' ? 'Your application is being reviewed' : 'You are already an artist' };
}

const validSlot = (s) => (/^[0-3]$/.test(String(s)) ? Number(s) : -1);

// Send the draft in. Needs every piece.
function submit(rec, note, now = Date.now()) {
  if (!rec || rec.status !== 'draft') return { status: 409, error: 'Add your pieces first' };
  if (filled(rec) !== LIMITS.pieces) return { status: 400, error: `Add exactly ${LIMITS.pieces} pieces of your art` };
  rec.status = 'pending'; rec.note = text(note, LIMITS.note); rec.appliedAt = now;
  return { ok: true };
}

// A moderator's decision on a pending application. Rejecting needs a note and starts the cooldown.
function decide(rec, action, note, by, now = Date.now(), cooldownMs = COOLDOWN_MS) {
  if (action !== 'approve' && action !== 'reject') return { status: 400, error: 'action must be approve or reject' };
  if (!rec || rec.status !== 'pending') return { status: 404, error: 'No application is waiting for that person' };
  const n = text(note, LIMITS.review);
  if (action === 'reject' && !n) return { status: 400, error: 'Say why, so the person knows what to change' };
  rec.status = action === 'approve' ? 'approved' : 'rejected';
  if (action === 'reject') rec.retryAt = now + cooldownMs;
  rec.reviewNote = n; rec.reviewedAt = now; rec.reviewedBy = by;
  return { ok: true };
}

// what the applicant sees about their own application
function view(rec, now = Date.now()) {
  if (!rec) return { status: 'none', pieces: [], filled: 0, note: '', reviewNote: '', retryAt: null, appliedAt: null };
  const left = cooldownLeft(rec, now);
  return {
    status: rec.status, pieces: pieceIds(rec), filled: filled(rec), note: rec.note || '', appliedAt: rec.appliedAt || null,
    reviewNote: rec.status === 'approved' || rec.status === 'rejected' ? rec.reviewNote || '' : '',
    retryAt: left > 0 ? rec.retryAt : null,
  };
}
const isArtist = (rec) => !!rec && rec.status === 'approved';

// ---------- items ----------
// An item is a badge in db().badges with an artistId. Only approved ones are for sale.
const isItem = (b) => !!b && typeof b.artistId === 'string' && b.artistId.length > 0;
const listed = (b) => !isItem(b) || b.status === 'approved';
// An item is a badge (worn next to a name) or a profile frame (a ring drawn around the avatar). Older items have no `kind` and are badges.
const KINDS = ['badge', 'frame'];
const kindOf = (b) => (b && b.kind === 'frame' ? 'frame' : 'badge');
const isFrame = (b) => kindOf(b) === 'frame';
// A frame picture is a square PNG, JPEG or WebP; the middle of it (the avatar hole) has to be see-through. The browser checks the hole, the server the shape.
const FRAME = { side: 512, hole: 384, minSide: 128 }; // the template: 512px square, the avatar sits in a 384px circle in the middle (75%)

// Checks the fields of a new item (partial = false: name and price are required) or of an edit (partial = true: only what is sent).
// A price of null is returned as null; editItem decides whether that is allowed.
function cleanItem(body, partial = false) {
  const out = {}, b = body || {};
  if (!partial) {
    const kind = b.kind === undefined || b.kind === null || b.kind === '' ? 'badge' : b.kind;
    if (!KINDS.includes(kind)) return { error: 'An item is a badge or a profile frame' };
    out.kind = kind;
  }
  if (!partial || b.name !== undefined) {
    const name = oneLine(b.name, LIMITS.name + 1);
    if (!name || Array.from(name).length > LIMITS.name) return { error: `A name is 1-${LIMITS.name} characters` };
    out.name = name;
  }
  if (b.desc !== undefined) {
    const raw = oneLine(b.desc, LIMITS.desc + 1);
    if (Array.from(raw).length > LIMITS.desc) return { error: `A description is at most ${LIMITS.desc} characters` };
    out.desc = raw;
  }
  if (!partial || b.price !== undefined) {
    if (partial && (b.price === null || b.price === '')) out.price = null;
    else {
      const p = Number(b.price);
      if (b.price === null || b.price === '' || !Number.isInteger(p) || p < LIMITS.minPrice || p > MAX_PRICE) return { error: `The price is a whole number of credits from ${LIMITS.minPrice} to ${MAX_PRICE.toLocaleString('en-US')}` };
      out.price = p;
    }
  }
  return { out };
}

// Validates an edit to an existing item. Returns { ok, out } (apply it with applyEdit) or { status, error }.
function editItem(b, body) {
  const { out, error } = cleanItem(body, true);
  if (error) return { status: 400, error };
  if (b.status === 'approved') {
    if (Object.keys(out).some((k) => k !== 'price')) return { status: 409, error: 'An approved item cannot be changed, only its price. Make a new item instead.' };
  } else if (out.price === null) return { status: 400, error: 'An item needs a price' };
  return { ok: true, out };
}
// Changing a not-yet-approved item takes it back to a draft, so a reviewer never approves something that was edited afterwards.
function applyEdit(b, out) {
  Object.assign(b, out);
  if (b.status !== 'approved') { b.status = 'draft'; b.reviewNote = ''; }
}

// Send an item to the reviewers. Needs a picture and a price.
function submitItem(b, now = Date.now()) {
  if (!isItem(b) || b.status !== 'draft') return { status: 409, error: 'This item was already sent, or is already approved' };
  if (!b.image) return { status: 400, error: 'Add a picture first' };
  if (!Number.isInteger(b.price) || b.price < LIMITS.minPrice) return { status: 400, error: 'Set a price first' };
  b.status = 'pending'; b.submittedAt = now; b.reviewNote = '';
  return { ok: true };
}

// A moderator's decision on a pending item. Rejecting needs a note.
function decideItem(b, action, note, by, now = Date.now()) {
  if (action !== 'approve' && action !== 'reject') return { status: 400, error: 'action must be approve or reject' };
  if (!isItem(b) || b.status !== 'pending') return { status: 404, error: 'That item is not waiting for review' };
  const n = text(note, LIMITS.review);
  if (action === 'reject' && !n) return { status: 400, error: 'Say why, so the artist knows what to change' };
  b.status = action === 'approve' ? 'approved' : 'rejected';
  b.reviewNote = n; b.reviewedAt = now; b.reviewedBy = by;
  return { ok: true };
}

// How many items an artist may have (a rejected or draft one that is deleted does not count, because it is gone).
const itemRoom = (items) => items.length < LIMITS.items;

module.exports = {
  LIMITS, CUT_PERCENT, COOLDOWN_MS, cutFor,
  blank, pieceIds, filled, validSlot, cooldownLeft, open, submit, decide, view, isArtist,
  isItem, listed, KINDS, FRAME, kindOf, isFrame, cleanItem, editItem, applyEdit, submitItem, decideItem, itemRoom,
};
