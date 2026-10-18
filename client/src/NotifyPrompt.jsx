import React, { useState } from 'react';
import { Icon } from './ui.jsx';
import * as notify from './notify.js';

const KEY = 'aduna_notify_asked';
const read = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const write = () => { try { localStorage.setItem(KEY, '1'); } catch { /* private mode */ } };

// A one-time banner asking to turn notifications on. Browsers only allow the permission question after a tap, so it needs a button.
// On an iPhone / iPad it can only work from the home-screen app, so the banner says how to install it instead.
export function NotifyPrompt() {
  const [hidden, setHidden] = useState(read);
  const p = notify.permission();
  if (hidden || (p !== 'default' && p !== 'needs-install')) return null;
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
