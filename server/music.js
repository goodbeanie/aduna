// Song search for the profile song. Like profile.js this has no Express / database imports, so server/music-test.js can run it with a fake fetch.
//
// Spotify and YouTube Music do not let an app search their catalogue (or play a clip of a song) without per-app keys and a sign-in, so the search and
// the play button use Apple's public iTunes Search API instead: no key, and every song comes with a 30 second preview. The profile card gets the song
// name, artist, cover and the preview address, and also "Spotify" and "YouTube Music" links that open a search for the same song (see client/src/ProfileSong.jsx).
//
// A saved song keeps only what this file read from iTunes itself (the client sends just the track id), and the cover and preview addresses are
// checked against Apple's own hosts, so nobody can make a profile load a picture or sound from somewhere else.

const API = 'https://itunes.apple.com';
const TEXT_MAX = 60;

const clean = (s, n = TEXT_MAX) => Array.from(String(s ?? '').replace(/[<>\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, n).join('');
const host = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.hostname.toLowerCase() : ''; } catch { return ''; } };
const isArt = (u) => /^[a-z0-9-]+\.mzstatic\.com$/.test(host(u)) && String(u).length < 400;
const isPreview = (u) => { const h = host(u); return (h === 'audio-ssl.itunes.apple.com' || /^[a-z0-9-]+\.mzstatic\.com$/.test(h)) && String(u).length < 500; };
const isLink = (u) => ['music.apple.com', 'itunes.apple.com'].includes(host(u)) && String(u).length < 500;

// One iTunes result -> what we keep, or null when it has no usable preview / title.
function mapItem(it) {
  if (!it || typeof it !== 'object') return null;
  const tid = Number(it.trackId);
  const title = clean(it.trackName), artist = clean(it.artistName);
  if (!Number.isInteger(tid) || tid <= 0 || !title || !artist) return null;
  if (!isPreview(it.previewUrl)) return null;
  let art = typeof it.artworkUrl100 === 'string' ? it.artworkUrl100.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/200x200bb.jpg') : '';
  if (!isArt(art)) art = '';
  const out = { tid, title, artist, art, preview: it.previewUrl };
  if (isLink(it.trackViewUrl)) out.link = it.trackViewUrl;
  return out;
}

const cache = new Map(); // key -> { at, value }
const TTL = 10 * 60_000;
function remember(key, value) {
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}
const recall = (key) => { const c = cache.get(key); return c && Date.now() - c.at < TTL ? c.value : undefined; };

async function getJson(url, fetchFn) {
  const r = await fetchFn(url, { signal: AbortSignal.timeout(6000), headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('bad status');
  return r.json();
}

// Up to 12 songs that match `q` (title, artist or both).
async function search(q, fetchFn = fetch) {
  const term = clean(q, 80);
  if (term.length < 2) return [];
  const key = 's:' + term.toLowerCase();
  const hit = recall(key);
  if (hit) return hit;
  const body = await getJson(`${API}/search?media=music&entity=song&limit=20&term=${encodeURIComponent(term)}`, fetchFn);
  const seen = new Set(), out = [];
  for (const it of Array.isArray(body.results) ? body.results : []) {
    const t = mapItem(it);
    if (!t) continue;
    const k = (t.title + '|' + t.artist).toLowerCase(); // the same song on a single and an album is listed once
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 12) break;
  }
  return remember(key, out);
}

// One song by its track id (null when there is no such song, or it has no preview).
async function lookup(tid, fetchFn = fetch) {
  const id = Number(tid);
  if (!Number.isInteger(id) || id <= 0) return null;
  const body = await getJson(`${API}/lookup?id=${id}&entity=song`, fetchFn);
  const it = (Array.isArray(body.results) ? body.results : []).find((x) => Number(x && x.trackId) === id);
  return mapItem(it);
}

// A saved track as stored on the user (u.song) is still checked on the way out, in case the stored data is old or was edited by hand.
const trackOk = (s) => !!s && s.kind === 'track' && Number.isInteger(s.tid) && !!s.title && isPreview(s.preview);

// The part of the 30 second preview that plays on the card (the person picks it in the profile editor).
// Returns { section: { start, end } } (seconds, to a tenth), { section: null } for the whole preview (nothing asked, or all of it), or { error } for a part that cannot be used.
const PREVIEW_SECS = 30, MIN_SECS = 3;
function cleanSection(start, end) {
  if (start === undefined && end === undefined) return { section: null };
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) return { error: 'Pick the part of the song to play' };
  const s = Math.round(Math.max(0, start) * 10) / 10, e = Math.round(Math.min(PREVIEW_SECS, end) * 10) / 10;
  if (e - s < MIN_SECS - 0.001) return { error: `Pick at least ${MIN_SECS} seconds of the song` };
  if (s <= 0.05 && e >= PREVIEW_SECS - 0.05) return { section: null };
  return { section: { start: s, end: e } };
}
const sectionOf = (s) => (Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end <= PREVIEW_SECS + 0.05 && s.end - s.start >= MIN_SECS - 0.05 ? { start: s.start, end: s.end } : null);
const trackView = (s) => (trackOk(s) ? { kind: 'track', tid: s.tid, title: clean(s.title), artist: clean(s.artist), art: isArt(s.art) ? s.art : '', url: s.preview, link: isLink(s.link) ? s.link : '', ...(sectionOf(s) || {}) } : null);

module.exports = { mapItem, search, lookup, trackOk, trackView, cleanSection, isArt, isPreview, PREVIEW_SECS, MIN_SECS };
