// Run with: node ai/agent-test.js   (no Electron or Ollama needed: the model is faked)
'use strict';
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const core = require('./core');
const { runAgent } = require('./agent');

let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aduna-ai-'));
function exec(cmd, cwd) {
  return new Promise((resolve) => {
    let out = ''; const c = spawn(cmd.exe === 'node' ? process.execPath : cmd.exe, cmd.args, { cwd });
    c.stdout.on('data', (d) => out += d); c.stderr.on('data', (d) => out += d);
    c.on('error', (e) => resolve({ code: -1, output: String(e) })); c.on('close', (code) => resolve({ code, output: out }));
  });
}
const scripted = (replies) => { let i = 0; return async () => replies[Math.min(i++, replies.length - 1)]; };

(async () => {
  await t('parseResponse reads files, run and done; strips think blocks and fences', () => {
    const p = core.parseResponse('<think>hmm <file path="x">no</file></think>\n<file path="a.js">\n```js\nconsole.log(1)\n```\n</file>\n<file path=\'sub/b.txt\'>hi</file>\n<run>node test.js</run>\n<done>All good.</done>');
    assert.deepStrictEqual(p.files.map((f) => f.path), ['a.js', 'sub/b.txt']);
    assert.strictEqual(p.files[0].content, 'console.log(1)\n');
    assert.strictEqual(p.files[1].content, 'hi\n');
    assert.strictEqual(p.run, 'node test.js');
    assert.strictEqual(p.done, 'All good.');
  });
  await t('a <run> mentioned inside a file is not mistaken for a command', () => {
    const p = core.parseResponse('<file path="a.js">\nconst s = "<run>rm -rf</run>";\n</file>');
    assert.strictEqual(p.run, null);
  });
  await t('safeJoin blocks escapes and risky files', () => {
    const root = path.resolve('/tmp/proj');
    assert.ok(core.safeJoin(root, 'a/b.js'));
    for (const bad of ['../x.js', 'a/../../x.js', '/etc/passwd', 'C:\\Windows\\x.js', 'run.bat', 'node_modules/x.js', '.git/config', '', 'a.exe']) assert.strictEqual(core.safeJoin(root, bad), null, bad);
  });
  await t('parseCommand allows node/python with files only', () => {
    assert.deepStrictEqual(core.parseCommand('node test.js'), { exe: 'node', args: ['test.js'] });
    assert.deepStrictEqual(core.parseCommand('python3 "my test.py" --x'), { exe: 'python3', args: ['my test.py', '--x'] });
    for (const bad of ['node -e "1"', 'node test.js && del *', 'node test.js | more', 'rm -rf /', 'powershell x', 'node ../x.js', 'node C:\\x.js', 'node test.js > out', 'python -c print(1)', '']) assert.strictEqual(core.parseCommand(bad), null, bad);
  });
  await t('ctxFor scales with VRAM', () => {
    assert.strictEqual(core.ctxFor(0).numCtx, 8192); assert.strictEqual(core.ctxFor(8).numCtx, 12288); assert.strictEqual(core.ctxFor(24).numCtx, 16384);
  });
  await t('catalog is ordered low to high and tags are valid', () => {
    for (let i = 1; i < core.MODELS.length; i++) assert.ok(core.MODELS[i].vramGB >= core.MODELS[i - 1].vramGB);
    for (const m of core.MODELS) assert.ok(core.MODEL_NAME_RE.test(m.tag), m.tag);
  });
  await t('readProject keeps small files first, truncates, skips binaries and node_modules', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'small.js'), 'a'); fs.writeFileSync(path.join(d, 'big.js'), 'b'.repeat(9000));
    fs.writeFileSync(path.join(d, 'img.png'), Buffer.from([0, 1, 2])); fs.mkdirSync(path.join(d, 'node_modules')); fs.writeFileSync(path.join(d, 'node_modules', 'x.js'), 'x');
    const files = core.readProject(d, fs, 3000);
    assert.deepStrictEqual(files.map((f) => f.path), ['small.js', 'big.js']);
    assert.ok(files[1].truncated && files[1].content.length <= 3000);
  });

  await t('loop: wrong code -> test fails -> model sees the error -> fixes -> done', async () => {
    const dir = tmp(); const seen = [];
    const testJs = '<file path="test.js">\nconst assert = require("node:assert");\nconst { add } = require("./add.js");\nassert.strictEqual(add(2, 3), 5);\nconsole.log("pass");\n</file>\n';
    const replies = [
      testJs + '<file path="add.js">\nexports.add = (a, b) => a - b;\n</file>\n<run>node test.js</run>',
      '<file path="add.js">\nexports.add = (a, b) => a + b;\n</file>\n<run>node test.js</run>\n<done>add() adds two numbers.</done>',
    ];
    const chat = scripted(replies);
    const events = [];
    const res = await runAgent({ request: 'make add()', dir, chat: async (m, tok) => { seen.push(m[1].content); return chat(m, tok); }, exec, emit: (e) => events.push(e), autoRun: true, maxIter: 5 });
    assert.strictEqual(res.ok, true); assert.strictEqual(res.attempts, 2); assert.strictEqual(res.summary, 'add() adds two numbers.');
    assert.match(seen[1], /exit code 1/); assert.match(seen[1], /AssertionError/); assert.match(seen[1], /a - b/);
    assert.ok(events.some((e) => e.kind === 'result' && e.ok === false) && events.some((e) => e.kind === 'result' && e.ok === true));
    assert.match(fs.readFileSync(path.join(dir, 'add.js'), 'utf8'), /a \+ b/);
  });
  await t('loop: <done> before tests pass is refused', async () => {
    const dir = tmp(); let n = 0;
    const chat = async () => ++n === 1 ? '<file path="test.js">\nprocess.exit(1)\n</file>\n<run>node test.js</run>\n<done>finished</done>' : '<file path="test.js">\nconsole.log(1)\n</file>\n<run>node test.js</run>\n<done>now really</done>';
    const res = await runAgent({ request: 'x', dir, chat, exec, autoRun: true });
    assert.strictEqual(res.ok, true); assert.strictEqual(res.attempts, 2); assert.strictEqual(res.summary, 'now really');
  });
  await t('loop: unsafe paths and commands are blocked, not executed', async () => {
    const dir = tmp(); const outside = path.join(path.dirname(dir), 'escaped.js'); let ran = 0, n = 0;
    const chat = async () => ++n === 1 ? '<file path="../escaped.js">\nx\n</file>\n<run>node -e "process.exit(0)"</run>' : '<file path="a.js">\n1\n</file>\n<run>node a.js</run>\n<done>ok</done>';
    const events = [];
    const res = await runAgent({ request: 'x', dir, chat, exec: async (...a) => { ran++; return exec(...a); }, emit: (e) => events.push(e), autoRun: true });
    assert.ok(!fs.existsSync(outside)); assert.strictEqual(ran, 1); assert.ok(events.some((e) => e.kind === 'note' && /unsafe path/.test(e.text))); assert.strictEqual(res.ok, true);
  });
  await t('loop: gives up on a model that ignores the format', async () => {
    const res = await runAgent({ request: 'x', dir: tmp(), chat: async () => 'Sure! Here is how you do it...', exec, autoRun: true });
    assert.strictEqual(res.ok, false); assert.match(res.summary, /larger model/); assert.strictEqual(res.attempts, 2);
  });
  await t('loop: stops at the attempt limit when the test keeps failing', async () => {
    const res = await runAgent({ request: 'x', dir: tmp(), maxIter: 3, chat: async () => '<file path="test.js">\nprocess.exit(1)\n</file>\n<run>node test.js</run>', exec, autoRun: true });
    assert.strictEqual(res.ok, false); assert.strictEqual(res.attempts, 3); assert.match(res.summary, /3 attempts/);
  });
  await t('loop: declining a command stops the loop; abort stops it too', async () => {
    const chat = async () => '<file path="test.js">\n1\n</file>\n<run>node test.js</run>';
    const r1 = await runAgent({ request: 'x', dir: tmp(), chat, exec, autoRun: false, confirm: async () => false });
    assert.strictEqual(r1.ok, false); assert.match(r1.summary, /declined/);
    const ac = new AbortController(); ac.abort();
    const r2 = await runAgent({ request: 'x', dir: tmp(), chat, exec, autoRun: true, signal: ac.signal });
    assert.strictEqual(r2.summary, 'Stopped.');
  });
  await t('loop: model error is reported', async () => {
    const res = await runAgent({ request: 'x', dir: tmp(), chat: async () => { throw new Error("model 'nope' not found"); }, exec, autoRun: true });
    assert.strictEqual(res.ok, false); assert.match(res.summary, /not found/);
  });
  await t('loop: follow-up request sees existing project files', async () => {
    const dir = tmp(); fs.writeFileSync(path.join(dir, 'app.js'), 'const old = 1;\n'); let prompt = '';
    await runAgent({ request: 'change it', dir, maxIter: 1, chat: async (m) => { prompt = m[1].content; return ''; }, exec, autoRun: true });
    assert.match(prompt, /--- app\.js ---\nconst old = 1;/); assert.match(prompt, /Make the change/);
  });
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
