// Run with: node ai/logic-test.js   (no Electron, Ollama or sandbox needed: the model and the test runner are faked)
// Checks the parts of the AI bot builder that decide what the model is told and when the build ends:
// line diffs, the memory of earlier attempts (and the escalation when the same error repeats), reading the model's reply,
// saved builds, lessons, and the build loop itself (no attempt cap, only finishes when covered).
'use strict';
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { lineDiff } = require('./diff');
const memory = require('./memory');
const botMode = require('./bot-mode');
const { createJobStore } = require('./jobs');
const { createLessons } = require('./lessons');
const { runBuild } = require('./loop');

let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aduna-ai-logic-'));

(async () => {
  // ---------- diff ----------
  await t('lineDiff counts added and removed lines and says nothing for equal text', () => {
    assert.deepStrictEqual(lineDiff('a\nb\nc\n', 'a\nb\nc\n'), { text: '', added: 0, removed: 0, same: true });
    const d = lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
    assert.strictEqual(d.added, 2); assert.strictEqual(d.removed, 1); assert.strictEqual(d.same, false);
    assert.match(d.text, /@@ line 2\n- b\n\+ B/); assert.match(d.text, /\+ d/);
    assert.strictEqual(lineDiff('', 'x\ny').added, 2);
    const big = lineDiff('', Array.from({ length: 100 }, (_, i) => 'line ' + i).join('\n'), { maxLines: 10 });
    assert.match(big.text, /90 more changed lines/);
  });

  // ---------- memory ----------
  await t('signature: the same mistake looks the same, whatever the numbers, paths and names', () => {
    assert.strictEqual(memory.signature("Error at C:\\Users\\a\\bot.js:12 'x' is not defined"), memory.signature("Error at C:\\Users\\b\\bot.js:99 'x' is not defined"));
    assert.strictEqual(memory.signature('line 4: "foo" bad'), memory.signature('line 9: "bar" bad'));
    assert.notStrictEqual(memory.signature('a is not defined'), memory.signature('a is not a function'));
  });
  await t('gapsOf names what is missing in plain words', () => {
    const g = memory.gapsOf({ coverage: { missing: ['memberJoin', 'timer'], silent: ['install'], noHandlers: false, noAssertions: true } });
    assert.strictEqual(g.length, 4); assert.match(g[0], /memberJoin.*t\.join\(\)/); assert.match(g[1], /timer.*t\.advance/); assert.match(g[2], /install.*did nothing/); assert.match(g[3], /does not assert anything/);
    assert.deepStrictEqual(memory.gapsOf({ coverage: { missing: [], silent: [], noHandlers: false, noAssertions: false } }), []);
  });
  await t('diagnose gives plain hints for the errors models keep making', () => {
    assert.match(memory.diagnose({ error: '', tests: [{ ok: false, error: "BotError: The bot failed while handling \"message\": 'console' is not defined" }] }), /bot\.log/);
    assert.match(memory.diagnose({ error: "ReferenceError: 'setTimeout' is not defined" }), /t\.advance/);
    assert.match(memory.diagnose({ tests: [{ ok: false, error: 'BotError: took longer than 100 ms' }] }), /100 ms/);
    assert.strictEqual(memory.diagnose({ tests: [{ ok: false, error: 'AssertionError: nope' }] }), '');
  });
  await t('escalation grows when the same error comes back', () => {
    const at = [];
    const add = (sig) => { at.push({ n: at.length + 1, outcome: 'failed', sig, problem: 'p ' + sig, wrote: ['bot.js'], botDiff: '', botAdded: 1, botRemoved: 0, testAdded: 0, testRemoved: 0 }); return memory.escalation(at); };
    assert.strictEqual(add('a'), ''); assert.strictEqual(add('a') === '', false);
    assert.match(memory.escalation(at), /WARNING/);
    assert.match(add('a'), /STEP BACK/); assert.match(add('a'), /NEW APPROACH/); assert.match(add('a'), /PROBE/); assert.match(add('a'), /STEP BACK/);
    assert.strictEqual(add('b'), '');
    assert.strictEqual(memory.repeats(at), 1);
  });
  await t('weakened notices a test that got easier after a failure', () => {
    assert.ok(memory.weakened({ outcome: 'failed', assertions: 5, testsTotal: 3 }, { assertions: 2, testsTotal: 3 }));
    assert.ok(memory.weakened({ outcome: 'failed', assertions: 5, testsTotal: 3 }, { assertions: 5, testsTotal: 1 }));
    assert.strictEqual(memory.weakened({ outcome: 'failed', assertions: 5, testsTotal: 3 }, { assertions: 6, testsTotal: 3 }), null);
    assert.strictEqual(memory.weakened({ outcome: 'passed', assertions: 5, testsTotal: 3 }, { assertions: 1, testsTotal: 1 }), null);
  });
  await t('render tells the model what each attempt changed and how it ended', () => {
    const text = memory.render([
      { n: 1, outcome: 'failed', problem: 'x is not defined', wrote: ['bot.js', 'test.js'], botAdded: 9, botRemoved: 0, testAdded: 7, testRemoved: 0, botDiff: '@@ line 1\n+ code', notes: [] },
      { n: 2, outcome: 'format', problem: 'bad format', wrote: [], notes: ['reply was cut off'] },
    ]);
    assert.match(text, /Attempt 1: changed bot\.js \(\+9 -0\), test\.js \(\+7 -0\) -> FAILED: x is not defined/);
    assert.match(text, /Attempt 2: changed nothing -> reply did not follow the format \[reply was cut off\]/);
    assert.match(text, /bot\.js change:\n\s+@@ line 1/);
    assert.strictEqual(memory.render([]), '');
  });

  // ---------- reading the model's reply ----------
  await t('parseReply reads files, fences, names and cut-off replies', () => {
    const p = botMode.parseReply('<think>hmm</think>\n<file path="./Bot.js">\n```js\nbot.on(\'message\', () => {});\n```\n</file>\n<file path="notes.txt">x</file>\n<file path=\'test.js\'>\ntest(\'a\', () => {});\n</file>\n<name>My Bot</name>\n<done>Does things.</done>', {});
    assert.deepStrictEqual(Object.keys(p.files), ['bot.js', 'test.js']); assert.strictEqual(p.files['bot.js'], "bot.on('message', () => {});\n");
    assert.deepStrictEqual(p.ignored, ['notes.txt']); assert.strictEqual(p.name, 'My Bot'); assert.strictEqual(p.done, 'Does things.'); assert.strictEqual(p.cutOff, false);
    assert.strictEqual(botMode.parseReply('<file path="bot.js">\nbot.on(', {}).cutOff, true);
    assert.strictEqual(botMode.parseReply('<file path="bot.js">\nx\n</file>', { truncated: true }).cutOff, true);
    assert.strictEqual(botMode.parseReply('Sure! Here you go.', {}).done, null);
  });
  await t('codeProblem mirrors the server: empty, too big, syntax errors', () => {
    assert.strictEqual(botMode.codeProblem("bot.on('message', () => {});"), null);
    assert.match(botMode.codeProblem(''), /no code/); assert.match(botMode.codeProblem('x'.repeat(33 * 1024)), /32 KB/); assert.match(botMode.codeProblem('bot.on('), /Syntax error/);
    assert.strictEqual(botMode.codeProblem('return 5;'), null); // a bot is a function body: a top-level return is fine
  });
  await t('the system prompt lists the real fetch hosts and the bot rules; botNameFrom makes a short name', () => {
    const s = botMode.systemPrompt({ fetchHosts: ['api.github.com', 'example.org'] });
    assert.match(s, /api\.github\.com, example\.org/); assert.match(s, /NOT a Node\.js program/); assert.match(s, /bot\.timer\.daily/); assert.match(s, /newBot\(\)/);
    assert.strictEqual(botMode.botNameFrom('Please make me a bot that rolls dice'), 'Rolls Dice Bot');
    assert.strictEqual(botMode.botNameFrom(''), 'My Bot');
    assert.ok(botMode.botNameFrom('x'.repeat(200)).length <= 32);
  });

  // ---------- saved builds ----------
  await t('jobs are saved after every attempt, listed newest first, and a running one becomes stopped at startup', () => {
    const dir = tmp(); let clock = 1000;
    const jobs = createJobStore({ dir, now: () => ++clock });
    const a = jobs.newJob({ request: 'first', model: 'm', fetchHosts: ['api.github.com'] }); a.bot = 'x'; jobs.save(a);
    const b = jobs.newJob({ request: 'second', model: 'm' }); b.status = 'done'; jobs.save(b);
    assert.deepStrictEqual(jobs.list().map((j) => j.request), ['second', 'first']);
    assert.strictEqual(jobs.load(a.id).bot, 'x'); assert.strictEqual(jobs.load('../x'), null); assert.strictEqual(jobs.load('abcdef123456'), null);
    assert.strictEqual(jobs.markInterrupted(), 1); assert.strictEqual(jobs.load(a.id).status, 'stopped'); assert.strictEqual(jobs.load(b.id).status, 'done');
    fs.writeFileSync(path.join(dir, 'zzzzzzzzzz.json'), '{broken'); assert.strictEqual(jobs.list().length, 2);
    assert.strictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
    for (let i = 0; i < 30; i++) jobs.save(jobs.newJob({ request: 'n' + i, model: 'm' }));
    jobs.prune(25); assert.strictEqual(jobs.list().length, 25);
    assert.strictEqual(jobs.remove(a.id), false);
  });
  await t('very old attempts keep their story but lose the long text', () => {
    const jobs = createJobStore({ dir: tmp() });
    const j = jobs.newJob({ request: 'r', model: 'm' });
    for (let i = 1; i <= 160; i++) j.attempts.push({ n: i, outcome: 'failed', detail: 'long text', botDiff: 'diff', testDiff: 'diff', problem: 'p' });
    jobs.save(j); const back = jobs.load(j.id);
    assert.strictEqual(back.attempts[0].detail, ''); assert.strictEqual(back.attempts[0].problem, 'p'); assert.strictEqual(back.attempts[159].detail, 'long text');
  });

  // ---------- lessons ----------
  await t('lessons: only a finished build teaches, only fixed errors count, and they come back for similar requests', () => {
    const file = path.join(tmp(), 'lessons.json');
    const L = createLessons({ file });
    const job = { status: 'running', request: 'a bot that counts votes', attempts: [] };
    assert.strictEqual(L.learnFromJob(job), 0);
    job.status = 'done';
    job.attempts = [
      { n: 1, outcome: 'failed', stage: 'bot', sig: memory.signature("'console' is not defined"), problem: "'console' is not defined", botDiff: '- console.log(x)\n+ bot.log(x)' },
      { n: 2, outcome: 'failed', stage: 'assert', sig: 'same', problem: 'votes differ', botDiff: '+ a' },
      { n: 3, outcome: 'failed', stage: 'assert', sig: 'same', problem: 'votes differ', botDiff: '+ b' },
      { n: 4, outcome: 'format', sig: 'f', problem: 'format', botDiff: '' },
      { n: 5, outcome: 'passed', sig: '', problem: '', botDiff: '- votes = 1\n+ bot.store.incr("votes", 1)' },
    ];
    assert.strictEqual(L.learnFromJob(job), 2);
    assert.strictEqual(createLessons({ file }).all().length, 2);            // saved on disk
    const hit = L.relevant({ request: 'count votes in a poll bot', problem: '' });
    assert.strictEqual(hit.length >= 1, true); assert.match(L.render(hit), /LESSONS FROM YOUR EARLIER BUILDS/);
    assert.strictEqual(L.relevant({ request: 'something completely unrelated xyz', problem: '' }).length, 0);
    const stuck = L.relevant({ request: 'unrelated', problem: "'console' is not defined" });
    assert.ok(stuck.some((l) => /console/.test(l.problem)), 'a lesson for the exact error the build is stuck on');
    assert.strictEqual(L.render([]), '');
  });

  // ---------- the build loop ----------
  const PASS = { ok: true, covered: true, error: null, tests: [{ name: 'a', ok: true }], assertions: 4, failures: [], console: [], activity: [], coverage: { missing: [], silent: [], noHandlers: false, noAssertions: false }, final: null };
  const failing = (error, extra) => ({ ok: false, covered: false, error: null, tests: [{ name: 'a', ok: false, error }], assertions: 2, failures: [], console: [], activity: [], coverage: { missing: [], silent: [], noHandlers: false, noAssertions: false }, final: null, ...extra });
  const botN = (n) => `<file path="bot.js">\nbot.on('message', (m) => { bot.reply(m, 'v${n}'); });\n</file>\n<file path="test.js">\ntest('a', () => {});\n</file>`;
  const build = (over) => {
    const jobs = createJobStore({ dir: tmp() });
    const job = jobs.newJob({ request: 'a bot', model: 'm' });
    const prompts = [], events = [];
    return { jobs, job, prompts, events, run: (o) => runBuild({ job, jobs, emit: (e) => events.push(e), sleep: async () => {}, ...over, ...o }) };
  };

  await t('the loop has no attempt cap, escalates when the same error repeats, and ends only when the test passes and is covered', async () => {
    let n = 0;
    const b = build();
    const r = await b.run({
      chat: async (messages) => { b.prompts.push(messages[1].content); n++; return n <= 35 ? botN(n) : n === 36 ? botN(36) : '<name>Votes Bot</name><done>Counts votes.</done>'; },
      runner: { run: async () => (b.prompts.length < 36 ? failing('Error: votes is not defined') : PASS) },
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.strictEqual(r.name, 'Votes Bot'); assert.strictEqual(r.attempts, 36); assert.strictEqual(b.job.status, 'done');
    assert.doesNotMatch(b.prompts[1], /WARNING|STEP BACK|NEW APPROACH|PROBE/);
    assert.match(b.prompts[2], /WARNING/); assert.match(b.prompts[3], /STEP BACK/); assert.match(b.prompts[4], /NEW APPROACH/); assert.match(b.prompts[5], /PROBE/); assert.match(b.prompts[6], /STEP BACK/);
    assert.match(b.prompts[10], /WHAT YOU ALREADY TRIED/); assert.match(b.prompts[10], /bot\.js change:/);
    assert.match(b.prompts[36], /The test passed and everything is covered/);
    assert.strictEqual(b.jobs.load(b.job.id).status, 'done'); assert.strictEqual(b.jobs.load(b.job.id).attempts.length, 36);
  });

  await t('a passing test that does not cover every handler is not the end', async () => {
    const b = build(); let n = 0;
    const gaps = { ...PASS, coverage: { missing: ['memberJoin'], silent: [], noHandlers: false, noAssertions: false } };
    const r = await b.run({
      chat: async (m) => { b.prompts.push(m[1].content); n++; return n === 1 ? botN(1) : n === 2 ? botN(2) : '<name>Greeter</name><done>Greets.</done>'; },
      runner: { run: async () => (n < 2 ? gaps : PASS) },
    });
    assert.strictEqual(r.ok, true);
    assert.match(b.prompts[1], /never triggers it/); assert.match(b.prompts[1], /Extend test\.js/); assert.strictEqual(b.job.attempts[0].outcome, 'incomplete');
  });

  await t('<done> before the test passes is refused; the model is told why', async () => {
    const b = build(); let n = 0;
    const r = await b.run({
      chat: async (m) => { b.prompts.push(m[1].content); n++; return n === 1 ? botN(1) + '\n<name>X</name><done>Done!</done>' : n === 2 ? botN(2) : '<name>X</name><done>Done.</done>'; },
      runner: { run: async () => (n === 1 ? failing('Error: nope') : PASS) },
    });
    assert.strictEqual(r.ok, true); assert.match(b.prompts[1], /You wrote <done> but the build is not finished/);
  });

  await t('a weaker test, identical code, and a reply in the wrong format are all pointed out', async () => {
    const b = build(); let n = 0;
    const replies = [botN(1), botN(1), 'Sure, here is how you do it', botN(2), '<name>X</name><done>x</done>'];
    const results = [failing('Error: a', { assertions: 6, tests: [{ name: 'a', ok: false, error: 'Error: a' }, { name: 'b', ok: true }] }), failing('Error: a', { assertions: 2 }), PASS];
    let ri = 0;
    const r = await b.run({ chat: async (m) => { b.prompts.push(m[1].content); return replies[n++]; }, runner: { run: async () => results[ri++] } });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.match(b.prompts[2], /test\.js got weaker|You sent exactly the same code/); assert.match(b.prompts[3], /did not follow the format/i);
    assert.ok(b.job.attempts.some((a) => a.outcome === 'format')); assert.ok(b.job.attempts.some((a) => a.notes.includes('same code again') || a.notes.includes('test made weaker')));
  });

  await t('Stop returns at once with the build saved as stopped', async () => {
    const b = build(); const ac = new AbortController();
    const r = await b.run({ signal: ac.signal, chat: async () => { ac.abort(); return botN(1); }, runner: { run: async () => PASS } });
    assert.strictEqual(r.status, 'stopped'); assert.strictEqual(b.jobs.load(b.job.id).status, 'stopped');
  });

  await t('a missing sandbox, or a model that is not installed, is fatal; anything else is waited out', async () => {
    const b = build();
    const r = await b.run({ chat: async () => botN(1), runner: { run: async () => ({ ...failing('x'), sandboxMissing: true, error: 'The bot sandbox is not available: Cannot find module' }) } });
    assert.strictEqual(r.status, 'error'); assert.match(r.summary, /sandbox/);
    const c = build(); let tries = 0;
    const r2 = await c.run({ chat: async () => { if (++tries < 4) throw new Error('fetch failed'); return botN(1) + '<name>X</name><done>d</done>'; }, runner: { run: async () => PASS } });
    assert.strictEqual(r2.ok, true); assert.strictEqual(c.job.hiccups, 3);
    assert.deepStrictEqual(c.events.filter((e) => e.kind === 'wait').map((e) => e.seconds), [3, 6, 12]);
    const d = build();
    const r3 = await d.run({ chat: async () => { throw new Error("model 'x' not found"); }, runner: { run: async () => PASS } });
    assert.strictEqual(r3.status, 'error'); assert.match(r3.summary, /not found/);
  });

  await t('a build that was stopped continues from its saved attempts, with the history in the prompt', async () => {
    const b = build(); let n = 0;
    b.job.bot = "bot.on('message', () => {});\n"; b.job.test = "test('a', () => {});\n";
    b.job.attempts = [{ n: 1, at: 1, wrote: ['bot.js', 'test.js'], botDiff: '@@ line 1\n+ x', testDiff: '', botAdded: 1, botRemoved: 0, testAdded: 1, testRemoved: 0, unchanged: false, notes: [], assertions: 1, testsTotal: 1, testsPassed: 0, covered: false, gaps: [], outcome: 'failed', stage: 'assert', problem: 'old problem', sig: 'old problem', detail: 'TEST RESULT: FAILED' }];
    const r = await b.run({ chat: async (m) => { b.prompts.push(m[1].content); return n++ === 0 ? botN(2) : '<name>Back</name><done>Back again.</done>'; }, runner: { run: async () => PASS } });
    assert.strictEqual(r.ok, true); assert.strictEqual(b.events.find((e) => e.kind === 'start').resumed, true);
    assert.match(b.prompts[0], /Attempt 1: changed bot\.js/); assert.match(b.prompts[0], /RESULT OF YOUR LAST ATTEMPT:\nTEST RESULT: FAILED/);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
