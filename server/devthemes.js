'use strict';
// Developer themes: a theme a developer writes as CSS, with its own pictures. Nobody but the author can use one until an admin has read
// it and verified it (no Express, no database: tested by devthemes-test.js).
//
// What stops a theme from doing harm:
//  - the CSS is read by a small scanner (scan) and refused if it uses anything that can load or run something from outside: @import, @font-face,
//    url() to anything but a picture uploaded to the same theme, image-set(), expression() and the like. Backslash escapes are refused outside
//    strings, so nothing can be spelled in a way the checks do not see;
//  - it cannot paint over the app: no position: fixed, a low z-index limit, and strings in the CSS (what content: can print) are short, so a
//    theme cannot put a message or a fake form on the screen;
//  - the page's own policy (security.js) only lets styles and pictures come from this site, so even a rule the checks missed cannot call out;
//  - an admin reads the CSS and sees the pictures before verifying. Verification is tied to a hash of everything the theme is made of, so it
//    lapses by itself when the author changes the CSS, the colours or a picture;
//  - the pictures go through the same nudity check as every other public picture (store.putImage).
const crypto = require('crypto');
const listing = require('./listing');
const gallery = require('./themegallery');

// css stays under the JSON body limit of the API (64 KB) even when quotes and line breaks are escaped
const LIMITS = { perDeveloper: 5, css: 32 * 1024, images: 8, imageSide: 2400, imageBytes: 3 * 1024 * 1024, name: 30, description: 120, rules: 2000, string: 40, zIndex: 20, page: 24, reportsToHide: 3, notes: 300 };
const IMAGE_NAME = /^[a-z0-9][a-z0-9_-]{0,30}\.(?:png|jpe?g|webp)$/;
const AT_RULES = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes', 'layer', 'container', 'property']);

const squash = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// "bg.png", "images/bg.png" and "./images/bg.png" all mean the picture named bg.png; anything else is not a picture of this theme.
function imageName(value) {
  const t = String(value ?? '').trim().toLowerCase().replace(/^\.?\/?(?:images\/)?/, '');
  return IMAGE_NAME.test(t) ? t : null;
}

// Walks the CSS once. Returns { error } or
//   out     the CSS without comments, each url() replaced by a marker (\0N\0) that render() swaps for the real address
//   code    the same with every string blanked, lower case: what the checks read, so text inside a string never looks like CSS
//   strings the text of every string, urls the text inside every url()
function scan(css) {
  const n = css.length, out = [], code = [], strings = [], urls = [];
  const readString = (start) => {
    const q = css[start];
    let j = start + 1, s = '';
    while (j < n && css[j] !== q) {
      const ch = css[j];
      if (ch === '\n' || ch === '\r' || ch === '\f') return { error: 'A string is not closed on its line.' };
      if (ch === '\\') {
        const m = /^\\[0-9a-fA-F]{1,6} ?/.exec(css.slice(j, j + 8));
        if (!m) return { error: 'A backslash inside a string must be a hex code, like "\\201C".' };
        s += m[0]; j += m[0].length;
        continue;
      }
      s += ch; j++;
    }
    if (j >= n) return { error: 'A string is not closed.' };
    return { value: s, end: j + 1, quote: q };
  };
  let i = 0;
  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const e = css.indexOf('*/', i + 2);
      if (e < 0) return { error: 'A comment is not closed.' };
      out.push(' '); code.push(' '); i = e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const r = readString(i);
      if (r.error) return r;
      strings.push(r.value); out.push(c + r.value + c); code.push('""'); i = r.end;
      continue;
    }
    if (c === '\\') return { error: 'Backslashes are only allowed inside strings.' };
    if ((c === 'u' || c === 'U') && /^url\(/i.test(css.slice(i, i + 4)) && !/[a-z0-9_-]/i.test(css[i - 1] || ' ')) {
      let j = i + 4;
      while (j < n && /\s/.test(css[j])) j++;
      let value;
      if (css[j] === '"' || css[j] === "'") {
        const r = readString(j);
        if (r.error) return r;
        if (r.value.includes('\\')) return { error: 'A picture address cannot contain a backslash.' };
        value = r.value; j = r.end;
      } else {
        const e = css.indexOf(')', j);
        if (e < 0) return { error: 'A url( is not closed.' };
        value = css.slice(j, e).trim();
        if (/[\s"'()\\]/.test(value)) return { error: 'A picture address must be one plain name, like url("bg.png").' };
        j = e;
      }
      while (j < n && /\s/.test(css[j])) j++;
      if (css[j] !== ')') return { error: 'A url( is not closed.' };
      urls.push(value);
      out.push('\u0000' + (urls.length - 1) + '\u0000'); code.push('url()');
      i = j + 1;
      continue;
    }
    out.push(c); code.push(c); i++;
  }
  return { out: out.join(''), code: code.join('').toLowerCase(), strings, urls };
}

const FORBIDDEN = [
  [/expression\s*\(/, 'expression()'], [/behavior\s*:/, 'behavior'], [/-moz-binding/, '-moz-binding'], [/(?:java|vb)script\s*:/, 'script addresses'],
  [/image-set\s*\(/, 'image-set()'], [/(?:^|[^a-z0-9_-])src\s*\(/, 'src()'], [/(?:^|[^a-z0-9_-])element\s*\(/, 'element()'],
];

// available: the picture names uploaded to the theme (a Set), or null to check only the form of every address (while the author is still typing).
// Returns { error } or { ok: { used: [picture names the CSS uses] } }.
function lintCss(css, available = null) {
  if (typeof css !== 'string') return { error: 'The CSS must be text.' };
  if (css.length > LIMITS.css) return { error: `The CSS is too long (${LIMITS.css / 1024} KB at most).` };
  if (css.includes('\u0000')) return { error: 'The CSS contains an invalid character.' };
  const s = scan(css);
  if (s.error) return { error: s.error };
  for (const at of s.code.match(/@[a-z-]+/g) || []) {
    const name = at.slice(1);
    if (name === 'import') return { error: '@import is not allowed: a theme is one stylesheet, with its own pictures.' };
    if (name === 'font-face') return { error: '@font-face is not allowed: themes use the fonts the app already has.' };
    if (!AT_RULES.has(name)) return { error: `@${name} is not allowed in a theme.` };
  }
  for (const [re, what] of FORBIDDEN) if (re.test(s.code)) return { error: `${what} is not allowed in a theme.` };
  if (/position\s*:\s*fixed/.test(s.code)) return { error: 'position: fixed is not allowed in a theme (it could cover the app). Use sticky, absolute or relative.' };
  for (const m of s.code.matchAll(/z-index\s*:\s*(-?\d+)/g)) {
    if (Number(m[1]) > LIMITS.zIndex) return { error: `z-index can be at most ${LIMITS.zIndex} in a theme.` };
  }
  for (const str of s.strings) {
    if (str.length > LIMITS.string) return { error: `Text in a string can be at most ${LIMITS.string} characters: a theme cannot put messages on the screen.` };
  }
  let depth = 0, rules = 0;
  for (const ch of s.code) {
    if (ch === '{') { depth++; rules++; } else if (ch === '}' && --depth < 0) return { error: 'There is a } without a matching {.' };
  }
  if (depth !== 0) return { error: 'A { is never closed.' };
  if (rules > LIMITS.rules) return { error: `A theme can have at most ${LIMITS.rules} rules.` };
  const used = [];
  for (const raw of s.urls) {
    const name = imageName(raw);
    if (!name) return { error: 'url() can only point to a picture uploaded to this theme, like url("bg.png"). Other addresses are not allowed.' };
    if (available && !available.has(name)) return { error: `The picture "${name}" is used in the CSS but has not been uploaded.` };
    if (!used.includes(name)) used.push(name);
  }
  return { ok: { used } };
}

// The CSS that is served: comments gone, every picture address pointing at the theme's own picture route. mapUrl(name) -> address.
function render(css, mapUrl) {
  const s = scan(String(css || ''));
  if (s.error) return null;
  return s.out.replace(/\u0000(\d+)\u0000/g, (_m, k) => {
    const name = imageName(s.urls[Number(k)]);
    return name ? `url("${mapUrl(name)}")` : 'url("")';
  });
}

// What an admin verifies: if any of it changes, the verification no longer matches.
function verifyHash(t) {
  const pics = (t.images || []).map((p) => [p.name, p.imageId]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify([t.name, t.css || '', t.seed, pics])).digest('hex');
}
const version = (t) => verifyHash(t).slice(0, 12);

// 'draft' (not sent, or changed since), 'pending' (waiting for an admin), 'approved' or 'rejected' (for exactly what is there now)
function statusOf(t) {
  const h = verifyHash(t);
  if (t.review && t.review.hash === h) return t.review.state;
  if (t.submitted && t.submitted.hash === h) return 'pending';
  return 'draft';
}
const isApproved = (t) => !!t && !t.hidden && statusOf(t) === 'approved';

// Checks a create (no `current`) or an edit (only the fields present). Returns { error } or { value: { fields to set } }.
function checkTheme(body, { current = null, words = [] } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if (!current || b.name !== undefined) {
    const name = squash(b.name, LIMITS.name);
    if (name.length < 2) return { error: 'Give the theme a name (at least 2 characters).' };
    if (listing.blockedWord(name, words, { compact: true })) return { error: 'The name contains words that are not allowed.' };
    if (listing.hasLink(name)) return { error: 'Names cannot contain links.' };
    out.name = name;
  }
  if (!current || b.description !== undefined) {
    const description = squash(b.description, LIMITS.description);
    if (listing.blockedWord(description, words)) return { error: 'The description contains words that are not allowed.' };
    if (listing.hasLink(description)) return { error: 'Descriptions cannot contain links.' };
    out.description = description;
  }
  if (!current || b.seed !== undefined) {
    const seed = gallery.cleanSeed(b.seed);
    if (!seed) return { error: 'Pick a light or dark base, a background colour and an accent colour.' };
    const problem = gallery.readabilityProblem(seed);
    if (problem) return { error: problem };
    out.seed = seed;
  }
  if (!current || b.css !== undefined) {
    const css = b.css === undefined ? '' : b.css;
    const r = lintCss(css, null);
    if (r.error) return { error: r.error };
    out.css = css;
  }
  return { value: out };
}

// Why this theme cannot be sent for review yet, or null.
function submitProblem(t) {
  const st = statusOf(t);
  if (st === 'pending') return 'This theme is already waiting for review.';
  if (st === 'approved') return 'This theme is already verified.';
  if (st === 'rejected') return 'This theme was turned down. Change something in it before sending it again.';
  if (!String(t.css || '').trim()) return 'Write some CSS first.';
  const r = lintCss(t.css, new Set((t.images || []).map((p) => p.name)));
  return r.error || null;
}

const picsOf = (t) => (t.images || []).map((p) => ({ name: p.name, width: p.width, height: p.height, bytes: p.bytes }));

// everything the author sees of their own theme
function ownView(t) {
  const st = statusOf(t);
  return { id: t.id, name: t.name, description: t.description, seed: t.seed, css: t.css || '', images: picsOf(t), status: st, note: st === 'rejected' && t.review ? t.review.note || '' : '',
    hidden: !!t.hidden, uses: t.uses || 0, createdAt: t.createdAt, updatedAt: t.updatedAt, v: version(t), key: t.previewKey || null };
}

// what everybody sees of a verified theme (no CSS: the app loads it from the theme's own address)
function publicView(t, uid, users) {
  const a = users[t.ownerId];
  return { id: t.id, name: t.name, description: t.description, seed: t.seed, cover: t.images && t.images[0] ? t.images[0].name : null, coverImage: t.images && t.images[0] ? t.images[0].imageId : null, uses: t.uses || 0, createdAt: t.createdAt, v: version(t), mine: t.ownerId === uid,
    author: a ? { id: a.id, displayName: a.displayName || a.username } : { id: t.ownerId, displayName: 'Someone' } };
}

// the verified themes: sort 'popular' or 'new', mode 'light' | 'dark', q matches name, description and author
function list(all, users, { sort = 'popular', mode, q, offset = 0, limit = LIMITS.page, uid } = {}) {
  const needle = String(q || '').trim().toLowerCase().slice(0, 40);
  let rows = all.filter(isApproved);
  if (mode === 'light' || mode === 'dark') rows = rows.filter((t) => t.seed.dark === (mode === 'dark'));
  if (needle) rows = rows.filter((t) => `${t.name} ${t.description} ${users[t.ownerId]?.displayName || ''}`.toLowerCase().includes(needle));
  rows.sort(sort === 'new' ? (a, b) => b.createdAt - a.createdAt : (a, b) => (b.uses || 0) - (a.uses || 0) || b.createdAt - a.createdAt);
  const start = Math.max(0, Math.min(Number(offset) || 0, 100000)), size = Math.max(1, Math.min(Number(limit) || LIMITS.page, LIMITS.page));
  return { themes: rows.slice(start, start + size).map((t) => publicView(t, uid, users)), more: start + size < rows.length };
}

// admin list: filter 'pending' (waiting for review), 'approved', 'rejected' or 'all'
function adminList(all, users, filter, q) {
  const needle = String(q || '').trim().toLowerCase().slice(0, 60);
  return all.map((t) => ({ t, st: statusOf(t) }))
    .filter(({ st }) => filter === 'all' || st === filter)
    .filter(({ t }) => !needle || `${t.name} ${users[t.ownerId]?.username || ''}`.toLowerCase().includes(needle))
    .sort((a, b) => ((b.t.submitted && b.t.submitted.at) || b.t.updatedAt || 0) - ((a.t.submitted && a.t.submitted.at) || a.t.updatedAt || 0))
    .map(({ t, st }) => ({ id: t.id, name: t.name, description: t.description, developer: users[t.ownerId]?.username || null, status: st, uses: t.uses || 0, images: (t.images || []).length,
      submittedAt: t.submitted ? t.submitted.at : null, updatedAt: t.updatedAt || t.createdAt, reviewedBy: t.review ? users[t.review.by]?.username || null : null, hidden: !!t.hidden,
      lapsed: !!t.review && t.review.state === 'approved' && t.review.hash !== verifyHash(t) }));
}

// An admin's decision. action: 'approve' | 'reject' | 'revoke'. hash: what the admin was looking at. Returns { ok } or { status, error }.
function review(t, { action, hash, note, by, at }) {
  if (action === 'revoke') { delete t.review; delete t.submitted; return { ok: true }; }
  if (action !== 'approve' && action !== 'reject') return { status: 400, error: 'action must be approve, reject or revoke' };
  if (hash !== verifyHash(t)) return { status: 409, error: 'The developer changed this theme after you opened it. Look at it again.' };
  if (statusOf(t) !== 'pending') return { status: 400, error: 'This theme is not waiting for review.' };
  const r = lintCss(t.css, new Set((t.images || []).map((p) => p.name)));
  if (action === 'approve' && r.error) return { status: 400, error: r.error };
  t.review = { state: action === 'approve' ? 'approved' : 'rejected', at, by, hash, note: squash(note, LIMITS.notes) };
  return { ok: true };
}

module.exports = { LIMITS, IMAGE_NAME, imageName, scan, lintCss, render, verifyHash, version, statusOf, isApproved, checkTheme, submitProblem, ownView, publicView, list, adminList, review, picsOf };
