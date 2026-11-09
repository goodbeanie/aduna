import React, { useEffect, useState } from 'react';
import { api } from './api.js';

// Shown instead of the app while the account has a name warning (server/appropriate.js). The 3 days start when this screen first appears.
// Fixing every flagged name ends the warning. "Continue" lets people use Aduna meanwhile; the screen comes back each time the app opens.
export default function NameWarning({ me, onUpdate, onLogout, onContinue }) {
  const w = me.nameWarning;
  const [vals, setVals] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { // starts the 3 days (does nothing when they already started)
    if (!w.seenAt) api('/me/name-warning/seen', { method: 'POST' }).then((r) => onUpdate(r.user)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(item) {
    const key = item.serverId || item.field;
    const value = (vals[key] || '').trim();
    if (!value && item.field !== 'bio') { setError('Type a new ' + item.label); return; }
    setError(''); setBusy(key);
    try {
      if (item.serverId) await api('/servers/' + item.serverId, { method: 'PATCH', body: { name: value } });
      else await api('/me', { method: 'PATCH', body: { [item.field]: value } });
      onUpdate((await api('/me')).user); // the warning is gone when nothing is flagged any more
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  }

  const left = w.seenAt ? w.daysLeft : w.days;
  return (
    <div className="auth-bg">
      <div className="auth-card">
        <span className="wordmark" role="img" aria-label="Aduna" />
        <h1>Please change a name</h1>
        <p className="muted center">
          Something on your account is not allowed on Aduna. Change it within {left} {left === 1 ? 'day' : 'days'} or the account will be deleted.
        </p>
        {w.items.map((item) => {
          const key = item.serverId || item.field;
          return (
            <div key={key} className="namewarn-item" style={{ display: 'grid', gap: 8, margin: '12px 0' }}>
              <label htmlFor={'nw-' + key}>Your {item.label}{item.value ? <> (<strong>{item.value}</strong>)</> : null}</label>
              <input id={'nw-' + key} value={vals[key] || ''} maxLength={item.field === 'username' ? 20 : item.field === 'bio' ? 190 : 40} placeholder={'New ' + item.label}
                onChange={(e) => setVals((v) => ({ ...v, [key]: e.target.value }))} disabled={!!busy} />
              <button className="btn primary full" type="button" disabled={!!busy} onClick={() => save(item)}>{busy === key ? 'Saving' : 'Save new ' + item.label}</button>
            </div>
          );
        })}
        {error && <div className="error">{error}</div>}
        <button className="btn full" type="button" onClick={onContinue}>Continue to Aduna</button>
        <p className="muted small"><a href="#" onClick={(e) => { e.preventDefault(); onLogout(); }}>Log out</a></p>
      </div>
    </div>
  );
}
