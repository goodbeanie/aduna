import React, { useState } from 'react';
import { api } from './api.js';

// Shown instead of the app while the account has not agreed to the current Terms of Service (server/terms.js). That covers accounts that
// were made before the terms existed and every account after the terms change. The terms open in a new tab so this screen stays put.
export default function TermsGate({ me, onUpdate, onLogout }) {
  const version = me.terms && me.terms.version;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const when = version ? new Date(version + 'T12:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';

  async function agree() {
    setError(''); setBusy(true);
    try {
      const r = await api('/me/terms/accept', { method: 'POST', body: { version } });
      onUpdate(r.user); // terms.needed is false now, so the app opens
    } catch (err) {
      if (err.code === 'terms_changed' && err.data && err.data.user) onUpdate(err.data.user); // newer terms came out meanwhile: show them again
      setError(err.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="auth-bg">
      <div className="auth-card">
        <span className="wordmark" role="img" aria-label="Aduna" />
        <h1>Our Terms of Service</h1>
        <p className="muted center">
          {when ? `The Terms of Service were last updated on ${when}. ` : ''}Please read them and agree to keep using Aduna.
        </p>
        <p className="center"><a href="/terms" target="_blank" rel="noopener noreferrer">Read the Terms of Service</a></p>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn primary full" type="button" disabled={busy} onClick={agree}>{busy ? 'Saving' : 'I agree'}</button>
        <p className="muted small">If you don’t agree, you can’t keep using Aduna. <a href="#" onClick={(e) => { e.preventDefault(); onLogout(); }}>Log out</a></p>
      </div>
    </div>
  );
}
