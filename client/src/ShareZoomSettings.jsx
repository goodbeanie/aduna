import React, { useEffect, useState } from 'react';
import { acceleratorFrom, desktopZoom, keyLabel, keyFromCode, DEFAULT_KEY } from './sharezoom.js';

// Settings > Voice & Video > "Zoom while sharing": the shortcut that zooms the shared screen in on your cursor (Aduna desktop app only; it needs
// the desktop app because only it can listen for a key while another program is in front, and know where the cursor is). Click the button, then
// press the new combination. It must include Ctrl, Alt or Win, so it can never take over normal typing.
export function ShareZoomSettings() {
  const dz = desktopZoom();
  const [info, setInfo] = useState(null); // { key, def, wheel } from the app
  const [rec, setRec] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (dz) dz.getKey().then((r) => r && setInfo(r)).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (acc) => {
    setBusy(true); setNote('');
    try {
      const r = await dz.setKey(acc);
      if (r && r.ok) setInfo((i) => ({ ...(i || {}), key: r.key })); else setNote((r && r.error) || 'Could not save that shortcut.');
    } catch { setNote('Could not save that shortcut.'); }
    setBusy(false);
  };

  // While recording, every key goes here (capture phase) and none reaches the rest of the app. Escape cancels.
  useEffect(() => {
    if (!rec) return undefined;
    const h = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { setRec(false); setNote(''); return; }
      const acc = acceleratorFrom(e);
      if (acc) { setRec(false); save(acc); }
      else if (keyFromCode(e.code)) setNote('Hold Ctrl, Alt or Win together with the key.');
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [rec]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!dz) return null;
  const key = (info && info.key) || DEFAULT_KEY;
  return (
    <div className="zoom-settings">
      <label>Zoom while sharing</label>
      <div className="dev-row">
        <button type="button" className={'btn' + (rec ? ' on' : '')} onClick={() => { setRec(!rec); setNote(''); }} disabled={busy} aria-pressed={rec}>
          {rec ? 'Press the new shortcut… (Esc to cancel)' : keyLabel(key)}
        </button>
        {key !== DEFAULT_KEY && !rec && <button type="button" className="btn" onClick={() => save((info && info.def) || DEFAULT_KEY)} disabled={busy}>Reset</button>}
      </div>
      {note && <p className="small" role="alert" style={{ color: 'var(--err-fg)' }}>{note}</p>}
      <p className="muted small hint">
        While you share a whole screen, press this to zoom in on your cursor, and press it again to zoom back out. While zoomed in, scroll to zoom further.
        It works from any program. Sharing a single window can't be zoomed.
      </p>
      {info && info.wheel === false && <p className="muted small hint">Scrolling to zoom needs a component that isn't in this build of the app, so only the shortcut works for now.</p>}
    </div>
  );
}
