import React, { useState } from 'react';
import { Icon } from './ui.jsx';

// A short getting-started checklist for brand-new accounts: pick a theme, add a picture, join a server.
// It only shows for accounts under two weeks old (so a long-time user on a new device never sees it), can be dismissed, and goes away by itself once all three are done.
const OFF = 'aduna-firstrun-off';
const NEW_FOR = 14 * 24 * 3600e3;
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

export function FirstRun({ me, serverCount, onTheme, onPicture, onServer }) {
  const [off, setOff] = useState(() => read(OFF) === '1');
  const fresh = !!me?.createdAt && Date.now() - me.createdAt < NEW_FOR;
  if (off || !fresh) return null;

  const steps = [
    { id: 'theme', label: 'Pick a theme', done: !!read('aduna-theme'), go: onTheme },
    { id: 'picture', label: 'Add a picture', done: !!me.avatarImage, go: onPicture },
    { id: 'server', label: 'Join a server', done: serverCount > 0, go: onServer },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;

  const dismiss = () => { try { localStorage.setItem(OFF, '1'); } catch { /* private mode: hidden until the page closes */ } setOff(true); };

  return (
    <section className="firstrun" aria-label="Getting started">
      <div className="firstrun-head">
        <span>Getting started · {doneCount} of {steps.length}</span>
        <button type="button" className="icon-btn firstrun-x" onClick={dismiss} aria-label="Hide getting started" title="Hide"><Icon name="close" size={14} /></button>
      </div>
      <ul className="firstrun-list">
        {steps.map((s) => (
          <li key={s.id}>
            <button type="button" className={'firstrun-step' + (s.done ? ' done' : '')} disabled={s.done} onClick={s.go}>
              <span className="firstrun-box" aria-hidden="true">{s.done && <Icon name="check" size={12} />}</span>
              <span>{s.label}</span>
              <span className="sr-only">{s.done ? ' (done)' : ''}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
