import React, { useState, useEffect } from 'react';
import { api, markSignedIn, endSession } from './api.js';
import { createIdentity, unlockIdentity, saveKey, hasCrypto, recoverIdentity, isRecoveryKey } from './crypto.js';
import { RecoveryKeyCard } from './Recovery.jsx';
import { LANGS, getLang, setLang, useLang } from './i18n.js';

export default function Auth({ onAuthed }) {
  const { lang, t } = useLang();
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
  const [method, setMethod] = useState('key'); // forgot-password: 'key' (recovery key, keeps messages) or 'email' (emailed link, new encryption key)
  const [mailed, setMailed] = useState(false); // email method: a link was requested (the new password is chosen on the page the link opens: ResetPassword.jsx)
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
          body: { username, email: email.trim(), password, lang: getLang(), setup: true, publicKey: ident.publicKey, encPrivKey: ident.encPrivKey, ...(useKey ? { recovery: { blob: ident.recovery.blob, auth: ident.recovery.auth } } : {}), ...(useMail && mailOk ? { emailRecovery: true } : {}) },
        });
        markSignedIn(true);
        await saveKey(user.id, ident.privateKey);
        if (!useKey) { onAuthed(user, ident.privateKey); return; } // email recovery only: no key to show
        setFresh({ user, privateKey: ident.privateKey, key: ident.recovery.key }); // the recovery key is shown once before the app opens
      } else if (mode === 'recover' && method === 'email') {
        // The answer is the same whether or not the account has email recovery on. The email holds a link to /reset: the new password,
        // the two-factor code (if any) and the new encryption key are all handled on that page.
        await api('/recover/email/start', { method: 'POST', body: { username } });
        setMailed(true);
        setInfo('If that account has email recovery turned on, a reset link is on its way to its address. It works once and expires in 30 minutes. You can ask for another once a minute.');
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
        <RecoveryKeyCard recoveryKey={fresh.key} username={fresh.user.username} onDone={() => onAuthed(fresh.user, fresh.privateKey)} doneLabel="Open Aduna" />
      </div>
    </div>
  );

  const switchMode = (m) => { setError(''); setNeedCode(false); setCode(''); setRkey(''); setAgain(''); setMethod('key'); setMailed(false); setInfo(''); setMode(m); };

  return (
    <div className="auth-bg">
      <form className="auth-card" onSubmit={submit}>
        <img className="wordmark" src="/aduna-wordmark.png" alt="Aduna" width="190" />
        <h1>{mode === 'login' ? t('welcomeBack') : mode === 'recover' ? t('resetTitle') : t('createTitle')}</h1>
        <p className="muted center">{mode === 'login' ? t('excited') : mode === 'recover' ? (method === 'key' ? t('resetKeyHelp') : t('resetMailHelp')) : t('joinConv')}</p>

        <label>{t('username')}</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required autoComplete="username" maxLength={20} />

        {mode === 'register' && (
          <>
            <label>{t('email')}</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" maxLength={254} placeholder="you@example.com" />
            <p className="hint">{t('emailHint')}</p>
          </>
        )}

        {mode === 'recover' && (
          <div className="seg">
            <button type="button" className={'btn' + (method === 'key' ? ' primary' : '')} onClick={() => { setMethod('key'); setError(''); setInfo(''); }}>{t('recoveryKeyBtn')}</button>
            <button type="button" className={'btn' + (method === 'email' ? ' primary' : '')} onClick={() => { setMethod('email'); setError(''); setInfo(''); }}>{t('emailLinkBtn')}</button>
          </div>
        )}

        {mode === 'recover' && method === 'key' && (
          <>
            <label>{t('recoveryKeyLabel')}</label>
            <input value={rkey} onChange={(e) => setRkey(e.target.value)} required autoComplete="off" spellCheck={false} maxLength={60} placeholder="ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789" />
            <p className="hint">{t('recoveryHelp')}</p>
          </>
        )}

        {!(mode === 'recover' && method === 'email') && <>
        <label>{mode === 'recover' ? t('newPassword') : t('password')}</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'login' ? 1 : 8}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </>}
        {mode === 'register' && <p className="hint">{t('passwordHint')}</p>}
        {mode === 'register' && (
          <>
            <label>{t('ifForget')}</label>
            <p className="hint">{t('chooseBack')}</p>
            <label className="check-row">
              <input type="checkbox" checked={useKey} onChange={(e) => { if (!e.target.checked && !(useMail && mailOk)) return; setUseKey(e.target.checked); }} />
              <span><strong>{t('keyOptionB')}</strong>{t('keyOptionT')}</span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={useMail && mailOk} disabled={!mailOk} onChange={(e) => { if (!e.target.checked && !useKey) return; setUseMail(e.target.checked); }} />
              <span><strong>{t('mailOptionB')}</strong>{t('mailOptionT')}{!mailOk && t('mailUnavailable')}</span>
            </label>
          </>
        )}
        {mode === 'recover' && method === 'key' && (
          <>
            <label>{t('newPasswordAgain')}</label>
            <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} required autoComplete="new-password" />
          </>
        )}
        {mode === 'login' && <p className="muted small"><a href="#" onClick={(e) => { e.preventDefault(); switchMode('recover'); }}>{t('forgot')}</a></p>}

        {(mode === 'login' || (mode === 'recover' && method === 'key')) && needCode && (
          <>
            <label>{t('authCode')}</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus required autoComplete="one-time-code" inputMode="text" maxLength={20} placeholder="123456" />
            <p className="hint">{t('authCodeHint')}</p>
          </>
        )}

        {info && <p className="muted small">{info}</p>}
        {error && <div className="error">{error}</div>}

        <button className="btn primary full" disabled={busy}>{busy ? t('working') : mode === 'login' ? t('logIn') : mode === 'recover' ? (method === 'email' ? (mailed ? t('sendAgain') : t('sendLink')) : t('resetBtn')) : t('continue')}</button>
        <p className="muted small">
          {mode === 'login' ? t('needAccount') : mode === 'recover' ? t('remembered') : t('haveAccount')}
          <a href="#" onClick={(e) => { e.preventDefault(); switchMode(mode === 'login' ? 'register' : 'login'); }}>
            {mode === 'login' ? t('register') : t('logInLink')}
          </a>
        </p>
        <select className="auth-lang" aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)}>
          {LANGS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
      </form>
    </div>
  );
}
