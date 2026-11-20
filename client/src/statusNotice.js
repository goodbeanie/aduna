import { useEffect, useSyncExternalStore } from 'react';

// The notice posted from the status site's admin page (adunastatus). It is stored on Cloudflare, so it still loads while
// this server is down. Keep the address in step with STATUS_NOTICE_URL in server/security.js, which lets the page reach it.
const NOTICE_URL = 'https://adunafront.nathankennethvc2.workers.dev/status-notice';
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

export async function refreshNotice() {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const stop = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : 0;
  try {
    const r = await fetch(NOTICE_URL + '?t=' + Date.now(), { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    if (r.ok) setNotice(await r.json());
  } catch { /* keep the last notice */ }
  clearTimeout(stop);
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
