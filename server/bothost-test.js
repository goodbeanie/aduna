// The host side of bots (bothost.js) against the REAL sandbox, with a fake database, fake sockets and a fake fetcher. No Postgres, no Express:
//   node server/bothost-test.js
const assert = require('assert');
const { createBotHost } = require('./bothost');
const botrun = require('./botrun');
const botstate = require('./botstate');
const sandbox = require('./sandbox');
const step = (m) => console.log('✓', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) assert.fail('timed out waiting for ' + what); await sleep(10); } };

const A = 'a'.repeat(16), BU = 'b'.repeat(16), BU2 = 'e'.repeat(16), BOT = '1'.repeat(16), BOT2 = '2'.repeat(16);
function world() {
  const data = {
    users: { [A]: { id: A, username: 'ann', displayName: 'Ann' }, [BU]: { id: BU, username: 'bot-1', displayName: 'Bot', bot: true }, [BU2]: { id: BU2, username: 'bot-2', displayName: 'Bot2', bot: true } },
    bots: { [BOT]: { id: BOT, code: '' }, [BOT2]: { id: BOT2, code: '' } },
    messages: { m1: { id: 'm1', channelId: 'gen', serverId: 's1', authorId: A, content: 'hello', reactions: {} }, mOther: { id: 'mOther', channelId: 'other', serverId: 's2', authorId: A, content: 'x', reactions: {} }, mVoice: { id: 'mVoice', channelId: 'vc', serverId: 's1', authorId: A, content: 'x', reactions: {} } },
    servers: { s1: { id: 's1', name: 'Home', members: [A, BU, BU2], channels: [{ id: 'gen', name: 'general' }, { id: 'side', name: 'side', type: 'text' }, { id: 'vc', name: 'voice', type: 'voice' }], installedBots: [{ botId: BOT, userId: BU, channels: null }] } },
  };
  const w = { data, saves: 0, posted: [], emitted: [], fetchCalls: [], fetchDelay: 5, clock: 1_000_000_000_000, fetchAnswer: { ok: true, status: 200, text: '{"stars":7}', json: { stars: 7 }, truncated: false, error: null } };
  w.set = (code, botId = BOT) => { data.bots[botId].code = code; };
  w.host = createBotHost({
    db: () => data, store: { save: () => { w.saves++; } },
    io: { to: (room) => ({ emit: (ev, p) => w.emitted.push({ room, ev, p: JSON.parse(JSON.stringify(p)) }) }) },
    sandbox,
    fetcher: { check: (u) => (/^https:\/\/api\.github\.com\//.test(u) ? { url: u } : { error: 'not allowed' }), get: async (u) => { w.fetchCalls.push(u); await sleep(w.fetchDelay); return w.fetchAnswer; } },
    postMessage: (s, channel, botUser, a) => w.posted.push({ server: s.id, channel: channel.id, as: botUser.id, text: a.text, replyTo: a.replyTo, mentions: a.mentions }),
    emojiOk: (e) => e === '👍' || e === '🎉', now: () => w.clock, tickMs: 60_000,
  });
  w.inst = () => data.servers.s1.installedBots[0];
  w.say = (text, over = {}) => w.host.dispatch(data.servers.s1, 'message', { channel: data.servers.s1.channels[0], msg: { id: 'm1', channelId: 'gen', serverId: 's1', content: text, mentions: [], createdAt: 1, ...over }, author: data.users[A] });
  w.idle = async () => { await sleep(30); await until(() => w.host.guard.logs(BOT).length >= 0, 'idle'); };
  return w;
}

(async () => {
  await sandbox.ready();

  // ----- storage: a counter that survives between events -----
  {
    const w = world();
    w.set(`bot.on('message', (m) => { const n = bot.store.incr('count'); bot.store.set('last', { by: m.author.username, n }); bot.reply(m, 'message number ' + n); });`);
    w.say('a'); await until(() => w.posted.length === 1, 'first reply');
    w.say('b'); w.say('c'); await until(() => w.posted.length === 3, 'three replies');
    assert.deepStrictEqual(w.posted.map((p) => p.text), ['message number 1', 'message number 2', 'message number 3'], 'events for one bot run one after the other, so every event sees the one before');
    assert.deepStrictEqual([w.inst().kv.count, JSON.parse(w.inst().kv.last)], ['3', { by: 'ann', n: 3 }]);
    assert.ok(w.saves >= 3, 'saved before posting');
    step('storage: a counter that survives events; events for one bot run in order');
  }
  // reads see the stored value; writes inside one event are seen by later reads in that event; bad things are refused
  {
    const w = world();
    w.inst().kv = { greeting: '"hi"' };
    w.set(`bot.on('message', (m) => {
      bot.log('read', bot.store.get('greeting'), bot.store.get('nope'));
      bot.store.set('x', [1,2]); bot.log('after set', bot.store.get('x'), bot.store.keys().join(','));
      bot.store.delete('greeting'); bot.log('after delete', bot.store.get('greeting'));
      try { bot.store.set('f', () => 1); } catch (e) { bot.log('threw', e.name); }
      bot.store.set('bad key!', 1); bot.store.set('big', 'y'.repeat(5000));
    });`);
    w.say('go'); const e = await until(() => w.host.guard.logs(BOT)[0], 'log');
    assert.deepStrictEqual(e.logs, ['read hi undefined', 'after set [1,2] greeting,x', 'after delete undefined', 'threw TypeError'], JSON.stringify(e));
    assert.deepStrictEqual(w.inst().kv, { x: '[1,2]' }, 'the bad key and the oversized value were refused, the rest applied');
    assert.strictEqual(e.dropped.length, 2, JSON.stringify(e.dropped));
    assert.ok(e.stored >= 3);
    step('storage reads, in-event writes, refusals are reported to the developer');
  }
  {
    const w = world();
    w.inst().kv = { other: '1' };
    w.set(`bot.on('message', () => { while (true) {} });`);
    w.say('hang'); await until(() => w.host.guard.logs(BOT)[0], 'timeout log');
    assert.deepStrictEqual(w.inst().kv, { other: '1' });
    w.set(`bot.on('message', (m) => { bot.store.set('before', 1); throw new Error('boom'); });`);
    w.say('boom'); await until(() => w.host.guard.logs(BOT).length === 2, 'second log');
    assert.strictEqual(w.inst().kv.before, '1', 'what a bot stored before it failed is kept (like messages it sent before failing)');
    step('a bot that fails halfway keeps its earlier writes; a hung bot changes nothing');
  }
  // storage is private to the install: another server gets nothing, removing the bot erases it
  {
    const w = world();
    w.data.servers.s2 = { id: 's2', name: 'Other', members: [A, BU], channels: [{ id: 'other', name: 'x' }], installedBots: [{ botId: BOT, userId: BU, channels: null }] };
    w.set(`bot.on('message', (m) => { const n = bot.store.incr('count'); bot.reply(m, 'n=' + n); });`);
    w.say('a'); await until(() => w.posted.length === 1, 'reply in s1');
    w.host.dispatch(w.data.servers.s2, 'message', { channel: w.data.servers.s2.channels[0], msg: { id: 'mOther', channelId: 'other', serverId: 's2', content: 'a', mentions: [], createdAt: 1 }, author: w.data.users[A] });
    await until(() => w.posted.length === 2, 'reply in s2');
    assert.deepStrictEqual(w.posted.map((p) => p.text), ['n=1', 'n=1'], 'each server has its own storage');
    assert.deepStrictEqual([w.data.servers.s1.installedBots[0].kv.count, w.data.servers.s2.installedBots[0].kv.count], ['1', '1']);
    step('storage is per bot per server');
  }

  // ----- reactions -----
  {
    const w = world();
    w.set(`bot.on('message', (m) => { if (m.text === 'two') { bot.react({ id: 'mVoice' }, '👍'); bot.react({ id: '__proto__' }, '🎉'); return; } bot.react(m, '👍'); bot.react(m, '👍'); bot.react({ id: 'mOther' }, '👍'); bot.react(m, 'word'); bot.react(m, '🎉'); });`);
    w.say('hi'); const e = await until(() => w.host.guard.logs(BOT)[0], 'log');
    assert.deepStrictEqual(w.data.messages.m1.reactions, { '👍': [BU], '🎉': [BU] }, JSON.stringify(w.data.messages.m1.reactions));
    assert.deepStrictEqual([w.data.messages.mOther.reactions, w.data.messages.mVoice.reactions], [{}, {}], 'no reactions in other servers');
    assert.strictEqual(e.reacted, 2);
    assert.ok(e.dropped.some((d) => /unknown message/.test(d)) && e.dropped.some((d) => /not an emoji/.test(d)), JSON.stringify(e.dropped));
    const ev = w.emitted.filter((x) => x.ev === 'reaction:update');
    assert.ok(ev.length === 2 && ev.every((x) => x.room === 'channel:gen' && x.p.messageId === 'm1' && x.p.kind === 'channel'), JSON.stringify(ev));
    w.say('two'); const e2 = await until(() => w.host.guard.logs(BOT)[0].dropped.length && w.host.guard.logs(BOT)[0], 'voice');
    assert.deepStrictEqual([w.data.messages.mVoice.reactions, e2.dropped.length], [{}, 2], 'not in a voice channel, not for __proto__: ' + JSON.stringify(e2.dropped));
    w.say('again'); await until(() => w.host.guard.logs(BOT).length === 3, 'third');
    assert.strictEqual(w.data.messages.m1.reactions['👍'].length, 1, 'the same bot cannot react twice with the same emoji');
    step('reactions: only this server and channels the bot may read, real emoji only, once each, live update sent');
  }
  {
    const w = world();
    w.data.messages.m1.reactions = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['e' + i, [A]]));
    w.set(`bot.on('message', (m) => bot.react(m, '👍'));`);
    w.say('x'); await until(() => w.host.guard.logs(BOT)[0], 'log');
    assert.ok(!('👍' in w.data.messages.m1.reactions), 'a message that already has 20 kinds takes no new kind (same cap as people)');
    step('the 20-kinds cap people have applies to bots');
  }

  // ----- timers -----
  {
    const w = world();
    w.set(`
      bot.on('install', (e) => { bot.timer.every('beat', 60, { n: 0 }); bot.timer.daily('morning', '09:00', 'UTC'); bot.timer.after('hello', 5, { hi: true }); });
      bot.on('timer', (e) => { bot.store.incr('fired:' + e.name); bot.send(e.channels[0].id, 'timer ' + e.name + ' ' + JSON.stringify(e.data)); });`);
    w.host.dispatchTo(w.data.servers.s1, w.inst(), 'install', { by: w.data.users[A] });
    await until(() => w.inst().timers && w.inst().timers.length === 3, 'timers created');
    assert.deepStrictEqual(w.inst().timers.map((t) => t.name).sort(), ['beat', 'hello', 'morning']);
    // nothing due yet
    w.host.tick(); await sleep(50); assert.strictEqual(w.posted.length, 0);
    w.clock += 6_000; w.host.tick();
    await until(() => w.posted.length === 1, 'the 5 s timer');
    assert.strictEqual(w.posted[0].text, 'timer hello {"hi":true}');
    assert.ok(!w.inst().timers.some((t) => t.name === 'hello'), 'a one-shot timer is gone');
    w.host.tick(); await sleep(50); assert.strictEqual(w.posted.length, 1, 'it does not fire twice');
    w.clock += 60_000; w.host.tick();
    await until(() => w.posted.length === 2, 'the repeating timer');
    assert.strictEqual(w.posted[1].text, 'timer beat {"n":0}');
    assert.strictEqual(w.inst().kv['fired:beat'], '1');
    const beat = w.inst().timers.find((t) => t.name === 'beat'); assert.ok(beat.at > w.clock, 'next run is in the future');
    step('timers: install event sets them, a due timer fires once with its data, one-shots go, repeating ones are rescheduled');
  }
  {
    // a slow bot cannot make the same timer fire twice; an uninstalled or removed bot's timers do not run; paused bot is retried later
    const w = world();
    w.set(`bot.on('timer', () => { bot.store.incr('n'); });`);
    w.inst().timers = [{ name: 'beat', kind: 'every', at: w.clock - 1, everySec: 60, data: null, time: null, tz: null, since: 0 }];
    w.host.tick(); w.host.tick(); w.host.tick();
    await until(() => w.inst().kv && w.inst().kv.n, 'ran'); await sleep(60);
    assert.strictEqual(w.inst().kv.n, '1', 'three ticks in a row ran the timer once');
    w.data.bots[BOT].listingHold = { state: 'removed' };
    w.inst().timers[0].at = w.clock - 1; w.host.tick(); await sleep(60);
    assert.strictEqual(w.inst().kv.n, '1', 'a removed bot does not run');
    delete w.data.bots[BOT].listingHold;
    for (let i = 0; i < 3; i++) w.host.guard.record(BOT, { ms: 5, timedOut: true });
    w.inst().timers[0].at = w.clock - 1; w.host.tick(); await sleep(60);
    assert.strictEqual(w.inst().kv.n, '1', 'a paused bot does not run');
    assert.strictEqual(w.inst().timers[0].at, w.clock + 60_000, 'its timer is tried again in a minute');
    step('timers: no double fire, removed and paused bots do not run');
  }
  {
    // at most 20 timers per tick
    const w = world();
    w.set(`bot.on('timer', () => {});`);
    w.data.servers.s1.installedBots = [];
    for (let i = 0; i < 30; i++) {
      const bid = ('f' + String(i).padStart(15, '0')), uid = ('d' + String(i).padStart(15, '0'));
      w.data.bots[bid] = { id: bid, code: "bot.on('timer', () => {});" }; w.data.users[uid] = { id: uid, bot: true, username: 'b' + i };
      w.data.servers.s1.installedBots.push({ botId: bid, userId: uid, channels: null, timers: [{ name: 't', kind: 'after', at: w.clock - 1 }] });
    }
    w.host.tick();
    const left = w.data.servers.s1.installedBots.filter((i) => i.timers.length).length;
    assert.strictEqual(left, 10, 'a tick starts at most 20 timers; the rest wait for the next tick (' + left + ' left)');
    step('a tick starts at most 20 timers');
  }

  // ----- fetch -----
  {
    const w = world();
    w.set(`
      bot.on('message', (m) => { if (m.text.startsWith('!stars')) { bot.fetch('https://api.github.com/repos/a/b', 'stars'); bot.fetch('https://evil.com/x', 'evil'); bot.fetch('https://api.github.com/x', 'bad name'); } });
      bot.on('fetch', (f) => { bot.send(f.channels[0].id, f.name + ': ' + (f.ok ? f.json.stars + ' stars' : f.error)); });`);
    w.say('!stars', {}); await until(() => w.posted.length === 1, 'fetch answer');
    assert.strictEqual(w.posted[0].text, 'stars: 7 stars');
    assert.deepStrictEqual(w.fetchCalls, ['https://api.github.com/repos/a/b'], 'only the allowed request was made');
    const e = w.host.guard.logs(BOT).find((l) => l.event === 'message');
    assert.ok(e.dropped.some((d) => /not allowed/.test(d)) && e.dropped.some((d) => /bad name/.test(d)), JSON.stringify(e.dropped));
    assert.strictEqual(w.host.guard.logs(BOT).find((l) => l.event === 'fetch').ok, true);
    w.fetchAnswer = { ok: false, status: 404, text: '', json: null, truncated: false, error: 'The server answered 404' };
    w.say('!stars'); await until(() => w.posted.length === 2, 'error answer');
    assert.strictEqual(w.posted[1].text, 'stars: The server answered 404', 'a failed fetch is still answered, with an error the bot can show');
    step('fetch: only allowed addresses go out; the answer returns as a fetch event; failures are answered too');
  }
  {
    // the person who asked can be answered with a ping; the bot is removed while the request is out: the answer is discarded
    const w = world();
    w.set(`bot.on('message', (m) => bot.fetch('https://api.github.com/x', 'x')); bot.on('fetch', (f) => bot.send(f.channels[0].id, 'got it <@${A}>'));`);
    w.say('go'); await until(() => w.posted.length === 1, 'answer');
    assert.deepStrictEqual(w.posted[0].mentions, [A], 'the person who triggered it may be pinged in the answer');
    const w2 = world(); w2.fetchDelay = 200;
    w2.set(`bot.on('message', (m) => bot.fetch('https://api.github.com/x', 'x')); bot.on('fetch', (f) => bot.send(f.channels[0].id, 'late'));`);
    w2.say('go'); await until(() => w2.fetchCalls.length === 1, 'fetch started');
    w2.data.servers.s1.installedBots = [];
    await sleep(350);
    assert.strictEqual(w2.posted.length, 0, 'nothing is posted for a bot that was removed while the request was out');
    step('fetch answers: the asker can be pinged; a removed bot gets no answer');
  }
  {
    // budgets
    const w = world();
    w.host.guard.L.fetchesPerMin = 2;
    w.set(`bot.on('message', (m) => { bot.fetch('https://api.github.com/a', 'a'); bot.fetch('https://api.github.com/b', 'b'); bot.fetch('https://api.github.com/c', 'c'); bot.fetch('https://api.github.com/d', 'd'); });`);
    w.say('go'); const e = await until(() => w.host.guard.logs(BOT).find((l) => l.event === 'message'), 'log');
    await sleep(60);
    assert.strictEqual(w.fetchCalls.length, 2, 'per-minute fetch budget: ' + w.fetchCalls.length);
    assert.ok(e.dropped.some((d) => /over the limit/.test(d)) || e.dropped.some((d) => /more than 3/.test(d)), JSON.stringify(e.dropped));
    const w2 = world();
    w2.host.guard.L.reactionsPerMin = 1; w2.host.guard.L.messagesPerMin = 2;
    w2.set(`bot.on('message', (m) => { bot.react(m, '👍'); bot.react(m, '🎉'); bot.send('gen', '1'); bot.send('gen', '2'); bot.send('gen', '3'); });`);
    w2.say('go'); await until(() => w2.host.guard.logs(BOT)[0], 'log2');
    assert.deepStrictEqual([Object.keys(w2.data.messages.m1.reactions).length, w2.posted.length], [1, 2], 'reaction and message budgets are separate and enforced');
    step('every kind has its own per-minute budget');
  }

  // ----- events: edit, leave, install; no loops; channel scope -----
  {
    const w = world();
    w.set(`bot.on('messageEdit', (m) => bot.reply(m, 'edited: ' + m.text + ' ' + !!m.editedAt));
           bot.on('memberLeave', (e) => bot.send(e.channels[0].id, 'bye ' + e.user.username + ' (' + e.reason + ')'));
           bot.on('memberJoin', (e) => bot.send(e.channels[0].id, 'hi ' + e.user.username));`);
    const s = w.data.servers.s1;
    w.host.dispatch(s, 'messageEdit', { channel: s.channels[0], msg: { id: 'm1', channelId: 'gen', serverId: 's1', content: 'new text', editedAt: 5, mentions: [] }, author: w.data.users[A] });
    w.host.dispatch(s, 'memberLeave', { user: w.data.users[A], reason: 'kicked' });
    w.host.dispatch(s, 'memberJoin', { user: w.data.users[A] });
    await until(() => w.posted.length === 3, 'three events');
    assert.deepStrictEqual(w.posted.map((p) => p.text).sort(), ['bye ann (kicked)', 'edited: new text true', 'hi ann']);
    // bots never receive events caused by bots
    w.host.dispatch(s, 'messageEdit', { channel: s.channels[0], msg: { id: 'm1', channelId: 'gen', serverId: 's1', content: 'x' }, author: w.data.users[BU2] });
    w.host.dispatch(s, 'memberLeave', { user: w.data.users[BU2], reason: 'left' });
    w.host.dispatch(s, 'memberJoin', { user: w.data.users[BU2] });
    // a channel the install may not read stays unseen
    w.inst().channels = ['side'];
    w.host.dispatch(s, 'messageEdit', { channel: s.channels[0], msg: { id: 'm1', channelId: 'gen', serverId: 's1', content: 'x' }, author: w.data.users[A] });
    w.host.dispatch(s, 'messageEdit', { channel: s.channels[2], msg: { id: 'mVoice', channelId: 'vc', serverId: 's1', content: 'x' }, author: w.data.users[A] });
    await sleep(120);
    assert.strictEqual(w.posted.length, 3, 'nothing for bot-caused events, unreadable channels or voice channels');
    step('messageEdit, memberLeave, memberJoin; never for bots; channel scope honoured');
  }
  {
    // two bots in one server do not see each other's work, and a failing bot only fills its own log
    const w = world();
    w.data.servers.s1.installedBots.push({ botId: BOT2, userId: BU2, channels: null });
    w.set(`bot.on('message', () => { throw new Error('mine'); });`, BOT);
    w.set(`bot.on('message', (m) => { bot.store.incr('n'); bot.reply(m, 'ok'); });`, BOT2);
    w.say('x'); await until(() => w.posted.length === 1, 'second bot answered');
    assert.deepStrictEqual([w.posted[0].as, w.data.servers.s1.installedBots[0].kv, w.data.servers.s1.installedBots[1].kv], [BU2, undefined, { n: '1' }]);
    assert.ok(/mine/.test(w.host.guard.logs(BOT)[0].error));
    step('bots are independent of each other');
  }
  console.log('\nAll bot host checks passed.');
  await sandbox.stop();
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
