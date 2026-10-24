// Where you stopped reading each conversation: 'c:<channelId>' / 'd:<userId>' -> createdAt of the newest message you had reached.
// The "New messages" line goes after it the next time you open that chat.
// Memory only, like the DM unread counts: direct messages are end-to-end encrypted, so nothing about them is stored.
const seen = new Map();

export const getSeen = (key) => (key && seen.get(key)) || 0;

export function markSeen(key, ts) {
  if (key && Number.isFinite(ts) && ts > getSeen(key)) seen.set(key, ts);
}

export const clearSeen = () => seen.clear(); // on sign-out
