// "Aduna bot" rules for the AI: what to tell the model, how to read its reply, and the checks that mirror server/bots.js.
// Pure logic: no Electron, no files, no network.
'use strict';
const vm = require('vm');
const core = require('./core');

const LIMITS = { name: 32, description: 200, code: 32 * 1024 };

// hosts: the web addresses this server lets bots fetch (the page passes the server's real list)
function systemPrompt(o = {}) {
  const hosts = Array.isArray(o.fetchHosts) && o.fetchHosts.length ? o.fetchHosts : ['api.github.com'];
  return [
    'You are an expert JavaScript programmer writing a chat bot for Aduna, inside an automated build loop on the user\'s PC.',
    'Build exactly what the user asks for, prove it with a test, and keep fixing it until the test passes.',
    '',
    'HOW AN ADUNA BOT WORKS',
    'bot.js is the BODY of a function that receives one argument, `bot`. It is NOT a Node.js program.',
    '- There is NO require, import, export, module, process, console, setTimeout, setInterval, fetch or window, and NO npm packages. Only plain JavaScript (JSON, Math, Date, Promise, strings, arrays) and `bot`.',
    '- The code runs again from the top for every event. Variables are NOT kept between events. Keep anything you need with bot.store.',
    '- Each event gets about 100 ms and may send at most 5 messages of 2000 characters, 5 reactions and 3 web requests. Keep handlers short.',
    '- bot.js may be at most 32 KB. Bots never receive messages from other bots, and only see text channels.',
    '',
    'THE bot OBJECT',
    'bot.on(\'message\', (m) => {})      m = { id, channelId, serverId, text, mentions, mentionsBot, attachments, replyTo, createdAt, author: { id, username, displayName, bot } }',
    'bot.on(\'messageEdit\', (m) => {})  same as message',
    'bot.on(\'memberJoin\', (e) => {})   e = { user: { id, username, displayName, bot }, channels: [{ id, name }] }',
    'bot.on(\'memberLeave\', (e) => {})  like memberJoin, plus e.reason',
    'bot.on(\'install\', (e) => {})      e = { serverName, by, channels }',
    'bot.on(\'timer\', (e) => {})        e = { name, kind, data, firedAt, channels }',
    'bot.on(\'fetch\', (e) => {})        e = { name, url, ok, status, text, json, truncated, error, channels }',
    'bot.reply(m, \'text\')   bot.send(channelId, \'text\')   bot.react(m, \'\u{1F44D}\')   bot.log(\'text\')',
    'bot.store.set(key, value)   bot.store.get(key)   bot.store.incr(key, 1)   bot.store.delete(key)   bot.store.keys()',
    '  Saved data: up to 64 keys per server, 4 KB a value (any JSON value), keys of letters, numbers and _ . : -',
    'bot.timer.after(name, seconds, data)   bot.timer.every(name, seconds, data)   bot.timer.daily(name, \'09:30\', \'America/Vancouver\', data)   bot.timer.cancel(name)',
    '  Timers: at least 5 seconds for after and 60 for every, at most 10 per server, name of letters, numbers and _ . : -',
    'bot.fetch(\'https://...\', \'name\')   GET only, https only, JSON or text. It returns nothing: the answer arrives later in a \'fetch\' event.',
    '  Only these web addresses are allowed: ' + hosts.join(', '),
    'Mention the person you answer with \'<@\' + m.author.id + \'>\'. A bot can only ping the person it is answering. Commands usually start with "!".',
    'Web requests: the answer comes in a separate event that has no message, so first save where to answer (bot.store.set(\'reply:name\', m.channelId)), then in the \'fetch\' event read it back with bot.store.get and use bot.send(channelId, text).',
    '',
    'THE TEST (test.js) runs in the same kind of sandbox, with these globals: assert, test, newBot, console.log',
    'assert works like node:assert (ok, equal, strictEqual, deepStrictEqual, throws, match, ...). require(\'node:assert\') also works, but nothing else can be required.',
    'test(name, fn) defines a test. Inside it, newBot() gives a fresh bot (empty saved data) running bot.js:',
    '  const t = newBot();',
    '  t.say(\'!ping\')                       // person u1 (Tester) types in channel c1. Extra: t.say(text, { author: \'u2\', channelId: \'c2\', mentionsBot: true, replyTo: \'m1\' })',
    '  t.edit(text)  t.join()  t.leave()  t.install()   // other events. For anything else: t.emit(event, payload)',
    '  t.advance(seconds)                    // time passes; timers that are due fire as \'timer\' events',
    '  t.fetchAnswer(\'name\', { json: { stars: 7 } })     // answer a bot.fetch (also { text, ok: false, status: 500 })',
    '  t.setStore(key, value)                // put saved data in place before an event',
    '  Read what happened: t.sent [{ channelId, text, replyTo }], t.reactions [{ messageId, emoji }], t.logs, t.fetches [{ url, name }], t.timers, t.store (an object), t.dropped (what the server refused, and why)',
    '  People: u1 Tester, u2 Sam, u3 Other Bot (a bot: its messages are ignored). Channels: c1 general, c2 random, c3 Lounge (voice: bots cannot use it). Message ids are m1, m2, ...',
    'Example test.js:',
    'test(\'!ping answers pong\', () => {',
    '  const t = newBot();',
    '  t.say(\'!ping\');',
    '  assert.deepStrictEqual(t.sent.map((s) => s.text), [\'pong <@u1>\']);',
    '});',
    '',
    'RULES FOR THE TEST',
    '- Every bot.on(...) handler in bot.js must be triggered by the test, and the test must assert what it does. The build is only finished when each handler was exercised and the test really asserts something.',
    '- Test every command and event the request needs, including a message that should be ignored. Assert exact texts.',
    '- If a test fails, fix the cause in bot.js. Never weaken or delete test expectations to make a test pass; only change a test that is plainly wrong.',
    '- Always write COMPLETE files. Never write "..." or "rest of file unchanged".',
    '- You are shown what you already tried and how it failed. Never repeat a fix that already failed; if the same error keeps coming back, change your approach.',
    '',
    'REPLY FORMAT: only these blocks, no other commentary:',
    '<file path="bot.js">',
    'complete file content',
    '</file>',
    '<file path="test.js">',
    'complete file content',
    '</file>',
    '(include only the files you change; both on the first attempt)',
    '<name>A short name for the bot, 2 to 4 words</name>',
    '<done>One plain sentence, under 180 characters, saying what the bot does and which commands people type.</done>',
    '(<name> and <done> only after the test has passed and covers everything the request asks for.)',
  ].join('\n');
}

// The files the model may write. Anything else is ignored.
const FILES = ['bot.js', 'test.js'];
const normPath = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

// Reads a model reply. Tolerant of think-blocks, code fences and quote style.
// -> { files: { 'bot.js'?: text, 'test.js'?: text }, ignored: [paths], name, done, cutOff }
function parseReply(raw, meta) {
  const text = core.stripThinking(raw);
  const files = {}, ignored = [];
  const re = /<file\s+path\s*=\s*(["'])(.+?)\1\s*>\r?\n?([\s\S]*?)<\/file>/gi;
  let m;
  while ((m = re.exec(text))) {
    const p = normPath(m[2]);
    if (FILES.includes(p)) files[p] = core.unfence(m[3]); else ignored.push(m[2].trim());
  }
  const rest = text.replace(re, '');
  const name = /<name>([\s\S]*?)<\/name>/i.exec(rest);
  const done = /<done>([\s\S]*?)<\/done>/i.exec(rest);
  const opens = (text.match(/<file\s/gi) || []).length, closes = (text.match(/<\/file>/gi) || []).length;
  const cutOff = !!(meta && meta.truncated) || opens > closes;
  return { files, ignored, name: name ? name[1].trim() : null, done: done ? (done[1].trim() || 'Done.') : null, cutOff };
}

// The same checks the server makes before it saves a bot: size, then syntax inside the same wrapper.
function codeProblem(code) {
  const c = String(code == null ? '' : code);
  if (!c.trim()) return 'The bot has no code.';
  if (Buffer.byteLength(c) > LIMITS.code) return 'The code is over the ' + (LIMITS.code / 1024) + ' KB limit for a bot.';
  try { new vm.Script('(function (bot) {\n' + c + '\n})', { filename: 'bot.js' }); return null; }
  catch (e) { return 'Syntax error: ' + String(e.message).slice(0, 160); }
}

const clipText = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trim() + '\u2026' : s; };

// A name for the bot when the AI did not give one: the first few words of the request.
function botNameFrom(request) {
  let s = String(request || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(please\s+)?(can you\s+)?(make|create|build|write|code)\s+(me\s+)?(an?\s+|the\s+)?(aduna\s+)?(chat\s+)?bot\s*(that|which|to|for|called|named)?\s*/i, '');
  const words = s.replace(/[^A-Za-z0-9 ]+/g, ' ').split(' ').filter(Boolean).slice(0, 3);
  if (!words.length) return 'My Bot';
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return (/bot$/i.test(name) ? name : name + ' Bot').slice(0, LIMITS.name).trim();
}

module.exports = { LIMITS, FILES, systemPrompt, parseReply, codeProblem, clipText, botNameFrom };
