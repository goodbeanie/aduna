// The server templates shown when you create a server. The ids must match server/templates.js, which builds the channels, categories and roles.
// `has` is the short list shown under each card.
export const TEMPLATES = [
  { id: 'standard', icon: 'message', title: 'Standard', desc: 'The simple start: text chat and a voice channel.', has: ['#general', '#off-topic', 'a voice channel'] },
  { id: 'business', icon: 'bag', title: 'Business', desc: 'Announcements, meetings and a to-do list your team can assign by role.', has: ['To-do channel', 'Manager and Team roles', 'announcements and meetings'] },
  { id: 'community', icon: 'users', title: 'Community', desc: 'Rules, announcements, server goals, chat and voice. Ready to publish.', has: ['rules and announcements', 'goals', 'Moderator role'] },
  { id: 'chill', icon: 'cup', title: 'Chill', desc: 'A relaxed hangout: chat, music, memes and two voice rooms.', has: ['#music', '#memes', 'two voice rooms'] },
];
export const DEFAULT_TEMPLATE = 'standard';
