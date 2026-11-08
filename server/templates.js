// Server templates: what a new server starts with. Pure, so server/templates-test.js can run it without a server; index.js uses it in POST /api/servers.
// build(id, newId) returns the pieces to put on the new server: { categories, channels, roles }.
//
// Four templates:
//   standard   the plain start: a couple of text channels and a voice channel.
//   business   announcements, general, a to-do channel (the Manager role can add tasks) and meetings, with Manager and Team roles.
//   community  rules, announcements, goals, chat and voice. It already has what a public server needs (see PUBLISH_REQ / PUBLIC_REQ in index.js).
//   chill      a relaxed hangout: chat, music, memes and two voice rooms.
//
// Keep ids in sync with client/src/templates.js, which draws the cards.

const IDS = ['standard', 'business', 'community', 'chill'];
const DEFAULT = 'standard';

// channels: { name, type, cat (a category key), rules? (starter rules), addRoles? (role keys that may add tasks) }
const TEMPLATES = {
  standard: {
    categories: [{ key: 'text', name: 'Text' }, { key: 'voice', name: 'Voice' }],
    roles: [],
    channels: [
      { name: 'general', type: 'text', cat: 'text' },
      { name: 'off-topic', type: 'text', cat: 'text' },
      { name: 'voice', type: 'voice', cat: 'voice' },
    ],
  },
  business: {
    categories: [{ key: 'info', name: 'Company' }, { key: 'work', name: 'Work' }, { key: 'meet', name: 'Meetings' }],
    roles: [
      { key: 'manager', name: 'Manager', color: '#e67e22', perms: ['manageChannels', 'manageMessages', 'postAnnouncements', 'mentionEveryone'] },
      { key: 'team', name: 'Team', color: '#3498db', perms: [] },
    ],
    channels: [
      { name: 'general', type: 'text', cat: 'work' }, // first, because the first channel is where people land; the categories keep the sidebar order
      { name: 'announcements', type: 'announcements', cat: 'info' },
      { name: 'tasks', type: 'todo', cat: 'work', addRoles: ['manager'] },
      { name: 'meetings', type: 'voice', cat: 'meet' },
    ],
  },
  community: {
    categories: [{ key: 'info', name: 'Info' }, { key: 'text', name: 'Chat' }, { key: 'voice', name: 'Voice' }],
    roles: [
      { key: 'mod', name: 'Moderator', color: '#2ecc71', perms: ['manageMessages', 'kickMembers'] },
    ],
    channels: [
      { name: 'general', type: 'text', cat: 'text' }, // first, because the first channel is where people land; the categories keep the sidebar order
      { name: 'rules', type: 'rules', cat: 'info', rules: ['Be kind and respectful to everyone.', 'No spam, scams or self-promotion without asking.', 'Keep chats on topic and use the right channel.'] },
      { name: 'announcements', type: 'announcements', cat: 'info' },
      { name: 'goals', type: 'goals', cat: 'info' },
      { name: 'introductions', type: 'text', cat: 'text' },
      { name: 'media', type: 'text', cat: 'text' },
      { name: 'lounge', type: 'voice', cat: 'voice' },
      { name: 'hangout', type: 'voice', cat: 'voice' },
    ],
  },
  chill: {
    categories: [{ key: 'text', name: 'Chat' }, { key: 'voice', name: 'Voice' }],
    roles: [],
    channels: [
      { name: 'general', type: 'text', cat: 'text' },
      { name: 'music', type: 'text', cat: 'text' },
      { name: 'memes', type: 'text', cat: 'text' },
      { name: 'chill-room', type: 'voice', cat: 'voice' },
      { name: 'late-night', type: 'voice', cat: 'voice' },
    ],
  },
};

// The pieces for a new server. `newId` makes an id (store.id). The first channel is always a text channel, because that is where people land.
function build(id, newId) {
  const t = TEMPLATES[IDS.includes(id) ? id : DEFAULT];
  const catId = Object.fromEntries(t.categories.map((c) => [c.key, newId()]));
  const roleId = Object.fromEntries(t.roles.map((r) => [r.key, newId()]));
  const channels = t.channels.map((c) => {
    const ch = { id: newId(), name: c.name, type: c.type, categoryId: catId[c.cat] };
    if (c.type === 'rules') ch.rules = (c.rules || []).map((text) => ({ id: newId(), text }));
    if (c.type === 'todo') { ch.addRoles = (c.addRoles || []).map((k) => roleId[k]); ch.todos = []; }
    if (c.type === 'goals') ch.goals = [];
    return ch;
  });
  return {
    categories: t.categories.map((c) => ({ id: catId[c.key], name: c.name })),
    // roles go top to bottom, highest first (index 0 is the top role), which is the order listed above
    roles: t.roles.map((r) => ({ id: roleId[r.key], name: r.name, color: r.color, perms: [...r.perms] })),
    channels,
  };
}

module.exports = { IDS, DEFAULT, TEMPLATES, build };
