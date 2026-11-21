import { useEffect, useSyncExternalStore } from 'react';

// The notice posted in /admin > Status. The server answers it live; the server also saves a copy on the status site (Cloudflare), which still
// loads while this server is down. Keep the copy's address in step with STATUS_NOTICE_URL in server/security.js, which lets the page reach it.
const NOTICE_URL = '/api/public/status-notice';
const COPY_URL = 'https://adunafront.nathankennethvc2.workers.dev/status.json';
const POLL_MS = 30000;
const TIMEOUT_MS = 5000;

let notice = null; // { down, message, backAt } or null
const subs = new Set();
let timer = 0;

function setNotice(next) {
  const empty = !next || (!next.down && !next.message);
  const value = empty ? null : { down: !!next.down, message: String(next.message || ''), backAt: next.backAt || null };
  if (JSON.stringify(value) === JSON.stringify(notice)) return;
  notice = value;
  subs.forEach((f) => f());
}

async function readJson(url) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const stop = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : 0;
  try {
    const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(stop); }
}

// Live from the server first; when it does not answer (it is off or restarting), the copy saved on the status site. If neither answers, keep the last notice.
export async function refreshNotice() {
  const live = await readJson(NOTICE_URL);
  if (live && typeof live === 'object') return setNotice(live);
  const copy = await readJson(COPY_URL);
  if (copy && typeof copy === 'object') setNotice(copy);
}

const subscribe = (fn) => {
  subs.add(fn);
  if (subs.size === 1) { refreshNotice(); timer = setInterval(refreshNotice, POLL_MS); }
  return () => {
    subs.delete(fn);
    if (!subs.size) { clearInterval(timer); timer = 0; }
  };
};

export function useNotice() {
  return useSyncExternalStore(subscribe, () => notice);
}

// The text for the banner, with the back-up time in the viewer's own time zone.
export function noticeText(n, t) {
  if (!n) return '';
  let text = (n.message || '').trim();
  if (!text) text = t('connReconnecting');
  const ms = n.backAt ? Date.parse(n.backAt) : NaN;
  if (isNaN(ms)) return text;
  if (!/[.!?…]$/.test(text)) text += '.';
  if (ms <= Date.now()) return text + ' ' + t('noticeSoon');
  const when = new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return text + ' ' + t('noticeBackUp') + ' ' + when + '.';
}

// Re-reads the notice when something about the connection changes, so a notice posted a moment ago shows up without waiting for the next poll.
export function useNoticeRefresh(trigger) {
  useEffect(() => { refreshNotice(); }, [trigger]);
}
