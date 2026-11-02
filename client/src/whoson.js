// Who's On: who among your friends is around right now, who is in a voice channel, and who is playing what.
// Everything here is already in the app (presence, profiles, who is in each voice channel), so the list updates live with no extra calls.
// People who turned the switch off in Settings > Activity have `listed === false` and are left out. A voice channel counts only when it is in a
// server you are in, and a 1:1 or group call is never shown (those are private to the people on them).

// 'call' (in a voice channel) | 'playing' | 'online'
export function buildWhosOn({ friends = [], users = {}, statusOf, voiceMembers = {}, servers = [] }) {
  const where = new Map(); // userId -> { serverId, serverName, channelId, channelName }
  for (const s of servers) {
    for (const c of s.channels || []) {
      if (c.type !== 'voice') continue;
      for (const id of voiceMembers[c.id] || []) if (!where.has(id)) where.set(id, { serverId: s.id, serverName: s.name, channelId: c.id, channelName: c.name });
    }
  }
  const out = { call: [], playing: [], online: [] };
  for (const f of friends) {
    const user = users[f.id] || f;
    if (!user || user.bot || user.listed === false) continue;
    const status = statusOf(user.id);
    if (status === 'offline') continue;
    const at = where.get(user.id) || null;
    const activity = user.activity && user.activity.name ? user.activity : null;
    const row = { user, status, activity, at };
    if (at) out.call.push(row); else if (activity) out.playing.push(row); else out.online.push(row);
  }
  const byName = (a, b) => a.user.displayName.localeCompare(b.user.displayName, undefined, { sensitivity: 'base' });
  out.call.sort((a, b) => a.at.serverName.localeCompare(b.at.serverName) || a.at.channelName.localeCompare(b.at.channelName) || byName(a, b));
  out.playing.sort((a, b) => a.activity.name.localeCompare(b.activity.name) || byName(a, b));
  out.online.sort(byName);
  return out;
}

export const countOn = (w) => w.call.length + w.playing.length + w.online.length;
