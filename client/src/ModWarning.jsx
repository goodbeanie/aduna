import React, { useState } from 'react';
import { api } from './api.js';

// Shown instead of the app while the account has a warning from the moderators that has not been read (server/moderation.js). Nobody can send a message
// until they press "I understand", so there is no way to skip this screen. The server marks every warning shown here as read.
export default function ModWarning({ me, onUpdate, onLogout }) {
  const list = (me.modState && me.modState.pending) || [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function understood() {
    setError(''); setBusy(true);
    try {
      const r = await api('/me/warnings/ack', { method: 'POST' });
      onUpdate(r.user); // modState has no unread warnings now, so the app opens
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="auth-bg">
      <div className="auth-card">
        <span className="wordmark" role="img" aria-label="Aduna" />
        <h1>{list.length === 1 ? 'A warning from the moderators' : 'Warnings from the moderators'}</h1>
        <p className="muted center">
          Please read {list.length === 1 ? 'this' : 'these'} before you carry on. Repeated warnings lead to a mute or a suspension of your account.
        </p>
        {list.map((w) => (
          <div key={w.id} style={{ margin: '12px 0', padding: '12px 14px', borderRadius: 10, border: '1px solid var(--line, rgba(128,128,128,.35))', textAlign: 'left' }}>
            <div className="muted small">{new Date(w.at).toLocaleString()}</div>
            <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{w.reason}</p>
          </div>
        ))}
        {error && <div className="error">{error}</div>}
        <button className="btn primary full" type="button" disabled={busy} onClick={understood}>{busy ? 'Saving' : 'I understand'}</button>
        <p className="muted small"><a href="#" onClick={(e) => { e.preventDefault(); onLogout(); }}>Log out</a></p>
      </div>
    </div>
  );
}
