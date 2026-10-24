// Run with: node ai/suite-test.js   (no Electron or Ollama needed)
// Checks the bot test sandbox: bot.js and test.js both run inside QuickJS, with the server's rules.
'use strict';
const assert = require('node:assert');
const { createRunner } = require('./qjs-host');
const { scanHandlers } = require('./suite');

let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } }

const PING = `bot.on('message', (m) => {\n  if (m.text === '!ping') bot.reply(m, 'pong <@' + m.author.id + '>');\n});\n`;

(async () => {
  const runner = createRunner({ suiteMs: 3000 });
  const run = (botCode, testCode, extra) => runner.run({ botCode, testCode, ...(extra || {}) }, { suiteMs: 3000 });

  await t('scanHandlers finds the events a bot listens to', () => {
    assert.deepStrictEqual(scanHandlers(`bot.on('message', f); bot . on("memberJoin", g); bot.on(\`timer\`, h); bot.on('message', i)`), ['message', 'memberJoin', 'timer']);
    assert.deepStrictEqual(scanHandlers('// nothing'), []);
  });

  await t('a correct bot and test pass and the goal is covered', async () => {
    const r = await run(PING, `test('ping', () => {\n  const t = newBot();\n  t.say('!ping');\n  assert.deepStrictEqual(t.sent.map((s) => s.text), ['pong <@u1>']);\n  assert.strictEqual(t.sent[0].replyTo, 'm1');\n});`);
    assert.strictEqual(r.error, null, r.error);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.covered, true);
    assert.strictEqual(r.assertions, 2); assert.deepStrictEqual(r.tests.map((x) => x.ok), [true]);
    assert.deepStrictEqual(r.registered, ['message']);
  });

  await t('the old harness style (loadBot, async IIFE, node:assert) still works', async () => {
    const r = await run(PING, `const assert = require('node:assert');\n(async () => {\n  const t = loadBot('bot.js');\n  await t.emit('message', t.message('!ping'));\n  assert.deepStrictEqual(t.sent.map((s) => s.text), ['pong <@u1>']);\n  console.log('ok');\n})().catch((e) => { console.error(e); process.exit(1); });`);
    assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.deepStrictEqual(r.console, ['ok']);
  });

  await t('a failing assertion reports the first difference', async () => {
    const r = await run(PING, `test('ping', () => {\n  const t = newBot();\n  t.say('!ping');\n  assert.deepStrictEqual(t.sent.map((s) => s.text), ['pong']);\n});`);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.tests[0].ok, false);
    assert.match(r.tests[0].error, /first difference at \[0\]/); assert.match(r.tests[0].error, /pong <@u1>/); assert.match(r.tests[0].error, /test\.js:4/);
    assert.strictEqual(r.failures.length, 1); assert.deepStrictEqual(r.final.sent.map((s) => s.text), ['pong <@u1>']);
  });

  await t('a failure swallowed by an unawaited async function still fails the run', async () => {
    const r = await run(PING, `(async () => { const t = newBot(); t.say('!ping'); try { assert.strictEqual(t.sent.length, 5); } catch (e) { /* swallowed */ } })();`);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.failures.length, 1);
  });

  await t('a bot that uses require or console fails with a plain error the model can read', async () => {
    const r = await run(`const fs = require('fs');\nbot.on('message', (m) => bot.reply(m, 'x'));`, `test('x', () => { const t = newBot(); t.say('hi'); });`);
    assert.strictEqual(r.ok, false); assert.match(r.tests[0].error, /BotError.*'require' is not defined/s);
  });

  await t('a handler the test never reaches, or that does nothing, is not "covered"', async () => {
    const bot = PING + `bot.on('memberJoin', (e) => { if (e.channels.length) bot.send(e.channels[0].id, 'hi <@' + e.user.id + '>'); });\nbot.on('install', (e) => {});`;
    const r = await run(bot, `test('ping', () => { const t = newBot(); t.say('!ping'); assert.strictEqual(t.sent.length, 1); t.install(); });`);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.covered, false);
    assert.deepStrictEqual(r.coverage.missing, ['memberJoin']); assert.deepStrictEqual(r.coverage.silent, ['install']);
    const r2 = await run(bot, `test('all', () => { const t = newBot(); t.say('!ping'); t.join(); t.say('x'); assert.strictEqual(t.sent.length, 2); assert.strictEqual(t.sent[1].text, 'hi <@u1>'); });`);
    assert.deepStrictEqual(r2.coverage.missing, ['install']); assert.deepStrictEqual(r2.coverage.silent, []);
  });

  await t('a test that asserts nothing, and a bot with no handlers, are not "covered"', async () => {
    const r = await run(PING, `test('nothing', () => { const t = newBot(); t.say('!ping'); });`);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.covered, false); assert.strictEqual(r.coverage.noAssertions, true);
    const r2 = await run(`const x = 1;`, `test('x', () => { assert.ok(true); });`);
    assert.strictEqual(r2.coverage.noHandlers, true); assert.strictEqual(r2.covered, false);
  });

  await t('saved data and counters persist between events; variables do not', async () => {
    const bot = `let local = 0;\nbot.on('message', (m) => { local++; const n = bot.store.incr('count', 1); bot.reply(m, 'count ' + n + ' local ' + local); });`;
    const r = await run(bot, `test('count', () => { const t = newBot(); t.say('a'); t.say('b'); assert.deepStrictEqual(t.sent.map((s) => s.text), ['count 1 local 1', 'count 2 local 1']); assert.deepStrictEqual(t.store, { count: 2 }); });`);
    assert.strictEqual(r.ok, true, JSON.stringify(r.tests));
  });

  await t('the server rules apply: voice channels, bad timers, big values, blocked URLs are refused', async () => {
    const bot = `bot.on('message', (m) => {\n  bot.send('c3', 'to the voice channel');\n  bot.timer.after('t', 1, {});\n  bot.store.set('big', 'x'.repeat(5000));\n  bot.fetch('https://example.com/x', 'bad');\n  bot.reply(m, 'ok');\n});`;
    const r = await run(bot, `test('refused', () => { const t = newBot(); t.say('go'); assert.strictEqual(t.sent.length, 1); const d = t.dropped.join('\\n'); assert.match(d, /not a text channel/); assert.match(d, /timer "t"/); assert.match(d, /over 4096 bytes/); assert.match(d, /example\\.com is not on the allowed list/); assert.deepStrictEqual(t.timers, []); assert.deepStrictEqual(t.store, {}); });`);
    assert.strictEqual(r.ok, true, JSON.stringify(r.tests) + r.error);
  });

  await t('timers fire when time advances, and fetch answers arrive as events', async () => {
    const bot = `bot.on('message', (m) => { if (m.text === '!soon') { bot.store.set('ch', m.channelId); bot.timer.after('soon', 30, { by: m.author.id }); } if (m.text === '!gh') { bot.store.set('ch', m.channelId); bot.fetch('https://api.github.com/repos/a/b', 'stars'); } });\nbot.on('timer', (e) => bot.send(bot.store.get('ch'), 'timer ' + e.name + ' by ' + e.data.by));\nbot.on('fetch', (e) => bot.send(bot.store.get('ch'), e.ok ? 'stars ' + e.json.stars : 'failed ' + e.error));`;
    const r = await run(bot, `test('time', () => { const t = newBot(); t.say('!soon'); assert.strictEqual(t.sent.length, 0); assert.strictEqual(t.timers[0].name, 'soon'); t.advance(10); assert.strictEqual(t.sent.length, 0); t.advance(25); assert.deepStrictEqual(t.sent.map((s) => s.text), ['timer soon by u1']); assert.deepStrictEqual(t.timers, []); });\ntest('fetch', () => { const t = newBot(); t.say('!gh'); assert.strictEqual(t.fetches[0].url, 'https://api.github.com/repos/a/b'); t.fetchAnswer('stars', { json: { stars: 7 } }); t.fetchAnswer('stars', { ok: false, status: 500 }); assert.deepStrictEqual(t.sent.map((s) => s.text), ['stars 7', 'failed The server answered 500']); assert.throws(() => t.fetchAnswer('nope', {}), /never asked/); });`);
    assert.strictEqual(r.ok, true, JSON.stringify(r.tests) + r.error); assert.strictEqual(r.covered, true);
  });

  await t('bots never see messages from bots or from voice channels', async () => {
    const r = await run(PING, `test('skip', () => { const t = newBot(); t.say('!ping', { author: 'u3' }); t.say('!ping', { channelId: 'c3' }); assert.strictEqual(t.sent.length, 0); t.say('!ping', { author: 'u2' }); assert.strictEqual(t.sent[0].text, 'pong <@u2>'); });`);
    assert.strictEqual(r.ok, true, JSON.stringify(r.tests) + r.error);
  });

  await t('an endless loop in the bot is stopped at 100 ms and the next test still runs', async () => {
    const r = await run(`bot.on('message', () => { while (true) {} });`, `test('loop', () => { const t = newBot(); t.say('x'); });`);
    assert.strictEqual(r.ok, false); assert.match(r.tests[0].error, /took longer than 100 ms/);
    const again = await run(PING, `test('ping', () => { const t = newBot(); t.say('!ping'); assert.strictEqual(t.sent.length, 1); });`);
    assert.strictEqual(again.ok, true, again.error);
  });

  await t('an endless loop in the test is stopped', async () => {
    const r = await run(PING, `while (true) {}`);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.timedOut, true); assert.match(r.error, /took longer than/);
  });

  await t('a regex bomb that QuickJS cannot interrupt is killed by the host and the worker is replaced', async () => {
    const t0 = Date.now();
    const r = await runner.run({ botCode: `bot.on('message', (m) => { /(a+)+$/.test('a'.repeat(60) + 'b'); });`, testCode: `test('bomb', () => { const t = newBot(); t.say('x'); });` }, { suiteMs: 1000 });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.timedOut, true);
    assert.ok(Date.now() - t0 < 12000, 'killed by the hard deadline');
    const again = await run(PING, `test('ping', () => { const t = newBot(); t.say('!ping'); assert.strictEqual(t.sent.length, 1); });`);
    assert.strictEqual(again.ok, true, again.error);
  });

  await t('a test with a syntax error, a bot with a syntax error, and a test that never finishes are reported', async () => {
    const a = await run(PING, `test('x', ( => {`);
    assert.strictEqual(a.ok, false); assert.match(a.error, /SyntaxError/);
    const b = await run(`bot.on('message', (m) => {`, `test('x', () => { const t = newBot(); t.say('hi'); });`);
    assert.strictEqual(b.ok, false); assert.match(b.tests[0].error, /SyntaxError/);
    const c = await run(PING, `await new Promise(() => {});`);
    assert.strictEqual(c.ok, false); assert.match(c.error, /never finished/);
  });

  await t('node-only things in a test explain themselves', async () => {
    const r = await run(PING, `const fs = require('fs');`);
    assert.strictEqual(r.ok, false); assert.match(r.error, /Cannot find module 'fs'/);
  });

  await runner.stop();
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
