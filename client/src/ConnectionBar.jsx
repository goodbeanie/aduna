import React, { useEffect, useRef, useState } from 'react';
import { useLang } from './i18n.js';
import { useConnection, retryNow } from './connection.js';
import './connection.css';

// A small pill at the top of the screen when Aduna cannot reach the server.
//   offline        the device has no network: shown at once
//   reconnecting   the live connection dropped but the device is online: shown after a short wait, so a blink of a second
//                  (a phone waking up, a server restart) does not flash a warning; has a "Retry now" button
//   back           shown for a moment after things recover, so people know it worked
// It says nothing at all while everything is fine.
const WAIT_MS = 2500;
const BACK_MS = 2200;

export function ConnectionBar() {
  const { t } = useLang();
  const { offline, down } = useConnection();
  const bad = offline ? 'offline' : down ? 'reconnecting' : null;
  const [shown, setShown] = useState(null);
  const shownRef = useRef(null);
  const show = (v) => { shownRef.current = v; setShown(v); };

  useEffect(() => {
    if (bad === 'offline') { show('offline'); return undefined; }
    if (bad === 'reconnecting') {
      if (shownRef.current) { show('reconnecting'); return undefined; } // already telling them something: keep it right
      const id = setTimeout(() => show('reconnecting'), WAIT_MS);
      return () => clearTimeout(id);
    }
    if (!shownRef.current) return undefined; // it was only a blink: nothing was shown, nothing to take back
    show('back');
    const id = setTimeout(() => show(null), BACK_MS);
    return () => clearTimeout(id);
  }, [bad]);

  const text = shown === 'offline' ? t('connOffline') : shown === 'back' ? t('connBack') : t('connReconnecting');
  return (
    <div className="conn-wrap" role="status" aria-live="polite">
      {shown && (
        <div className={'conn-bar ' + shown}>
          <span className="conn-dot" aria-hidden="true" />
          <span>{text}</span>
          {shown === 'reconnecting' && <button type="button" className="btn primary conn-retry" onClick={retryNow}>{t('connRetry')}</button>}
        </div>
      )}
    </div>
  );
}
