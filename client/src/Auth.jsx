import React, { useState, useEffect } from 'react';
import { Select } from './Controls.jsx';
import { api, markSignedIn, endSession } from './api.js';
import { createIdentity, unlockIdentity, saveKey, hasCrypto, recoverIdentity, isRecoveryKey } from './crypto.js';
import { RecoveryKeyCard } from './Recovery.jsx';
import { DeviceSignIn } from './DeviceLogin.jsx';
import SignupFlow from './SignupFlow.jsx';
import { passkeysSupported, signInWithPasskey } from './passkeys.js';
import { GoogleButton, GoogleFlow, startGoogle, pendingGoogle, clearGoogle } from './GoogleLogin.jsx';
import { LANGS, getLang, setLang, useLang } from './i18n.js';

// A problem with one field: submit() shows it under that field and moves focus there, instead of in the general box above the button.
const fieldError = (field, msg) => Object.assign(new Error(msg), { field });

export default function Auth({ onAuthed }) {
  const { lang, t } = useLang();
  // Back from Google (the server sends the web app to /app?google=1): pick the sign-in up where it left off. Otherwise a stale request id is ignored.
  const [gid, setGid] = useState(() => (typeof location !== 'undefined' && /[?&]google=1(&|$)/.test(location.search) ? pendingGoogle() : ''));
  const [gprofile, setGprofile] = useState(null); // Google's answer for a NEW account: { id, email, name }; the sign-up then skips the email box and the emailed code
  const [googleOn, setGoogleOn] = useState(false); // the server has Google sign-in set up
  const [mode, setMode] = useState(gid ? 'google' : typeof location !== 'undefined' && location.hash === '#signup' ? 'register' : 'login');
  useEffect(() => { if (gid && typeof history !== 'undefined') { try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* ignore */ } } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [fe, setFe] = useState(null); // an error that belongs to one field: { field, msg }, shown under that field
  const [busy, setBusy] = useState(false);
  const [needCode, setNeedCode] = useState(false); // the account has two-factor on: ask for the code
  const [code, setCode] = useState('');
  const [rkey, setRkey] = useState('');       // forgot-password mode: the recovery key
  const [again, setAgain] = useState('');
  const [method, setMethod] = useState('key'); // forgot-password: 'key' (recovery key, keeps messages) or 'email' (emailed link, new encryption key)
  const [mailed, setMailed] = useState(false); // email method: a link was requested (the new password is chosen on the page the link opens: ResetPassword.jsx)
  const [info, setInfo] = useState('');
  const [mailOk, setMailOk] = useState(false);        // the server can send email, so email recovery can be offered at sign-up
  const [apply, setApply] = useState(false);          // joining needs an application (an admin approves it) instead of making an account at once
  useEffect(() => { api('/auth-options').then((o) => { setMailOk(!!o.emailRecovery); setApply(!!o.applyToJoin); setGoogleOn(!!o.google); }).catch(() => {}); }, []);
  const [fresh, setFresh] = useState(null);     // just registered: { user, privateKey, key } until the recovery key is saved
  const [sent, setSent] = useState(null);       // just applied: { username, key } (key = the recovery key, shown once, or null) until they go back to log in

  // Sign-up (the three steps live in SignupFlow.jsx; it calls this at the end). Throws on a problem so the flow can show it on the right step.
  // `form`: { username, email, password, useKey, useMail, design: { displayName, avatarLogo, avatarColor, profileTheme } }
  async function register(form) {
    if (!hasCrypto()) throw new Error('Encryption needs a secure context. Open the app via http://localhost or HTTPS.');
    try {
      const { useKey, useMail } = form;
      if (!useKey && !useMail) throw fieldError('method', 'Pick at least one way to get back into your account.');
      const ident = await createIdentity(form.password);
      const { user: made, applied } = await api('/register', {
        method: 'POST',
        body: { username: form.username, email: form.email, password: form.password, lang: getLang(), setup: true, publicKey: ident.publicKey, encPrivKey: ident.encPrivKey, design: form.design, ...(form.google ? { google: form.google } : {}), ...(form.reason ? { reason: form.reason, source: form.source } : {}), ...(useKey ? { recovery: { blob: ident.recovery.blob, auth: ident.recovery.auth } } : {}), ...(useMail ? { emailRecovery: true } : {}) },
      });
      if (form.google) { clearGoogle(); setGprofile(null); setGid(''); } // used up: the account (or application) exists now
      if (applied) { // no account yet: an admin decides. The recovery key is shown now because it cannot be shown later.
        endSession();
        setSent({ username: form.username, key: useKey ? ident.recovery.key : null });
        return;
      }
      markSignedIn(true);
      await saveKey(made.id, ident.privateKey);
      // The profile they designed. The account already exists, so if this fails they just restyle it in Settings: it must not undo the sign-up.
      let user = made;
      try {
        const d = form.design || {};
        const body = { avatarColor: d.avatarColor, avatarLogo: !!d.avatarLogo };
        if (d.displayName && d.displayName !== form.username) body.displayName = d.displayName;
        if (d.profileTheme) body.profileTheme = d.profileTheme;
        user = (await api('/me', { method: 'PATCH', body })).user || made;
      } catch { /* keep the account as registered */ }
      if (!useKey) { onAuthed(user, ident.privateKey); return; } // email recovery only: no key to show
      setFresh({ user, privateKey: ident.privateKey, key: ident.recovery.key }); // the recovery key is shown once before the app opens
    } catch (err) {
      endSession(); // a sign-up that did not finish must not leave a session behind
      if (err.code === 'google_expired' || err.code === 'google_has_account') { clearGoogle(); setGprofile(null); setGid(''); } // fall back to the normal sign-up; the message says what to do
      throw err;
    }
  }

  // "Continue with Google": goes to Google (web) or opens the browser (apps), then GoogleFlow takes over. Returns a message when it could not start ('' otherwise).
  async function googleStart() {
    setError(''); setBusy(true);
    try { setGid(await startGoogle()); setMode('google'); return ''; }
    catch (err) { const m = err.message || 'Could not start Google sign-in.'; setError(m); return m; }
    finally { setBusy(false); }
  }

  async function submit(e) {
    e.preventDefault();
    setError(''); setInfo(''); setFe(null);
    if (!hasCrypto()) {
      setError('Encryption needs a secure context. Open the app via http://localhost or HTTPS.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'recover' && method === 'email') {
        // The answer is the same whether or not the account has email recovery on. The email holds a link to /reset: the new password,
        // the two-factor code (if any) and the new encryption key are all handled on that page.
        await api('/recover/email/start', { method: 'POST', body: { username } });
        setMailed(true);
        setInfo('If that account has email recovery turned on, a reset link is on its way to its address. It works once and expires in 30 minutes. You can ask for another once a minute.');
      } else if (mode === 'recover') {
        if (!isRecoveryKey(rkey)) throw fieldError('rkey', 'A recovery key has 32 letters and numbers, like ABCD-EFGH-….');
        if (password.length < 8) throw fieldError('password', 'The new password must be at least 8 characters.');
        if (password !== again) throw fieldError('again', 'The two passwords do not match.');
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
      if (err.field) { setFe({ field: err.field, msg: err.message }); setTimeout(() => document.getElementById('f-' + err.field)?.focus(), 0); return; }
      setError(err.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  // Log in with a passkey: no username, no password. The passkey also unlocks the encryption key (see passkeys.js).
  async function passkeyLogin() {
    setError(''); setInfo(''); setFe(null);
    if (!hasCrypto()) { setError('Encryption needs a secure context. Open the app via http://localhost or HTTPS.'); return; }
    setBusy(true);
    try {
      const { user, privateKey } = await signInWithPasskey();
      markSignedIn(true);
      await saveKey(user.id, privateKey);
      onAuthed(user, privateKey);
    } catch (err) {
      endSession(); // a login that did not finish must not leave a session behind
      setError(err.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (sent) return (
    <div className="auth-bg">
      <div className="auth-card">
        {sent.key ? (
          <RecoveryKeyCard recoveryKey={sent.key} username={sent.username} onDone={() => setSent({ ...sent, key: null })} doneLabel="Continue" />
        ) : (
          <>
            <span className="wordmark" role="img" aria-label="Aduna" />
            <h1>Application sent</h1>
            <p className="muted center">Thanks, {sent.username}. A person will review your application. Once it is approved you can log in with the username and password you just chose{mailOk ? ', and we will email you about the decision' : ''}.</p>
            <button type="button" className="btn primary full" onClick={() => { setSent(null); setMode('login'); setUsername(sent.username); }}>Back to log in</button>
          </>
        )}
      </div>
    </div>
  );
  if (fresh) return (
    <div className="auth-bg">
      <div className="auth-card">
        <RecoveryKeyCard recoveryKey={fresh.key} username={fresh.user.username} onDone={() => onAuthed(fresh.user, fresh.privateKey)} doneLabel="Open Aduna" />
      </div>
    </div>
  );

  const switchMode = (m) => { setError(''); setFe(null); setNeedCode(false); setCode(''); setRkey(''); setAgain(''); setMethod('key'); setMailed(false); setInfo(''); setMode(m); };
  if (mode === 'device') return (
    <div className="auth-bg">
      <div className="auth-card"><DeviceSignIn onAuthed={onAuthed} onBack={() => switchMode('login')} /></div>
    </div>
  );
  if (mode === 'google') return (
    <div className="auth-bg">
      <div className="auth-card">
        <GoogleFlow id={gid} onAuthed={onAuthed}
          onNew={(p) => { setGprofile(p); setMode('register'); }}
          onBack={() => { setGid(''); switchMode('login'); }}
          onForgot={() => { setGid(''); switchMode('recover'); }} />
      </div>
    </div>
  );
  if (mode === 'register') return (
    <div className="auth-bg su-bg">
      <SignupFlow mailOk={mailOk} apply={apply} onSubmit={register} onLogin={() => { setGprofile(null); switchMode('login'); }} google={gprofile} googleOn={googleOn} onGoogle={googleStart} />
    </div>
  );
  // props for a field that can carry its own error, and the message under it
  const fp = (f) => ({ id: 'f-' + f, 'aria-invalid': fe?.field === f ? true : undefined, 'aria-describedby': fe?.field === f ? 'e-' + f : undefined });
  const ferr = (f) => (fe?.field === f ? <p className="error-text field-error" id={'e-' + f} role="alert">{fe.msg}</p> : null);
  const clear = (f, set) => (e) => { set(e.target.value); if (fe?.field === f) setFe(null); };

  return (
    <div className="auth-bg">
      <form className="auth-card" onSubmit={submit}>
        <span className="wordmark" role="img" aria-label="Aduna" />
        <h1>{mode === 'login' ? t('welcomeBack') : t('resetTitle')}</h1>
        <p className="muted center">{mode === 'login' ? t('excited') : (method === 'key' ? t('resetKeyHelp') : t('resetMailHelp'))}</p>

        {/* Log in takes a username or an email address (an email is longer than a username, so no 20-character cap there); password recovery is still by username. */}
        <label>{mode === 'login' ? t('loginId') : t('username')}</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required autoComplete="username" maxLength={mode === 'login' ? 254 : 20} autoCapitalize="none" spellCheck={false} />

        {mode === 'recover' && (
          <div className="seg">
            <button type="button" className={'btn' + (method === 'key' ? ' primary' : '')} onClick={() => { setMethod('key'); setError(''); setInfo(''); }}>{t('recoveryKeyBtn')}</button>
            <button type="button" className={'btn' + (method === 'email' ? ' primary' : '')} onClick={() => { setMethod('email'); setError(''); setInfo(''); }}>{t('emailLinkBtn')}</button>
          </div>
        )}

        {mode === 'recover' && method === 'key' && (
          <>
            <label>{t('recoveryKeyLabel')}</label>
            <input {...fp('rkey')} value={rkey} onChange={clear('rkey', setRkey)} required autoComplete="off" spellCheck={false} maxLength={60} placeholder="ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789" />
            {ferr('rkey')}
            <p className="hint">{t('recoveryHelp')}</p>
          </>
        )}

        {!(mode === 'recover' && method === 'email') && <>
        <label>{mode === 'recover' ? t('newPassword') : t('password')}</label>
        <input {...fp('password')} type="password" value={password} onChange={clear('password', setPassword)} required minLength={mode === 'login' ? 1 : undefined}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        {ferr('password')}
        </>}
        {mode === 'recover' && method === 'key' && (
          <>
            <label>{t('newPasswordAgain')}</label>
            <input {...fp('again')} type="password" value={again} onChange={clear('again', setAgain)} required autoComplete="new-password" />
            {ferr('again')}
          </>
        )}
        {mode === 'login' && <p className="muted small auth-forgot"><a href="#" onClick={(e) => { e.preventDefault(); switchMode('recover'); }}>{t('forgot')}</a></p>}

        {(mode === 'login' || (mode === 'recover' && method === 'key')) && needCode && (
          <>
            <label>{t('authCode')}</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus required autoComplete="one-time-code" inputMode="text" maxLength={20} placeholder="123456" />
            <p className="hint">{t('authCodeHint')}</p>
          </>
        )}

        {info && <p className="muted small">{info}</p>}
        {error && <div className="error">{error}</div>}

        <button className="btn primary full" disabled={busy}>{busy ? t('working') : mode === 'login' ? t('logIn') : (method === 'email' ? (mailed ? t('sendAgain') : t('sendLink')) : t('resetBtn'))}</button>
        {mode === 'login' && (
          <div className="auth-alt">
            {googleOn && <GoogleButton label="Continue with Google" busy={busy} onClick={googleStart} />}
            {passkeysSupported() && <button type="button" className="btn full" disabled={busy} onClick={passkeyLogin}>{t('passkeyBtn')}</button>}
            <button type="button" className="btn full" disabled={busy} onClick={() => switchMode('device')}>{t('deviceBtn')}</button>
          </div>
        )}
        <p className="muted small auth-switch">
          {mode === 'login' ? t('needAccount') : t('remembered')}
          <a href="#" onClick={(e) => { e.preventDefault(); switchMode(mode === 'login' ? 'register' : 'login'); }}>
            {mode === 'login' ? t('register') : t('logInLink')}
          </a>
        </p>
        <Select className="auth-lang" aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)}>
          {LANGS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </Select>
      </form>
    </div>
  );
}
