import React, { useState } from 'react';
import { api, setToken } from './api.js';
import { createIdentity, unlockIdentity, saveKey, hasCrypto } from './crypto.js';

export default function Auth({ onAuthed }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!hasCrypto()) {
      setError('Encryption needs a secure context. Open the app via http://localhost or HTTPS.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'register') {
        const ident = await createIdentity(password);
        const { token, user } = await api('/register', {
          method: 'POST',
          body: { username, password, publicKey: ident.publicKey, encPrivKey: ident.encPrivKey },
        });
        setToken(token);
        await saveKey(user.id, ident.privateKey);
        onAuthed(user, ident.privateKey);
      } else {
        const { token, user: u0, encPrivKey } = await api('/login', { method: 'POST', body: { username, password } });
        setToken(token);
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
      setToken('');
      setError(err.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-bg">
      <form className="auth-card" onSubmit={submit}>
        <img className="wordmark" src="/aduna-wordmark.png" alt="Aduna" width="190" />
        <h1>{mode === 'login' ? 'Welcome back!' : 'Create an account'}</h1>
        <p className="muted center">{mode === 'login' ? "We're so excited to see you again!" : 'Join the conversation. DMs are end-to-end encrypted.'}</p>

        <label>USERNAME</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required autoComplete="username" maxLength={20} />

        <label>PASSWORD</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'register' ? 8 : 1}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        {mode === 'register' && <p className="hint">At least 8 characters. Your password also protects your encryption key, so it can't be reset.</p>}

        {error && <div className="error">{error}</div>}

        <button className="btn primary full" disabled={busy}>{busy ? 'Working…' : mode === 'login' ? 'Log In' : 'Continue'}</button>
        <p className="muted small">
          {mode === 'login' ? 'Need an account? ' : 'Already have an account? '}
          <a href="#" onClick={(e) => { e.preventDefault(); setError(''); setMode(mode === 'login' ? 'register' : 'login'); }}>
            {mode === 'login' ? 'Register' : 'Log in'}
          </a>
        </p>
      </form>
    </div>
  );
}
