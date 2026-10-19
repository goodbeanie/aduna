import React, { useState } from 'react';
import { api } from './api.js';
import * as notify from './notify.js';

// Settings > Security: sign out of every device at once (lost or stolen phone, a shared computer you forgot to log out of).
// The server asks for the password again, closes every open connection and rejects every older login token.
// This device gets a fresh cookie and carries on.
export function SecuritySettings({ getSocketId }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const run = async () => {
    if (!password || busy) return;
    setBusy(true); setMsg('');
    try {
      await api('/me/logout-all', { method: 'POST', body: { password, socketId: getSocketId?.() || '' } }); // the answer carries this device's new cookie
      // the server dropped every push registration: put this device back (with the new cookie), but never wait long for it
      if (notify.permission() === 'granted') await Promise.race([notify.subscribe().catch(() => {}), new Promise((res) => setTimeout(res, 12000))]);
      location.reload();
    } catch (e) {
      setMsg(e.message || 'Could not do that. Try again.');
      setBusy(false);
    }
  };

  return (
    <div className="security-settings">
      <p className="muted">If you lost a phone, or logged in on a computer you do not trust, sign out everywhere. Every other device is logged out straight away and stops getting notifications. You stay logged in here.</p>
      <label>YOUR PASSWORD</label>
      <input type="password" value={password} autoComplete="current-password" disabled={busy}
        onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
      <p className="hint">Asked again so that nobody holding a stolen login can lock you out.</p>
      <div className="notify-actions">
        <button className="btn danger" disabled={busy || !password} onClick={run}>{busy ? 'Signing out…' : 'Log out of all devices'}</button>
      </div>
      {msg && <p className="muted small hint">{msg}</p>}
    </div>
  );
}
