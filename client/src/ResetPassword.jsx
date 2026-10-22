import React, { useEffect, useState } from 'react';
import { api, markSignedIn } from './api.js';
import { createIdentity, saveKey, hasCrypto } from './crypto.js';
import { RecoveryKeyCard } from './Recovery.jsx';

// The page an emailed reset link opens: <site>/reset#<token>.
// The token sits after the # on purpose: browsers never send that part to a server, so it stays out of access logs and Referer headers.
// Opening the page changes nothing. It asks the server whether the link is still good (/recover/email/check), and only when the person
// submits a new password does it call /recover/email/finish. That call makes a NEW encryption key in this browser (an email cannot
// bring the old one back), so older direct messages become unreadable; the person must tick a box that says so.

export const RESET_PATH = /^\/reset\/?$/;
export const resetTokenFromLocation = () => (RESET_PATH.test(location.pathname) ? location.hash.replace(/^#/, '') : null);

const goToApp = () => location.replace('/app'); // a full load: the new login cookie and the key saved in this browser are picked up from scratch

export default function ResetPassword({ token }) {
  const [phase, setPhase] = useState('checking'); // checking | bad | form | done
  const [who, setWho] = useState({ username: '', twoFactor: false });
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [code, setCode] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(null); // { key, username } until the new recovery key is saved
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let live = true;
    if (!token) { setPhase('bad'); return undefined; }
    api('/recover/email/check', { method: 'POST', body: { token } })
      .then((r) => { if (live) { setWho({ username: r.username, twoFactor: !!r.twoFactor }); setPhase('form'); } })
      .catch((e) => {
        if (!live) return;
        if (e.status === 401 || e.status === 400) setPhase('bad');
        else { setOffline(true); setPhase('bad'); } // rate limited or no connection: the link may still be fine
      });
    return () => { live = false; };
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!hasCrypto()) return setError('Encryption needs a secure context. Open this link in a normal browser over HTTPS.');
    if (password.length < 8) return setError('The new password must be at least 8 characters.');
    if (password !== again) return setError('The two passwords do not match.');
    if (!ack) return setError('Tick the box to confirm you understand your older messages will become unreadable.');
    setBusy(true);
    try {
      const ident = await createIdentity(password); // a NEW encryption key: an email cannot bring the old one back
      const out = await api('/recover/email/finish', { method: 'POST', body: {
        token, newPassword: password, newKey: true, publicKey: ident.publicKey, encPrivKey: ident.encPrivKey,
        recovery: { blob: ident.recovery.blob, auth: ident.recovery.auth }, ...(who.twoFactor ? { twoFactorCode: code.trim() } : {}),
      } });
      markSignedIn(true);
      await saveKey(out.user.id, ident.privateKey);
      setFresh({ key: ident.recovery.key, username: out.user.username });
      setPhase('done');
    } catch (err) {
      if (err.code === 'reset_link_invalid') { setPhase('bad'); return; } // used or replaced while this page was open
      if (err.code === '2fa_required' || err.code === '2fa_invalid') setWho((w) => ({ ...w, twoFactor: true }));
      setError(err.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const frame = (children) => (
    <div className="auth-bg">
      <div className="auth-card">
        <img className="wordmark" src="/aduna-wordmark.png" alt="Aduna" width="190" />
        {children}
      </div>
    </div>
  );

  if (phase === 'checking') return frame(<p className="muted center" role="status">Checking your link…</p>);

  if (phase === 'bad') return frame(
    <>
      <h1>{offline ? 'Could not check your link' : 'This link no longer works'}</h1>
      <p className="muted center">
        {offline
          ? 'We could not reach the server just now. Wait a moment and reload this page; the link may still be good.'
          : 'A reset link works once, and only for 30 minutes. It may have been used already, replaced by a newer one, or expired.'}
      </p>
      {offline
        ? <button type="button" className="btn primary full" onClick={() => location.reload()}>Try again</button>
        : <button type="button" className="btn primary full" onClick={goToApp}>Back to log in to ask for a new link</button>}
      {!offline && <p className="hint center">On the log-in page choose “Forgot your password?”, then “Email me a link”.</p>}
    </>,
  );

  if (phase === 'done') return frame(
    <RecoveryKeyCard recoveryKey={fresh.key} username={fresh.username} title="Save your new recovery key" onDone={goToApp} doneLabel="Open Aduna" />,
  );

  return (
    <div className="auth-bg">
      <form className="auth-card" onSubmit={submit}>
        <img className="wordmark" src="/aduna-wordmark.png" alt="Aduna" width="190" />
        <h1>Choose a new password</h1>
        <p className="muted center">For <strong>{who.username}</strong>. You will be signed in on this device, and signed out everywhere else.</p>

        {/* lets a password manager attach the new password to the right account */}
        <input type="text" name="username" value={who.username} autoComplete="username" readOnly hidden />

        <label>NEW PASSWORD</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required minLength={8} maxLength={200} autoComplete="new-password" />
        <label>NEW PASSWORD AGAIN</label>
        <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} required maxLength={200} autoComplete="new-password" />

        {who.twoFactor && (
          <>
            <label>AUTHENTICATOR CODE</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="one-time-code" inputMode="text" maxLength={20} placeholder="123456" />
            <p className="hint">This account has two-factor on, so the link alone is not enough. Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
          </>
        )}

        <label className="check-row">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          I understand this creates a new encryption key, so my older direct messages become unreadable
        </label>
        <p className="hint">If you still have your recovery key, use it on the log-in page instead: it keeps your messages.</p>

        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn primary full" disabled={busy}>{busy ? 'Working…' : 'Reset password'}</button>
      </form>
    </div>
  );
}
