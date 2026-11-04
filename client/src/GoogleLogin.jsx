import React, { useState, useEffect, useRef } from 'react';
import { api, markSignedIn, endSession } from './api.js';
import { unlockIdentity, saveKey, loadKey } from './crypto.js';
import { isNativeApp, isDesktopApp } from './notify.js';
import { Avatar } from './ui.jsx';

// Continue with Google (the server side is server/googlelogin.js and the "Google" block in server/index.js).
// Google only proves who the person is. The password still locks the encryption key that opens their messages, so after Google says yes
// a device that does not hold the key yet asks for the password once (it never leaves this device).
//   web: this tab goes to Google and comes back to /app?google=1; the secret request id waits in sessionStorage meanwhile
//   desktop / Android: Google refuses embedded browsers, so the address opens in the system browser and this window keeps polling
const KEY = 'aduna-google-req';
const ask = () => { try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; } };
export const pendingGoogle = ask;
export const clearGoogle = () => { try { sessionStorage.removeItem(KEY); } catch { /* private mode */ } };

// Starts a sign-in and leaves for Google (web) or opens the system browser (apps). Returns the secret request id.
export async function startGoogle() {
  const native = isNativeApp() || isDesktopApp();
  const r = await api('/auth/google/start', { method: 'POST', body: { native } });
  try { sessionStorage.setItem(KEY, r.id); } catch { /* private mode: the apps do not need it, the web page then cannot resume */ }
  if (native) window.open(r.url, '_blank');
  else location.assign(r.url);
  return r.id;
}

export const GoogleG = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" style={{ flex: 'none' }}>
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

export function GoogleButton({ label, busy, onClick }) {
  return (
    <button type="button" className="btn full" disabled={busy} onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
      <GoogleG />{label}
    </button>
  );
}

// The screens after the person has been sent to Google. `id` is the secret request id.
//   waiting -> (Google answers) -> no account: onNew({ id, email, name }) | one account: sign in | several: pick one
//   then, if the account has two-factor: the code; then, if this device has no key for it: the password.
export function GoogleFlow({ id, onAuthed, onNew, onBack, onForgot }) {
  const [phase, setPhase] = useState('waiting'); // waiting | pick | code | unlock | error
  const [error, setError] = useState('');
  const [info, setInfo] = useState(null);        // what Google said: { email, name, accounts, canCreate }
  const [chosen, setChosen] = useState('');
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [signed, setSigned] = useState(null);    // { user, encPrivKey } once the session exists, until the key is open
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  async function signIn(account, twoFactor) {
    setBusy(true); setError('');
    try {
      const out = await api('/auth/google/signin', { method: 'POST', body: { id, account, ...(twoFactor ? { code: twoFactor.trim() } : {}) } });
      if (!alive.current) return;
      markSignedIn(true);
      clearGoogle();
      let key = null;
      try { key = await loadKey(out.user.id); } catch { /* no stored key: ask for the password */ }
      if (key) { onAuthed(out.user, key); return; } // this device already has the key: nothing to type
      if (!out.encPrivKey) { // an old account without encryption keys: they are made from the password, which only the password login can check
        await endSession();
        setError('This account needs one log-in with its username and password to finish setting up encryption. Log in that way once, then Google works.'); setPhase('error');
        return;
      }
      setSigned(out); setPhase('unlock');
    } catch (e) {
      if (!alive.current) return;
      if (e.code === '2fa_required') { setChosen(account); setPhase('code'); setError(''); return; }
      if (e.code === '2fa_invalid') { setError(e.message); return; }
      if (e.code === 'google_expired') { clearGoogle(); setError(e.message); setPhase('error'); return; }
      setError(e.message || 'Something went wrong'); if (phase === 'waiting') setPhase('error');
    } finally { if (alive.current) setBusy(false); }
  }

  // Ask the server how Google's answer went, every 2.5 s, until it has one.
  useEffect(() => {
    let stop = false, timer = 0;
    const tick = async () => {
      if (stop) return;
      try {
        const p = await api('/auth/google/poll', { method: 'POST', body: { id } });
        if (stop) return;
        if (p.status === 'failed') { clearGoogle(); setError(p.error || 'Google did not finish the sign-in.'); setPhase('error'); return; }
        if (p.status === 'expired') { clearGoogle(); setError('That Google sign-in expired. Try again.'); setPhase('error'); return; }
        if (p.status === 'ready') {
          setInfo(p);
          if (p.accounts.length === 0) { onNew({ id, email: p.email, name: p.name }); return; }
          if (p.accounts.length === 1) { setChosen(p.accounts[0].id); signIn(p.accounts[0].id); return; }
          setPhase('pick');
          return;
        }
      } catch (e) {
        if (stop) return;
        if (e.status && e.status !== 429) { setError(e.message || 'Something went wrong.'); setPhase('error'); return; }
        // offline for a moment, or "slow down": ask again
      }
      timer = setTimeout(tick, 2500);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function unlock(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      let key;
      try { key = await unlockIdentity(signed.encPrivKey, pw); } catch { throw new Error('That password is not right.'); } // fails here, on this device: nothing is sent
      await saveKey(signed.user.id, key);
      onAuthed(signed.user, key);
    } catch (err) { setError(err.message); } finally { if (alive.current) setBusy(false); }
  }
  async function leave(fn) { clearGoogle(); if (signed) await endSession(); fn(); } // a sign-in that does not finish must not leave a session behind

  const head = <span className="wordmark" role="img" aria-label="Aduna" />;
  const err = error ? <div className="error" role="alert">{error}</div> : null;

  if (phase === 'unlock') return (
    <form onSubmit={unlock}>
      {head}
      <h1>Unlock your messages</h1>
      <p className="muted center">Google confirmed it is you. Enter your Aduna password to open your encrypted messages on this device. It stays on this device.</p>
      <label htmlFor="g-pw">Password</label>
      <input id="g-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus required autoComplete="current-password" />
      <p className="muted small auth-forgot"><a href="#" onClick={(e) => { e.preventDefault(); leave(onForgot); }}>Forgot your password?</a></p>
      {err}
      <button className="btn primary full" disabled={busy}>{busy ? 'Working…' : 'Unlock'}</button>
      <button type="button" className="btn full" disabled={busy} onClick={() => leave(onBack)}>Cancel</button>
    </form>
  );

  if (phase === 'code') return (
    <form onSubmit={(e) => { e.preventDefault(); signIn(chosen, code); }}>
      {head}
      <h1>Two-factor code</h1>
      <p className="muted center">This account uses an authenticator app. Enter the 6-digit code (or a recovery code).</p>
      <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus required autoComplete="one-time-code" inputMode="text" maxLength={20} placeholder="123456" aria-label="Code" />
      {err}
      <button className="btn primary full" disabled={busy}>{busy ? 'Working…' : 'Continue'}</button>
      <button type="button" className="btn full" disabled={busy} onClick={() => leave(onBack)}>Cancel</button>
    </form>
  );

  if (phase === 'pick') return (
    <>
      {head}
      <h1>Which account?</h1>
      <p className="muted center">{info.email} has more than one Aduna account. Pick the one to open.</p>
      <div className="auth-alt">
        {info.accounts.map((a) => (
          <button key={a.id} type="button" className="btn full" disabled={busy} onClick={() => { setChosen(a.id); signIn(a.id); }} style={{ display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' }}>
            <Avatar user={a} size={36} />
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.displayName || a.username}</strong>
              <span className="muted small">@{a.username}{a.creator ? ' · Creator' : ''}</span>
            </span>
          </button>
        ))}
        {info.canCreate && <button type="button" className="btn full" disabled={busy} onClick={() => onNew({ id, email: info.email, name: info.name })}>Make a new account with this Google email</button>}
      </div>
      {err}
      <button type="button" className="btn full" disabled={busy} onClick={() => leave(onBack)}>Cancel</button>
    </>
  );

  if (phase === 'error') return (
    <>
      {head}
      <h1>Google sign-in</h1>
      {err}
      <button type="button" className="btn primary full" onClick={() => leave(onBack)}>Back</button>
    </>
  );

  return (
    <>
      {head}
      <h1>Continue with Google</h1>
      <p className="muted center" role="status">{busy ? 'Signing you in…' : 'Finish choosing your Google account. In the Aduna app that happens in your browser; come back here when it is done.'}</p>
      {err}
      <button type="button" className="btn full" onClick={() => leave(onBack)}>Cancel</button>
    </>
  );
}
