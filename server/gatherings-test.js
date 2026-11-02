// Gathering (Events) rules without a server: node server/gatherings-test.js
const assert = require('assert');
const G = require('./gatherings');
const step = (m) => console.log('✓', m);

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0); // "now" for the tests: Sunday 1 November 2026, noon UTC
const server = () => ({
  id: 's1', members: ['host', 'ann', 'bob', 'cy'],
  channels: [{ id: 'gen', name: 'general', type: 'text' }, { id: 'vc', name: 'Game night', type: 'voice' }, { id: 'vc2', name: 'Lounge', type: 'voice' }],
});
const friday8 = T0 + 5 * DAY + 8 * HOUR; // some time on Friday

// ---- making one: every field is checked ----
let r = G.parse(server(), { title: '  Game night  ', desc: 'Bring snacks', startsAt: friday8, channelId: 'vc' }, T0);
assert.deepStrictEqual(r.value, { title: 'Game night', desc: 'Bring snacks', startsAt: friday8, endsAt: friday8 + 2 * HOUR, channelId: 'vc' });
step('a new event: trimmed name, two hours long unless said, a voice channel');

assert.deepStrictEqual(G.parse(server(), { title: 'x', startsAt: friday8 }, T0).value, { title: 'x', desc: '', startsAt: friday8, endsAt: friday8 + 2 * HOUR, channelId: null }, 'description and channel are optional');
assert.ok(G.parse(server(), { startsAt: friday8 }, T0).error, 'a name is needed');
assert.ok(G.parse(server(), { title: '   ', startsAt: friday8 }, T0).error, 'an empty name');
assert.ok(G.parse(server(), { title: 'x'.repeat(61), startsAt: friday8 }, T0).error, 'a name of 61 characters');
assert.strictEqual(G.parse(server(), { title: 'x'.repeat(60), startsAt: friday8 }, T0).value.title.length, 60);
assert.strictEqual(G.parse(server(), { title: 'a<b>c\u0000d\n e', startsAt: friday8 }, T0).value.title, 'a b c d e', 'markup, control characters and line breaks become spaces');
assert.strictEqual(G.parse(server(), { title: 'Night', desc: 'one\r\n\r\n\r\n\r\ntwo  three', startsAt: friday8 }, T0).value.desc, 'one\n\ntwo three', 'a description keeps line breaks (at most one blank line) and drops stray spaces');
assert.ok(G.parse(server(), { title: 'x', desc: 'y'.repeat(501), startsAt: friday8 }, T0).error, 'a description of 501 characters');
assert.ok(G.parse(server(), { title: 'x', desc: 42, startsAt: friday8 }, T0).error, 'a description that is not text');
step('names and descriptions are cleaned and limited');

assert.ok(G.parse(server(), { title: 'x' }, T0).error, 'a start time is needed');
assert.ok(G.parse(server(), { title: 'x', startsAt: '2026-11-06' }, T0).error, 'a start that is not a number');
assert.ok(G.parse(server(), { title: 'x', startsAt: NaN }, T0).error);
assert.ok(G.parse(server(), { title: 'x', startsAt: T0 - 6 * MIN }, T0).error, 'six minutes ago has passed');
assert.ok(!G.parse(server(), { title: 'x', startsAt: T0 - 4 * MIN }, T0).error, 'four minutes ago still counts as now');
assert.ok(G.parse(server(), { title: 'x', startsAt: T0 + 367 * DAY }, T0).error, 'more than a year away');
assert.ok(!G.parse(server(), { title: 'x', startsAt: T0 + 365 * DAY }, T0).error);
assert.ok(G.parse(server(), { title: 'x', startsAt: friday8, endsAt: friday8 + 10 * MIN }, T0).error, 'shorter than 15 minutes');
assert.ok(G.parse(server(), { title: 'x', startsAt: friday8, endsAt: friday8 - HOUR }, T0).error, 'ends before it starts');
assert.ok(G.parse(server(), { title: 'x', startsAt: friday8, endsAt: friday8 + 25 * HOUR }, T0).error, 'longer than a day');
assert.strictEqual(G.parse(server(), { title: 'x', startsAt: friday8, endsAt: friday8 + 3 * HOUR }, T0).value.endsAt, friday8 + 3 * HOUR);
assert.ok(G.parse(server(), { title: 'x', startsAt: friday8, endsAt: 'late' }, T0).error, 'an end that is not a number');
step('times: a start in the future (up to a year), 15 minutes to a day long');

assert.ok(G.parse(server(), { title: 'x', startsAt: friday8, channelId: 'gen' }, T0).error, 'a text channel is not for voice');
assert.ok(G.parse(server(), { title: 'x', startsAt: friday8, channelId: 'nope' }, T0).error, 'a channel the server does not have');
assert.ok(G.parse(server(), { title: 'x', startsAt: friday8, channelId: { id: 'vc' } }, T0).error, 'a channel that is not an id');
assert.strictEqual(G.parse(server(), { title: 'x', startsAt: friday8, channelId: '' }, T0).value.channelId, null);
assert.ok(G.parse(server(), null, T0).error, 'a request with no body');
step('the voice channel must be one of the server\'s voice channels');

// ---- limits ----
{
  const s = server();
  const mk = (uid, n) => { for (let i = 0; i < n; i++) G.create(s, uid, G.parse(s, { title: 'e' + i, startsAt: friday8 + i * HOUR }, T0).value, T0, uid + i + Math.random()); };
  mk('host', 5);
  assert.strictEqual(G.roomFor(s, 'host', T0).ok, false, 'one person: five at a time');
  assert.strictEqual(G.roomFor(s, 'ann', T0).ok, true, 'someone else may still make one');
  assert.strictEqual(G.roomFor(s, 'host', friday8 + 30 * DAY).ok, true, 'once they are over they stop counting');
  mk('ann', 5); mk('bob', 5); mk('cy', 5);
  const four = server(); four.gatherings = Array.from({ length: 25 }, (_, i) => ({ id: 'g' + i, by: 'u' + i, startsAt: friday8, endsAt: friday8 + HOUR, rsvps: {}, reminded: {} }));
  assert.strictEqual(G.roomFor(four, 'ann', T0).ok, false, 'a server holds 25');
  assert.strictEqual(G.roomFor(four, 'ann', friday8 + 2 * HOUR).ok, true, '...that have not ended');
}
step('limits: 5 upcoming events per person, 25 per server, finished ones do not count');

// ---- making and changing ----
{
  const s = server();
  const g = G.create(s, 'host', G.parse(s, { title: 'Game night', startsAt: friday8, channelId: 'vc' }, T0).value, T0, 'g1');
  assert.deepStrictEqual(g.rsvps, { host: 'yes' }, 'the person who made it is going');
  assert.deepStrictEqual(g.reminded, {}, 'a week away: both reminders are still to come');
  assert.strictEqual(G.find(s, 'g1'), g);
  assert.strictEqual(G.find(s, 'nope'), null);
  assert.strictEqual(G.find(s, { id: 'g1' }), null);

  const soon = G.create(s, 'host', G.parse(s, { title: 'Quick', startsAt: T0 + 10 * MIN }, T0).value, T0, 'g2');
  assert.deepStrictEqual(soon.reminded, { soon: -1 }, 'made 10 minutes before the start: no "in 15 minutes" reminder');
  const now = G.create(s, 'host', G.parse(s, { title: 'Now', startsAt: T0 - 2 * MIN }, T0).value, T0, 'g3');
  assert.deepStrictEqual(now.reminded, { soon: -1, start: -1 }, 'made after it started: no reminders at all');

  // changing
  let c = G.parse(s, { title: 'Movie night' }, T0, g);
  assert.deepStrictEqual(c.value, { title: 'Movie night', startsAt: friday8, endsAt: friday8 + 2 * HOUR }, 'only what is sent changes');
  c = G.parse(s, { startsAt: friday8 + 3 * HOUR }, T0, g);
  assert.strictEqual(c.value.endsAt, friday8 + 5 * HOUR, 'moving the start keeps the length');
  c = G.parse(s, { startsAt: friday8, endsAt: friday8 + 3 * HOUR, channelId: null, desc: '' }, T0, g);
  assert.deepStrictEqual(c.value, { desc: '', startsAt: friday8, endsAt: friday8 + 3 * HOUR, channelId: null });
  assert.ok(G.parse(s, { startsAt: T0 - HOUR }, T0, g).error, 'it cannot be moved into the past');
  assert.ok(G.parse(s, { title: '' }, T0, g).error, 'the name cannot be emptied');
  assert.ok(!G.parse(s, { title: 'Still on' }, friday8 + 30 * MIN, g).error, 'an event that is under way can be renamed');
  assert.ok(!G.parse(s, { startsAt: friday8 }, friday8 + 30 * MIN, g).error, '...and keeps its start, which is now in the past');

  g.reminded = { soon: 5, start: 6 };
  G.update(g, { title: 'Movie night' }, T0);
  assert.deepStrictEqual(g.reminded, { soon: 5, start: 6 }, 'a rename does not send the reminders again');
  G.update(g, { startsAt: friday8 + DAY, endsAt: friday8 + DAY + 2 * HOUR }, T0);
  assert.deepStrictEqual(g.reminded, {}, 'a new start time starts the reminders over');
  assert.strictEqual(g.title, 'Movie night');
}
step('making an event: the host is going; changing: only what is sent, a new start restarts the reminders');

// ---- answering ----
{
  const s = server();
  const g = G.create(s, 'host', G.parse(s, { title: 'Game night', startsAt: friday8 }, T0).value, T0, 'g1');
  assert.deepStrictEqual(G.setRsvp(g, 'ann', 'yes', T0), { ok: true });
  assert.deepStrictEqual(G.setRsvp(g, 'bob', 'maybe', T0), { ok: true });
  assert.deepStrictEqual(g.rsvps, { host: 'yes', ann: 'yes', bob: 'maybe' });
  G.setRsvp(g, 'ann', 'maybe', T0);
  assert.strictEqual(g.rsvps.ann, 'maybe', 'a person can change their answer');
  G.setRsvp(g, 'ann', null, T0);
  assert.strictEqual('ann' in g.rsvps, false, 'or take it back');
  assert.ok(G.setRsvp(g, 'cy', 'no', T0).error, 'only going or maybe');
  assert.ok(G.setRsvp(g, 'cy', 'yes ', T0).error);
  assert.ok(G.setRsvp(g, 'cy', undefined, T0).error, 'a missing answer is not "take it back"');
  assert.ok(G.setRsvp(g, 'cy', 'yes', friday8 + 2 * HOUR).error, 'nobody can join an event that is over');
  assert.ok(!G.setRsvp(g, 'cy', 'yes', friday8 + HOUR).error, 'but one that is under way is fine');
  g.rsvps = null;
  assert.deepStrictEqual(G.setRsvp(g, 'cy', 'yes', T0), { ok: true });
  assert.deepStrictEqual(g.rsvps, { cy: 'yes' }, 'a damaged record is repaired');
}
step('answers: going, maybe, change, take back; not for an event that is over');

// ---- what the browser sees ----
{
  const s = server();
  const a = G.create(s, 'host', G.parse(s, { title: 'Later', startsAt: friday8 + DAY, channelId: 'vc2' }, T0).value, T0, 'a');
  const b = G.create(s, 'ann', G.parse(s, { title: 'Sooner', startsAt: friday8, channelId: 'vc' }, T0).value, T0, 'b');
  G.setRsvp(b, 'bob', 'maybe', T0); G.setRsvp(b, 'gone', 'yes', T0); G.setRsvp(b, 'cy', 'yes', T0);
  let v = G.view(s, T0).gatherings;
  assert.deepStrictEqual(v.map((x) => x.id), ['b', 'a'], 'soonest first');
  assert.deepStrictEqual(v[0], { id: 'b', title: 'Sooner', desc: '', startsAt: friday8, endsAt: friday8 + 2 * HOUR, channelId: 'vc', by: 'ann', yes: ['ann', 'cy'], maybe: ['bob'] }, 'people who left the server are not counted; no internal fields leak');
  s.channels = s.channels.filter((c) => c.id !== 'vc');
  assert.strictEqual(G.view(s, T0).gatherings[0].channelId, null, 'a deleted voice channel is simply gone from the event');
  assert.deepStrictEqual(G.view({}, T0), { gatherings: [] });
  assert.strictEqual(G.view(s, friday8 + 2 * HOUR + 30 * MIN).gatherings.length, 2, 'an event that just ended is still listed (as over)');
  assert.deepStrictEqual(G.view(s, friday8 + 3 * HOUR + MIN).gatherings.map((x) => x.id), ['a'], 'an hour after it ended it is gone');
}
step('the view: soonest first, no answers from people who left, ended events linger for an hour');

// ---- reminders ----
{
  const s = server();
  const g = G.create(s, 'host', G.parse(s, { title: 'Game night', startsAt: friday8, channelId: 'vc' }, T0).value, T0, 'g1');
  G.setRsvp(g, 'ann', 'yes', T0); G.setRsvp(g, 'bob', 'maybe', T0); G.setRsvp(g, 'gone', 'yes', T0); // cy never answered
  let d = G.due(s, T0 + 3 * DAY);
  assert.deepStrictEqual(d, { reminders: [], changed: false }, 'long before: nothing');
  d = G.due(s, friday8 - 16 * MIN);
  assert.deepStrictEqual(d, { reminders: [], changed: false }, '16 minutes before: not yet');
  d = G.due(s, friday8 - 15 * MIN);
  assert.deepStrictEqual(d.reminders, [{ gatheringId: 'g1', kind: 'soon', to: ['host', 'ann', 'bob'] }], '15 minutes before: yes and maybe, not the one who never answered, not someone who left');
  assert.strictEqual(d.changed, true);
  assert.deepStrictEqual(G.due(s, friday8 - 14 * MIN), { reminders: [], changed: false }, 'it is only sent once');
  assert.deepStrictEqual(G.due(s, friday8 - 1 * MIN), { reminders: [], changed: false });
  d = G.due(s, friday8 + 20_000);
  assert.deepStrictEqual(d.reminders, [{ gatheringId: 'g1', kind: 'start', to: ['host', 'ann', 'bob'] }], 'at the start: "starting now"');
  assert.deepStrictEqual(G.due(s, friday8 + 5 * MIN), { reminders: [], changed: false }, 'once');
  assert.ok(g.reminded.soon > 0 && g.reminded.start > 0);
}
{
  const s = server();
  const g = G.create(s, 'host', G.parse(s, { title: 'Game night', startsAt: friday8 }, T0).value, T0, 'g1');
  G.setRsvp(g, 'ann', 'yes', T0);
  const inVoice = (uid) => uid === 'ann';
  assert.deepStrictEqual(G.due(s, friday8 - 15 * MIN, { skip: inVoice }).reminders[0].to, ['host'], 'someone already in the voice channel is not reminded');
  const allIn = server();
  G.create(allIn, 'host', G.parse(allIn, { title: 'x', startsAt: friday8 }, T0).value, T0, 'g2');
  const r2 = G.due(allIn, friday8 - 10 * MIN, { skip: () => true });
  assert.deepStrictEqual(r2.reminders, [], 'nobody to remind: nothing is sent');
  assert.strictEqual(r2.changed, true, '...but it is marked as done');
}
{
  // the server was off: a late reminder is dropped, not sent stale
  const s = server();
  const g = G.create(s, 'host', G.parse(s, { title: 'Game night', startsAt: friday8 }, T0).value, T0, 'g1');
  let d = G.due(s, friday8 + 3 * MIN);
  assert.deepStrictEqual(d.reminders.map((x) => x.kind), ['start'], 'back 3 minutes after the start: "starting now" is still useful, "in 15 minutes" is not');
  assert.strictEqual(g.reminded.soon, -1);
  const h = G.create(s, 'host', G.parse(s, { title: 'Other', startsAt: friday8 + DAY }, T0).value, T0, 'g9');
  d = G.due(s, friday8 + DAY + 11 * MIN);
  assert.deepStrictEqual(d.reminders, [], 'back 11 minutes after the start: nothing');
  assert.deepStrictEqual(h.reminded, { soon: -1, start: -1 }, 'both marked as passed, so they are never looked at again');
  assert.strictEqual(G.due(s, friday8 + DAY + 12 * MIN).changed, false);
}
{
  // moved to another time: the reminders come again
  const s = server();
  const g = G.create(s, 'host', G.parse(s, { title: 'Game night', startsAt: friday8 }, T0).value, T0, 'g1');
  assert.strictEqual(G.due(s, friday8 - 15 * MIN).reminders.length, 1);
  G.update(g, G.parse(s, { startsAt: friday8 + DAY }, friday8 - 14 * MIN, g).value, friday8 - 14 * MIN);
  assert.strictEqual(G.due(s, friday8 + 5 * MIN).reminders.length, 0, 'the old time passes quietly');
  assert.strictEqual(G.due(s, friday8 + DAY - 15 * MIN).reminders.length, 1, 'the new time gets its own reminders');
}
{
  // a damaged record does not break the sweep
  const s = server();
  s.gatherings = [{ id: 'x', title: 't', startsAt: friday8, endsAt: friday8 + HOUR, by: 'host', reminded: 'oops', rsvps: undefined }];
  assert.doesNotThrow(() => G.due(s, friday8 - 10 * MIN));
  assert.deepStrictEqual(G.due({}, T0), { reminders: [], changed: false });
}
step('reminders: 15 minutes before and at the start, once, to yes and maybe; not to people already in voice; never stale');

assert.strictEqual(G.reminderText({}, 'soon', ''), 'Starts in 15 minutes');
assert.strictEqual(G.reminderText({}, 'start', 'Game night'), 'Starting now \u00b7 Game night');
step('reminder wording');

// ---- cleaning up ----
{
  const s = server();
  G.create(s, 'host', G.parse(s, { title: 'Old', startsAt: T0 + MIN }, T0).value, T0, 'old');
  G.create(s, 'host', G.parse(s, { title: 'New', startsAt: friday8 }, T0).value, T0, 'new');
  assert.strictEqual(G.prune(s, T0 + 2 * HOUR + 59 * MIN), false, 'less than an hour after it ended: kept');
  assert.strictEqual(G.prune(s, T0 + 3 * HOUR + 2 * MIN), true);
  assert.deepStrictEqual(s.gatherings.map((g) => g.id), ['new']);
  assert.strictEqual(G.prune(s, T0 + 3 * HOUR + 3 * MIN), false, 'nothing left to remove');
  assert.strictEqual(G.prune({}, T0), false);
}
step('old events are deleted an hour after they end');

console.log('gatherings tests passed');
