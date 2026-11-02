// Profile extras: pronouns, a shelf of favorite games, and a profile song.
//
// Like stickers.js, shop.js and artists.js this file has no Express / database imports: the rules are plain functions over strings and bytes,
// so server/profile-test.js can run them without a server. index.js wires them to PATCH /api/me and the song routes (next to the profile image routes).
//
//   u.pronouns  'she/her'                     up to 24 characters, free text ('' = not set)
//   u.games     ['Hades', 'Celeste', ...]     up to 6 names of up to 40 characters, in the order the person chose
//   u.song      { id, title, mime }           a short audio clip; id is the stored bytes' id (the 32 hex characters the image table uses)
//
// The song is served by GET /api/songs/:id with Range support (Safari will not play an audio file it cannot seek in). Whoever opens the profile
// hears it only after pressing the speaker: it starts out muted, and nothing here changes that default.

const LIMITS = {
  pronouns: 24,
  games: 6,
  gameName: 40,
  songBytes: 1024 * 1024, // 1 MB: about a minute of ordinary MP3, far more than a 30 second clip needs
  songSecs: 30,           // the browser checks the length before upload (the server can only measure a WAV), so this is what the editor tells people
  songTitle: 60,
};
// audio/* as sent by the browser's file picker; the real type is sniffed from the bytes, never taken from the header
const SONG_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/webm'];
const SONG_ID = /^[0-9a-f]{32}$/;

// text from a person: control characters and angle brackets out, spaces collapsed, cut to n characters (counted as people count them, not UTF-16 units)
const tidy = (s, n) => Array.from(String(s ?? '').replace(/[<>\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, n).join('');

// Pronouns: anything up to 24 characters. '' clears them.
function cleanPronouns(raw) {
  if (raw === null || raw === undefined) return { value: '' };
  if (typeof raw !== 'string') return { error: 'Pronouns must be text' };
  const cut = tidy(raw, LIMITS.pronouns + 1);
  if (Array.from(cut).length > LIMITS.pronouns) return { error: `Pronouns can be up to ${LIMITS.pronouns} characters` };
  return { value: cut };
}

// The games shelf: a list of names (or { name } objects). Blank entries are dropped, a name listed twice is kept once (the first spelling wins).
function cleanGames(input) {
  if (input === null || input === undefined) return { list: [] };
  if (!Array.isArray(input)) return { error: 'Games must be a list' };
  const out = [], seen = new Set();
  for (const item of input) {
    const raw = typeof item === 'string' ? item : item && typeof item === 'object' ? item.name : '';
    if (raw !== undefined && raw !== null && typeof raw !== 'string') return { error: 'A game name must be text' };
    const name = tidy(raw, LIMITS.gameName + 1);
    if (!name) continue;
    if (Array.from(name).length > LIMITS.gameName) return { error: `A game name can be up to ${LIMITS.gameName} characters` };
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length > LIMITS.games) return { error: `Your shelf holds up to ${LIMITS.games} games` };
  }
  return { list: out };
}

// The name shown for a song (the file's name without its ending when the person gave none)
function cleanSongTitle(raw, fallback = '') {
  const t = tidy(raw, LIMITS.songTitle);
  return t || tidy(String(fallback).replace(/\.[a-z0-9]{2,5}$/i, ''), LIMITS.songTitle) || 'My song';
}

// What kind of audio are these bytes? { mime, ext } or null. Only the first bytes are looked at.
function sniffAudio(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const s = (a, b) => buf.toString('latin1', a, b);
  if (s(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) !== 0 && (buf[2] & 0xf0) !== 0xf0)) return { mime: 'audio/mpeg', ext: 'mp3' };
  if (s(0, 4) === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  if (s(4, 8) === 'ftyp') return { mime: 'audio/mp4', ext: 'm4a' };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { mime: 'audio/webm', ext: 'webm' };
  return null;
}

// The length of a WAV in seconds (null when it cannot be worked out). Other formats need a decoder, so the browser measures those before upload.
function wavSeconds(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF') return null;
  let pos = 12, byteRate = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4), size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 20 <= buf.length) byteRate = buf.readUInt32LE(pos + 16);
    if (id === 'data') return byteRate > 0 ? Math.min(size, buf.length - pos - 8) / byteRate : null;
    pos += 8 + size + (size & 1);
  }
  return null;
}

// Checks an uploaded song. Returns { data, mime, ext } or { error }.
function checkSong(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { error: 'Choose an MP3, M4A, OGG, WAV or WebM audio file' };
  if (buf.length > LIMITS.songBytes) return { error: `That song is too big (max ${Math.round(LIMITS.songBytes / 1024)} KB). Use a clip of up to ${LIMITS.songSecs} seconds.` };
  const kind = sniffAudio(buf);
  if (!kind) return { error: 'That file is not a valid MP3, M4A, OGG, WAV or WebM audio file' };
  const secs = kind.ext === 'wav' ? wavSeconds(buf) : null;
  if (secs !== null && secs > LIMITS.songSecs + 1) return { error: `That song is too long (max ${LIMITS.songSecs} seconds)` };
  return { data: buf, mime: kind.mime, ext: kind.ext };
}

const isSongId = (id) => typeof id === 'string' && SONG_ID.test(id);

// A Range header ("bytes=0-", "bytes=100-199", "bytes=-500") against a body of `size` bytes:
// null = no usable Range header (send everything), 'bad' = cannot be satisfied (416), else { start, end } inclusive.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { const n = Number(m[2]); if (!n) return 'bad'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!Number.isFinite(start) || start >= size || end < start) return 'bad';
  return { start, end };
}

// What other people get of a person's song (null when there is none)
const songView = (u) => (u && u.song && isSongId(u.song.id) ? { id: u.song.id, title: u.song.title || 'My song', mime: u.song.mime || 'audio/mpeg' } : null);
const gamesView = (u) => (u && Array.isArray(u.games) ? u.games.filter((g) => typeof g === 'string' && g).slice(0, LIMITS.games) : []);
const pronounsView = (u) => (u && typeof u.pronouns === 'string' ? u.pronouns : '');

module.exports = { LIMITS, SONG_TYPES, cleanPronouns, cleanGames, cleanSongTitle, sniffAudio, wavSeconds, checkSong, isSongId, parseRange, songView, gamesView, pronounsView };
