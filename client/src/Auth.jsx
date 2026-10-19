import React, { useState, useEffect } from 'react';
import { api, markSignedIn, endSession } from './api.js';
import { createIdentity, unlockIdentity, saveKey, hasCrypto, recoverIdentity, isRecoveryKey } from './crypto.js';
import { RecoveryKeyCard } from './Recovery.jsx';

export default function Auth({ onAuthed }) {
  const [mode, setMode] = useState(typeof location !== 'undefined' && location.hash === '#signup' ? 'register' : 'login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [needCode, setNeedCode] = useState(false); // the account has two-factor on: ask for the code
  const [code, setCode] = useState('');
  const [rkey, setRkey] = useState('');       // forgot-password mode: the recovery key
  const [again, setAgain] = useState('');
  const [method, setMethod] = useState('key'); // forgot-password: 'key' (recovery key, keeps messages) or 'email' (emailed code, new encryption key)
  const [mailed, setMailed] = useState(false); // email method: the code was requested
  const [ecode, setEcode] = useState('');       // email method: the emailed code
  const [ack, setAck] = useState(false);         // email method: understands older messages become unreadable
  const [info, setInfo] = useState('');
  const [useKey, setUseKey] = useState(true);        // sign-up: protect the account with a recovery key (keeps messages)
  const [useMail, setUseMail] = useState(false);      // sign-up: also/instead allow email recovery (new encryption key)
  const [mailOk, setMailOk] = useState(false);        // the server can send email, so email recovery can be offered
  useEffect(() => { api('/auth-options').then((o) => setMailOk(!!o.emailRecovery)).catch(() => {}); }, []);
  const [fresh, setFresh] = useState(null);     // just registered: { user, privateKey, key } until the recovery key is saved

  async function submit(e) {
    e.preventDefault();
    setError(''); setInfo('');
    if (!hasCrypto()) {
      setError('Encryption needs a secure context. Open the app via http://localhost or HTTPS.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'register') {
        if (!useKey && !(useMail && mailOk)) throw new Error('Pick at least one way to get back into your account.');
        const ident = await createIdentity(password);
        const { user } = await api('/register', {
          method: 'POST',
          body: { username, email: email.trim(), password, publicKey: ident.publicKey, encPrivKey: ident.encPrivKey, ...(useKey ? { recovery: { blob: ident.recovery.blob, auth: ident.recovery.auth } } : {}), ...(useMail && mailOk ? { emailRecovery: true } : {}) },
        });
        markSignedIn(true);
        await saveKey(user.id, ident.privateKey);
        if (!useKey) { onAuthed(user, ident.privateKey); return; } // email recovery only: no key to show
        setFresh({ user, privateKey: ident.privateKey, key: ident.recovery.key }); // the recovery key is shown once before the app opens
      } else if (mode === 'recover' && method === 'email') {
        if (!mailed) { // step 1: ask for the code. The answer is the same whether or not the account has email recovery on.
          await api('/recover/email/start', { method: 'POST', body: { username } });
          setMailed(true);
          setInfo('If that account has email recovery turned on, a code is on its way to its address. It expires in 15 minutes.');
          return;
        }
        if (password.length < 8) throw new Error('The new password must be at least 8 characters.');
        if (password !== again) throw new Error('The two passwords do not match.');
        if (!ack) throw new Error('Tick the box to confirm you understand your older messages will become unreadable.');
        const ident = await createIdentity(password); // a NEW encryption key: an email cannot bring the old one back
        const out = await api('/recover/email/finish', { method: 'POST', body: {
          username, code: ecode.trim(), newPassword: password, newKey: true, publicKey: ident.publicKey, encPrivKey: ident.encPrivKey,
          recovery: { blob: ident.recovery.blob, auth: ident.recovery.auth }, ...(needCode ? { twoFactorCode: code.trim() } : {}),
        } });
        markSignedIn(true);
        await saveKey(out.user.id, ident.privateKey);
        setFresh({ user: out.user, privateKey: ident.privateKey, key: ident.recovery.key, reset: true });
      } else if (mode === 'recover') {
        if (!isRecoveryKey(rkey)) throw new Error('A recovery key has 32 letters and numbers, like ABCD-EFGH-….');
        if (password.length < 8) throw new Error('The new password must be at least 8 characters.');
        if (password !== again) throw new Error('The two passwords do not match.');
        const { blob } = await api('/recover/start', { method: 'POST', body: { username } });
        const r = await recoverIdentity(blob, rkey, password); // fails here, on this device, if the key is wrong
        const out = await api('/recover/finish', { method: 'POST', body: { username, auth: r.auth, newPassword: password, encPrivKey: r.encPrivKey, ...(needCode ? { code: code.trim() } : {}) } });
        markSignedIn(true);
        await saveKey(out.user.id, r.privateKey);
        onAuthed(out.user, r.privateKey);
      } else {
        const { user: u0, encPrivKey } = await api('/login', { method: 'POST', body: { username, password, ...(needCode ? { code: code.trim() } : {}) } });
        markSignedIn(true);
        let user = u0, privateKey;
        if (encPrivKey) privateKey = await unlockIdentity(encPrivKey, password);
        else { // account without encryption keys: create them now
          const ident = await createIdentity(password);
          user = (await api('/me/keys', { method: 'PUT', body: { publicKey: ident.publicKey, encPrivKey: ident.encPrivKey } })).user;
          privateKey = ident.privateKey;
        }
        await saveKey(user.id, privateKey);
        onAuthed(user, privateKey);
      }
    } catch (err) {
      endSession(); // a login that did not finish must not leave a session behind
      if (err.code === '2fa_required') { setNeedCode(true); setError(''); return; } // password (or recovery key) was right: now the code
      setError(err.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (fresh) return (
    <div className="auth-bg">
      <div className="auth-card">
        <RecoveryKeyCard recoveryKey={fresh.key} username={fresh.user.username} title={fresh.reset ? 'Save your new recovery key' : undefined} onDone={() => onAuthed(fresh.user, fresh.privateKey)} doneLabel="Open Aduna" />
      </div>
    </div>
  );

  const switchMode = (m) => { setError(''); setNeedCode(false); setCode(''); setRkey(''); setAgain(''); setMethod('key'); setMailed(false); setEcode(''); setAck(false); setInfo(''); setMode(m); };

  return (
    <div className="auth-bg">
      <form className="auth-card" onSubmit={submit}>
        <img className="wordmark" src="/aduna-wordmark.png" alt="Aduna" width="190" />
        <h1>{mode === 'login' ? 'Welcome back!' : mode === 'recover' ? 'Reset your password' : 'Create an account'}</h1>
        <p className="muted center">{mode === 'login' ? "We're so excited to see you again!" : mode === 'recover' ? (method === 'key' ? 'Use the recovery key you saved. Your messages stay readable.' : 'We can email a code to the address on the account, if you turned email recovery on.') : 'Join the conversation. DMs are end-to-end encrypted.'}</p>

        <label>USERNAME</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required autoComplete="username" maxLength={20} />

        {mode === 'register' && (
          <>
            <label>EMAIL</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" maxLength={254} placeholder="you@example.com" />
            <p className="hint">Never shown to other people. We'll email you a code to verify it, and use it for payment receipts and important account notices.</p>
          </>
        )}

        {mode === 'recover' && (
          <div className="seg">
            <button type="button" className={'btn' + (method === 'key' ? ' primary' : '')} onClick={() => { setMethod('key'); setError(''); setInfo(''); }}>Recovery key</button>
            <button type="button" className={'btn' + (method === 'email' ? ' primary' : '')} onClick={() => { setMethod('email'); setError(''); setInfo(''); }}>Email me a code</button>
          </div>
        )}

        {mode === 'recover' && method === 'key' && (
          <>
            <label>RECOVERY KEY</label>
            <input value={rkey} onChange={(e) => setRkey(e.target.value)} required autoComplete="off" spellCheck={false} maxLength={60} placeholder="ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789" />
            <p className="hint">Your password also locks your encryption key, so the recovery key is what keeps your messages readable. No key? Try “Email me a code” if you turned it on in Settings.</p>
          </>
        )}

        {mode === 'recover' && method === 'email' && mailed && (
          <>
            <label>EMAILED CODE</label>
            <input value={ecode} onChange={(e) => setEcode(e.target.value)} required autoFocus autoComplete="one-time-code" inputMode="numeric" maxLength={12} placeholder="12345678" />
            <p className="hint">8 digits. Didn't get it? Check spam, or <a href="#" onClick={(e) => { e.preventDefault(); api('/recover/email/start', { method: 'POST', body: { username } }).then(() => setInfo('Asked again. You can request a new code once a minute.')).catch((er) => setError(er.message)); }}>send it again</a>.</p>
          </>
        )}

        {!(mode === 'recover' && method === 'email' && !mailed) && <>
        <label>{mode === 'recover' ? 'NEW PASSWORD' : 'PASSWORD'}</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'login' ? 1 : 8}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </>}
        {mode === 'register' && <p className="hint">At least 8 characters. Your password also protects your encryption key. You can change the password in Settings &gt; Security.</p>}
        {mode === 'register' && (
          <>
            <label>IF YOU FORGET YOUR PASSWORD</label>
            <p className="hint">Choose how you want to get back in. Pick one or both.</p>
            <label className="check-row">
              <input type="checkbox" checked={useKey} onChange={(e) => { if (!e.target.checked && !(useMail && mailOk)) return; setUseKey(e.target.checked); }} />
              <span><strong>Recovery key</strong>: a key you save yourself. Your messages stay readable.</span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={useMail && mailOk} disabled={!mailOk} onChange={(e) => { if (!e.target.checked && !useKey) return; setUseMail(e.target.checked); }} />
              <span><strong>Email recovery</strong>: we email you a code. This makes a new encryption key, so older direct messages become unreadable.{!mailOk && ' (Not available on this server yet.)'}</span>
            </label>
          </>
        )}
        {mode === 'recover' && !(method === 'email' && !mailed) && (
          <>
            <label>NEW PASSWORD AGAIN</label>
            <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} required autoComplete="new-password" />
          </>
        )}
        {mode === 'recover' && method === 'email' && mailed && (
          <label className="check-row">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            I understand this creates a new encryption key, so my older direct messages become unreadable
          </label>
        )}

        {mode === 'login' && <p className="muted small"><a href="#" onClick={(e) => { e.preventDefault(); switchMode('recover'); }}>Forgot your password?</a></p>}

        {(mode === 'login' || mode === 'recover') && needCode && (
          <>
            <label>AUTHENTICATOR CODE</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus required autoComplete="one-time-code" inputMode="text" maxLength={20} placeholder="123456" />
            <p className="hint">Open your authenticator app and enter the 6-digit code. Lost your phone? Enter one of your recovery codes instead (each works once).</p>
          </>
        )}

        {info && <p className="muted small">{info}</p>}
        {error && <div className="error">{error}</div>}

        <button className="btn primary full" disabled={busy}>{busy ? 'Working…' : mode === 'login' ? 'Log In' : mode === 'recover' ? (method === 'email' && !mailed ? 'Send me a code' : 'Reset password') : 'Continue'}</button>
        <p className="muted small">
          {mode === 'login' ? 'Need an account? ' : mode === 'recover' ? 'Remembered it? ' : 'Already have an account? '}
          <a href="#" onClick={(e) => { e.preventDefault(); switchMode(mode === 'login' ? 'register' : 'login'); }}>
            {mode === 'login' ? 'Register' : 'Log in'}
          </a>
        </p>
      </form>
    </div>
  );
}
