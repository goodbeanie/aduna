// Firebase Cloud Messaging (FCM) sender for the Android app. No dependencies: it signs a service-account JWT with Node's
// crypto, trades it for an access token and calls the FCM HTTP v1 API. Like push.js it has no Express / Postgres imports,
// so server/fcm-test.js can test it alone with a fake fetch.
//
// Setup: Firebase console > Project settings > Service accounts > Generate new private key, then set the whole JSON (or its
// base64) as FCM_SERVICE_ACCOUNT on the server. Without it, Android push is simply off.
const crypto = require('crypto');

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const b64u = (b) => Buffer.from(b).toString('base64url');

function parseAccount(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  if (!text.startsWith('{')) { try { text = Buffer.from(text, 'base64').toString('utf8'); } catch { return null; } }
  try {
    const j = JSON.parse(text);
    if (j && j.type === 'service_account' && j.project_id && j.client_email && j.private_key) {
      return { projectId: String(j.project_id), email: String(j.client_email), key: String(j.private_key) };
    }
  } catch { /* not JSON */ }
  return null;
}

// A registration token as the Android SDK hands it out: letters, digits, : _ -
const validToken = (t) => typeof t === 'string' && t.length >= 20 && t.length <= 4096 && /^[A-Za-z0-9:_-]+$/.test(t);

function createFcm({ raw, fetchFn = globalThis.fetch, now = Date.now } = {}) {
  const acct = parseAccount(raw);
  let tok = null, tokExp = 0, inflight = null;

  async function accessToken(force) {
    if (!force && tok && now() < tokExp - 60000) return tok;
    if (inflight) return inflight;
    inflight = (async () => {
      const iat = Math.floor(now() / 1000);
      const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const claim = b64u(JSON.stringify({ iss: acct.email, scope: SCOPE, aud: TOKEN_URI, iat, exp: iat + 3600 }));
      const sig = crypto.sign('RSA-SHA256', Buffer.from(head + '.' + claim), acct.key);
      const r = await fetchFn(TOKEN_URI, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + b64u(sig) }).toString(),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) {
        // statusCode 502 (not 404/410) so a server-side auth problem never deletes anyone's device
        throw Object.assign(new Error('FCM sign-in failed: ' + (j.error_description || j.error || r.status)), { statusCode: 502 });
      }
      tok = j.access_token; tokExp = now() + (Number(j.expires_in) || 3600) * 1000;
      return tok;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  // body: the same JSON string the Web Push path gets: { kind, title, body, url, tag }. opts: { TTL (seconds), callUi }
  // callUi: this device's app has the native call screen (Answer / Decline buttons, looping ringtone). For it, a call is sent as a
  // data-only message (no "notification" block), because only the app's own service can draw that screen, even while the app is closed.
  // Older apps never say callUi, so they keep getting the plain system notification below.
  async function send(token, body, opts = {}) {
    if (!acct) throw Object.assign(new Error('FCM is not configured'), { statusCode: 503 });
    const p = typeof body === 'string' ? JSON.parse(body) : body;
    const kind = String(p.kind || 'dm');
    const ttl = Math.max(0, Math.floor(opts.TTL || 3600)) + 's';
    const ring = kind === 'call' && opts.callUi === true && /^[A-Za-z0-9_-]{1,64}$/.test(String(p.callId || ''));
    const message = ring
      ? {
        token,
        data: {
          kind, url: String(p.url || '/app'), tag: String(p.tag || 'call'), callId: String(p.callId),
          title: String(p.title || 'Aduna'), body: String(p.body || ''), sender: String(p.sender || ''), video: p.video ? '1' : '0',
          ...(p.declineToken ? { declineToken: String(p.declineToken) } : {}),
          ...(p.cancel ? { cancel: '1' } : {}),
        },
        android: { priority: 'HIGH', ttl },
      }
      : {
        token,
        notification: { title: String(p.title || 'Aduna'), body: String(p.body || '') },
        data: { url: String(p.url || '/app'), kind, tag: String(p.tag || '') },
        android: {
          priority: 'HIGH',
          ttl,
          notification: { channel_id: kind === 'call' ? 'calls' : 'messages', icon: 'ic_stat_icon', ...(p.tag ? { tag: String(p.tag) } : {}) },
        },
      };
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(acct.projectId)}/messages:send`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await accessToken(attempt > 0);
      const r = await fetchFn(url, { method: 'POST', headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
      if (r.ok) return true;
      if (r.status === 401 && attempt === 0) { tok = null; continue; } // the access token expired early: get a fresh one once
      const j = await r.json().catch(() => ({}));
      const status = j?.error?.status || '';
      const text = String(j?.error?.message || r.status).slice(0, 200);
      // UNREGISTERED / NOT_FOUND: the app was uninstalled or the token rotated. The caller drops the device on 404.
      const dead = r.status === 404 || status === 'UNREGISTERED' || status === 'NOT_FOUND';
      throw Object.assign(new Error('FCM: ' + text), { statusCode: dead ? 404 : r.status, body: status + ' ' + text });
    }
  }

  return { enabled: !!acct, send, projectId: acct?.projectId || null };
}

module.exports = { createFcm, parseAccount, validToken };
