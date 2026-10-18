import React, { useEffect, useState } from 'react';
import { api } from './api.js';

// Shown instead of the app until the person enters the 6-digit code we emailed them.
export default function VerifyEmail({ me, onUpdate, onLogout }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0); // seconds until "resend" works again
  const [editing, setEditing] = useState(!me.email); // older accounts may have no email yet
  const [email, setEmail] = useState(me.email || '');

  useEffect(() => { // an older account that has an email but was never sent a code: send one now
    if (me.email && !me.codeSent) api('/me/resend-verification', { method: 'POST' }).then(() => setWait(60)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function verify(e) {
    e.preventDefault();
    setError(''); setInfo(''); setBusy(true);
    try { onUpdate((await api('/me/verify-email', { method: 'POST', body: { code } })).user); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function resend() {
    setError(''); setInfo('');
    try { const r = await api('/me/resend-verification', { method: 'POST' }); setInfo('A new code is on its way.'); setWait(r.retryAfter || 60); }
    catch (err) { setError(err.message); if (err.status === 429) setWait(60); }
  }

  async function changeEmail(e) {
    e.preventDefault();
    setError(''); setInfo(''); setBusy(true);
    try {
      const { user } = await api('/me', { method: 'PATCH', body: { email: email.trim() } });
      onUpdate(user); setEditing(false); setCode(''); setInfo('We sent a code to ' + user.email + '.'); setWait(60);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="auth-bg">
      <form className="auth-card" onSubmit={editing ? changeEmail : verify}>
        <img className="wordmark" src="/aduna-wordmark.png" alt="Aduna" width="190" />
        <h1>{me.email ? 'Check your email' : 'Add your email'}</h1>
        {!me.email && <p className="muted center">Please add an email address so we can verify your account.</p>}
        {editing ? (
          <>
            <label>EMAIL</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="email" maxLength={254} />
          </>
        ) : (
          <>
            <p className="muted center">We sent a 6-digit code to <b>{me.email}</b>. It expires in 15 minutes.</p>
            <label>VERIFICATION CODE</label>
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code"
              placeholder="123456" autoFocus required pattern="\d{6}" style={{ letterSpacing: 6, fontSize: 20, textAlign: 'center' }} />
          </>
        )}
        {error && <div className="error">{error}</div>}
        {info && <p className="hint">{info}</p>}
        <button className="btn primary full" disabled={busy || (!editing && code.length !== 6)}>{busy ? 'Working…' : editing ? 'Send code to this address' : 'Verify'}</button>
        <p className="muted small">
          {editing
            ? <a href="#" onClick={(e) => { e.preventDefault(); setEditing(false); setError(''); }}>Cancel</a>
            : <>
                {wait > 0 ? `Resend code in ${wait}s` : <a href="#" onClick={(e) => { e.preventDefault(); resend(); }}>Resend code</a>}
                {' · '}<a href="#" onClick={(e) => { e.preventDefault(); setEditing(true); setError(''); setInfo(''); }}>Wrong email?</a>
              </>}
          {' · '}<a href="#" onClick={(e) => { e.preventDefault(); onLogout(); }}>Log out</a>
        </p>
      </form>
    </div>
  );
}
