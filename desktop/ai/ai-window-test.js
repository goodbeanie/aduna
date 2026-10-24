// Run with: node ai/ai-window-test.js   (fake Electron + fake Ollama on a random port; checks the whole click-Build-to-working-code chain)
'use strict';
const assert = require('node:assert');
const http = require('http'), fs = require('fs'), path = require('path');
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...r) { return req === 'electron' ? require.resolve('./test-stubs/electron.js') : orig.call(this, req, ...r); };
const electron = require('electron');

let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } }

let replies = [], chatBodies = [];
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => b += d);
  req.on('end', () => {
    if (req.url === '/api/version') return res.end('{"version":"0.9.0"}');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b', size: 4.7e9 }] }));
    if (req.url === '/api/chat') {
      chatBodies.push(JSON.parse(b)); const text = replies.shift() || '';
      for (const piece of text.match(/[\s\S]{1,25}/g) || []) res.write(JSON.stringify({ message: { content: piece } }) + '\n');
      return res.end(JSON.stringify({ done: true }) + '\n');
    }
    res.statusCode = 404; res.end('{}');
  });
});
const call = (ch, ...a) => electron._handlers[ch]({ sender: electron.BrowserWindow.last.webContents }, ...a);
const events = () => electron._sent.filter(([c]) => c === 'ai:event').map(([, d]) => d);
const waitFinished = async () => { for (let i = 0; i < 200; i++) { const f = events().find((e) => e.kind === 'finished'); if (f) return f; await new Promise((r) => setTimeout(r, 50)); } throw new Error('never finished'); };

server.listen(0, '127.0.0.1', async () => {
  process.env.ADUNA_AI_TEST = '1'; process.env.ADUNA_OLLAMA_BASE = 'http://127.0.0.1:' + server.address().port;
  const { openAiWindow } = require('./ai-window');
  openAiWindow('x.png');
  await t('status reports ollama running, installed models and the catalog', async () => {
    const s = await call('ai:status');
    assert.strictEqual(s.ok, true); assert.strictEqual(s.ollama.running, true); assert.strictEqual(s.models[0].name, 'qwen2.5-coder:7b'); assert.ok(s.catalog.length >= 6);
  });
  await t('calls from any other window are refused', async () => {
    const r = await electron._handlers['ai:status']({ sender: {} }); assert.strictEqual(r.ok, false);
  });
  await t('input validation', async () => {
    assert.strictEqual((await call('ai:run', { request: '', model: 'x' })).ok, false);
    assert.strictEqual((await call('ai:run', { request: 'hi', model: 'bad name; rm' })).ok, false);
    assert.strictEqual((await call('ai:pull', '../../etc')).ok, false);
    assert.strictEqual((await call('ai:remove', 'x y')).ok, false);
  });
  await t('build: writes code + test, first test fails, AI fixes it, finishes with a summary', async () => {
    replies = [
      '<file path="test.js">\nconst assert=require("node:assert");const {double}=require("./double.js");assert.strictEqual(double(4),8);console.log("ok");\n</file>\n<file path="double.js">\nexports.double=(n)=>n+n+1;\n</file>\n<run>node test.js</run>',
      '<file path="double.js">\nexports.double=(n)=>n*2;\n</file>\n<run>node test.js</run>\n<done>double(n) returns n times two.</done>',
    ];
    const r = await call('ai:run', { request: 'a function that doubles a number', model: 'qwen2.5-coder:7b', autoRun: true, maxIter: 5 });
    assert.strictEqual(r.ok, true); assert.match(r.project, /^a-function-that-doubles-a-number/);
    const second = await call('ai:run', { request: 'again', model: 'qwen2.5-coder:7b' });
    assert.strictEqual(second.ok, false); assert.match(second.error, /already running/);
    const fin = await waitFinished();
    assert.strictEqual(fin.ok, true); assert.strictEqual(fin.attempts, 2); assert.match(fin.summary, /times two/);
    const ev = events(); const kinds = ev.map((e) => e.kind);
    assert.ok(kinds.includes('token') && kinds.includes('file') && kinds.includes('run'));
    assert.deepStrictEqual(ev.filter((e) => e.kind === 'result').map((e) => e.ok), [false, true]);
    assert.match(ev.find((e) => e.kind === 'result' && !e.ok).output, /AssertionError/);
    const dir = path.join(electron._docs, 'Aduna AI Projects', r.project);
    assert.match(fs.readFileSync(path.join(dir, 'double.js'), 'utf8'), /n\*2/);
    assert.strictEqual(chatBodies[0].options.num_ctx, 8192); assert.strictEqual(chatBodies[0].model, 'qwen2.5-coder:7b');
  });
  await t('follow-up request keeps editing the same project, and "new project" starts a fresh folder', async () => {
    electron._sent.length = 0; chatBodies = [];
    replies = ['<file path="test.js">\nconsole.log(1)\n</file>\n<run>node test.js</run>\n<done>updated</done>'];
    const before = (await call('ai:status')).project;
    const r = await call('ai:run', { request: 'now also triple', model: 'qwen2.5-coder:7b' });
    assert.strictEqual(r.project, before); await waitFinished();
    assert.match(chatBodies[0].messages[1].content, /--- double\.js ---/);
    await call('ai:new-project'); assert.strictEqual((await call('ai:status')).project, null);
  });
  await t('declining a command (Ask first mode) stops the build', async () => {
    electron._sent.length = 0;
    replies = ['<file path="test.js">\nconsole.log(1)\n</file>\n<run>node test.js</run>'];
    await call('ai:run', { request: 'ask me first', model: 'qwen2.5-coder:7b', autoRun: false });
    for (let i = 0; i < 100 && !events().some((e) => e.kind === 'confirm'); i++) await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(events().find((e) => e.kind === 'confirm').cmd, 'node test.js');
    await call('ai:confirm', false);
    const fin = await waitFinished(); assert.strictEqual(fin.ok, false); assert.match(fin.summary, /declined/);
  });
  await t('stop aborts a build in progress', async () => {
    electron._sent.length = 0; await call('ai:new-project');
    replies = ['<file path="test.js">\nsetTimeout(()=>{},20000)\n</file>\n<run>node test.js</run>'];
    await call('ai:run', { request: 'slow one', model: 'qwen2.5-coder:7b' });
    for (let i = 0; i < 100 && !events().some((e) => e.kind === 'run'); i++) await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now(); await call('ai:stop'); const fin = await waitFinished();
    assert.strictEqual(fin.summary, 'Stopped.'); assert.ok(Date.now() - t0 < 5000);
  });
  await t('open-folder opens the current project (or the root)', async () => {
    const r = await call('ai:open-folder'); assert.strictEqual(r.ok, true); assert.match(electron._opened, /Aduna AI Projects/);
  });
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100);
});
