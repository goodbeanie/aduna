import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './ui.jsx';

// A short getting-started list for brand-new accounts. It starts partly done on purpose: the account exists and the person has usually joined the
// official server already, so they begin at 2 of 4 and every step after that is the part that makes a chat app worth opening: say hello, add a friend.
// It only shows for accounts under two weeks old (so a long-time user on a new device never sees it), can be dismissed, and says "You're all set"
// for a few seconds when the last step is ticked during a visit.
const OFF = 'aduna-firstrun-off';
const NEW_FOR = 14 * 24 * 3600e3;
const EVENT = 'aduna-firstrun';
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const helloKey = (id) => 'aduna-hello-' + id;

// App.jsx calls this after a message has gone out. The flag lives in this browser; the list is only for the first two weeks, so that is enough.
export function markSaidHello(userId) {
  if (!userId || read(helloKey(userId)) === '1') return;
  try { localStorage.setItem(helloKey(userId), '1'); } catch { /* private mode: it ticks until the page closes */ }
  try { window.dispatchEvent(new Event(EVENT)); } catch { /* ignore */ }
}

export function FirstRun({ me, serverCount, friendCount, onHello, onFriend, onServer }) {
  const [off, setOff] = useState(() => read(OFF) === '1');
  const [, bump] = useState(0);
  const [celebrate, setCelebrate] = useState(false);
  const wasDone = useRef(null); // were all steps done when this list first drew? then there is nothing to celebrate
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);

  const fresh = !!me?.createdAt && Date.now() - me.createdAt < NEW_FOR;
  const steps = [
    { id: 'account', label: 'Create your account', done: true },
    { id: 'server', label: 'Join a server', done: serverCount > 0, go: onServer },
    { id: 'hello', label: 'Say hello', done: read(helloKey(me?.id)) === '1', go: onHello },
    { id: 'friend', label: 'Add a friend', done: friendCount > 0, go: onFriend },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const all = doneCount === steps.length;

  if (wasDone.current === null) wasDone.current = all;
  useEffect(() => {
    if (!all || wasDone.current) return undefined;
    setCelebrate(true);
    const t = setTimeout(() => { setCelebrate(false); wasDone.current = true; }, 4000);
    return () => clearTimeout(t);
  }, [all]);

  if (off || !fresh) return null;
  if (all && !celebrate) return null;

  const dismiss = () => { try { localStorage.setItem(OFF, '1'); } catch { /* private mode: hidden until the page closes */ } setOff(true); };

  if (celebrate) {
    return (
      <section className="firstrun" aria-label="Getting started" role="status">
        <div className="firstrun-head"><span>You’re all set</span></div>
        <p className="firstrun-done"><Icon name="check" size={14} /> You’ve made yourself at home. Enjoy Aduna.</p>
      </section>
    );
  }

  return (
    <section className="firstrun" aria-label="Getting started">
      <div className="firstrun-head">
        <span>Getting started · {doneCount} of {steps.length}</span>
        <button type="button" className="icon-btn firstrun-x" onClick={dismiss} aria-label="Hide getting started" title="Hide"><Icon name="close" size={14} /></button>
      </div>
      <div className="firstrun-bar" aria-hidden="true"><i style={{ width: (doneCount / steps.length * 100) + '%' }} /></div>
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
