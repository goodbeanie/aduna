import React, { useEffect, useState } from 'react';
import { Icon } from './ui.jsx';
import * as notify from './notify.js';

const KEY = 'aduna_notify_asked';
const read = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const write = () => { try { localStorage.setItem(KEY, '1'); } catch { /* private mode */ } };

let autoTried = false; // the Android app asks once per launch

// Asks to turn notifications on.
//   - Android app: asks by itself as soon as the person is logged in and the main screen is up (Android shows its own question).
//   - Installed web app (home screen): browsers only allow the question after a tap, so it comes with the first tap after login.
//   - Plain browser: a one-time banner with a button. On an iPhone / iPad it can only work from the home-screen app,
//     so the banner says how to install it instead.
export function NotifyPrompt() {
  const [hidden, setHidden] = useState(read);
  const [, bump] = useState(0);
  const native = notify.isNativeApp();

  useEffect(() => {
    if (!native || autoTried) return;
    autoTried = true;
    notify.enable().catch(() => {}).finally(() => bump((n) => n + 1));
  }, [native]);

  useEffect(() => {
    if (native || notify.isDesktopApp() || !notify.isInstalled() || notify.permission() !== 'default') return undefined;
    const onTap = (e) => {
      if (e.target?.closest?.('.notify-prompt')) return; // taps on the banner keep their own meaning ("Not now")
      window.removeEventListener('click', onTap, true);
      notify.enable().catch(() => {}).finally(() => bump((n) => n + 1));
    };
    window.addEventListener('click', onTap, true);
    return () => window.removeEventListener('click', onTap, true);
  }, [native]);

  const p = notify.permission();
  if (native || hidden || (p !== 'default' && p !== 'needs-install')) return null;
  const close = () => { write(); setHidden(true); };
  return (
    <div className="notify-prompt" role="region" aria-label="Notifications">
      <Icon name="bell" size={20} />
      {p === 'needs-install'
        ? <span>To get notifications on iPhone, tap Share, then <b>Add to Home Screen</b>, and open Aduna from there.</span>
        : <span>Get notified about DMs, mentions and calls, even when Aduna is closed.</span>}
      {p === 'default' && <button className="btn primary" onClick={async () => { await notify.enable(); close(); }}>Turn on</button>}
      <button className="btn ghost" onClick={close}>{p === 'default' ? 'Not now' : 'Got it'}</button>
    </div>
  );
}
