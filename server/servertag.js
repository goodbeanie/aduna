'use strict';
// Server tags: a short badge (up to 4 characters) that a server's managers design for the server: its text, a background colour and an
// optional frame colour. Any member can choose to wear ONE server tag, and it then shows next to their name in chat, the member list and
// their profile card.
//
// What is stored:
//   server.serverTag = { text, bg, frame }   frame is a hex colour, or null for no frame
//   user.serverTag   = a server id           the tag that person wears
// A worn tag is checked every time it is shown (see wornView): leaving or being removed from the server, the managers clearing the tag,
// or the server being deleted all simply make it stop showing, so nothing has to be cleaned up by hand.
// (Not to be confused with server.tags, the discovery tags a public server is searched by.)

const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_LEN = 4;
const TEXT_RE = /^[\p{L}\p{N}]+$/u; // letters and numbers of any language: no spaces, symbols or emoji

// Black or white, whichever reads better on the background (WCAG relative luminance).
function textColorOn(bg) {
  const c = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return lum > 0.35 ? '#111111' : '#ffffff';
}

// Checks what a manager sent. Returns { value } (value null = take the tag away) or { error }.
function clean(b) {
  if (b === null || b === undefined) return { value: null };
  if (typeof b !== 'object' || Array.isArray(b)) return { error: 'Send the tag as { text, bg, frame }' };
  const text = String(b.text ?? '').trim();
  if (!text) return { value: null }; // an empty text is the same as no tag
  if ([...text].length > MAX_LEN) return { error: `A server tag can be at most ${MAX_LEN} characters` }; // characters, not UTF-16 units
  if (!TEXT_RE.test(text)) return { error: 'A server tag can only use letters and numbers' };
  if (typeof b.bg !== 'string' || !HEX.test(b.bg)) return { error: 'Pick a background colour for the tag' };
  let frame = null;
  if (b.frame !== null && b.frame !== undefined && b.frame !== '') {
    if (typeof b.frame !== 'string' || !HEX.test(b.frame)) return { error: 'Pick a colour for the frame, or turn the frame off' };
    frame = b.frame.toLowerCase();
  }
  return { value: { text, bg: b.bg.toLowerCase(), frame } };
}

// How a server's tag is drawn. `fg` (the text colour) is worked out here so every screen agrees.
function view(s) {
  const t = s && s.serverTag;
  if (!t || !t.text) return null;
  return { text: t.text, bg: t.bg, frame: t.frame || null, fg: textColorOn(t.bg) };
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const memberOf = (s, uid) => !!s && Array.isArray(s.members) && s.members.includes(uid);

// The tag a person is wearing right now, or null: it must still exist, and they must still be in that server.
function wornView(u, servers) {
  if (!u || u.bot || !u.serverTag) return null;
  const s = servers && has(servers, u.serverTag) ? servers[u.serverTag] : null;
  if (!memberOf(s, u.id)) return null;
  const v = view(s);
  return v ? { serverId: s.id, name: s.name, ...v } : null;
}

// Every tag the person could wear (one per server they are in that has a tag), for the picker in their profile.
function choicesFor(u, servers) {
  const out = [];
  for (const s of Object.values(servers || {})) {
    if (!memberOf(s, u.id)) continue;
    const v = view(s);
    if (v) out.push({ serverId: s.id, name: s.name, ...v, worn: u.serverTag === s.id });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Checks which tag a person asks to wear. Returns { value } (a server id, or null for none) or { error }.
function cleanWorn(id, u, servers) {
  if (id === null || id === undefined || id === '') return { value: null };
  if (typeof id !== 'string') return { error: 'Pick one of your servers' };
  const s = has(servers, id) ? servers[id] : null;
  if (!memberOf(s, u.id)) return { error: 'You can only wear the tag of a server you are in' };
  if (!view(s)) return { error: 'That server has no tag yet' };
  return { value: s.id };
}

module.exports = { MAX_LEN, clean, view, wornView, choicesFor, cleanWorn, textColorOn };
