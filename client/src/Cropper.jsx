import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './ui.jsx';
import { processImage } from './image.js';
import './cropper.css';

// Crop and position a picture before it is used as a profile picture, banner or server icon.
// The window shows exactly what will be kept (same shape ratio as the final picture): drag to move, slider / mouse wheel / + and - keys to zoom.
// Nothing is uploaded here. onApply gets the finished, resized blob; the caller stages it like it did before.
//   file: the chosen File   size: { w, h } of the final picture   shape: 'square' (rounded corners, for pictures and icons) or 'wide' (banners)
const MAX_ZOOM = 4;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export default function Cropper({ file, size, shape = 'wide', title = 'Position your picture', onApply, onCancel }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const [nat, setNat] = useState(null); // the picture's own size, once it has loaded
  const [view, setView] = useState(null); // size of the crop window on screen
  const [zoom, setZoom] = useState(1);
  const [mid, setMid] = useState({ x: 0.5, y: 0.5 }); // middle of the kept part, as a share of the picture
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const drag = useRef(null);
  const box = useRef(null);

  // the crop window: as wide as fits, with the final picture's proportions
  useEffect(() => {
    const fit = () => {
      const maxW = Math.max(220, Math.min(shape === 'wide' ? 520 : 320, window.innerWidth - 72));
      setView({ w: maxW, h: Math.round(maxW * size.h / size.w) });
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [size.w, size.h, shape]);

  const geo = useMemo(() => {
    if (!nat || !view) return null;
    const s = Math.max(view.w / nat.w, view.h / nat.h) * zoom; // screen pixels per picture pixel
    return { s, w: nat.w * s, h: nat.h * s };
  }, [nat, view, zoom]);

  // keep the picture covering the whole window
  const keep = (m, g = geo) => g ? ({
    x: clamp(m.x, view.w / 2 / g.w, 1 - view.w / 2 / g.w),
    y: clamp(m.y, view.h / 2 / g.h, 1 - view.h / 2 / g.h),
  }) : m;
  useEffect(() => { if (geo) setMid((m) => keep(m)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [geo]);

  const left = geo ? view.w / 2 - mid.x * geo.w : 0;
  const top = geo ? view.h / 2 - mid.y * geo.h : 0;

  const down = (e) => {
    if (!geo) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, mid };
  };
  const move = (e) => {
    const d = drag.current;
    if (!d || !geo) return;
    setMid(keep({ x: d.mid.x - (e.clientX - d.x) / geo.w, y: d.mid.y - (e.clientY - d.y) / geo.h }));
  };
  const up = () => { drag.current = null; };

  const nudge = (dx, dy) => geo && setMid((m) => keep({ x: m.x + dx / geo.w, y: m.y + dy / geo.h }));
  const key = (e) => {
    const step = e.shiftKey ? 30 : 10;
    if (e.key === 'ArrowLeft') nudge(-step, 0);
    else if (e.key === 'ArrowRight') nudge(step, 0);
    else if (e.key === 'ArrowUp') nudge(0, -step);
    else if (e.key === 'ArrowDown') nudge(0, step);
    else if (e.key === '+' || e.key === '=') setZoom((z) => clamp(z + 0.1, 1, MAX_ZOOM));
    else if (e.key === '-') setZoom((z) => clamp(z - 0.1, 1, MAX_ZOOM));
    else return;
    e.preventDefault();
  };

  // the wheel zooms (a listener of our own, because React's wheel handler cannot stop the page from scrolling)
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const wheel = (e) => { e.preventDefault(); setZoom((z) => clamp(z * (e.deltaY < 0 ? 1.08 : 1 / 1.08), 1, MAX_ZOOM)); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [view]);

  async function apply() {
    setBusy(true); setErr('');
    try { onApply(await processImage(file, size, { x: mid.x, y: mid.y, zoom })); }
    catch (ex) { setErr(ex.message); setBusy(false); }
  }

  return (
    <Modal title={title} onClose={onCancel}>
      <div className="crop">
        <p className="muted small">Drag the picture to move it. Use the slider to zoom. Only what is inside the frame is kept.</p>
        {view && (
          <div
            ref={box}
            className={'crop-window ' + shape}
            style={{ width: view.w, height: view.h }}
            tabIndex={0}
            role="img"
            aria-label="Crop area. Arrow keys move the picture, plus and minus zoom."
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}
          >
            <img
              src={url} alt="" draggable={false}
              onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              onError={() => setErr("Couldn't read that image")}
              style={geo ? { width: geo.w, height: geo.h, transform: `translate(${left}px, ${top}px)` } : { visibility: 'hidden' }}
            />
            <span className="crop-grid" aria-hidden="true" />
          </div>
        )}
        <label className="crop-zoom">
          <span className="muted small">Zoom</span>
          <input type="range" min="1" max={MAX_ZOOM} step="0.01" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom" />
        </label>
        {err && <p className="error-text" role="alert">{err}</p>}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={apply} disabled={busy || !geo}>{busy ? 'Applying…' : 'Apply'}</button>
        </div>
      </div>
    </Modal>
  );
}
