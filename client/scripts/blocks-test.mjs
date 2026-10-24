// Checks for the block editor's code generation (client/src/blocks.js) without a browser: blockly runs headless in Node (it brings its own jsdom).
// Run: node client/scripts/blocks-test.mjs   (needs `npm --prefix client install`; without blockly installed the checks are skipped, like the sandbox ones)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const step = (m) => console.log('\u2713', m);

try { await import('blockly'); } catch (e) {
  if (e.code === 'ERR_MODULE_NOT_FOUND') { console.log('(skipped block editor checks: blockly is not installed, run: npm --prefix client install)'); process.exit(0); }
  throw e;
}
const Blockly = await import('blockly');
const B = await import('../src/blocks.js');
const botsLib = createRequire(import.meta.url)('../../server/bots.js');

// A stand-in for the `bot` object a bot gets, recording what the generated code does.
function run(code, event, ev) {
  const calls = [], saved = {}, handlers = {};
  const rec = (name) => (...a) => { calls.push([name, ...a]); };
  const bot = {
    on: (n, fn) => { (handlers[n] ||= []).push(fn); },
    reply: (m, t) => calls.push(['reply', t]), send: rec('send'), react: (m, e) => calls.push(['react', e]), log: rec('log'),
    store: { get: (k) => saved[k], set: (k, v) => { saved[k] = v; }, incr: (k, n = 1) => (saved[k] = (saved[k] || 0) + n), delete: (k) => { delete saved[k]; } },
    timer: { after: rec('after'), every: rec('every'), daily: rec('daily'), cancel: rec('cancel') },
    fetch: rec('fetch'),
  };
  new Function('bot', code)(bot); // the code is a function body, like a real bot's
  for (const fn of handlers[event] || []) fn(ev);
  return { calls, saved };
}
const mustCompile = (code, what) => {
  assert.doesNotThrow(() => new Function('bot', code), `${what}: valid JavaScript`);
  assert.ok(!botsLib.checkBot({ name: 'x', code }).error, `${what}: the server accepts it: ${botsLib.checkBot({ name: 'x', code }).error}`);
};
const layoutOf = (...blocks) => JSON.stringify({ blocks: { languageVersion: 0, blocks } });
const txt = (s) => ({ block: { type: 'text', fields: { TEXT: s } } });
const num = (n) => ({ block: { type: 'math_number', fields: { NUM: n } } });

// 1. the starting bot is the same bot as the JavaScript starter
{
  const code = B.codeFromLayout(B.startLayout());
  mustCompile(code, 'starting blocks');
  assert.deepEqual(run(code, 'message', { text: '!ping', author: { id: 'u1' } }).calls, [['reply', 'pong <@u1>']]);
  assert.deepEqual(run(code, 'message', { text: 'hello', author: { id: 'u1' } }).calls, [], 'other messages are left alone');
  assert.deepEqual(run(code, 'memberJoin', { user: { id: 'u2' }, channels: [{ id: 'c1' }, { id: 'c2' }] }).calls, [['send', 'c1', 'Welcome <@u2>']]);
  assert.deepEqual(run(code, 'memberJoin', { user: { id: 'u2' }, channels: [] }).calls, [], 'no channel to write in: nothing is sent');
  step('the starting blocks make the !ping / welcome bot');
}

// 2. a named hat (timer, web answer) only runs for its own name
{
  const code = B.codeFromLayout(layoutOf(
    { type: 'bot_on_timer', fields: { NAME: 'tick' }, inputs: { DO: { block: { type: 'bot_log', inputs: { VALUE: txt('ticked') } } } } },
    { type: 'bot_on_web', fields: { NAME: 'stars' }, inputs: { DO: { block: { type: 'bot_log', inputs: { VALUE: { block: { type: 'bot_answer_value', inputs: { KEY: txt('a.b') } } } } } } } },
  ));
  mustCompile(code, 'named hats');
  assert.deepEqual(run(code, 'timer', { name: 'other' }).calls, []);
  assert.deepEqual(run(code, 'timer', { name: 'tick' }).calls, [['log', 'ticked']]);
  assert.deepEqual(run(code, 'fetch', { name: 'stars', json: { a: { b: 42 } } }).calls, [['log', 42]], 'dots reach into JSON answers');
  assert.deepEqual(run(code, 'fetch', { name: 'stars', json: null }).calls, [['log', undefined]], 'a missing value is just empty');
  step('timer and web-answer hats only answer to their own name; value-from-answer reads nested JSON');
}

// 3. blocks that are not under an event block do not make it into the code
{
  const code = B.codeFromLayout(layoutOf(
    { type: 'bot_reply', x: 0, y: 0, inputs: { TEXT: txt('loose') } },
    { type: 'bot_on_message', x: 0, y: 100, inputs: { DO: { block: { type: 'bot_react', inputs: { EMOJI: txt('\u{1F44D}') } } } } },
  ));
  assert.ok(!code.includes('loose'), 'a loose block is left out');
  assert.deepEqual(run(code, 'message', { text: 'x' }).calls, [['react', '\u{1F44D}']]);
  assert.equal(B.codeFromLayout(layoutOf({ type: 'bot_reply', inputs: { TEXT: txt('x') } })), '', 'no event block, no code');
  step('loose blocks are left out');
}

// 4. text helpers, saved data, timers, repeats
{
  const code = B.codeFromLayout(layoutOf({
    type: 'bot_on_message', inputs: { DO: { block: { type: 'controls_if', inputs: {
      IF0: { block: { type: 'bot_text_starts', inputs: { A: { block: { type: 'bot_text' } }, B: txt('!roll') } } },
      DO0: { block: { type: 'bot_store_add', inputs: { KEY: txt('rolls'), BY: num(1) }, next: { block: { type: 'bot_timer_after', fields: { NAME: 'later' }, inputs: { SECONDS: num(30) }, next: { block: { type: 'bot_reply', inputs: {
        TEXT: { block: { type: 'text_join', extraState: { itemCount: 2 }, inputs: { ADD0: txt('sides: '), ADD1: { block: { type: 'bot_word', inputs: { N: num(2), TEXT: { block: { type: 'bot_text' } } } } } } } },
      } } } } } } },
    } } } },
  }));
  mustCompile(code, 'commands');
  const r = run(code, 'message', { text: '!roll 6' });
  assert.deepEqual(r.calls, [['after', 'later', 30], ['reply', 'sides: 6']]);
  assert.equal(r.saved.rolls, 1);
  assert.deepEqual(run(code, 'message', { text: 'roll' }).calls, []);
  assert.deepEqual(run(code, 'message', { text: '!roll' }).calls.slice(-1), [['reply', 'sides: ']], 'a word that is not there is empty');
  step('commands, saved counters, timers and word picking');
}

// 5. a variable called like something the bot API uses is renamed, not allowed to break the code
{
  const code = B.codeFromLayout(JSON.stringify({
    variables: [{ name: 'bot', id: 'v1' }, { name: 'ev', id: 'v2' }],
    blocks: { languageVersion: 0, blocks: [{ type: 'bot_on_message', inputs: { DO: { block: { type: 'variables_set', fields: { VAR: { id: 'v1' } }, inputs: { VALUE: num(1) },
      next: { block: { type: 'variables_set', fields: { VAR: { id: 'v2' } }, inputs: { VALUE: num(2) } } } } } } }] },
  }));
  mustCompile(code, 'reserved names');
  assert.ok(!/\bvar (bot|ev)\b/.test(code) && !/\b(bot|ev) = /.test(code), 'the variables did not take the names of bot and ev: ' + code);
  run(code, 'message', { text: 'x' });
  step('variables named bot or ev are renamed');
}

// 6. every block in the toolbox makes valid code, alone in a handler
{
  const types = new Set();
  (function walk(list) { for (const c of list) { if (c.kind === 'block' && c.type) types.add(c.type); if (c.contents) walk(c.contents); } })(B.TOOLBOX.contents);
  assert.ok(types.size > 40, 'the toolbox lists the blocks');
  let checked = 0;
  for (const type of types) {
    const ws = new Blockly.Workspace();
    try {
      const hat = ws.newBlock('bot_on_message');
      const blk = ws.newBlock(type);
      if (type.startsWith('bot_on_')) { // a hat is its own handler
        const code = B.generate(ws);
        mustCompile(code, type);
        checked++;
        continue;
      }
      if (blk.outputConnection) {
        const log = ws.newBlock('bot_log');
        hat.getInput('DO').connection.connect(log.previousConnection);
        log.getInput('VALUE').connection.connect(blk.outputConnection);
      } else hat.getInput('DO').connection.connect(blk.previousConnection);
      const code = B.generate(ws);
      assert.ok(code.includes("bot.on('message'"), `${type}: ends up in the handler`);
      mustCompile(code, type);
      checked++;
    } finally { ws.dispose(); }
  }
  assert.equal(checked, types.size);
  step(`all ${checked} toolbox blocks make code the server accepts`);
}

// 7. the saved layout and the screen agree: the same layout gives the same code either way
{
  const json = B.startLayout();
  const ws = new Blockly.Workspace();
  try {
    Blockly.serialization.workspaces.load(JSON.parse(json), ws);
    const again = JSON.stringify(Blockly.serialization.workspaces.save(ws));
    assert.equal(B.codeFromLayout(again), B.codeFromLayout(json), 'saving and loading the layout does not change the code');
    assert.equal(B.generate(ws), B.codeFromLayout(json));
  } finally { ws.dispose(); }
  step('a saved layout loads back into the same code');
}

console.log('\nAll block editor checks passed.');
