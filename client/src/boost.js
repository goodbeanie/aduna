// Server boosts on the client. The server sends `boost: { level, boosters: [{ userId, level, endsAt }] }` inside each server's view
// (rules: server/boosts.js). The level is worked out again from the end times here, so a boost that ran out while the app stayed open stops counting.
export const boostLevelNow = (server, now = Date.now()) =>
  ((server && server.boost && server.boost.boosters) || []).reduce((top, b) => (b.endsAt > now ? Math.max(top, b.level) : top), 0);

// the booster tag in chat: this person has a boost running on this server
export const boosterOf = (server, userId, now = Date.now()) =>
  ((server && server.boost && server.boost.boosters) || []).find((b) => b.userId === userId && b.endsAt > now) || null;
