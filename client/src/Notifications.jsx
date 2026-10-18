import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import * as notify from './notify.js';

const KINDS = [
  ['dm', 'Direct messages', 'Who wrote to you. On this device the text is shown too (decrypted here); when Aduna is closed it only says you have a message, because DMs are end-to-end encrypted.'],
  ['mentions', 'Mentions and @everyone', 'When someone @mentions you or pings the whole server.'],
  ['announcements', 'Announcements', 'New posts in a server’s announcements channel.'],
  ['calls', 'Calls', 'When a friend rings you.'],
  ['friends', 'Friend requests', 'When someone sends you a friend request.'],
];

// Settings > Notifications. Which kinds you get is saved on your account (every device); the permission is per device.
export function NotificationSettings({ me, onPrefs }) {
  const [perm, setPerm] = useState(notify.permission());
  const [subbed, setSubbed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const prefs = me.notifPrefs || {};
  const desktop = notify.isDesktopApp();

  useEffect(() => { notify.isSubscribed().then(setSubbed); }, [perm]);

  const turnOn = async () => {
    setBusy(true); setMsg('');
    try {
      const p = await notify.enable();
      setPerm(notify.permission());
      if (p === 'granted') {
        const ok = await notify.isSubscribed();
        setSubbed(ok);
        if (!ok && notify.pushSupported()) setMsg('Notifications work while Aduna is open. Notifications while it is closed are not available on this server right now.');
        notify.show({ title: 'Notifications are on', body: 'You’ll see DMs, mentions and calls here.', tag: 'aduna-test' });
      }
    } finally { setBusy(false); }
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
      <p className="muted">Choose what Aduna tells you about when you are in another window, another app, or have it closed.</p>

      <label>THIS DEVICE</label>
      <div className="notify-status">
        {desktop && <p>Notifications show as Windows notifications while the Aduna app is running. Clicking one opens that chat.</p>}
        {!desktop && perm === 'granted' && <p><b>On.</b> {subbed ? 'You will also get them while Aduna is closed.' : notify.pushSupported() ? 'You get them while Aduna is open in the background.' : 'You get them while Aduna is open in the background.'}</p>}
        {!desktop && perm === 'default' && <p>Off. Turn them on to hear about DMs, mentions and calls.</p>}
        {!desktop && perm === 'denied' && <p><b>Blocked.</b> Allow notifications for Aduna in your browser or phone settings (the lock icon next to the address, or Settings &gt; Notifications on your phone), then come back.</p>}
        {!desktop && perm === 'needs-install' && <p>iPhone and iPad only allow notifications for apps on the home screen. Tap Share, then <b>Add to Home Screen</b>, open Aduna from there and come back to this page.</p>}
        {!desktop && perm === 'unsupported' && <p>This browser does not support notifications. Chrome, Edge, Firefox and Safari do.</p>}
        <div className="notify-actions">
          {!desktop && perm === 'default' && <button className="btn primary" disabled={busy} onClick={turnOn}>Turn on notifications</button>}
          {!desktop && perm === 'granted' && <button className="btn" disabled={busy} onClick={() => notify.show({ title: 'Test notification', body: 'This is what Aduna notifications look like.', tag: 'aduna-test' })}>Send a test</button>}
          {!desktop && perm === 'granted' && subbed === false && notify.pushSupported() && <button className="btn" disabled={busy} onClick={turnOn}>Enable while closed</button>}
          {!desktop && perm === 'granted' && subbed && <button className="btn" disabled={busy} onClick={turnOff}>Stop while-closed notifications</button>}
          {desktop && <button className="btn" onClick={() => notify.show({ title: 'Test notification', body: 'This is what Aduna notifications look like.', tag: 'aduna-test' })}>Send a test</button>}
        </div>
        {msg && <p className="muted small hint">{msg}</p>}
      </div>

      <label>WHAT TO TELL ME ABOUT</label>
      {KINDS.map(([key, name, hint]) => (
        <React.Fragment key={key}>
          <label className="check-row">
            <input type="checkbox" checked={prefs[key] !== false} onChange={(e) => set(key, e.target.checked)} />
            <span>{name}</span>
          </label>
          <p className="muted small hint">{hint}</p>
        </React.Fragment>
      ))}
      <p className="muted small hint">With Do Not Disturb on, only calls come through. These choices are saved on your account and apply to all your devices.</p>
    </div>
  );
}
