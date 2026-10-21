import React, { useEffect, useRef, useState } from 'react';
import { isNativeApp } from './notify.js';

// Android app only: a small rounded box when a newer build exists. Tap Update, the app downloads it and Android's own
// installer opens (one more tap on Install there; Android never allows silent installs outside Google Play).
const plugin = () => window.Capacitor?.Plugins?.AdunaUpdater;
const skipKey = 'aduna_update_skip'; // JSON { code, until }: "Later" hides that build for 12 hours, then the box comes back
const SNOOZE_MS = 12 * 60 * 60 * 1000;
const snoozed = (code) => { try { const j = JSON.parse(localStorage.getItem(skipKey) || 'null'); return !!j && j.code >= code && Date.now() < j.until; } catch { return false; } };

export function UpdatePrompt() {
  const [info, setInfo] = useState(null); // { versionCode, versionName, url, legacy }; legacy = this APK has no updater plugin (built before in-app updates)
  const [state, setState] = useState('idle'); // idle | downloading | permission | error
  const [pct, setPct] = useState(-1);
  const [why, setWhy] = useState('');
  const current = useRef(0);

  useEffect(() => {
    if (!isNativeApp()) return undefined;
    let dead = false;
    let sub;
    const check = async () => {
      try {
        const p = plugin();
        // An APK built before in-app updates has no plugin: it can never report its version, so it counts as version 0 (any published build is newer)
        // and the box sends the person to the download instead of installing in place.
        if (!current.current) {
          try { current.current = p ? Number((await p.getVersion()).versionCode) || 0 : 0; } catch { current.current = 0; }
        }
        // Same as the desktop app: read the site's own feed (updates/latest.json) first; /api/app-version is only the fallback
        let v = null;
        for (const path of ['/updates/latest.json', '/api/app-version']) {
          try {
            const r = await fetch(path, { cache: 'no-store' });
            if (!r.ok) continue;
            const j = await r.json();
            if (j && j.url && Number(j.versionCode) > 0) { v = j; break; }
          } catch { /* try the next one */ }
        }
        if (!v) { if (!dead) setInfo(null); return; }
        const newer = !!v.url && Number(v.versionCode) > current.current && !snoozed(Number(v.versionCode));
        if (!dead) setInfo(newer ? { ...v, legacy: !p } : null);
      } catch { /* offline: try again later */ }
    };
    const t0 = setTimeout(check, 4000);
    const t1 = setTimeout(check, 60 * 1000); // second look in case the first one ran before the connection was ready
    const iv = setInterval(check, 30 * 60 * 1000);
    const vis = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('online', check);
    plugin()?.addListener?.('progress', (e) => setPct(e.percent)).then?.((h) => { sub = h; });
    return () => { dead = true; clearTimeout(t0); clearTimeout(t1); clearInterval(iv); document.removeEventListener('visibilitychange', vis); window.removeEventListener('online', check); sub?.remove?.(); };
  }, []);

  if (!info) return null;

  async function go() {
    if (info.legacy) { window.location.assign(info.url); return; } // old APK: let Android download it in the browser, then tap the file to install
    setState('downloading'); setPct(-1);
    try { await plugin().install({ url: info.url }); setState('idle'); }
    catch (e) { const m = String(e?.code || e?.message || e); setWhy(m.includes('not_apk') ? 'The server sent something that is not an app file. The new APK may not be uploaded yet.' : m.includes('incomplete') ? 'The download was cut off. Try again.' : ''); setState(m.includes('permission') ? 'permission' : 'error'); }
  }
  function later() { try { localStorage.setItem(skipKey, JSON.stringify({ code: Number(info.versionCode), until: Date.now() + SNOOZE_MS })); } catch { /* private mode */ } setInfo(null); }

  return (
    <div className="update-box" role="alert">
      <div className="update-text">
        <b>Update available</b>
        <span>{state === 'downloading' ? (pct >= 0 ? `Downloading… ${pct}%` : 'Downloading…')
          : state === 'permission' ? 'Allow Aduna to install apps in the settings that just opened, then come back and tap Update.'
          : state === 'error' ? (why || 'Could not download. Check your connection and try again.')
          : info.legacy ? `Aduna ${info.versionName || info.versionCode} is ready. Tap Update to download it, then open the file to install.`
          : `Aduna ${info.versionName || info.versionCode} is ready.`}</span>
      </div>
      {state !== 'downloading' && <button className="btn" onClick={later}>Later</button>}
      <button className="btn primary" onClick={go} disabled={state === 'downloading'}>Update</button>
    </div>
  );
}
