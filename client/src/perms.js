// Roles and permissions, mirrored from server/index.js (the server repeats every check; this only decides what to show).
// server.roles is ordered highest first, server.everyone is what every member can do, server.memberRoles is { userId: [roleId] }.
export const PERMS = [
  { id: 'administrator', label: 'Administrator', desc: 'Has every permission. Give this out carefully.', danger: true },
  { id: 'manageServer', label: 'Manage server', desc: 'Change the name, icon, banner, theme, tags and invite link.' },
  { id: 'manageRoles', label: 'Manage roles', desc: 'Create and edit roles below their own, and give them to members.' },
  { id: 'manageChannels', label: 'Manage channels', desc: 'Create, rename, reorder and delete channels and categories, and edit rules.' },
  { id: 'manageMessages', label: 'Manage messages', desc: "Delete other people's messages." },
  { id: 'kickMembers', label: 'Kick members', desc: 'Remove members from the server. They can rejoin with the invite link.' },
  { id: 'mentionEveryone', label: 'Mention @everyone', desc: 'Notify the whole server with @everyone.' },
  { id: 'postAnnouncements', label: 'Post announcements', desc: 'Post in announcement channels.' },
];
const ALL = PERMS.map((p) => p.id);

export function permsOf(server, uid) {
  if (!server || !uid) return new Set();
  if (uid === server.ownerId) return new Set(ALL);
  const set = new Set(server.everyone || []);
  for (const r of heldRoles(server, uid)) for (const p of r.perms) set.add(p);
  return set.has('administrator') ? new Set(ALL) : set;
}
export const can = (server, uid, perm) => permsOf(server, uid).has(perm);

// the member's roles, highest first
export function heldRoles(server, uid) {
  const ids = (server?.memberRoles || {})[uid] || [];
  return (server?.roles || []).filter((r) => ids.includes(r.id));
}
// 0 = top role, larger = lower; -1 = owner; Infinity = no role
export function rankOf(server, uid) {
  if (uid === server.ownerId) return -1;
  const ids = (server.memberRoles || {})[uid] || [];
  const idx = (server.roles || []).map((r, i) => (ids.includes(r.id) ? i : -1)).filter((i) => i >= 0);
  return idx.length ? Math.min(...idx) : Infinity;
}
// may this person change this role (it sits strictly below their top role)?
export const belowMe = (server, uid, roleId) => uid === server.ownerId || (server.roles || []).findIndex((r) => r.id === roleId) > rankOf(server, uid);

// the name colour a member's top coloured role gives them (undefined = their own accent colour)
export const roleColorOf = (server, uid) => heldRoles(server, uid).find((r) => r.color)?.color;

// does this person have any server-management power at all (shows "Server settings")?
export const canManageAny = (server, uid) => ['manageServer', 'manageRoles', 'manageChannels', 'kickMembers'].some((p) => can(server, uid, p)) || uid === server.ownerId;

// The member list, grouped like Discord: the owner and then each role (highest first) list their members who are online,
// then everyone else who is online, then everyone offline (offline people keep their role colour on their name).
// `textOf(member)` is what `q` is matched against (name and username).
export function memberGroups(server, members, isOnline, textOf, q) {
  const needle = String(q || '').trim().toLowerCase();
  const list = needle ? members.filter((m) => textOf(m).toLowerCase().includes(needle)) : members;
  const groups = [], placed = new Set();
  const take = (key, label, color, pick) => {
    const items = list.filter((m) => !placed.has(m.id) && isOnline(m.id) && pick(m));
    if (!items.length) return;
    items.forEach((m) => placed.add(m.id));
    groups.push({ key, label, color, items });
  };
  take('owner', 'Owner', null, (m) => m.id === server.ownerId);
  (server.roles || []).forEach((r, i) => take('r:' + r.id, r.name, r.color || null, (m) => rankOf(server, m.id) === i));
  take('online', 'Online', null, () => true);
  const off = list.filter((m) => !placed.has(m.id));
  if (off.length) groups.push({ key: 'offline', label: 'Offline', color: null, items: off, off: true });
  return { groups, total: list.length };
}
