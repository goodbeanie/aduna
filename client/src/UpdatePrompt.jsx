import React, { useEffect, useRef, useState } from 'react';
import { isNativeApp } from './notify.js';

// Android app only: a small rounded box when a newer build exists. Tap Update, the app downloads it and Android's own
// installer opens (one more tap on Install there; Android never allows silent installs outside Google Play).
const plugin = () => window.Capacitor?.Plugins?.AdunaUpdater;
const skipKey = 'aduna_update_skip';
const readSkip = () => { try { return Number(localStorage.getItem(skipKey)) || 0; } catch { return 0; } };

export function UpdatePrompt() {
  const [info, setInfo] = useState(null); // { versionCode, versionName, url }
  const [state, setState] = useState('idle'); // idle | downloading | permission | error
  const [pct, setPct] = useState(-1);
  const current = useRef(0);

  useEffect(() => {
    if (!isNativeApp()) return undefined;
    let dead = false;
    let sub;
    const check = async () => {
      try {
        const p = plugin();
        if (!p) return;
        if (!current.current) current.current = (await p.getVersion()).versionCode || 0;
        const r = await fetch('/api/app-version', { cache: 'no-store' });
        if (!r.ok) return;
        const v = await r.json();
        if (!dead && v.url && v.versionCode > current.current && v.versionCode > readSkip()) setInfo(v);
        else if (!dead) setInfo(null);
      } catch { /* offline: try again later */ }
    };
    const t0 = setTimeout(check, 4000);
    const iv = setInterval(check, 30 * 60 * 1000);
    const vis = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', vis);
    plugin()?.addListener?.('progress', (e) => setPct(e.percent)).then?.((h) => { sub = h; });
    return () => { dead = true; clearTimeout(t0); clearInterval(iv); document.removeEventListener('visibilitychange', vis); sub?.remove?.(); };
  }, []);

  if (!info) return null;

  async function go() {
    setState('downloading'); setPct(-1);
    try { await plugin().install({ url: info.url }); setState('idle'); }
    catch (e) { setState(String(e?.code || e?.message || e).includes('permission') ? 'permission' : 'error'); }
  }
  function later() { try { localStorage.setItem(skipKey, String(info.versionCode)); } catch { /* private mode */ } setInfo(null); }

  return (
    <div className="update-box" role="alert">
      <div className="update-text">
        <b>Update available</b>
        <span>{state === 'downloading' ? (pct >= 0 ? `Downloading… ${pct}%` : 'Downloading…')
          : state === 'permission' ? 'Allow Aduna to install apps in the settings that just opened, then come back and tap Update.'
          : state === 'error' ? 'Could not download. Check your connection and try again.'
          : `Aduna ${info.versionName || info.versionCode} is ready.`}</span>
      </div>
      {state !== 'downloading' && <button className="btn" onClick={later}>Later</button>}
      <button className="btn primary" onClick={go} disabled={state === 'downloading'}>Update</button>
    </div>
  );
}
