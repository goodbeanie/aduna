import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './ui.jsx';
import { FRAME_ZOOM, processFrame } from './image.js';
import { useLang } from './i18n.js';
import './cropper.css';

// Position and zoom a profile frame picture before it is uploaded (Settings > Artist, a frame item).
// The window is the 512 x 512 frame. The dashed rounded square is where the profile picture sits (it has to stay empty); the blue band around it is
// where the ring goes. Drag to move, slider / mouse wheel / + and - keys to zoom, arrow keys to nudge. Zoom 1 fits the whole picture in the square.
// Nothing is uploaded here: onApply gets the finished 512px PNG (the same checks as before run in processFrame, so a filled-in middle is explained here).
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export default function FrameAdjust({ file, onApply, onCancel }) {
  const { t } = useLang();
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const [nat, setNat] = useState(null); // the picture's own size, once it has loaded
  const [side, setSide] = useState(320); // size of the window on screen
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 }); // the picture's middle, as a share of the square (0 = centred)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const drag = useRef(null);
  const box = useRef(null);

  useEffect(() => {
    const fit = () => setSide(Math.max(220, Math.min(360, window.innerWidth - 72)));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  const geo = useMemo(() => {
    if (!nat) return null;
    const s = (side / Math.max(nat.w, nat.h)) * zoom; // screen pixels per picture pixel
    return { w: nat.w * s, h: nat.h * s };
  }, [nat, side, zoom]);

  const keep = (p) => ({ x: clamp(p.x, -0.5, 0.5), y: clamp(p.y, -0.5, 0.5) }); // the middle of the picture stays inside the square
  const left = geo ? side / 2 + pos.x * side - geo.w / 2 : 0;
  const top = geo ? side / 2 + pos.y * side - geo.h / 2 : 0;

  const down = (e) => {
    if (!geo) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, pos };
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    setPos(keep({ x: d.pos.x + (e.clientX - d.x) / side, y: d.pos.y + (e.clientY - d.y) / side }));
  };
  const up = () => { drag.current = null; };

  const nudge = (dx, dy) => setPos((p) => keep({ x: p.x + dx / side, y: p.y + dy / side }));
  const zoomBy = (f) => setZoom((z) => clamp(z * f, FRAME_ZOOM.min, FRAME_ZOOM.max));
  const key = (e) => {
    const step = e.shiftKey ? 30 : 10;
    if (e.key === 'ArrowLeft') nudge(-step, 0);
    else if (e.key === 'ArrowRight') nudge(step, 0);
    else if (e.key === 'ArrowUp') nudge(0, -step);
    else if (e.key === 'ArrowDown') nudge(0, step);
    else if (e.key === '+' || e.key === '=') zoomBy(1.1);
    else if (e.key === '-') zoomBy(1 / 1.1);
    else return;
    e.preventDefault();
  };

  // the wheel zooms (a listener of our own, because React's wheel handler cannot stop the page from scrolling)
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const wheel = (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.08 : 1 / 1.08); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  async function apply() {
    setBusy(true); setErr('');
    try { onApply(await processFrame(file, { zoom, x: pos.x, y: pos.y })); }
    catch (ex) { setErr(ex.message); setBusy(false); }
  }
  const reset = () => { setZoom(1); setPos({ x: 0, y: 0 }); setErr(''); };

  return (
    <Modal title="Position your frame" onClose={onCancel}>
      <div className="crop">
        <p className="muted small">Drag to move the picture and use the slider (or the mouse wheel) to zoom. Your ring goes in the blue band. The dashed square is where the profile picture sits, so keep it empty.</p>
        <div
          ref={box}
          className="crop-window frame-window"
          style={{ width: side, height: side }}
          tabIndex={0}
          role="img"
          aria-label={t('cropArea')}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}
        >
          <img
            src={url} alt="" draggable={false}
            onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setErr(t('imgRead'))}
            style={geo ? { width: geo.w, height: geo.h, transform: `translate(${left}px, ${top}px)` } : { visibility: 'hidden' }}
          />
          <span className="frame-hole" aria-hidden="true" />
        </div>
        <label className="crop-zoom">
          <span className="muted small">{t('cropZoom')}</span>
          <input type="range" min={FRAME_ZOOM.min} max={FRAME_ZOOM.max} step="0.01" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label={t('cropZoom')} />
        </label>
        {err && <p className="error-text" role="alert">{err}</p>}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={reset} disabled={busy}>Reset</button>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>{t('cropCancel')}</button>
          <button type="button" className="btn primary" onClick={apply} disabled={busy || !geo}>{busy ? t('cropApplying') : t('cropApply')}</button>
        </div>
      </div>
    </Modal>
  );
}
