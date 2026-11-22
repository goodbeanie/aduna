// Translate messages, the server's half, with a fake network: node server/translate-test.js
'use strict';
const assert = require('assert');
const T = require('./translate');
const ok = (m) => console.log('✓', m);

(async () => {
  // ---- protect: tokens are wrapped, text is escaped, emoji-only and link-only messages have no words
  let p = T.protect('Hola <@0123456789abcdef> mira https://example.com/a?b=1&c=2 y `code` :)\nadiós <b>x</b>');
  assert.ok(p.letters);
  assert.ok(p.html.includes('<span class="notranslate" translate="no">&lt;@0123456789abcdef&gt;</span>'));
  assert.ok(p.html.includes('<span class="notranslate" translate="no">https://example.com/a?b=1&amp;c=2</span>'));
  assert.ok(p.html.includes('<span class="notranslate" translate="no">`code`</span>'));
  assert.ok(p.html.includes('<br>adiós &lt;b&gt;x&lt;/b&gt;'));
  for (const bare of ['<@0123456789abcdef>', 'https://example.com/', '<:wave:0123456789abcdef>', '@everyone', '```js\nlet a = 1\n```', '👍 😀', '123 456', '']) assert.ok(!T.protect(bare).letters, bare);
  assert.ok(T.protect('@everyone meeting now').letters);
  ok('protect keeps tokens, links and code out of the text and finds messages with no words');

  // ---- restore: tags, line breaks and entities
  assert.strictEqual(T.restore('Hello <span class="notranslate" translate="no">&lt;@0123456789abcdef&gt;</span>, it&#39;s &quot;fine&quot; &amp; done<br>bye &#x1F44B; &lt;b&gt;'), 'Hello <@0123456789abcdef>, it\'s "fine" & done\nbye 👋 <b>');
  assert.strictEqual(T.restore('a &amp;lt; b'), 'a &lt; b', 'decoded once, not twice');
  assert.strictEqual(T.restore('x &#99999999; &nope;'), 'x &#99999999; &nope;');
  ok('restore strips the wrappers and turns entities back into text');

  // ---- the service, with a fake network
  let calls = 0, mode = 'ok', t = Date.UTC(2026, 10, 21), lastBody = null;
  const fetchImpl = async (url, opts) => {
    calls++;
    assert.ok(String(url).startsWith('https://translation.googleapis.com/language/translate/v2?key='));
    lastBody = JSON.parse(opts.body);
    assert.strictEqual(lastBody.format, 'html');
    if (mode === 'down') throw new Error('network down');
    if (mode === '500') return { ok: false, status: 500, json: async () => ({}) };
    if (mode === 'short') return { ok: true, status: 200, json: async () => ({ data: { translations: [] } }) };
    const translations = lastBody.q.map((q) => (/Hola/.test(q)
      ? { translatedText: q.replace('Hola', 'Hello'), detectedSourceLanguage: 'es' }
      : { translatedText: q, detectedSourceLanguage: 'en' }));
    return { ok: true, status: 200, json: async () => ({ data: { translations } }) };
  };

  const off = T.createTranslator({ fetchImpl });
  assert.strictEqual(off.enabled, false);
  assert.deepStrictEqual(await off.translate(['Hola'], 'en'), { ok: false, reason: 'off', results: [] });
  assert.strictEqual(calls, 0, 'no key, no network');

  const tr = T.createTranslator({ key: 'K', fetchImpl, now: () => t, restMs: 60_000, monthlyChars: 400 });
  assert.strictEqual(tr.enabled, true);
  assert.deepStrictEqual(await tr.translate(['Hola'], 'xx'), { ok: false, reason: 'lang', results: [] });

  let r = await tr.translate(['Hola <@0123456789abcdef>', 'Already English here', '👍', 'https://example.com/', 'x'.repeat(T.MAX_CHARS + 1)], 'en');
  assert.ok(r.ok);
  assert.strictEqual(calls, 1);
  assert.strictEqual(lastBody.target, 'en');
  assert.strictEqual(lastBody.q.length, 2, 'only the two messages with words are sent');
  assert.deepStrictEqual(r.results[0], { text: 'Hello <@0123456789abcdef>', from: 'es' });
  assert.strictEqual(r.results[1], null, 'already in that language: nothing to show');
  assert.deepStrictEqual(r.results.slice(2), [null, null, null]);
  ok('a message in another language is translated, the rest are left alone');

  r = await tr.translate(['Hola <@0123456789abcdef>', 'Already English here'], 'en');
  assert.ok(r.ok);
  assert.strictEqual(calls, 1, 'answered from memory, including the "nothing to show" ones');
  assert.strictEqual(r.results[0].text, 'Hello <@0123456789abcdef>');
  ok('answers are remembered');

  r = await tr.translate(['Hola amigo'], 'zh');
  assert.strictEqual(lastBody.target, 'zh-CN');
  ok('Chinese goes out as zh-CN');

  const same = await tr.translate(['Hola de nuevo'], 'es');
  assert.strictEqual(same.results[0], null, 'Spanish into Spanish shows nothing');
  ok('text already in the reader\'s language is not shown twice');

  // monthly cap: 400 characters in this test
  const small = T.createTranslator({ key: 'K', fetchImpl, now: () => t, monthlyChars: 60 });
  calls = 0;
  r = await small.translate(['Hola, ¿cómo estás hoy amigo?'], 'en');
  assert.ok(r.ok);
  r = await small.translate(['Hola, ¿qué tal te va por ahí hoy?'], 'en');
  assert.deepStrictEqual([r.ok, r.reason, calls], [false, 'limit', 1]);
  t += 32 * 86400_000;
  r = await small.translate(['Hola, ¿qué tal te va por ahí hoy?'], 'en');
  assert.ok(r.ok, 'a new month starts the count again');
  ok('the monthly character cap stops calls and resets with the month');

  // failures: rest for a while, then try again; bad answers count as failures
  const f = T.createTranslator({ key: 'K', fetchImpl, now: () => t, restMs: 60_000 });
  calls = 0; mode = 'down';
  r = await f.translate(['Hola uno'], 'en');
  assert.deepStrictEqual([r.ok, r.reason, calls], [false, 'error', 1]);
  mode = 'ok';
  r = await f.translate(['Hola dos'], 'en');
  assert.deepStrictEqual([r.ok, r.reason, calls], [false, 'error', 1], 'resting: no new call');
  t += 61_000;
  r = await f.translate(['Hola dos'], 'en');
  assert.ok(r.ok); assert.strictEqual(calls, 2);
  mode = '500'; t += 61_000;
  assert.strictEqual((await f.translate(['Hola tres'], 'en')).reason, 'error');
  mode = 'short'; t += 61_000;
  assert.strictEqual((await f.translate(['Hola cuatro'], 'en')).reason, 'error');
  ok('a failing service is left alone for a minute, then tried again');

  console.log('\ntranslate (server): all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
