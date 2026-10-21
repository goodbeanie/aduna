import React from 'react';
import { actions, useRailMode, useUpdateState } from './updateStore.js';

// The update chip on the right of the server bar, phones and the Android app (the desktop app has the same chip): "Checking for update…" ->
// "No update available" (10 s, then it fades) or "Update available [Install]" -> "Downloading 40%". For a new site version the button is Reload.
const Svg = ({ cls, children }) => <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={cls}>{children}</svg>;
const ICON = {
  spin: <Svg cls="spin"><path d="M13.2 8A5.2 5.2 0 1 1 11.7 4.3" /></Svg>,
  ok: <Svg cls="ok"><circle cx="8" cy="8" r="6.2" /><path d="M5.2 8.2l2 2 3.6-4" /></Svg>,
  down: <Svg cls="warn"><path d="M8 2.5v8M4.8 7.6L8 10.8l3.2-3.2M3 13.2h10" /></Svg>,
  bad: <Svg cls="bad"><circle cx="8" cy="8" r="6.2" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" /></Svg>,
};

export function RailUpdateChip() {
  const rail = useRailMode();
  const s = useUpdateState();
  let v = null;
  if (s.apk && s.apkState === 'downloading') v = { icon: ICON.down, text: <>Downloading <b>{s.pct >= 0 ? s.pct + '%' : '…'}</b></>, bar: s.pct >= 0 ? s.pct : 4 };
  else if (s.apk && s.apkState === 'permission') v = { icon: ICON.down, text: 'Allow installs, then tap Install', button: 'Install', on: () => actions.apkGo?.() };
  else if (s.apk && s.apkState === 'error') v = { icon: ICON.bad, text: 'Download failed', title: s.why, button: 'Retry', on: () => actions.apkGo?.() };
  else if (s.apk) v = { icon: ICON.down, text: <>Update available{s.apk.versionName ? <> <b>{s.apk.versionName}</b></> : null}</>, button: 'Install', on: () => actions.apkGo?.() };
  else if (s.site) v = { icon: ICON.down, text: 'Update available', button: 'Reload', on: () => window.location.reload() };
  else if (s.checking) v = { icon: ICON.spin, text: 'Checking for update…' };
  else if (s.none) v = { icon: ICON.ok, text: 'No update available' };
  if (!rail || !v) return null;
  return (
    <div className={'rail-upd' + (v.button ? '' : ' noinstall')} role="status" aria-live="polite" title={v.title}>
      {v.icon}
      <span>{v.text}</span>
      {v.bar != null && <div className="pbar"><i style={{ width: Math.max(2, Math.min(100, v.bar)) + '%' }} /></div>}
      {v.button && <button onClick={v.on}>{v.button}</button>}
    </div>
  );
}
