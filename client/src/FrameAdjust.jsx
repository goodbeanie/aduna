import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './ui.jsx';
import { FRAME_ZOOM, processFrame } from './image.js';
import { useLang } from './i18n.js';
import './cropper.css';

// Position, scale and rotate a profile frame picture before it is uploaded (Settings > Artist, a frame item).
// The outlined square is the 512 x 512 frame, and the window shows a bit more around it (dimmed, that part is cut off) so the whole picture can be seen.
// The dashed rounded square is where the profile picture sits (art drawn there shows over it); the blue band around it is where the ring goes.
// A sample profile picture sits under the art so the fit can be judged. Drag to move, slider / mouse wheel / + and - keys to scale, [ and ] keys to rotate,
// arrow keys to nudge, or type exact numbers. Scale 100% fits the whole picture in the square. Scale and rotation both work from the picture's middle.
// Nothing is uploaded here: onApply gets the finished 512px PNG (processFrame only refuses a picture with almost nothing in it).
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const VIEW = 1.5; // the window is this many frames wide
const FRAME_INSET = `${((1 - 1 / VIEW) / 2) * 100}%`;
const wrapTurn = (d) => ((d + 540) % 360) - 180;

// A number box that only applies what was typed when you leave it or press Enter, so a half-typed value is not clamped under your fingers.
function NumberField({ value, min, max, onCommit, label }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const v = parseFloat(text);
    if (!Number.isFinite(v)) { setText(String(value)); return; }
    const c = clamp(v, min, max);
    setText(String(c));
    onCommit(c);
  };
  return (
    <input
      type="text" inputMode="decimal" className="frame-num" value={text} aria-label={label}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
    />
  );
}

export default function FrameAdjust({ file, onApply, onCancel }) {
  const { t } = useLang();
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const [nat, setNat] = useState(null); // the picture's own size, once it has loaded
  const [view, setView] = useState(460); // size of the window on screen
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0); // degrees, -180 to 180
  const [pos, setPos] = useState({ x: 0, y: 0 }); // the picture's middle, as a share of the square (0 = centred)
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState(true); // a stand-in profile picture under the art
  const [err, setErr] = useState('');
  const drag = useRef(null);
  const box = useRef(null);
  const side = view / VIEW; // the frame's size on screen

  useEffect(() => {
    const fit = () => { const w = window.innerWidth; setView(w >= 800 ? 460 : Math.max(240, Math.min(460, w - 56))); };
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
  const left = geo ? view / 2 + pos.x * side - geo.w / 2 : 0;
  const top = geo ? view / 2 + pos.y * side - geo.h / 2 : 0;

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
  const turnBy = (d) => setRot((r) => wrapTurn(r + d));
  const key = (e) => {
    const step = e.shiftKey ? 30 : 10;
    if (e.key === 'ArrowLeft') nudge(-step, 0);
    else if (e.key === 'ArrowRight') nudge(step, 0);
    else if (e.key === 'ArrowUp') nudge(0, -step);
    else if (e.key === 'ArrowDown') nudge(0, step);
    else if (e.key === '+' || e.key === '=') zoomBy(1.1);
    else if (e.key === '-') zoomBy(1 / 1.1);
    else if (e.key === '[') turnBy(e.shiftKey ? -15 : -1);
    else if (e.key === ']') turnBy(e.shiftKey ? 15 : 1);
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
    try { onApply(await processFrame(file, { zoom, x: pos.x, y: pos.y, rotate: rot })); }
    catch (ex) { setErr(ex.message); setBusy(false); }
  }
  const reset = () => { setZoom(1); setRot(0); setPos({ x: 0, y: 0 }); setErr(''); };

  return (
    <Modal title="Position your frame" onClose={onCancel} wide>
      <div className="crop">
        <p className="muted small">Drag to move the picture, or type exact numbers for its position, scale and rotation. Your ring goes in the blue band. The dashed square is where the profile picture sits, and art drawn inside it shows over the picture. The darker area outside the frame gets cut off.</p>
        <div className="frame-layout">
          <div
            ref={box}
            className="crop-window frame-window"
            style={{ width: view, height: view, '--fi': FRAME_INSET, '--fs': `${side}px` }}
            tabIndex={0}
            role="img"
            aria-label={t('cropArea')}
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}
          >
            <span className="frame-under" aria-hidden="true">{sample && <span className="frame-sample">A</span>}</span>
            <img
              src={url} alt="" draggable={false}
              onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              onError={() => setErr(t('imgRead'))}
              style={geo ? { width: geo.w, height: geo.h, transform: `translate(${left}px, ${top}px) rotate(${rot}deg)` } : { visibility: 'hidden' }}
            />
            <span className="frame-over" aria-hidden="true"><span className="frame-hole" /></span>
          </div>
          <div className="frame-fields">
            <label className="frame-row">
              <span className="muted small">Scale</span>
              <input type="range" min={FRAME_ZOOM.min} max={FRAME_ZOOM.max} step="0.01" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Scale" />
              <NumberField value={Math.round(zoom * 100)} min={FRAME_ZOOM.min * 100} max={FRAME_ZOOM.max * 100} onCommit={(v) => setZoom(v / 100)} label="Scale in percent" />
              <span className="muted small">%</span>
            </label>
            <label className="frame-row">
              <span className="muted small">Rotation</span>
              <input type="range" min="-180" max="180" step="1" value={rot} onChange={(e) => setRot(Number(e.target.value))} aria-label="Rotation" />
              <NumberField value={Math.round(rot * 10) / 10} min={-180} max={180} onCommit={setRot} label="Rotation in degrees" />
              <span className="muted small">°</span>
            </label>
            <div className="frame-row frame-pos">
              <span className="muted small">Position</span>
              <span className="frame-xy"><span className="muted small">X</span><NumberField value={Math.round(pos.x * 100)} min={-50} max={50} onCommit={(v) => setPos((p) => keep({ ...p, x: v / 100 }))} label="Horizontal position in percent" /></span>
              <span className="frame-xy"><span className="muted small">Y</span><NumberField value={Math.round(pos.y * 100)} min={-50} max={50} onCommit={(v) => setPos((p) => keep({ ...p, y: v / 100 }))} label="Vertical position in percent" /></span>
            </div>
            <label className="row small" style={{ alignItems: 'center', gap: 8, alignSelf: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} />
              <span>Show a sample profile picture</span>
            </label>
          </div>
        </div>
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
