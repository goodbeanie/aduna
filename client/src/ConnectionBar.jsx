import React, { useEffect, useRef, useState } from 'react';
import { useLang } from './i18n.js';
import { useConnection, retryNow } from './connection.js';
import { useNotice, noticeText, useNoticeRefresh } from './statusNotice.js';
import './connection.css';

// One banner at the top of the screen for everything about reaching the server.
//   notice         a message posted from the status site's admin page (maintenance, a crash, a restart). Stays until it is cleared there.
//   offline        the device has no network: shown at once
//   reconnecting   the live connection dropped but the device is online: shown after a short wait, so a blink of a second
//                  (a phone waking up, a server restart) does not flash a warning; has a "Retry now" button
//   back           shown for a moment after things recover, so people know it worked
// When a notice and a connection state are both there, the notice is the main line and the state sits under it.
// It says nothing at all while everything is fine.
const WAIT_MS = 2500;
const BACK_MS = 2200;

export function ConnectionBar() {
  const { t } = useLang();
  const { offline, down } = useConnection();
  const notice = useNotice();
  const bad = offline ? 'offline' : down ? 'reconnecting' : null;
  const [shown, setShown] = useState(null);
  const shownRef = useRef(null);
  const show = (v) => { shownRef.current = v; setShown(v); };
  useNoticeRefresh(bad);

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

  const state = shown === 'offline' ? t('connOffline') : shown === 'back' ? t('connBack') : shown ? t('connReconnecting') : '';
  const cls = ['conn-bar'];
  if (notice) cls.push('has-notice', notice.down ? 'notice-down' : 'notice-warn');
  if (shown) cls.push(shown);
  return (
    <div className="conn-wrap" role="status" aria-live="polite">
      {(notice || shown) && (
        <div className={cls.join(' ')}>
          <span className="conn-dot" aria-hidden="true" />
          <span className="conn-text">
            <span>{notice ? noticeText(notice, t) : state}</span>
            {notice && state && <span className="conn-sub">{state}</span>}
          </span>
          {shown === 'reconnecting' && <button type="button" className="btn primary conn-retry" onClick={retryNow}>{t('connRetry')}</button>}
        </div>
      )}
    </div>
  );
}
