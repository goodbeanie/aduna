import { api } from './api.js';
import { identityJwk, lockIdentityWithPasskey, unlockIdentityWithPasskey } from './crypto.js';

// Passkeys in the browser (server/passkeys.js explains the idea). A passkey signs in without the password, and its "prf" output (secret
// bytes only that passkey can make) unlocks a copy of the end-to-end encryption key, so messages stay readable after a passkey sign-in.

// The fixed label the passkey turns into its secret bytes. It is not a secret itself.
const PRF_LABEL = new TextEncoder().encode('aduna passkey wrap v1');
const NO_PRF = 'This passkey cannot unlock your messages on this device (it needs a newer browser or passkey). Log in with your password instead.';

const toB64u = (buf) => {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64u = (s) => {
  const p = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(p + '='.repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

export const passkeysSupported = () => typeof window !== 'undefined' && window.isSecureContext !== false && !!window.PublicKeyCredential && !!navigator.credentials;

// What the browser says when the person closes the prompt, or has no way to answer it, in words they can use.
function friendly(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'AbortError') return new Error('That was cancelled, or it took too long. Try again.');
  if (n === 'InvalidStateError') return new Error('That device already has a passkey for Aduna.');
  if (n === 'NotSupportedError') return new Error('This device or browser cannot make passkeys.');
  if (n === 'SecurityError') return new Error('Passkeys do not work at this address.');
  return e instanceof Error ? e : new Error('Something went wrong with the passkey. Try again.');
}

// "Chrome on Windows": the default name of a new passkey, so the list tells them apart.
export function thisDeviceName() {
  const s = navigator.userAgent || '';
  const os = /Android/.test(s) ? 'Android' : /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Windows/.test(s) ? 'Windows' : /Macintosh|Mac OS X/.test(s) ? 'macOS' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : '';
  const br = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\/|FxiOS\//.test(s) ? 'Firefox' : /Chrome\/|CriOS\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  return br && os ? `${br} on ${os}` : br || os || 'Passkey';
}

const prfOf = (cred) => {
  const r = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
  const first = r && r.prf && r.prf.results && r.prf.results.first;
  return first ? new Uint8Array(first) : null;
};

// Settings > Security: make a passkey for this device. The password (and the two-factor code, if it is on) is asked again because a
// passkey is a way into the account and the key that opens its messages. Throws an Error with a sentence the person can read.
export async function addPasskey({ password, code, name }) {
  const { encPrivKey } = await api('/me');
  if (!encPrivKey) throw new Error('This account has no encryption key yet. Log out and back in once, then try again.');
  let jwk;
  try { jwk = await identityJwk(encPrivKey, password); } catch { throw Object.assign(new Error('That password is not right.'), { field: 'password' }); }

  const { challengeId, publicKey: pk } = await api('/me/passkeys/options', { method: 'POST', body: {} });
  const extensions = { prf: { eval: { first: PRF_LABEL } } };
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        ...pk,
        challenge: fromB64u(pk.challenge),
        user: { ...pk.user, id: fromB64u(pk.user.id) },
        excludeCredentials: (pk.excludeCredentials || []).map((c) => ({ ...c, id: fromB64u(c.id) })),
        extensions,
      },
    });
  } catch (e) { throw friendly(e); }
  if (!cred) throw new Error('That was cancelled. Try again.');

  // Most passkeys give the secret bytes straight away; some only on a sign-in, which asks the person once more.
  let prf = prfOf(cred);
  if (!prf) {
    try {
      const got = await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: pk.rp.id, allowCredentials: [{ type: 'public-key', id: cred.rawId }], userVerification: 'required', timeout: 120000, extensions } });
      prf = got && prfOf(got);
    } catch (e) { throw friendly(e); }
  }
  if (!prf) throw new Error(NO_PRF);

  const wrapped = await lockIdentityWithPasskey(jwk, prf);
  await unlockIdentityWithPasskey(wrapped, prf); // opened once before it is stored, so a broken copy is never kept

  return api('/me/passkeys/finish', {
    method: 'POST',
    body: {
      challengeId, name, password, code: code || undefined, wrapped,
      clientDataJSON: toB64u(cred.response.clientDataJSON),
      attestationObject: toB64u(cred.response.attestationObject),
    },
  });
}

export const removePasskey = ({ id, password, code }) => api('/me/passkeys/remove', { method: 'POST', body: { id, password, code: code || undefined } });

// The login screen: no username, no password. The browser shows the passkeys it has for this site (and "use a phone or tablet" for one
// that lives on another device). Resolves { user, privateKey }; the server's session cookie is already set, so the caller ends the
// session if anything after this fails.
export async function signInWithPasskey() {
  const { challengeId, publicKey: pk } = await api('/passkey/login/options', { method: 'POST', body: {} });
  let cred;
  try {
    cred = await navigator.credentials.get({ publicKey: { challenge: fromB64u(pk.challenge), rpId: pk.rpId, userVerification: pk.userVerification, timeout: pk.timeout, extensions: { prf: { eval: { first: PRF_LABEL } } } } });
  } catch (e) { throw friendly(e); }
  if (!cred) throw new Error('That was cancelled. Try again.');
  const prf = prfOf(cred);
  if (!prf) throw new Error(NO_PRF); // checked before asking the server, so no session is made that could not open the messages
  const r = await api('/passkey/login/finish', {
    method: 'POST',
    body: {
      challengeId, id: toB64u(cred.rawId),
      clientDataJSON: toB64u(cred.response.clientDataJSON),
      authenticatorData: toB64u(cred.response.authenticatorData),
      signature: toB64u(cred.response.signature),
      userHandle: cred.response.userHandle ? toB64u(cred.response.userHandle) : '',
    },
  });
  const privateKey = await unlockIdentityWithPasskey(r.wrapped, prf, r.user.publicKey);
  return { user: r.user, privateKey };
}
