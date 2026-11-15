import React, { useState } from 'react';
import { api } from './api.js';
import { Modal } from './ui.jsx';

const REASONS = {
  listing: [
    ['inappropriate', 'Inappropriate or offensive', 'Name, description, tags or pictures'],
    ['spam', 'Spam or scam', 'Advertising, phishing, fake giveaways'],
    ['illegal', 'Illegal or dangerous', 'Threats, exploitation, anything that puts people at risk'],
    ['impersonation', 'Impersonation', 'Pretends to be a person, brand or another server'],
    ['other', 'Something else', 'Tell us below'],
  ],
  message: [
    ['inappropriate', 'Inappropriate or offensive', 'Harassment, hate, explicit content'],
    ['spam', 'Spam or scam', 'Advertising, phishing, fake giveaways'],
    ['illegal', 'Illegal or dangerous', 'Threats, exploitation, anything that puts people at risk'],
    ['impersonation', 'Impersonation', 'Pretends to be someone else'],
    ['other', 'Something else', 'Tell us below'],
  ],
};

// Report a public listing or a message. The person reported never learns who reported; moderators read it and decide.
export default function ReportModal({ info, path, kind = 'listing', onClose }) {
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const message = kind === 'message';
  const send = async () => {
    setBusy(true); setErr('');
    try { await api(path, { method: 'POST', body: { reason, details } }); setDone(true); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <Modal title={message ? 'Report message' : `Report ${info.name}`} onClose={onClose}>
      {done ? (
        <>
          <p>Thank you. Your report was sent to the moderators. {message ? 'The person who wrote it is' : 'The server owner is'} not told who reported.</p>
          <div className="modal-foot"><button className="btn primary" autoFocus onClick={onClose}>Done</button></div>
        </>
      ) : (
        <>
          <p className="muted small">{message ? `What is wrong with this message from ${info.name}?` : 'What is wrong with this listing?'}</p>
          <div className="report-reasons">
            {REASONS[kind].map(([id, label, hint]) => (
              <label key={id} className={'report-reason keep-case' + (reason === id ? ' on' : '')}>
                <input type="radio" name="report-reason" checked={reason === id} disabled={busy} onChange={() => setReason(id)} />
                <span><b>{label}</b><span className="muted small"> {hint}</span></span>
              </label>
            ))}
          </div>
          <label className="field">Details {reason === 'other' ? '' : '(optional)'}
            <textarea rows={3} maxLength={500} value={details} disabled={busy} onChange={(e) => setDetails(e.target.value)} />
          </label>
          {err && <div className="error">{err}</div>}
          <div className="modal-foot">
            <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="btn primary danger-fill" disabled={busy || !reason || (reason === 'other' && !details.trim())} onClick={send}>{busy ? 'Sending…' : 'Send report'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
