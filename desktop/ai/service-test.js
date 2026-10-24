// Run with: node ai/service-test.js   (no Electron: a fake Ollama on a random port, the real QuickJS bot sandbox, a fake ipcMain)
// Checks the whole chain behind the AI panel: ask for a bot -> model writes bot.js + test.js -> sandbox runs them -> fixes -> done -> lessons,
// saved builds, resume after a stop, retry when Ollama has a hiccup, toast when finished, and that only the Aduna page may call it.
'use strict';
const assert = require('node:assert');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { create: createService } = require('./ai-service');
const { create: createOllama } = require('./ollama');

let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await wait(25); } }

// ---------- a fake Ollama ----------
let replies = [], chatBodies = [], installed = [], pullCalls = [];
const timers = new Set();
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d));
  req.on('end', () => {
    if (req.url === '/api/version') return res.end('{"version":"0.9.0"}');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: installed.map((name) => ({ name, size: 4.7e9 })) }));
    if (req.url === '/api/pull') {
      const name = JSON.parse(b).model; pullCalls.push(name);
      res.write(JSON.stringify({ status: 'pulling', digest: 'sha256:a', total: 100, completed: 50 }) + '\n');
      installed.push(name);
      return res.end(JSON.stringify({ status: 'success' }) + '\n');
    }
    if (req.url === '/api/chat') {
      chatBodies.push(JSON.parse(b));
      const r = replies.shift();
      if (r && r.status) { res.statusCode = r.status; return res.end(JSON.stringify({ error: r.error })); }
      if (r && r.delay) { const h = setTimeout(() => res.end(JSON.stringify({ done: true }) + '\n'), r.delay); timers.add(h); res.on('close', () => clearTimeout(h)); return; }
      const text = typeof r === 'string' ? r : r && r.text || '';
      for (const piece of text.match(/[\s\S]{1,40}/g) || []) res.write(JSON.stringify({ message: { content: piece } }) + '\n');
      return res.end(JSON.stringify({ done: true, done_reason: r && r.length ? 'length' : 'stop' }) + '\n');
    }
    res.statusCode = 404; res.end('{}');
  });
});

const BOT_V1 = `bot.on('message', (m) => { if (m.text === '!ping') bot.reply(m, 'pong'); });`;
const BOT_V2 = `bot.on('message', (m) => { if (m.text === '!ping') bot.reply(m, 'pong <@' + m.author.id + '>'); });`;
const TEST = `test('ping answers pong and mentions the person', () => {\n  const t = newBot();\n  t.say('!ping');\n  assert.deepStrictEqual(t.sent.map((s) => s.text), ['pong <@u1>']);\n  t.say('hello');\n  assert.strictEqual(t.sent.length, 1);\n});`;
const files = (bot, test) => (bot ? `<file path="bot.js">\n${bot}\n</file>\n` : '') + (test ? `<file path="test.js">\n${test}\n</file>\n` : '');

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aduna-ai-'));
  const handlers = {}, events = [], toasts = [];
  let panelActive = false;
  const make = (dir, into) => createService({
    ipcMain: { handle: (ch, fn) => { (into || {})[ch] = fn; } }, dataDir: dir || dataDir, ollama: createOllama({ base, gpu: { name: 'Test GPU', vramGB: 6 } }),
    send: (ch, d) => events.push([ch, d]), isTrusted: (e) => !!(e && e.trusted), notify: (n) => toasts.push(n), windowActive: () => panelActive, sleep: async () => {},
    openExternal() {},
  });
  const ai = make(null, handlers);
  const call = (ch, ...a) => handlers[ch]({ trusted: true }, ...a);
  const agent = () => events.filter(([c, d]) => c === 'ai:event' && d.type === 'agent').map(([, d]) => d);
  const finished = (n = 1) => until(() => { const f = agent().filter((e) => e.kind === 'finished'); return f.length >= n ? f[n - 1] : null; }, 'the build to finish');
  const reset = () => { events.length = 0; chatBodies = []; toasts.length = 0; };

  await t('only the Aduna page may call it', async () => {
    const r = await handlers['ai:status']({ trusted: false }); assert.strictEqual(r.ok, false);
    const r2 = await handlers['ai:run']({}, { request: 'x', model: 'm' }); assert.strictEqual(r2.ok, false);
  });

  await t('auto setup installs the best model for a 6 GB card, then does not download again', async () => {
    const r = await call('ai:auto-setup');
    assert.strictEqual(r.ok, true); assert.strictEqual(r.model, 'qwen2.5-coder:7b'); assert.strictEqual(r.downloaded, true); assert.deepStrictEqual(pullCalls, ['qwen2.5-coder:7b']);
    assert.ok(events.some(([, d]) => d.type === 'setup' && /Downloading qwen2\.5-coder:7b/.test(d.status)));
    const again = await call('ai:auto-setup'); assert.strictEqual(again.downloaded, false); assert.strictEqual(pullCalls.length, 1);
    const s = await call('ai:status');
    assert.strictEqual(s.ok, true); assert.strictEqual(s.ollama.running, true); assert.strictEqual(s.models[0].name, 'qwen2.5-coder:7b'); assert.strictEqual(s.busy, false);
  });

  await t('input is checked', async () => {
    assert.strictEqual((await call('ai:run', { request: '', model: 'qwen2.5-coder:7b' })).ok, false);
    assert.strictEqual((await call('ai:run', { request: 'x'.repeat(4001), model: 'qwen2.5-coder:7b' })).ok, false);
    assert.strictEqual((await call('ai:run', { request: 'hi', model: 'bad name; rm' })).ok, false);
    assert.strictEqual((await call('ai:pull', '../../etc')).ok, false);
    assert.strictEqual((await call('ai:job', '../../etc')).ok, false);
    assert.strictEqual((await call('ai:resume', { id: 'nope' })).ok, false);
  });

  let doneId;
  await t('a bot is built: wrong first try, fixed, confirmed; the build ends only when covered; a toast says so; lessons are kept', async () => {
    reset();
    replies = [files(BOT_V1, TEST), files(BOT_V2), '<name>Ping Bot</name>\n<done>Answers !ping with pong and a mention.</done>'];
    const r = await call('ai:run', { request: 'A bot that answers !ping with pong', model: 'qwen2.5-coder:7b', fetchHosts: ['api.github.com', 'bad host!'] });
    assert.strictEqual(r.ok, true); doneId = r.jobId;
    const second = await call('ai:run', { request: 'again', model: 'qwen2.5-coder:7b' });
    assert.strictEqual(second.ok, false); assert.match(second.error, /already running/);
    const s = await call('ai:status'); assert.strictEqual(s.busy, true); assert.strictEqual(s.jobId, doneId);
    const fin = await finished();
    assert.strictEqual(fin.ok, true, JSON.stringify(fin)); assert.strictEqual(fin.attempts, 2); assert.strictEqual(fin.name, 'Ping Bot'); assert.strictEqual(fin.learned, 1);
    const ev = agent(); const kinds = ev.map((e) => e.kind);
    for (const k of ['start', 'attempt', 'token', 'files', 'testing', 'result', 'finished']) assert.ok(kinds.includes(k), 'event ' + k);
    const results = ev.filter((e) => e.kind === 'result');
    assert.deepStrictEqual(results.map((e) => e.passed), [false, true]);
    assert.match(results[0].problem, /first difference at \[0\]|Expected values/); assert.match(results[0].detail, /pong <@u1>/);
    assert.strictEqual(chatBodies[0].options.num_ctx, 8192); assert.strictEqual(chatBodies[0].model, 'qwen2.5-coder:7b');
    // the second prompt shows what was tried and what the bot actually did
    const p2 = chatBodies[1].messages[1].content;
    assert.match(p2, /WHAT YOU ALREADY TRIED/); assert.match(p2, /Attempt 1: changed bot\.js/); assert.match(p2, /WHAT THE BOT DID/);
    assert.match(chatBodies[0].messages[0].content, /api\.github\.com/); assert.doesNotMatch(chatBodies[0].messages[0].content, /bad host/);
    assert.strictEqual(toasts.length, 1); assert.strictEqual(toasts[0].target, 'ai'); assert.match(toasts[0].body, /Ping Bot/);
    assert.strictEqual((await call('ai:status')).busy, false);
  });

  await t('the saved build can be used: name, description and the code that passed', async () => {
    const r = await call('ai:job', doneId);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.job.status, 'done'); assert.strictEqual(r.job.history.length, 2);
    assert.deepStrictEqual(r.job.history.map((a) => a.outcome), ['failed', 'passed']);
    assert.strictEqual(r.use.name, 'Ping Bot'); assert.strictEqual(r.use.finished, true); assert.strictEqual(r.use.description, 'Answers !ping with pong and a mention.');
    assert.match(r.use.code, /pong <@/); assert.doesNotMatch(r.use.code, /require|module/);
    const list = await call('ai:jobs'); assert.strictEqual(list.jobs[0].id, doneId); assert.strictEqual(list.jobs[0].status, 'done');
    assert.strictEqual((await call('ai:resume', { id: doneId })).ok, false);
    const st = await call('ai:status'); assert.strictEqual(st.lessons, 1);
  });

  await t('a lesson from an earlier build is shown to the model in a later, similar build', async () => {
    reset();
    replies = [files(BOT_V2, TEST), '<name>Pong</name><done>Pong.</done>'];
    const r = await call('ai:run', { request: 'a bot that answers !ping with pong', model: 'qwen2.5-coder:7b' });
    assert.strictEqual(r.ok, true); await finished();
    assert.match(chatBodies[0].messages[1].content, /LESSONS FROM YOUR EARLIER BUILDS/);
    assert.match(chatBodies[0].messages[1].content, /Error: /);
  });

  await t('Ollama having a hiccup is waited out, not fatal; a cut-off reply is noticed', async () => {
    reset();
    replies = [{ status: 500, error: 'something broke' }, { text: files(BOT_V2, TEST).slice(0, 80), length: true }, files(BOT_V2, TEST), '<name>Pong 2</name><done>Pong again.</done>'];
    const r = await call('ai:run', { request: 'a second pong bot with a hiccup', model: 'qwen2.5-coder:7b' });
    assert.strictEqual(r.ok, true);
    const fin = await finished();
    assert.strictEqual(fin.ok, true, JSON.stringify(fin));
    const ev = agent();
    assert.ok(ev.some((e) => e.kind === 'wait' && /something broke/.test(e.reason)), 'a wait event');
    assert.ok(ev.some((e) => e.kind === 'note' && /cut off/.test(e.text)), 'a cut-off note');
    const job = (await call('ai:job', r.jobId)).job; assert.ok(job.history.some((a) => a.outcome === 'cutoff'));
  });

  await t('a model that is not installed ends the build with a clear message, and a toast', async () => {
    reset();
    replies = [{ status: 404, error: "model 'ghost:1b' not found, try pulling it first" }];
    const r = await call('ai:run', { request: 'a bot with a ghost model', model: 'ghost:1b' });
    assert.strictEqual(r.ok, true);
    const fin = await finished();
    assert.strictEqual(fin.ok, false); assert.strictEqual(fin.status, 'error'); assert.match(fin.summary, /not found/);
    assert.strictEqual(toasts.length, 1); assert.match(toasts[0].body, /not found/);
  });

  let stoppedId;
  await t('Stop ends the build at once, without a toast; the saved build continues later from where it was', async () => {
    reset();
    replies = [files(BOT_V1, TEST), { delay: 20000 }];
    const r = await call('ai:run', { request: 'a bot that I will stop', model: 'qwen2.5-coder:7b' });
    stoppedId = r.jobId;
    await until(() => agent().filter((e) => e.kind === 'result').length >= 1 && chatBodies.length >= 2, 'the second attempt to start');
    const t0 = Date.now(); await call('ai:stop');
    const fin = await finished();
    assert.strictEqual(fin.status, 'stopped'); assert.match(fin.summary, /Stopped/); assert.ok(Date.now() - t0 < 4000);
    assert.strictEqual(toasts.length, 0);
    assert.strictEqual((await call('ai:job', stoppedId)).job.status, 'stopped');
    assert.strictEqual((await call('ai:job', stoppedId)).job.history.length, 1);
    assert.ok((await call('ai:job', stoppedId)).use, 'the code so far can still be used');
    reset();
    replies = [files(BOT_V2), '<name>Stopped Bot</name><done>Answers !ping.</done>'];
    const again = await call('ai:resume', { id: stoppedId, model: 'qwen2.5-coder:7b' });
    assert.strictEqual(again.ok, true);
    const fin2 = await finished();
    assert.strictEqual(fin2.ok, true, JSON.stringify(fin2)); assert.strictEqual(fin2.attempts, 2);
    assert.ok(agent().find((e) => e.kind === 'start').resumed);
    assert.match(chatBodies[0].messages[1].content, /Attempt 1: changed bot\.js/);
  });

  await t('no toast when the person is looking at the panel; the panel can catch up on what it missed', async () => {
    reset(); await call('ai:panel', true); panelActive = true;
    replies = [files(BOT_V2, TEST), { delay: 300 }, '<name>Watched</name><done>Watched.</done>'];
    await call('ai:run', { request: 'a bot that is watched', model: 'qwen2.5-coder:7b' });
    await until(() => agent().some((e) => e.kind === 'result'), 'the first result');
    const s = await call('ai:status');
    assert.strictEqual(s.busy, true); assert.ok(s.log.some((e) => e.kind === 'result'), 'the log is there for a late panel'); assert.ok(s.log.some((e) => e.kind === 'attempt'));
    await finished();
    assert.strictEqual(toasts.length, 0);
    panelActive = false; await call('ai:panel', false);
  });

  await t('delete removes a saved build, but not a running one', async () => {
    reset();
    replies = [files(BOT_V2, TEST), { delay: 5000 }];
    const r = await call('ai:run', { request: 'a bot to delete', model: 'qwen2.5-coder:7b' });
    await until(() => chatBodies.length >= 2, 'the build to be underway');
    assert.strictEqual((await call('ai:delete-job', r.jobId)).ok, false);
    await call('ai:stop'); await finished();
    assert.strictEqual((await call('ai:delete-job', r.jobId)).ok, true);
    assert.strictEqual((await call('ai:job', r.jobId)).ok, false);
  });

  await t('a build that was running when the app closed shows up as stopped, and can be continued', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aduna-ai2-'));
    const first = make(dir2, {});
    const job = first._test.jobs.newJob({ request: 'cut off by closing', model: 'qwen2.5-coder:7b' }); job.bot = BOT_V1; job.test = TEST; first._test.jobs.save(job);
    assert.strictEqual(first._test.jobs.load(job.id).status, 'running');
    const second = make(dir2, {});
    assert.strictEqual(second._test.jobs.load(job.id).status, 'stopped');
    await second.shutdown(); await first.shutdown();
  });

  await t('shutdown stops a running build', async () => {
    reset();
    replies = [{ delay: 20000 }];
    const r = await call('ai:run', { request: 'a build when the app quits', model: 'qwen2.5-coder:7b' });
    assert.strictEqual(r.ok, true); await until(() => chatBodies.length >= 1, 'the model to be asked');
    await ai.shutdown();
    const fin = await finished(); assert.strictEqual(fin.status, 'stopped');
  });

  for (const h of timers) clearTimeout(h);
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  server.close(); if (server.closeAllConnections) server.closeAllConnections();
  setTimeout(() => process.exit(process.exitCode || 0), 200);
});
