// Soundboard: short sounds that anyone in a voice channel can play for everyone in that channel.
//
// Like stickers.js and profile.js this file has no Express / database imports: the rules are plain functions over a server record and strings or
// bytes, so server/soundboard-test.js can run them without a server. index.js wires them to the routes and the `soundboard:play` socket event
// (the "soundboard" block, next to the server layout routes).
//
//   server.sounds      [{ id, name, emoji, audio, mime, by, at }]   up to 24; `audio` is the id of the stored bytes (the images table, like a profile song)
//   server.soundboard  { enabled, who, roles }                       who may PLAY them (anyone with Manage server may add and remove sounds)
//     enabled  false = the soundboard is off completely: nobody can play a sound, the owner included. Missing = on.
//     who      'everyone' = every member | 'roles' = only the roles listed in `roles`. The owner and administrators can always play (while it is on).
//
// A sound is played by the server telling every socket in the voice channel (`soundboard:play { channelId, soundId, userId }`); each browser then
// fetches and plays the clip itself (GET /api/servers/:id/sounds/:sid/audio, members only). Nothing is mixed into anybody's microphone, so a person
// who deafens themselves simply does not hear it. Sounds are short on purpose: 5 seconds and 256 KB.

const { sniffAudio, wavSeconds, SONG_TYPES } = require('./profile');

const LIMITS = {
  sounds: 24,            // per server
  name: 24,
  emoji: 8,              // characters (code points) of the little icon on the button
  bytes: 256 * 1024,
  secs: 5,               // the browser measures the length before upload; the server can only measure a WAV, so the size limit backs it up
  burst: 40,             // a person may press sound buttons as fast as they like, up to this many plays...
  windowMs: 5000,        // ...in any window this long (only a flood is refused; it protects the server, not the room)
  roles: 25,
};
const TYPES = SONG_TYPES;
const WHO = ['everyone', 'roles'];
const OFF_MESSAGE = 'The soundboard is turned off on this server';
const WHO_MESSAGE = 'You are not allowed to use the soundboard on this server';

const soundsOf = (s) => (s && Array.isArray(s.sounds) ? s.sounds : []);
const find = (s, id) => (typeof id === 'string' ? soundsOf(s).find((x) => x.id === id) || null : null);
const audioIds = (s) => soundsOf(s).map((x) => x.audio).filter(Boolean);

// ---------- settings ----------
// The settings as they are used and shown (a server that never touched them: on, for everyone)
function settingsOf(s) {
  const b = (s && s.soundboard) || {};
  return {
    enabled: b.enabled !== false,
    who: WHO.includes(b.who) ? b.who : 'everyone',
    roles: Array.isArray(b.roles) ? b.roles.filter((id) => typeof id === 'string') : [],
  };
}

// A change from the owner: any of { enabled, who, roles }; what is left out stays as it is. `roleIds` = the ids of the roles the server has.
// Returns { value } (the whole new settings object) or { error }.
function cleanSettings(body, current, roleIds) {
  const b = body && typeof body === 'object' ? body : {};
  const out = { ...settingsOf({ soundboard: current }) };
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return { error: 'Turn the soundboard on or off with true or false' };
    out.enabled = b.enabled;
  }
  if (b.who !== undefined) {
    if (!WHO.includes(b.who)) return { error: 'Choose everyone or only some roles' };
    out.who = b.who;
  }
  if (b.roles !== undefined) {
    if (!Array.isArray(b.roles) || b.roles.length > LIMITS.roles || b.roles.some((id) => typeof id !== 'string')) return { error: 'Roles must be a list of role ids' };
    const known = new Set(roleIds || []);
    if (b.roles.some((id) => !known.has(id))) return { error: 'One of those roles does not exist' };
    out.roles = [...new Set(b.roles)];
  }
  return { value: out };
}

// May this person play sounds? `who` = { owner, admin, roleIds }. Returns null when yes, else the reason as a sentence.
function whyNot(s, who) {
  const cfg = settingsOf(s);
  if (!cfg.enabled) return OFF_MESSAGE;
  if (who.owner || who.admin || cfg.who === 'everyone') return null;
  return (who.roleIds || []).some((id) => cfg.roles.includes(id)) ? null : WHO_MESSAGE;
}

// What the browser gets in the server record: the settings and the list of sounds (no storage ids: audio is fetched by the sound's own id).
const view = (s) => ({ soundboard: settingsOf(s), sounds: soundsOf(s).map((x) => ({ id: x.id, name: x.name, emoji: x.emoji || '' })) });

// ---------- one sound ----------
const clean1 = (s, n) => Array.from(String(s ?? '').replace(/[<>\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, n).join('');

function cleanName(raw) {
  const name = clean1(raw, LIMITS.name + 1);
  if (!name || Array.from(name).length > LIMITS.name) return { error: `A sound name is 1-${LIMITS.name} characters` };
  return { name };
}

// The little icon on the button: optional, a few emoji. Text is not an icon, so letters and digits are refused. (Joiners such as the zero-width
// joiner stay: they hold family and skin-tone emoji together.)
function cleanEmoji(raw) {
  if (raw === undefined || raw === null || raw === '') return { emoji: '' };
  if (typeof raw !== 'string') return { error: 'The icon must be an emoji' };
  const e = Array.from(raw.replace(/[<>\u0000-\u001f\u007f]/g, '').trim());
  if (/[A-Za-z0-9]/.test(e.join(''))) return { error: 'The icon must be an emoji, not text' };
  if (e.length > LIMITS.emoji) return { error: `The icon can be up to ${LIMITS.emoji} characters` };
  return { emoji: e.join('') };
}

// Can this sound be added now? A full soundboard and a name that is already taken (any capitals) are refused.
function roomFor(s, name) {
  const list = soundsOf(s);
  if (list.length >= LIMITS.sounds) return { ok: false, status: 400, error: `A server can have up to ${LIMITS.sounds} sounds` };
  if (list.some((x) => x.name.toLowerCase() === String(name).toLowerCase())) return { ok: false, status: 409, error: 'A sound with that name already exists' };
  return { ok: true };
}

// Checks the bytes of an uploaded sound: size, the real audio type (read from the bytes, never from the header) and, for a WAV, the length.
// Returns { data, mime, ext } or { error }.
function check(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { error: 'Choose an MP3, M4A, OGG, WAV or WebM audio file' };
  if (buf.length > LIMITS.bytes) return { error: `That sound is too big (max ${Math.round(LIMITS.bytes / 1024)} KB). Sounds are up to ${LIMITS.secs} seconds long.` };
  const kind = sniffAudio(buf);
  if (!kind) return { error: 'That file is not a valid MP3, M4A, OGG, WAV or WebM audio file' };
  const secs = kind.ext === 'wav' ? wavSeconds(buf) : null;
  if (secs !== null && secs > LIMITS.secs + 0.5) return { error: `That sound is too long (max ${LIMITS.secs} seconds)` };
  return { data: buf, mime: kind.mime, ext: kind.ext };
}

// ---------- flood protection ----------
// No pause between sounds: pressing a button many times plays it many times. Only a flood is refused: more than LIMITS.burst plays by one person
// in LIMITS.windowMs. plays: a Map of userId -> the times of their recent sounds. Returns true (and notes the time) when the person may play now.
function allow(plays, uid, t = Date.now()) {
  const recent = (plays.get(uid) || []).filter((x) => t - x < LIMITS.windowMs);
  if (recent.length >= LIMITS.burst) { plays.set(uid, recent); return false; }
  recent.push(t);
  plays.set(uid, recent);
  if (plays.size > 500) for (const [k, v] of plays) if (!v.length || t - v[v.length - 1] >= LIMITS.windowMs) plays.delete(k); // keep the map small
  return true;
}

module.exports = { LIMITS, TYPES, WHO, OFF_MESSAGE, WHO_MESSAGE, soundsOf, find, audioIds, settingsOf, cleanSettings, whyNot, view, cleanName, cleanEmoji, roomFor, check, allow };
