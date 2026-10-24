// Run with: node ai/ollama-test.js   (uses a fake Ollama server on a random port)
'use strict';
const assert = require('node:assert');
const http = require('http');
const { create } = require('./ollama');

let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } }

const requests = [];
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => body += d);
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    const send = (obj) => res.write(JSON.stringify(obj) + '\n');
    if (req.url === '/api/version') { res.end(JSON.stringify({ version: '0.9.0' })); }
    else if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b', size: 4700000000 }] })); }
    else if (req.url === '/api/pull') {
      const m = JSON.parse(body).model;
      if (m === 'missing') { res.statusCode = 404; return res.end(JSON.stringify({ error: 'pull model manifest: file does not exist' })); }
      if (m === 'broken') { send({ status: 'pulling abc', digest: 'abc', total: 100, completed: 10 }); return res.end(); }
      send({ status: 'pulling manifest' });
      send({ status: 'pulling aaa', digest: 'aaa', total: 800, completed: 0 });
      send({ status: 'pulling aaa', digest: 'aaa', total: 800, completed: 400 });
      send({ status: 'pulling bbb', digest: 'bbb', total: 200, completed: 200 });
      send({ status: 'pulling aaa', digest: 'aaa', total: 800, completed: 800 });
      send({ status: 'success' }); res.end();
    }
    else if (req.url === '/api/chat') {
      const j = JSON.parse(body);
      if (j.model === 'nope') { res.statusCode = 404; return res.end(JSON.stringify({ error: "model 'nope' not found" })); }
      if (j.model === 'oom') { send({ error: 'model requires more system memory (20.0 GiB) than is available (8.0 GiB)' }); return res.end(); }
      const half = JSON.stringify({ message: { role: 'assistant', content: '<file path="a.js">' } }) + '\n' + JSON.stringify({ message: { role: 'assistant', content: 'x</file>' }, done: true });
      res.write(half.slice(0, 20)); setTimeout(() => res.end(half.slice(20)), 20); // a JSON line split across two chunks
    }
    else if (req.url === '/api/delete') { res.end(''); }
    else { res.statusCode = 404; res.end('{}'); }
  });
});

server.listen(0, '127.0.0.1', async () => {
  const o = create({ base: 'http://127.0.0.1:' + server.address().port });
  await t('isRunning / listModels', async () => {
    assert.strictEqual(await o.isRunning(), true);
    assert.deepStrictEqual(await o.listModels(), [{ name: 'qwen2.5-coder:7b', sizeGB: 4.7 }]);
    assert.strictEqual(await create({ base: 'http://127.0.0.1:9' }).isRunning(), false);
  });
  await t('pull reports combined progress and finishes on success', async () => {
    const seen = []; await o.pull('qwen2.5-coder:7b', (p) => seen.push(p));
    assert.ok(seen.some((p) => p.pct !== null && p.pct > 40 && p.pct < 60)); assert.strictEqual(seen[seen.length - 1].status, 'success'); assert.strictEqual(seen[seen.length - 1].pct, 100);
  });
  await t('pull surfaces server errors and truncated downloads', async () => {
    await assert.rejects(o.pull('missing', () => {}), /does not exist/);
    await assert.rejects(o.pull('broken', () => {}), /ended early/);
  });
  await t('chat streams tokens and handles lines split across chunks', async () => {
    const toks = []; const full = await o.chat({ model: 'm', messages: [], numCtx: 8192, numPredict: 100, onToken: (x) => toks.push(x) });
    assert.strictEqual(full, '<file path="a.js">x</file>'); assert.strictEqual(toks.length, 2);
    const req = requests.filter((r) => r.url === '/api/chat').pop();
    assert.strictEqual(req.body.options.num_ctx, 8192); assert.strictEqual(req.body.stream, true);
  });
  await t('chat reports missing model and out-of-memory clearly', async () => {
    await assert.rejects(o.chat({ model: 'nope', messages: [] }), /not found/);
    await assert.rejects(o.chat({ model: 'oom', messages: [] }), /more system memory/);
  });
  await t('chat can be aborted', async () => {
    const ac = new AbortController(); const p = o.chat({ model: 'm', messages: [], signal: ac.signal }); ac.abort();
    await assert.rejects(p, /abort/i);
  });
  await t('remove sends the model name', async () => { await o.remove('x:1'); const r = requests.filter((q) => q.url === '/api/delete').pop(); assert.strictEqual(r.method, 'DELETE'); assert.strictEqual(r.body.model, 'x:1'); });
  await t('detectGpu returns null or a sane object and never throws', async () => {
    const g = await o.detectGpu(); assert.ok(g === null || (typeof g.name === 'string' && g.vramGB > 0));
  });
  await t('installOllama refuses off-Windows with a helpful message', async () => {
    if (process.platform !== 'win32') await assert.rejects(o.installOllama(() => {}), /ollama\.com\/download/);
  });
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  server.close();
});
