import React, { useCallback, useEffect, useState } from 'react';
import { Icon, Modal, timeLabel } from './ui.jsx';
import { away, show } from './notify.js';
import { EVENT, cancelReminder, listReminders, listSaved, removeSaved, takeDue, whenIn } from './saved.js';
import './saved.css';

// Everything for "save for later" and "remind me" that is not the menu itself (that lives in Chat.jsx):
//   - a timer that notices when a reminder is due and shows it (a toast in the app, plus a system notification when you are away)
//   - the "Saved messages" list, opened from the command palette (Ctrl/Cmd+K) or with the 'aduna:saved-open' event
export const openSaved = () => window.dispatchEvent(new Event('aduna:saved-open'));

const CHECK_MS = 15_000;

export default function SavedLayer({ meId }) {
  const [open, setOpen] = useState(false);
  const [, bump] = useState(0);
  const [due, setDue] = useState([]); // reminders that fired and are still on screen

  const check = useCallback(() => {
    const fired = takeDue(meId);
    if (!fired.length) return;
    setDue((d) => [...d, ...fired.filter((f) => !d.some((x) => x.id === f.id))]);
    if (away()) fired.forEach((r) => show({ title: 'Reminder from ' + r.author, body: r.text, tag: 'reminder:' + r.id, kind: 'dm', sticky: true }));
  }, [meId]);

  useEffect(() => {
    check(); // a reminder that came due while the app was closed shows as soon as it opens
    const t = setInterval(check, CHECK_MS);
    const wake = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', check);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', check); };
  }, [check]);

  useEffect(() => { // lists change from the menu, another tab, or a removal here
    const again = () => { check(); bump((n) => n + 1); };
    const openIt = () => setOpen(true);
    window.addEventListener(EVENT, again);
    window.addEventListener('storage', again);
    window.addEventListener('aduna:saved-open', openIt);
    return () => { window.removeEventListener(EVENT, again); window.removeEventListener('storage', again); window.removeEventListener('aduna:saved-open', openIt); };
  }, [check]);

  const saved = open ? listSaved(meId) : [];
  const pending = open ? listReminders(meId) : [];

  return (
    <>
      {due.length > 0 && (
        <div className="reminder-stack" role="status" aria-live="polite">
          {due.slice(-3).map((r) => (
            <div className="reminder-toast" key={r.id}>
              <span className="reminder-ico"><Icon name="bell" size={18} /></span>
              <div className="reminder-body">
                <b>Reminder</b>
                <span className="reminder-meta">{r.author}{r.convoTitle ? ' · ' + r.convoTitle : ''}</span>
                <span className="reminder-text">{r.text}</span>
              </div>
              <button className="icon-btn" aria-label="Dismiss reminder" onClick={() => setDue((d) => d.filter((x) => x.id !== r.id))}><Icon name="close" size={16} /></button>
            </div>
          ))}
        </div>
      )}
      {open && (
        <Modal title="Saved messages" onClose={() => setOpen(false)}>
          <div className="saved-list">
            {pending.length > 0 && <h3 className="saved-h">Reminders</h3>}
            {pending.map((r) => (
              <div className="saved-row" key={'r' + r.id}>
                <Icon name="clock" size={16} />
                <div className="saved-main">
                  <span className="saved-meta">In {whenIn(r.due)} · {r.author}{r.convoTitle ? ' · ' + r.convoTitle : ''}</span>
                  <span className="saved-text">{r.text}</span>
                </div>
                <button className="btn ghost" onClick={() => cancelReminder(meId, r.id)}>Cancel</button>
              </div>
            ))}
            {pending.length > 0 && <h3 className="saved-h">Saved</h3>}
            {saved.length === 0 && <p className="muted saved-empty">Nothing saved yet. Right-click a message (or tap its “⋯” menu) and choose Save for later.</p>}
            {saved.map((s) => (
              <div className="saved-row" key={'s' + s.id}>
                <Icon name="bookmark" size={16} />
                <div className="saved-main">
                  <span className="saved-meta">{s.author}{s.convoTitle ? ' · ' + s.convoTitle : ''} · {timeLabel(s.at)}</span>
                  <span className="saved-text">{s.text}</span>
                </div>
                <button className="btn ghost" onClick={() => removeSaved(meId, s.id)}>Remove</button>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
