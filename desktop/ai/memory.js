// The AI's memory for one build: what it changed on every attempt and how it failed, so it stops repeating the same mistake.
// Also turns a test result into plain words for the model (what the bot actually did), and common errors into a plain hint.
// Pure logic: no Electron, no network, no files. The attempts live in the job record (jobs.js), so they survive a restart.
//
// attempt = { n, at, wrote: ['bot.js'|'test.js'], botDiff, testDiff, botAdded, botRemoved, testAdded, testRemoved, unchanged,
//             outcome: 'passed'|'failed'|'format'|'cutoff'|'incomplete', stage, problem, sig, detail, notes: [string],
//             assertions, testsTotal, testsPassed, covered, gaps: [string] }
'use strict';

const MAX_ATTEMPT_LINES = 8, MAX_CHARS = 2600;
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; };

// The same mistake looks the same twice: no paths, no numbers, no quotes around names.
const signature = (line) => String(line || '').toLowerCase().replace(/[a-z]:\\[^'"\n]*/g, '<path>').replace(/\/[^\s'"]+/g, '<path>').replace(/\d+/g, '#').replace(/"[^"]*"/g, '"_"').slice(0, 140);

const HELPER = { message: 't.say(text)', messageEdit: 't.edit(text)', memberJoin: 't.join()', memberLeave: 't.leave()', install: 't.install()', timer: 't.advance(seconds) after the bot set a timer', fetch: 't.fetchAnswer(name, { json })' };

// What is missing before this build may be called finished, as plain sentences.
function gapsOf(r) {
  const g = [];
  const c = r.coverage || {};
  if (c.noHandlers) g.push('bot.js never calls bot.on(...), so it cannot react to anything.');
  for (const e of c.missing || []) g.push(`bot.js listens for "${e}" but test.js never triggers it (use ${HELPER[e] || 't.emit(\'' + e + '\', payload)'}).`);
  for (const e of c.silent || []) g.push(`The "${e}" handler was triggered but did nothing visible (no message, reaction, saved data, timer, web request or log). Fix the handler or test a case where it acts.`);
  if (c.noAssertions) g.push('test.js does not assert anything. Add assert calls that check what the bot sent or saved.');
  return g;
}

const lines = (s) => String(s || '').split('\n');
const firstDiff = (err) => lines(err).find((l) => /first difference at/.test(l));

// A one-line description of what failed, used for the signature and for the history.
function problemOf(r) {
  if (r.error) return clip(r.error.split('\n')[0], 200);
  const bad = (r.tests || []).find((t) => !t.ok);
  if (bad) { const l = lines(bad.error); return clip(l[0] + (firstDiff(bad.error) ? ' ' + firstDiff(bad.error).trim() : ''), 220); }
  if (r.failures && r.failures.length) { const l = lines(r.failures[0]); return clip(l[0] + (firstDiff(r.failures[0]) ? ' ' + firstDiff(r.failures[0]).trim() : ''), 220); }
  if (r.exitCode) return `the test called process.exit(${r.exitCode})`;
  const g = gapsOf(r);
  return g.length ? clip(g[0], 200) : '';
}
function stageOf(r) {
  if (r.sandboxMissing) return 'sandbox';
  if (r.error) return /^BotError/.test(r.error) ? 'bot' : 'test';
  const bad = (r.tests || []).find((t) => !t.ok);
  const e = bad ? bad.error : (r.failures && r.failures[0]) || '';
  if (/^BotError/.test(e)) return 'bot';
  if (/AssertionError/.test(e) || (!bad && r.failures && r.failures.length)) return 'assert';
  if (bad || r.exitCode) return 'test';
  return 'coverage';
}

const sayList = (a) => a.map((x) => JSON.stringify(typeof x === 'string' ? x : x.text !== undefined ? x.text : x.emoji !== undefined ? x.emoji : x)).join(', ');
// The long version for the model: the failures, what the bot actually did, and what it left behind.
function detailOf(r, maxChars = MAX_CHARS) {
  const out = [];
  const total = (r.tests || []).length, ok = (r.tests || []).filter((t) => t.ok).length;
  out.push(`TEST RESULT: ${r.ok ? (r.covered ? 'PASSED' : 'PASSED but not finished') : 'FAILED'} (${ok} of ${total} test${total === 1 ? '' : 's'} passed, ${r.assertions || 0} assertion${r.assertions === 1 ? '' : 's'} checked)`);
  if (r.error) out.push('ERROR: ' + r.error);
  for (const t of r.tests || []) if (!t.ok) out.push(`TEST "${t.name}" FAILED: ${t.error}`);
  const listed = new Set((r.tests || []).map((t) => t.error));
  for (const f of (r.failures || []).slice(0, 3)) if (![...listed].some((e) => e && e.includes(lines(f)[0]))) out.push('ASSERTION FAILED (the failure was caught inside the test, but it still counts): ' + f);
  if ((r.activity || []).length) {
    out.push('WHAT THE BOT DID (events from the test, oldest first):');
    for (const a of r.activity.slice(-10)) {
      const bits = [];
      if (a.skipped) bits.push('not delivered: ' + a.skipped);
      if (a.sent && a.sent.length) bits.push('sent ' + sayList(a.sent));
      if (a.reactions && a.reactions.length) bits.push('reacted ' + sayList(a.reactions));
      if (a.logs && a.logs.length) bits.push('logged ' + sayList(a.logs));
      if (a.dropped && a.dropped.length) bits.push('REFUSED by the server rules: ' + a.dropped.join('; '));
      if (a.error) bits.push('ERROR: ' + a.error);
      if (!bits.length) bits.push('did nothing');
      out.push(`- ${a.event}${a.input ? ' ' + JSON.stringify(a.input) : ''}: ${bits.join(' | ')}`);
    }
  }
  const f = r.final;
  if (f && !r.ok) {
    const keep = [];
    if (Object.keys(f.stored || {}).length) keep.push('saved data ' + JSON.stringify(f.stored));
    if ((f.timers || []).length) keep.push('timers ' + f.timers.join(', '));
    if (keep.length) out.push('LEFT BEHIND by the last bot in the test: ' + keep.join('; '));
  }
  if ((r.console || []).length) out.push('TEST OUTPUT (console.log): ' + r.console.slice(0, 8).join(' | '));
  const gaps = gapsOf(r);
  if (r.ok && gaps.length) out.push('NOT FINISHED, the test is missing:\n- ' + gaps.join('\n- '));
  let s = out.join('\n');
  if (s.length > maxChars) s = s.slice(0, maxChars - 40) + '\n\u2026 (the rest was cut to fit)';
  return s;
}

// A plain-words hint for an error that models keep making. '' when there is nothing useful to add.
function diagnose(r) {
  const text = [r.error || '', ...(r.tests || []).map((t) => t.error || ''), ...(r.failures || []), ...(r.activity || []).map((a) => a.error || '')].join('\n');
  const botSide = /BotError|The bot failed/.test(text);
  const undef = /'?(require|module|exports|console|process|setTimeout|setInterval|clearTimeout|fetch|window|document|Buffer|global)'? is not defined/.exec(text);
  if (undef) {
    const name = undef[1];
    if (botSide) return `A bot has no ${name}. Bot code is only plain JavaScript and the bot object: use bot.log instead of console.log, bot.timer instead of setTimeout, bot.fetch for the web, and no require or exports (the file is only the body of a function that receives bot).`;
    if (name === 'setTimeout' || name === 'setInterval') return 'A test has no timers. Use t.advance(seconds) to let time pass; it fires the bot\'s due timers.';
    return `A test has no ${name}. The test sandbox only has assert, test, newBot and console.log.`;
  }
  if (/Cannot find module/.test(text)) return 'A test cannot require anything except node:assert. Everything you need is already a global: assert, test, newBot.';
  if (/took longer than 100 ms/.test(text)) return 'An event gets about 100 ms. Remove endless loops and very large loops from the handler.';
  if (/too much memory/.test(text)) return 'The bot used too much memory. Do not build huge strings or arrays.';
  if (/never finished/.test(text)) return 'Everything in test.js is synchronous: call t.say(...) and read t.sent right away. Do not await things that never resolve.';
  if (/Cannot use import statement|Unexpected token 'export'|Unexpected token 'import'/.test(text)) return 'Use plain scripts: no import or export.';
  if (/SyntaxError/.test(text)) return botSide ? 'bot.js must be only the function body: no "function" wrapper around it, no exports, no top-level import. Check brackets and quotes.' : 'test.js has a syntax error. Check brackets and quotes.';
  if (/not on the allowed list/.test(text)) return 'The server only lets bots fetch the addresses listed in the instructions. Use one of those.';
  if (/bot\.store\.[a-z]+ is not a function|store\.(push|find|map) is not a function/.test(text)) return 'bot.store only has set, get, incr, delete and keys. To keep a list, save an array with bot.store.set(key, array).';
  return '';
}

// How many of the latest real attempts in a row failed with the same problem (0 when the last one passed or had no problem).
// A reply that was cut off or in the wrong format says nothing about the error, so it neither counts nor breaks the streak.
function repeats(attempts) {
  const real = attempts.filter((a) => a.outcome !== 'format' && a.outcome !== 'cutoff');
  const last = real[real.length - 1];
  if (!last || last.outcome === 'passed' || !last.sig) return 0;
  let n = 0;
  for (let i = real.length - 1; i >= 0 && real[i].outcome !== 'passed' && real[i].sig === last.sig; i--) n++;
  return n;
}

// Escalation: the more often the same error comes back, the bigger the change the model is asked to make.
function escalation(attempts) {
  const n = repeats(attempts);
  if (n < 2) return '';
  const real = attempts.filter((a) => a.outcome !== 'format' && a.outcome !== 'cutoff');
  const p = real[real.length - 1].problem;
  if (n === 2) return `WARNING: your last 2 attempts failed with the same problem ("${p}"). Repeating the same fix does not work. Read the error and the files again and find the real cause.`;
  const step = (n - 3) % 3;
  const head = `The same problem ("${p}") has now come back ${n} times in a row.`;
  let text;
  if (step === 0) text = `STEP BACK: ${head} Write the SMALLEST possible bot.js that makes ONE failing assertion pass (one handler, nothing extra). Grow it again once that works. Leave test.js alone unless it is the thing that is wrong (see below).`;
  else if (step === 1) text = `NEW APPROACH: ${head} Throw away your current design and rewrite bot.js from scratch with a different structure (for example parse the command another way, or keep state in bot.store instead of variables). Do not just edit the old code.`;
  else text = `PROBE: ${head} Add bot.log(...) lines to bot.js that print the values that matter (the incoming text, the saved data, which branch ran). Their output comes back under "WHAT THE BOT DID". Use what it shows before you change the logic.`;
  // An assertion that fails again and again is often a wrong expectation in test.js, not a wrong bot: say so.
  if (n >= 4 && real[real.length - 1].stage === 'assert') {
    text += '\n\nCHECK THE TEST: an assertion that keeps failing may be wrong itself. Compare the EXPECTED value in test.js with what the bot actually sent (under "WHAT THE BOT DID") and with what the request really asks for. If the bot\'s output already does what the request says and only the expected text, order or wording in test.js differs, fix test.js and say so in a comment. Never loosen a test to hide a real bot bug.';
  }
  return text;
}

// Fewer tests or fewer assertions than the attempt before, which had failed: the test may have been made easier instead of fixing the bot.
function weakened(prev, cur) {
  if (!prev || prev.outcome === 'passed' || prev.outcome === 'format' || prev.outcome === 'cutoff') return null;
  if (!prev.assertions && !prev.testsTotal) return null;
  const a = cur.assertions < prev.assertions, t = cur.testsTotal < prev.testsTotal;
  if (!a && !t) return null;
  return { text: `test.js got weaker: ${t ? `tests ${prev.testsTotal} -> ${cur.testsTotal}` : ''}${t && a ? ', ' : ''}${a ? `assertions ${prev.assertions} -> ${cur.assertions}` : ''}. Fix bot.js instead of making the test easier.` };
}

const changeText = (a) => {
  const bits = [];
  if (a.wrote.includes('bot.js')) bits.push(a.botAdded || a.botRemoved ? `bot.js (+${a.botAdded} -${a.botRemoved})` : 'bot.js (no change)'); else bits.push('bot.js unchanged');
  if (a.wrote.includes('test.js')) bits.push(a.testAdded || a.testRemoved ? `test.js (+${a.testAdded} -${a.testRemoved})` : 'test.js (no change)');
  return bits.join(', ');
};
const snippet = (d, n) => lines(d).slice(0, n).join('\n    ');

// The text added to the prompt: what each earlier attempt changed and how it ended, then the escalation.
function render(attempts) {
  if (!attempts.length) return '';
  const mine = attempts.slice(-MAX_ATTEMPT_LINES);
  const rows = mine.map((a, i) => {
    const end = a.outcome === 'passed' ? 'PASSED' : a.outcome === 'format' ? 'reply did not follow the format' : a.outcome === 'cutoff' ? 'reply was cut off' : a.outcome === 'incomplete' ? `passed but ${clip(a.gaps && a.gaps[0], 90) || 'not finished'}` : 'FAILED: ' + (a.problem || 'see above');
    let row = `- Attempt ${a.n}: ${a.wrote.length ? 'changed ' + changeText(a) : 'changed nothing'} -> ${end}${a.notes && a.notes.length ? ' [' + a.notes.join('; ') + ']' : ''}`;
    if (i >= mine.length - 3 && a.botDiff) row += '\n    bot.js change:\n    ' + snippet(a.botDiff, 7);
    return row;
  });
  while (rows.length > 1 && rows.join('\n').length > MAX_CHARS) rows.shift();
  const parts = ['WHAT YOU ALREADY TRIED (oldest first). A fix that already failed will fail again, so do something different:\n' + rows.join('\n')];
  const e = escalation(attempts);
  if (e) parts.push(e);
  return parts.join('\n\n');
}

module.exports = { signature, gapsOf, problemOf, stageOf, detailOf, diagnose, repeats, escalation, weakened, render, HELPER };
