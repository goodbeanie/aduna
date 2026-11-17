// Order and folders of the server bar. Kept on this device, one list per account (like panels.js).
//
// A layout is an ordered list of
//   { s: serverId }
//   { f: folderId, name, color, ids: [serverId, ...] }
// Servers that are not in it (just joined) go to the end, servers that are gone drop out, so it never has to be kept in step with the server list.

export const FOLDER_COLORS = ['#e8743b', '#e0a526', '#43b581', '#3aa0c9', '#5865f2', '#9b59d0', '#d6577f', '#8a8f98'];

const KEY = (userId) => 'aduna-rail-' + userId;

export function loadRail(userId) {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(userId)));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

export function saveRail(userId, layout) {
  try {
    localStorage.setItem(KEY(userId), JSON.stringify(layout));
  } catch { /* storage blocked: lasts until reload */ }
}

export const keyOf = (it) => (it.s ? 's:' + it.s : 'f:' + it.f);

export function arrange(saved, servers) {
  const ids = new Set(servers.map((s) => s.id));
  const seen = new Set();
  const out = [];
  for (const it of saved) {
    if (it && typeof it.s === 'string') {
      if (ids.has(it.s) && !seen.has(it.s)) { seen.add(it.s); out.push({ s: it.s }); }
    } else if (it && typeof it.f === 'string' && Array.isArray(it.ids)) {
      const mine = it.ids.filter((id) => ids.has(id) && !seen.has(id));
      mine.forEach((id) => seen.add(id));
      if (mine.length) out.push({ f: it.f, name: String(it.name || '').slice(0, 30), color: it.color, ids: mine });
    }
  }
  for (const s of servers) if (!seen.has(s.id)) out.push({ s: s.id });
  return out;
}

const without = (l, key) => l.filter((it) => keyOf(it) !== key);
const indexOfKey = (l, key) => l.findIndex((it) => keyOf(it) === key);

// Put the item with `dragKey` before or after the item with `overKey`.
export function reorder(l, dragKey, overKey, after) {
  if (dragKey === overKey) return l;
  const item = l.find((it) => keyOf(it) === dragKey);
  if (!item) return l;
  const rest = without(l, dragKey);
  const at = indexOfKey(rest, overKey);
  if (at < 0) return l;
  rest.splice(after ? at + 1 : at, 0, item);
  return rest;
}

// Drop a server on another server (they become a new folder, in the place of the one underneath) or on a folder (it joins it).
export function groupInto(l, serverId, overKey, info) {
  const over = l.find((it) => keyOf(it) === overKey);
  if (!over || over.s === serverId) return l;
  if (over.f) {
    return without(l, 's:' + serverId).map((it) => (it.f === over.f ? { ...it, ids: [...it.ids, serverId] } : it));
  }
  const folder = { f: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: info.name, color: info.color, ids: [over.s, serverId] };
  return without(l, 's:' + serverId).map((it) => (keyOf(it) === overKey ? folder : it));
}

// Reorder inside a folder.
export function reorderIn(l, folderId, serverId, overId, after) {
  return l.map((it) => {
    if (it.f !== folderId || serverId === overId) return it;
    const rest = it.ids.filter((id) => id !== serverId);
    const at = rest.indexOf(overId);
    if (at < 0 || !it.ids.includes(serverId)) return it;
    rest.splice(after ? at + 1 : at, 0, serverId);
    return { ...it, ids: rest };
  });
}

// Take a server out of its folder; it lands on the bar right after the folder. An emptied folder goes away.
export function takeOut(l, folderId, serverId) {
  const out = [];
  for (const it of l) {
    if (it.f !== folderId) { out.push(it); continue; }
    const ids = it.ids.filter((id) => id !== serverId);
    if (ids.length) out.push({ ...it, ids });
    out.push({ s: serverId });
  }
  return out;
}

export const editFolder = (l, folderId, info) => l.map((it) => (it.f === folderId ? { ...it, name: info.name, color: info.color } : it));

// A deleted folder leaves its servers where it was.
export const deleteFolder = (l, folderId) => l.flatMap((it) => (it.f === folderId ? it.ids.map((id) => ({ s: id })) : [it]));
