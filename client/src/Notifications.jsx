import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import * as notify from './notify.js';
import { useLang } from './i18n.js';

const KINDS = [['dm', 'nDm', 'nDmHint'], ['mentions', 'nMentions', 'nMentionsHint'], ['announcements', 'nAnn', 'nAnnHint'], ['calls', 'nCalls', 'nCallsHint'], ['friends', 'nFriends', 'nFriendsHint']];

// Settings > Notifications. Which kinds you get is saved on your account (every device); the permission is per device.
export function NotificationSettings({ me, onPrefs }) {
  const { t } = useLang();
  const [perm, setPerm] = useState(notify.permission());
  const [subbed, setSubbed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [diag, setDiag] = useState(null);
  const prefs = me.notifPrefs || {};
  const desktop = notify.isDesktopApp();
  const native = notify.isNativeApp();

  useEffect(() => { // Android app: the test push arrived while this page was open (the system only draws a banner when the app is in the background)
    const got = (e) => { if (e.detail?.kind === 'test') setMsg('The test push reached this phone. Android only shows it as a banner while Aduna is in the background.'); };
    window.addEventListener('aduna:push-received', got);
    return () => window.removeEventListener('aduna:push-received', got);
  }, []);

  useEffect(() => { notify.isSubscribed().then(setSubbed); }, [perm]);

  const turnOn = async () => {
    setBusy(true); setMsg('');
    try {
      const p = await notify.enable();
      setPerm(notify.permission());
      if (p === 'granted') {
        const ok = await notify.isSubscribed();
        setSubbed(ok);
        if (!ok && notify.pushSupported()) setMsg('Notifications work while Aduna is open. Closed-app notifications could not be set up' + (notify.subscribeError() ? ': ' + notify.subscribeError() : '.') + ' Press \u201cCheck notifications\u201d for details.');
        notify.show({ title: 'Notifications are on', body: 'You’ll see DMs, mentions and calls here.', tag: 'aduna-test' });
      }
    } finally { setBusy(false); }
  };
  const check = async () => { setBusy(true); setMsg(''); try { setDiag(await notify.diagnose()); } finally { setBusy(false); } };
  const serverTest = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await notify.pushTest();
      if (!r.enabled) setMsg('Push is switched off on the server.');
      else if (!r.devices) setMsg('No device of yours is registered for push yet. Press \u201cEnable while closed\u201d first.');
      else if (r.failed.length && !r.sent) setMsg('The push service refused the message (' + r.failed.map((f) => f.status || 'network error').join(', ') + '). Press \u201cStop while-closed notifications\u201d, then \u201cEnable while closed\u201d to register this device again.');
      else if (native) setMsg('Sent to ' + r.sent + ' of ' + r.devices + ' device' + (r.devices === 1 ? '' : 's') + '. Switch to another app or lock the screen: Android only shows the banner while Aduna is in the background.');
      else setMsg('Sent to ' + r.sent + ' of ' + r.devices + ' device' + (r.devices === 1 ? '' : 's') + '. It should appear within a few seconds. If it does not, check this app\u2019s notification settings in your phone\u2019s system settings (and that battery use is not restricted).');
    } catch (e) { setMsg(e.message || 'Test failed'); } finally { setBusy(false); }
  };
  const turnOff = async () => { setBusy(true); await notify.unsubscribe(); setSubbed(false); setBusy(false); setMsg('Closed-app notifications are off for this device. To stop all notifications, block them in your browser or phone settings.'); };
  const set = async (key, value) => {
    const next = { ...prefs, [key]: value };
    onPrefs(next); // show the change straight away
    try { const r = await api('/me/notifications', { method: 'PUT', body: next }); onPrefs(r.notifPrefs); }
    catch { onPrefs(prefs); setMsg('Could not save that. Try again.'); }
  };

  return (
    <div className="notify-settings">
      <p className="muted">{t('nIntro')}</p>

      <label>{t('nThisDevice')}</label>
      <div className="notify-status">
        {desktop && <p>{t('nDesktop')}</p>}
        {!desktop && perm === 'granted' && <p><b>{t('nOn')}</b> {subbed ? t('nOnClosed') : t('nOnOpen')}</p>}
        {!desktop && perm === 'default' && <p>{t('nOff')}</p>}
        {!desktop && perm === 'denied' && <p><b>{t('nBlockedB')}</b>{t('nBlocked')}</p>}
        {!desktop && perm === 'needs-install' && <p>{t('nInstallA')}<b>{t('nInstallB')}</b>{t('nInstallC')}</p>}
        {!desktop && perm === 'unsupported' && <p>{t('nUnsupported')}</p>}
        <div className="notify-actions">
          {!desktop && perm === 'default' && <button className="btn primary" disabled={busy} onClick={turnOn}>{t('nTurnOn')}</button>}
          {!desktop && !native && perm === 'granted' && <button className="btn" disabled={busy} onClick={() => notify.show({ title: 'Test notification', body: 'This is what Aduna notifications look like.', tag: 'aduna-test' })}>{t('nSendTest')}</button>}
          {!desktop && perm === 'granted' && subbed === false && notify.pushSupported() && <button className="btn" disabled={busy} onClick={turnOn}>{t('nEnableClosed')}</button>}
          {!desktop && perm === 'granted' && subbed && <button className="btn" disabled={busy} onClick={turnOff}>{t('nStopClosed')}</button>}
          {!desktop && perm === 'granted' && notify.pushSupported() && <button className="btn" disabled={busy} onClick={serverTest}>{t('nServerTest')}</button>}
          {!desktop && <button className="btn" disabled={busy} onClick={check}>{t('nCheck')}</button>}
          {desktop && <button className="btn" onClick={() => notify.show({ title: 'Test notification', body: 'This is what Aduna notifications look like.', tag: 'aduna-test' })}>{t('nSendTest')}</button>}
        </div>
        {msg && <p className="muted small hint">{msg}</p>}
        {diag && (
          <ul className="notify-diag">
            {diag.map((d) => (
              <li key={d.label} className={d.ok === true ? 'ok' : d.ok === false ? 'bad' : ''}>
                <span aria-hidden="true">{d.ok === true ? '\u2713' : d.ok === false ? '\u2717' : '\u2022'}</span>
                <span><b>{d.label}</b>{d.detail ? <><br /><span className="muted small">{d.detail}</span></> : null}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <label>{t('nWhat')}</label>
      {KINDS.map(([key, nameKey, hintKey]) => (
        <React.Fragment key={key}>
          <label className="check-row">
            <input type="checkbox" checked={prefs[key] !== false} onChange={(e) => set(key, e.target.checked)} />
            <span>{t(nameKey)}</span>
          </label>
          <p className="muted small hint">{t(hintKey)}</p>
        </React.Fragment>
      ))}
      <p className="muted small hint">{t('nFooter')}</p>
    </div>
  );
}
