import React, { useState } from 'react';

// Shows a recovery key once, with copy / save-to-file and a "yes I kept it" tick that must be set before carrying on.
// The key is made in the browser and never sent to us, so if it is lost it cannot be shown again (only replaced).
export function RecoveryKeyCard({ recoveryKey, username, title = 'Save your recovery key', onDone, doneLabel = 'Continue' }) {
  const [saved, setSaved] = useState(false);
  const [msg, setMsg] = useState('');

  const copy = () => navigator.clipboard?.writeText(recoveryKey).then(() => setMsg('Copied.')).catch(() => setMsg('Could not copy. Write it down instead.'));
  const download = () => {
    const text = `Aduna recovery key${username ? ' for ' + username : ''}\n\n${recoveryKey}\n\nKeep this somewhere safe and private. With it you can set a new password if you forget yours, and your messages stay readable. Anyone who has it can do the same, so do not share it.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'aduna-recovery-key.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setMsg('Saved to your downloads.');
  };

  return (
    <>
      <h1>{title}</h1>
      <p className="muted">If you forget your password, this key is the <strong>only</strong> way back in with your encrypted messages intact. We never see it and cannot show it again.</p>
      <div className="recovery-codes one"><code>{recoveryKey}</code></div>
      <div className="notify-actions">
        <button type="button" className="btn" onClick={copy}>Copy</button>
        <button type="button" className="btn" onClick={download}>Save as file</button>
      </div>
      {msg && <p className="muted small hint">{msg}</p>}
      <label className="check-row">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I saved my recovery key somewhere safe
      </label>
      <button type="button" className="btn primary full" disabled={!saved} onClick={onDone}>{doneLabel}</button>
    </>
  );
}
