// Bot runtime rules (botrun.js): what actions may do, payload shapes, and the Guard's limits. No database, no sandbox: node server/botrun-test.js
const assert = require('assert');
const b = require('./botrun');
const step = (m) => console.log('✓', m);

const U1 = 'a'.repeat(16), U2 = 'b'.repeat(16), BOT = 'c'.repeat(16);
const server = {
  id: 's1', members: [U1, U2, BOT],
  channels: [{ id: 'gen', name: 'general' }, { id: 'txt', name: 'chat', type: 'text' }, { id: 'vc', name: 'lounge', type: 'voice' }, { id: 'ru', name: 'rules', type: 'rules' }, { id: 'an', name: 'news', type: 'announcements' }],
};

// ----- planActions -----
{
  const replyOk = (cid, mid) => (mid === 'm-in-gen' && cid === 'gen' ? mid : null);
  const run = (actions, install = {}, mentionUserId = U1) => b.planActions({ actions, server, install, mentionUserId, replyOk });
  let r = run([{ channelId: 'gen', text: 'hi' }, { channelId: 'txt', text: 'yo' }]);
  assert.deepStrictEqual(r.send.map((x) => x.channel.id), ['gen', 'txt'], 'channels without a type count as text');
  r = run([{ channelId: 'vc', text: 'x' }, { channelId: 'ru', text: 'x' }, { channelId: 'an', text: 'x' }, { channelId: 'nope', text: 'x' }, { channelId: 'other-server-chan', text: 'x' }]);
  assert.strictEqual(r.send.length, 0, 'voice, rules, announcements and unknown channels are refused');
  assert.strictEqual(r.dropped.length, 5);
  r = run([{ channelId: 'gen', text: 'a' }, { channelId: 'txt', text: 'b' }], { channels: ['txt'] });
  assert.deepStrictEqual(r.send.map((x) => x.channel.id), ['txt'], 'the install allow-list is honoured');
  r = run([{ channelId: 'gen', text: 'a' }], { channels: [] });
  assert.strictEqual(r.send.length, 0, 'an empty allow-list means no channels, not all of them');
  r = run([{ channelId: 'gen', text: '   ' }, { channelId: 'gen', text: '' }]);
  assert.strictEqual(r.send.length, 0, 'empty text is dropped');
  r = run([{ channelId: 'gen', text: 'x'.repeat(5000) }]);
  assert.strictEqual(r.send[0].text.length, 2000, 'text is clipped');
  r = run([{ channelId: 'gen', text: 'ok', replyTo: 'm-in-gen' }, { channelId: 'txt', text: 'ok', replyTo: 'm-in-gen' }, { channelId: 'gen', text: 'ok', replyTo: '__proto__' }]);
  assert.deepStrictEqual(r.send.map((x) => x.replyTo), ['m-in-gen', null, null], 'replies must point at a message of that channel');
  step('actions: text channels only, allow-list, clipping, replies');
}

// ----- mentions -----
{
  const run = (text, mentionUserId) => b.planActions({ actions: [{ channelId: 'gen', text }], server, install: {}, mentionUserId }).send[0].mentions;
  assert.deepStrictEqual(run(`hello <@${U1}>`, U1), [U1], 'the person being answered may be pinged');
  assert.deepStrictEqual(run(`hello <@${U2}>`, U1), [], 'nobody else can be pinged');
  assert.deepStrictEqual(run(`<@${U1}> <@${U2}> <@${BOT}>`, U1), [U1], 'only the person being answered, whoever else is named');
  assert.deepStrictEqual(run('@everyone wake up', U1), [], '@everyone never pings');
  assert.deepStrictEqual(run(`hello <@${U1}>`, null), [], 'no one to answer, no ping');
  assert.deepStrictEqual(b.planActions({ actions: [{ channelId: 'gen', text: `<@${U1}>` }], server: { ...server, members: [U2, BOT] }, install: {}, mentionUserId: U1 }).send[0].mentions, [], 'someone who left cannot be pinged');
  step('mentions: only the person answered, never @everyone');
}

// ----- hostile action shapes -----
{
  const evil = [null, undefined, 5, 'x', [], { channelId: { toString() { return 'gen'; } }, text: 'x' }, { channelId: 'gen', text: { toString() { return 'x'; } } }, { channelId: 'constructor', text: 'x' }, { channelId: '__proto__', text: 'x' }];
  const r = b.planActions({ actions: evil, server, install: null, mentionUserId: U1 });
  assert.ok(r.send.every((x) => x.channel.id === 'gen'), 'nothing odd gets through');
  assert.strictEqual(b.planActions({ actions: 'nope', server, install: {} }).send.length, 0);
  assert.strictEqual(b.planActions({ actions: [{ channelId: 'gen', text: 'x' }], server: { id: 's', members: [], channels: null }, install: {} }).send.length, 0, 'a server without channels');
  step('hostile action shapes do not throw or slip through');
}

// ----- payloads -----
{
  const msg = { id: 'm1', channelId: 'gen', serverId: 's1', content: `hi <@${BOT}>`, mentions: [BOT], attachments: [{}, {}], createdAt: 5, replyTo: null };
  const p = b.messagePayload({ msg, author: { id: U1, username: 'ann', displayName: 'Ann', passHash: 'SECRET', email: 'a@b.c' }, botUserId: BOT });
  assert.deepStrictEqual(Object.keys(p).sort(), ['attachments', 'author', 'channelId', 'createdAt', 'id', 'mentions', 'mentionsBot', 'replyTo', 'serverId', 'text'].sort());
  assert.deepStrictEqual([p.mentionsBot, p.attachments, p.author], [true, 2, { id: U1, username: 'ann', displayName: 'Ann', bot: false }]);
  assert.ok(!JSON.stringify(p).includes('SECRET') && !JSON.stringify(p).includes('a@b.c'), 'private user fields never go to a bot');
  assert.strictEqual(b.messagePayload({ msg: { ...msg, mentions: [U2] }, author: { id: U1 }, botUserId: BOT }).mentionsBot, false);
  const j = b.joinPayload({ server, user: { id: U2, username: 'bo', displayName: 'Bo' }, install: { channels: ['txt'] } });
  assert.deepStrictEqual(j.channels, [{ id: 'txt', name: 'chat' }], 'a join event lists only the channels the bot may write in');
  assert.deepStrictEqual(b.joinPayload({ server, user: { id: U2 }, install: {} }).channels.map((c) => c.id), ['gen', 'txt']);
  step('payloads carry only public fields');
}

// ----- Guard -----
{
  let t = 1_000_000;
  const g = new b.Guard({ now: () => t, limits: { eventsPerMin: 3, messagesPerMin: 4, cpuMsPerMin: 100, timeoutStrikes: 2, pauseMs: 10_000, logKeep: 3 } });
  assert.ok(g.admit('b1', 's1').ok && g.admit('b1', 's1').ok && g.admit('b1', 's1').ok);
  assert.strictEqual(g.admit('b1', 's1').ok, false, 'events per minute are capped');
  assert.ok(g.admit('b1', 's2').ok, 'per server: another server has its own budget');
  assert.ok(g.admit('b2', 's1').ok, 'per bot');
  t += 61_000;
  assert.ok(g.admit('b1', 's1').ok, 'the window slides');
  step('guard: events per minute per bot per server');

  assert.strictEqual(g.takeMessages('b1', 's1', 3), 3);
  assert.strictEqual(g.takeMessages('b1', 's1', 3), 1, 'only what is left of the minute is granted');
  assert.strictEqual(g.takeMessages('b1', 's1', 3), 0);
  assert.strictEqual(g.takeMessages('b1', 's2', 2), 2, 'per server');
  t += 61_000;
  assert.strictEqual(g.takeMessages('b1', 's1', 9), 4);
  step('guard: messages per minute');

  t += 61_000;
  g.record('b3', { ms: 60 }); assert.ok(g.admit('b3', 's1').ok);
  g.record('b3', { ms: 60 });
  let a = g.admit('b3', 's9'); assert.deepStrictEqual([a.ok, /CPU/.test(a.reason)], [false, true], 'CPU time is a budget across all of a bot\'s servers');
  t += 61_000; assert.ok(g.admit('b3', 's1').ok, 'and it refills');
  g.record('b4', { ms: 1e12 }); assert.strictEqual(g.admit('b4', 's1').ok, false, 'a huge ms is capped, not trusted');
  step('guard: CPU budget');

  t += 61_000;
  assert.strictEqual(g.record('b5', { ms: 100, timedOut: true }).paused, false);
  assert.strictEqual(g.record('b5', { ms: 5, ok: true }).paused, false, 'a good run resets the strikes');
  g.record('b5', { ms: 100, timedOut: true });
  assert.strictEqual(g.record('b5', { ms: 100, timedOut: true }).paused, true, 'two timeouts in a row pause the bot');
  a = g.admit('b5', 's1'); assert.deepStrictEqual([a.ok, /paused/.test(a.reason)], [false, true]);
  assert.ok(g.pausedUntil('b5') > t);
  t += 61_000; assert.ok(g.admit('b5', 's1').ok, 'the pause ends');
  g.record('b6', { ms: 1, error: 'The bot used too much memory and was stopped' }); g.record('b6', { ms: 1, error: 'The bot sandbox crashed' });
  assert.ok(g.pausedUntil('b6'), 'out-of-memory and crashes count as strikes');
  g.resume('b6'); assert.strictEqual(g.pausedUntil('b6'), 0, 'resume (saving new code) lifts a pause');
  g.record('b7', { ms: 1, error: 'TypeError: x is not a function' }); g.record('b7', { ms: 1, error: 'TypeError: x is not a function' });
  assert.strictEqual(g.pausedUntil('b7'), 0, 'ordinary errors are logged, not punished');
  step('guard: timeouts pause a bot; errors do not');

  for (let i = 0; i < 5; i++) g.log('b8', { n: i });
  assert.deepStrictEqual(g.logs('b8').map((e) => e.n), [4, 3, 2], 'newest first, bounded');
  g.forget('b8'); assert.deepStrictEqual(g.logs('b8'), []);
  g.admit('b9', 's1'); g.forget('b9'); assert.ok(![...g.events.keys()].some((k) => k.startsWith('b9:')), 'forget clears everything for a deleted bot');
  step('guard: bounded log, forget');
}

console.log('\nAll bot runtime checks passed.');
