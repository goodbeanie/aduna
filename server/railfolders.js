// The server bar layout (folders and order), kept on the account so every device shows the same bar.
// A layout is an ordered list of { s: serverId } and { f: folderId, name, color, ids: [serverId, ...] } (see client/src/railfolders.js).
// Only the shape is checked here; servers that are gone or not joined yet are sorted out by the client when it draws the bar.
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_ITEMS = 200, MAX_IDS = 200, MAX_NAME = 30;

// The cleaned layout, or null when it is not a layout (not a list, too long, wrong types, markup or control characters in a name).
function cleanRail(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) return null;
  const out = [], seen = new Set();
  for (const it of raw) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
    if (typeof it.s === 'string') {
      if (!ID.test(it.s)) return null;
      if (!seen.has(it.s)) { seen.add(it.s); out.push({ s: it.s }); }
    } else if (typeof it.f === 'string') {
      if (!ID.test(it.f) || !Array.isArray(it.ids) || it.ids.length > MAX_IDS) return null;
      if (it.name !== undefined && typeof it.name !== 'string') return null;
      const name = typeof it.name === 'string' ? it.name.trim() : '';
      if (name.length > MAX_NAME || /[<>\u0000-\u001f\u007f]/.test(name)) return null;
      if (typeof it.color !== 'string' || !COLOR.test(it.color)) return null;
      const ids = [];
      for (const id of it.ids) {
        if (typeof id !== 'string' || !ID.test(id)) return null;
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
      }
      if (ids.length) out.push({ f: it.f, name: name || 'Folder', color: it.color.toLowerCase(), ids });
    } else return null;
  }
  return out;
}

module.exports = { cleanRail, MAX_ITEMS, MAX_IDS, MAX_NAME };
