// Bot sandbox (no database): node server/sandbox-test.js
const assert = require('assert');
const Module = require('module');
// Normally `npm install` provides quickjs-emscripten. If it is missing, fall back to a copy that happens to be installed on this machine.
try { require.resolve('quickjs-emscripten'); } catch {
  const fb = (process.env.QJS_FALLBACK || '/home/claude/.npm-global/lib/node_modules/@mermaid-js/mermaid-cli/node_modules');
  process.env.NODE_PATH = fb; Module._initPaths();
}
const S = require('./sandbox');
const step = (m) => console.log('✓', m);
const msg = { id: 'm1', channelId: 'c1', serverId: 's1', text: '!ping', author: { id: 'u1', username: 'ann', bot: false } };
const go = (code, payload = msg, event = 'message', limits) => S.run({ code, event, payload }, limits);

(async () => {
  await S.ready();

  let r = await go("bot.on('message', (m) => { if (m.text === '!ping') bot.reply(m, 'pong'); });");
  assert.deepStrictEqual([r.ok, r.actions], [true, [{ channelId: 'c1', text: 'pong', replyTo: 'm1' }]], JSON.stringify(r));
  r = await go("bot.on('message', (m) => bot.send('c9', 'hi'));");
  assert.deepStrictEqual(r.actions, [{ channelId: 'c9', text: 'hi', replyTo: null }]);
  r = await go("bot.on('message', (m) => bot.reply(m, 'x'));", msg, 'member:join');
  assert.deepStrictEqual([r.ok, r.actions.length], [true, 0], 'a handler for another event does not run');
  step('reply, send, and events with no handler');

  r = await go("bot.on('message', async (m) => { await null; await Promise.resolve(); bot.reply(m, 'later'); });");
  assert.strictEqual(r.actions[0] && r.actions[0].text, 'later', JSON.stringify(r));
  r = await go("bot.on('message', async (m) => { throw new Error('boom'); });");
  assert.ok(!r.ok && /boom/.test(r.error), JSON.stringify(r));
  step('async handlers run; rejected promises are reported');

  r = await go("bot.log('a', 1, {b: 2}); bot.on('message', () => bot.log('got it'));");
  assert.deepStrictEqual(r.logs, ['a 1 {"b":2}', 'got it']);
  step('bot.log');

  const t = Date.now();
  r = await go("bot.on('message', () => { while (true) {} });");
  assert.ok(r.timedOut && !r.ok && /longer than/.test(r.error), JSON.stringify(r));
  assert.ok(Date.now() - t < 1500, 'stopped quickly');
  r = await go('while (true) {}', msg, 'message', { ms: 30 });
  assert.ok(r.timedOut, 'loops at load time are stopped too');
  // QuickJS cannot interrupt a regex; the host kills the worker thread instead, and the main thread stays responsive meanwhile
  let ticks = 0; const iv = setInterval(() => ticks++, 10);
  const t2 = Date.now();
  r = await go("bot.on('message', () => { /(a+)+$/.test('a'.repeat(60) + 'b'); });", msg, 'message', { ms: 50 });
  clearInterval(iv);
  assert.ok(r.timedOut && !r.ok, 'a catastrophic regex is stopped: ' + JSON.stringify(r));
  assert.ok(Date.now() - t2 < 2000, 'killed quickly');
  assert.ok(ticks >= 10, 'the server kept running while the bot spun (' + ticks + ' ticks)');
  r = await go("bot.on('message', (m) => bot.reply(m, 'still works'));");
  assert.strictEqual(r.actions[0] && r.actions[0].text, 'still works', 'a replacement worker took over: ' + JSON.stringify(r));
  r = await go("bot.on('message', async () => { for (;;) await null; });");
  assert.ok(!r.ok, 'an endless promise chain is stopped: ' + JSON.stringify(r));
  step('infinite loops, regex bombs and endless promise chains are stopped');

  r = await go("bot.on('message', () => { const a = []; for (;;) a.push(new Array(100000).fill('x'.repeat(100))); });", msg, 'message');
  assert.ok(!r.ok && /memory|longer/.test(r.error), JSON.stringify(r));
  r = await go("bot.on('message', function f() { f(); });");
  assert.ok(!r.ok, 'runaway recursion is an error, not a crash: ' + JSON.stringify(r));
  step('memory bombs and runaway recursion fail safely');

  // nothing from the host is reachable
  const probe = `bot.on('message', (m) => {
    const seen = [];
    for (const n of ['process', 'require', 'module', 'global', 'Buffer', 'setTimeout', 'setInterval', 'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', '__emit', 'std', 'os', 'console'])
      if (typeof globalThis[n] !== 'undefined') seen.push(n);
    bot.log('seen:' + seen.join(','));
    try { bot.log('ctor:' + typeof bot.on.constructor('return typeof process')()); } catch (e) { bot.log('ctor-err'); }
    try { bot.log('proc:' + bot.on.constructor('return typeof process')()); } catch (e) { bot.log('proc-err'); }
    try { bot.log('req:' + bot.on.constructor('return typeof require')()); } catch (e) { bot.log('req-err'); }
  });`;
  r = await go(probe);
  assert.strictEqual(r.logs[0], 'seen:', 'no host globals: ' + r.logs.join(' | '));
  assert.ok(r.logs.includes('proc:undefined') && r.logs.includes('req:undefined'), 'the Function-constructor trick only sees the sandbox: ' + r.logs.join(' | '));
  step('no process / require / network / timers; the constructor trick finds nothing');

  // the bot cannot change what the shim does, and the door is closed after the shim runs
  r = await go("bot.on('message', (m) => { try { bot.send = () => {}; } catch (e) {} try { globalThis.__emit('send', '{}'); } catch (e) { bot.log('door-closed'); } bot.reply(m, 'ok'); });");
  assert.ok(r.logs.includes('door-closed') && r.actions[0].text === 'ok', JSON.stringify(r));
  r = await go("JSON.stringify = () => 'x'; JSON.parse = () => ({ channelId: 'c', text: 'forged' }); bot.on('message', (m) => bot.reply(m, 'hi'));");
  assert.ok(r.actions.every((a) => a.text !== 'forged'), 'the bot cannot forge actions by changing JSON: ' + JSON.stringify(r));
  step('the bot cannot reach the host function or change the bot object');

  // output limits
  r = await go("bot.on('message', (m) => { for (let i = 0; i < 50; i++) bot.reply(m, 'n' + i); });");
  assert.strictEqual(r.actions.length, S.LIMITS.maxActions);
  r = await go("bot.on('message', (m) => bot.reply(m, 'y'.repeat(100000)));");
  assert.strictEqual(r.actions[0].text.length, S.LIMITS.maxText);
  r = await go("bot.on('message', (m) => { bot.reply(m, '   '); bot.reply(m, ''); bot.reply(m, 'real'); });");
  assert.deepStrictEqual(r.actions.map((a) => a.text), ['real']);
  r = await go("bot.on('message', () => { for (let i = 0; i < 100; i++) bot.log('l' + i); });");
  assert.strictEqual(r.logs.length, S.LIMITS.maxLogs);
  r = await go("bot.on('message', (m) => bot.reply(m, 'a')); bot.on('message', (m) => bot.reply(m, 'b'));");
  assert.deepStrictEqual(r.actions.map((a) => a.text), ['a', 'b'], 'several handlers run in order');
  step('action, text and log limits; empty messages dropped');

  // failures
  r = await go('this is not javascript');
  assert.ok(!r.ok && /SyntaxError/.test(r.error), JSON.stringify(r));
  r = await go("bot.reply(null, 'x'); throw new Error('at load');");
  assert.ok(!r.ok && /at load/.test(r.error), JSON.stringify(r));
  r = await go("bot.on('message', (m) => { bot.reply(m, 'before'); null.x; });");
  assert.ok(!r.ok && r.actions[0].text === 'before', 'actions sent before an error are kept: ' + JSON.stringify(r));
  r = await go("bot.on('message', 5);");
  assert.ok(!r.ok && /bot\.on/.test(r.error), JSON.stringify(r));
  r = await S.run({ code: '', event: 'bad event!', payload: {} });
  assert.ok(!r.ok);
  r = await S.run({ code: '', event: 'message', payload: { t: 'x'.repeat(S.LIMITS.maxEventBytes) } });
  assert.ok(!r.ok && /too large/.test(r.error));
  step('syntax errors, load errors, handler errors, bad calls, bad events');

  // hostile event content cannot break out of the string it travels in
  const evil = { id: 'm1', channelId: 'c1', text: '"); bot.reply({channelId:"c1"}, "injected"); ("\u2028\u2029</script>\\' + "'`${1}" };
  r = await go("bot.on('message', (m) => bot.reply(m, m.text));", evil);
  assert.deepStrictEqual(r.actions.map((a) => a.text), [evil.text], 'the text arrives as data: ' + JSON.stringify(r));
  step('hostile message text stays data');

  // fresh runtime every event: nothing survives
  await go("globalThis.leak = 'secret'; bot.on('message', () => {});");
  r = await go("bot.on('message', (m) => bot.reply(m, String(typeof leak)));");
  assert.strictEqual(r.actions[0].text, 'undefined', 'no state shared between events');
  step('no state carries over between events');

  // many runs in a row (no leaks / crashes from disposing)
  for (let i = 0; i < 200; i++) { r = await go("bot.on('message', (m) => bot.reply(m, 'x'));"); assert.ok(r.ok); }
  for (let i = 0; i < 20; i++) { r = await go("bot.on('message', () => { for(;;){} });", msg, 'message', { ms: 10 }); assert.ok(r.timedOut); }
  step('200 normal and 20 interrupted runs in a row');

  // several bots at once share the workers; a hostile bot does not block the others for long
  const batch = await Promise.all(Array.from({ length: 12 }, (_, i) => go(`bot.on('message', (m) => bot.reply(m, 'n${i}'));`)));
  assert.deepStrictEqual(batch.map((x) => x.actions[0].text), Array.from({ length: 12 }, (_, i) => 'n' + i), 'parallel runs keep their own results');
  const mixed = await Promise.all([go("bot.on('message', () => { for(;;){} });", msg, 'message', { ms: 20 }), go("bot.on('message', (m) => bot.reply(m, 'fine'));"), go("bot.on('message', (m) => bot.reply(m, 'fine2'));")]);
  assert.ok(mixed[0].timedOut && mixed[1].ok && mixed[2].ok, JSON.stringify(mixed.map((x) => [x.ok, x.timedOut])));
  step('parallel runs; a hostile bot does not break its neighbours');

  console.log('\nAll sandbox checks passed.');
  await S.stop();
})().catch((e) => { console.error('\n✗ FAILED:', e); S.stop().catch(() => {}).then(() => process.exit(1)); });
