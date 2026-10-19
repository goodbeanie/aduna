import { io } from 'socket.io-client';

// The login lives in an httpOnly cookie that only the server can read or write, so no script on the page (an injected one
// included) can steal it. The browser sends it by itself with every request and socket connection; nothing here holds a token.
// "X-Session: cookie" tells the server not to put the token in its answers either.
const HINT = 'aduna_in'; // not a secret: only lets the landing page show \u201cOpen Aduna\u201d instead of \u201cLog in\u201d
export function markSignedIn(on) {
  try { on ? localStorage.setItem(HINT, '1') : localStorage.removeItem(HINT); } catch { /* private mode */ }
}
// Ends the session on the server (it is the only one that can delete the httpOnly cookie) and forgets everything local.
export async function endSession() {
  markSignedIn(false);
  try { localStorage.removeItem('aduna_token'); } catch { /* private mode */ }
  await fetch('/api/logout', { method: 'POST', headers: { 'X-Session': 'cookie' } }).catch(() => {});
}
// People who logged in before cookies existed have the old token in localStorage: trade it for the cookie once, then delete it.
export async function adoptLegacyToken() {
  let t = '';
  try { t = localStorage.getItem('aduna_token') || ''; } catch { return; }
  if (!t) return;
  try {
    const r = await fetch('/api/session', { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'X-Session': 'cookie' } });
    if (r.ok || r.status === 401) localStorage.removeItem('aduna_token'); // moved to the cookie, or it was dead anyway
  } catch { /* offline: try again next time */ }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Session': 'cookie' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403 && data.code === 'email_unverified') window.dispatchEvent(new Event('aduna:unverified'));
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

export const connectSocket = () => io(); // the cookie travels with the handshake

export const emitAck = (socket, event, payload) =>
  new Promise((resolve, reject) => {
    socket.timeout(8000).emit(event, payload, (err, res) => {
      if (err) return reject(new Error('Timed out'));
      if (res?.error) return reject(new Error(res.error));
      resolve(res);
    });
  });
