// Bot validation, views and search (no database): node server/bots-logic-test.js
const assert = require('assert');
const B = require('./bots');
const step = (m) => console.log('✓', m);
const WORDS = ['porn', 'nazi'];
const good = { name: 'Dice  Roller', description: 'Rolls dice with /roll', tags: ['dice', 'games'], visibility: 'public', code: "bot.on('message', (m) => { if (m.text === '!roll') bot.reply(m, String(1 + Math.floor(Math.random() * 6))); });" };

let r = B.checkBot(good, { words: WORDS });
assert.ok(r.value && r.value.name === 'Dice Roller' && r.value.visibility === 'public', JSON.stringify(r));
step('a good bot passes; name whitespace is cleaned');

assert.ok(B.checkBot({ ...good, name: '  ' }).error, 'name required');
assert.ok(B.checkBot({ ...good, code: '   ' }).error, 'code required');
assert.ok(B.checkBot({ ...good, visibility: 'secret' }).error, 'bad visibility');
assert.ok(B.checkBot({ ...good, tags: ['x'] }).error, 'bad tag');
assert.ok(B.checkBot({ ...good, tags: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'] }).error, 'too many tags');
assert.ok(/too long/.test(B.checkBot({ ...good, code: 'a'.repeat(B.LIMITS.code + 1) }).error), 'code size limit');
step('required fields, tags and size limits');

r = B.checkBot({ ...good, code: 'bot.on("message", (m => {' });
assert.ok(/Syntax error/.test(r.error), r.error);
r = B.checkBot({ ...good, code: 'const a = 1;\nconst a = 2;' });
assert.ok(/Syntax error near line 2/.test(r.error), r.error);
assert.ok(!B.checkBot({ ...good, code: 'return;' }).error, 'a top-level return is fine: the code is a function body');
step('syntax errors are reported with a line, nothing is executed');
let ran = false; global.__ran = () => { ran = true; };
B.checkBot({ ...good, code: '__ran();' }); // compiling must not run it
assert.strictEqual(ran, false, 'validation never runs the code');
step('validation compiles only');

assert.ok(B.checkBot({ ...good, name: 'Porn bot' }, { words: WORDS }).error, 'blocked name on a public bot');
assert.ok(B.checkBot({ ...good, description: 'see https://example.com' }, { words: WORDS }).error, 'links refused');
assert.ok(B.checkBot({ ...good, description: '' }, { words: WORDS }).error, 'public needs a description');
assert.ok(!B.checkBot({ ...good, visibility: 'private', description: '', name: 'Porn bot' }, { words: WORDS }).error, 'private bots are not text-checked: only their developer sees them');
step('public bots get the listing text checks, private ones do not');

// editing: only given fields; result is checked as a whole
const cur = { ...good, name: 'Dice Roller', tags: ['dice'], visibility: 'private', ownerId: 'u1', createdAt: 1 };
r = B.checkBot({ visibility: 'public' }, { current: { ...cur, description: '' }, words: WORDS });
assert.ok(r.error, 'going public without a description is refused');
r = B.checkBot({ description: 'Rolls dice', visibility: 'public' }, { current: cur, words: WORDS });
assert.deepStrictEqual(Object.keys(r.value).sort(), ['description', 'visibility']);
step('edits touch only what is sent and are checked as a whole');

// views hide the code from everyone but the developer
const users = { u1: { id: 'u1', username: 'dev', displayName: 'Dev' } };
const bot = { ...cur, id: 'b1', installs: ['s1', 's2'], visibility: 'public' };
assert.strictEqual(B.botView(bot, 'u2', users).code, undefined);
assert.strictEqual(B.botView(bot, 'u1', users).code, bot.code);
assert.strictEqual(B.botView(bot, 'u2', users).installs, 2);
assert.strictEqual(B.botView(bot, 'u2', users).developer.username, 'dev');
assert.ok(!JSON.stringify(B.botView(bot, 'u2', users)).includes('bot.on'), 'code never leaks to others');
step('views: code only for the developer');

// block bots: the layout is saved next to the generated code, only its developer gets it back
const layout = JSON.stringify({ blocks: { languageVersion: 0, blocks: [{ type: 'bot_on_message', x: 0, y: 0 }] } });
r = B.checkBot({ ...good, blocks: layout }, { words: WORDS });
assert.strictEqual(r.value.blocks, layout, 'a block layout is kept as given');
assert.strictEqual(B.checkBot({ ...good }, { words: WORDS }).value.blocks, undefined, 'a plain code bot has no layout');
assert.ok(B.checkBot({ ...good, blocks: '{nope' }).error, 'layout must be JSON');
assert.ok(B.checkBot({ ...good, blocks: '[1,2]' }).error, 'layout must be an object');
assert.ok(B.checkBot({ ...good, blocks: '"text"' }).error, 'layout must be an object');
assert.ok(B.checkBot({ ...good, blocks: { blocks: [] } }).error, 'layout must be text, not a live object');
assert.ok(/too big/.test(B.checkBot({ ...good, blocks: JSON.stringify({ a: 'x'.repeat(B.LIMITS.blocks) }) }).error), 'layout size limit');
assert.ok(B.checkBot({ ...good, code: 'bot.on(', blocks: layout }).error, 'the generated code is checked like any other code');
r = B.checkBot({ blocks: null }, { current: { ...cur, blocks: layout } });
assert.strictEqual(r.value.blocks, null, 'converting to JavaScript clears the layout');
r = B.checkBot({ description: 'x' }, { current: { ...cur, blocks: layout } });
assert.ok(!('blocks' in r.value), 'an edit that does not mention the layout leaves it alone');
assert.strictEqual(B.botView({ ...bot, blocks: layout }, 'u1', users).blocks, layout);
assert.strictEqual(B.botView({ ...bot, blocks: layout }, 'u2', users).blocks, undefined);
assert.strictEqual(B.botView(bot, 'u1', users).blocks, null, 'a code bot reports no layout');
step('blocks: layout checked, kept next to the code, shown only to the developer, clearable');

// explore: public only, not held, search + sort
const mk = (id, name, extra = {}) => ({ id, name, description: 'does things', tags: [], visibility: 'public', installs: [], createdAt: Number(id.slice(1)), ...extra });
const all = [mk('b1', 'Alpha', { installs: ['x'] }), mk('b2', 'Beta', { installs: ['x', 'y', 'z'], tags: ['music'] }), mk('b3', 'Gamma', { visibility: 'private' }), mk('b4', 'Delta', { listingHold: { state: 'hidden' } }), mk('b5', 'Porn bot')];
let e = B.exploreBots(all, { words: WORDS });
assert.deepStrictEqual(e.page.map((b) => b.id), ['b2', 'b1'], 'most installs first; private, held and blocked ones left out');
e = B.exploreBots(all, { q: 'music', words: WORDS });
assert.deepStrictEqual(e.page.map((b) => b.id), ['b2']);
e = B.exploreBots(all, { sort: 'az', words: WORDS });
assert.deepStrictEqual(e.page.map((b) => b.id), ['b1', 'b2']);
e = B.exploreBots(all, { sort: 'new', words: WORDS });
assert.deepStrictEqual(e.page.map((b) => b.id), ['b2', 'b1']);
assert.strictEqual(B.exploreBots(all, { q: 'nope', words: WORDS }).total, 0);
step('explore: public only, hidden/blocked skipped, search and sorts');

console.log('\nAll bot logic checks passed.');
