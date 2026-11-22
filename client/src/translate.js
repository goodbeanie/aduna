// "Translate messages" (Settings > Language). Only messages in server channels: the browser asks the server to translate them by id, a few at a time,
// and remembers the answers for this visit. Direct messages and groups are end-to-end encrypted and are never sent anywhere.
import { useEffect, useState } from 'react';
import { api } from './api.js';

const answers = new Map(); // `${lang}:${id}:${editedAt}` -> { text, from } or null (nothing to show: already in your language, or no words)
const waiting = new Map(); // key -> the redraw functions of the messages waiting for it
const queue = new Map(); // channelId -> Map(id -> { key, lang })
const MAX_BATCH = 20, MAX_ANSWERS = 2000;
let timer = 0, pausedUntil = 0; // the server said no (not set up, used up, or failing): leave it alone for a while

function answer(key, value) {
  if (answers.size >= MAX_ANSWERS) answers.delete(answers.keys().next().value); // the oldest goes first
  answers.set(key, value);
  const fns = waiting.get(key);
  if (fns) { fns.forEach((f) => f()); waiting.delete(key); }
}

async function send(channelId, lang, list) {
  try {
    const r = await api('/channels/' + channelId + '/translate', { method: 'POST', body: { ids: list.map((x) => x.id), lang } });
    if (!r.ok) pausedUntil = Date.now() + (r.reason === 'off' ? 10 * 60_000 : 60_000);
    for (const { id, key } of list) if (r.results && r.results[id] !== undefined) answer(key, r.results[id]);
  } catch { pausedUntil = Date.now() + 60_000; }
}

function flush() {
  timer = 0;
  const jobs = [...queue];
  queue.clear();
  for (const [channelId, items] of jobs) {
    const byLang = new Map();
    for (const [id, { key, lang }] of items) {
      if (!byLang.has(lang)) byLang.set(lang, []);
      byLang.get(lang).push({ id, key });
    }
    for (const [lang, list] of byLang) for (let i = 0; i < list.length; i += MAX_BATCH) send(channelId, lang, list.slice(i, i + MAX_BATCH));
  }
}

// The translation of one message, or null while it is not known or there is nothing to show. `on` is false in direct messages and groups.
export function useTranslation(m, on, lang) {
  const key = on && m.channelId && !m.system && m.content ? lang + ':' + m.id + ':' + (m.editedAt || 0) : '';
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!key || answers.has(key) || Date.now() < pausedUntil) return undefined;
    const fn = () => redraw((n) => n + 1);
    if (!waiting.has(key)) waiting.set(key, new Set());
    waiting.get(key).add(fn);
    if (!queue.has(m.channelId)) queue.set(m.channelId, new Map());
    queue.get(m.channelId).set(m.id, { key, lang });
    if (!timer) timer = setTimeout(flush, 200); // messages that appear together go out together
    return () => {
      const fns = waiting.get(key);
      if (fns) { fns.delete(fn); if (!fns.size) waiting.delete(key); }
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return key ? answers.get(key) || null : null;
}

// "German", "Deutsch", "alemán": the language's name in the language the app is shown in.
export function languageName(code, ui) {
  try { return new Intl.DisplayNames([ui], { type: 'language' }).of(String(code).split('-')[0]) || code; } catch { return String(code || ''); }
}
