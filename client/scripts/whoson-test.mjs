// Who's On rules without a browser: node client/scripts/whoson-test.mjs
import assert from 'node:assert';
import { buildWhosOn, countOn } from '../src/whoson.js';

const step = (m) => console.log('✓', m);
const u = (id, extra = {}) => ({ id, displayName: id, username: id, ...extra });
const status = { ann: 'online', bob: 'idle', cy: 'online', dee: 'offline', eli: 'online', fay: 'dnd', bot1: 'online', gus: 'online' };
const statusOf = (id) => status[id] || 'offline';
const servers = [
  { id: 's1', name: 'Crew', channels: [{ id: 'c1', name: 'general', type: 'text' }, { id: 'v1', name: 'Lounge', type: 'voice' }] },
  { id: 's2', name: 'Others', channels: [{ id: 'v2', name: 'Chill', type: 'voice' }] },
];
const users = {
  ann: u('ann', { activity: { name: 'Minecraft', since: 1, source: 'auto' } }),
  bob: u('bob'),
  cy: u('cy', { activity: { name: 'Chess', since: 1, source: 'manual' } }),
  dee: u('dee'),
  eli: u('eli', { listed: false, activity: null }),
  fay: u('fay'),
  bot1: u('bot1', { bot: true }),
  gus: u('gus', { listed: false }),
};
const friends = Object.values(users);

{
  const w = buildWhosOn({ friends, users, statusOf, voiceMembers: { v1: ['ann'], v2: ['gus'] }, servers });
  assert.deepStrictEqual(w.call.map((r) => r.user.id), ['ann'], 'in a voice channel: listed with the channel and server');
  assert.deepStrictEqual([w.call[0].at.channelName, w.call[0].at.serverName], ['Lounge', 'Crew']);
  assert.strictEqual(w.call[0].activity.name, 'Minecraft', 'a game is kept next to the call');
  assert.deepStrictEqual(w.playing.map((r) => r.user.id), ['cy']);
  assert.deepStrictEqual(w.online.map((r) => r.user.id), ['bob', 'fay'], 'idle and do not disturb still count as on; sorted by name');
  assert.ok(![...w.call, ...w.playing, ...w.online].some((r) => ['dee', 'eli', 'gus', 'bot1'].includes(r.user.id)), 'offline, hidden and bots are left out, even when in a call');
  assert.strictEqual(countOn(w), 4);
}
step('call, playing and online groups; offline, hidden and bots are left out');

{
  // a voice channel in a server you are not in is never shown
  const w = buildWhosOn({ friends: [users.cy], users, statusOf, voiceMembers: { vX: ['cy'] }, servers });
  assert.strictEqual(w.call.length, 0);
  assert.deepStrictEqual(w.playing.map((r) => r.user.id), ['cy']);
  // fresher profile in `users` wins over the copy in the friends list
  const stale = u('bob', { listed: true });
  const w2 = buildWhosOn({ friends: [stale], users: { bob: u('bob', { listed: false }) }, statusOf, voiceMembers: {}, servers });
  assert.strictEqual(countOn(w2), 0);
  assert.strictEqual(countOn(buildWhosOn({ friends: [], users: {}, statusOf, voiceMembers: {}, servers: [] })), 0);
}
step('only voice channels of your own servers; the live profile decides; empty lists are fine');

console.log('\nwhoson-test: all passed');
