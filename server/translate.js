'use strict';
// "Translate messages" (Settings > Language), the server's half. No Express or database imports, so server/translate-test.js can test it with fakes.
// Only messages in server channels come here: the server can read those anyway. Direct messages and groups are end-to-end encrypted and are never sent.
// The service is Google Cloud Translation (Basic, v2). It needs GOOGLE_TRANSLATE_API_KEY and is off without it.
// Mentions, channel tags, custom emoji, links and code are wrapped as "do not translate" before sending and come back as they were.
const crypto = require('crypto');

const MAX_TEXTS = 20; // messages per request
const MAX_CHARS = 4000; // the longest message there is (Aduna Plus); longer text is not sent
const ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const TARGET = { en: 'en', fr: 'fr', es: 'es', de: 'de', ru: 'ru', zh: 'zh-CN' }; // app language -> the service's code

const KEEP = /```[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s<]+|<:[a-z0-9_]{2,32}:[0-9a-f]{16}>|<@[0-9a-f]{16}>|<#[0-9a-f]{16}>|@everyone/g;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
const base = (code) => String(code || '').toLowerCase().split('-')[0];

// The text as HTML for the service, and whether any of it is actual words (a message that is only emoji, a link or a mention is skipped).
function protect(text) {
  let html = '', last = 0, letters = false;
  const plain = (s) => { if (/\p{L}/u.test(s)) letters = true; html += esc(s); };
  for (const m of text.matchAll(KEEP)) {
    plain(text.slice(last, m.index));
    html += '<span class="notranslate" translate="no">' + esc(m[0]) + '</span>';
    last = m.index + m[0].length;
  }
  plain(text.slice(last));
  return { html, letters };
}

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// The service's answer back to plain message text.
function restore(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
      }
      return ENTITY[e.toLowerCase()] ?? all;
    });
}

// translate(texts, lang) -> { ok, reason, results }. results[i] is { text, from } or null when there is nothing to show (already in that language, or no words).
// reason when not ok: 'off' (no key), 'lang', 'limit' (this month's characters are used up) or 'error' (the service failed; it then rests for a minute).
// Answers are remembered, so a message in a busy channel is translated once, not once per reader.
function createTranslator({ key, fetchImpl, now = Date.now, ttlMs = 6 * 3600_000, maxCached = 3000, timeoutMs = 6000, restMs = 60_000, monthlyChars = 400_000 } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const enabled = !!key && !!doFetch;
  const cache = new Map(); // hash of language + text -> { at, out }
  let restUntil = 0, month = '', used = 0; // the month's count lives in memory, so a restart starts it again

  const hash = (lang, text) => crypto.createHash('sha1').update(lang + '\n' + text).digest('hex');
  const fresh = (e) => e && now() - e.at < ttlMs;
  function remember(k, out) {
    if (cache.size >= maxCached) cache.delete(cache.keys().next().value); // the oldest goes first
    cache.set(k, { at: now(), out });
  }
  function charge(n) {
    const m = new Date(now()).toISOString().slice(0, 7);
    if (m !== month) { month = m; used = 0; }
    if (used + n > monthlyChars) return false;
    used += n;
    return true;
  }

  async function translate(texts, lang) {
    const results = texts.map(() => undefined);
    if (!enabled) return { ok: false, reason: 'off', results: [] };
    const target = TARGET[lang];
    if (!target) return { ok: false, reason: 'lang', results: [] };

    const todo = []; // { i, k, html }
    texts.forEach((text, i) => {
      if (typeof text !== 'string' || text.length > MAX_CHARS) { results[i] = null; return; }
      const k = hash(lang, text);
      const e = cache.get(k);
      if (fresh(e)) { results[i] = e.out; return; }
      const p = protect(text);
      if (!p.letters) { results[i] = null; return; }
      todo.push({ i, k, html: p.html, text });
    });
    if (!todo.length) return { ok: true, results };
    if (now() < restUntil) return { ok: false, reason: 'error', results };
    if (!charge(todo.reduce((n, t) => n + t.html.length, 0))) return { ok: false, reason: 'limit', results };

    try {
      const r = await doFetch(ENDPOINT + '?key=' + encodeURIComponent(key), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: todo.map((t) => t.html), target, format: 'html' }),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      if (!r.ok) throw new Error('Translation answered ' + r.status);
      const j = await r.json();
      const list = j && j.data && j.data.translations;
      if (!Array.isArray(list) || list.length !== todo.length) throw new Error('Translation sent back an unexpected answer');
      todo.forEach((t, n) => {
        const from = String(list[n].detectedSourceLanguage || '');
        const out = restore(list[n].translatedText);
        const result = base(from) === base(target) || out.trim() === t.text.trim() ? null : { text: out, from };
        remember(t.k, result);
        results[t.i] = result;
      });
      return { ok: true, results };
    } catch (e) {
      restUntil = now() + restMs;
      return { ok: false, reason: 'error', results, error: e.message };
    }
  }
  return { enabled, translate, _cache: cache };
}

module.exports = { MAX_TEXTS, MAX_CHARS, TARGET, protect, restore, createTranslator };
