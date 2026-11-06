import React, { Children, Fragment, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Aduna's own versions of the browser's built-in controls, so nothing in the app falls back to a default look.
//   <Select>         replaces <select>                (same props and <option> children; onChange gets { target: { value } } like a real event)
//   <DateTimeInput>  replaces <input type="datetime-local">   (value and onChange(e.target.value) use the same "YYYY-MM-DDTHH:mm" text)
//   <ColorInput>     replaces <input type="color">            (value and onChange(e.target.value) use the same "#rrggbb" text)
// The popups are drawn on document.body, so a modal or a scrolling panel never clips them.

const clamp = (n, a = 0, b = 1) => Math.min(b, Math.max(a, n));
const pad = (n) => String(n).padStart(2, '0');
const noop = () => {};
const fire = (value, name) => ({ target: { value, name }, currentTarget: { value, name } });

// ---------- the popup ----------
function Popover({ anchor, onClose, className = '', children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const place = useCallback(() => {
    const a = anchor.current, p = ref.current;
    if (!a || !p) return;
    const r = a.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const below = vh - r.bottom - 10, above = r.top - 10;
    const want = Math.min(p.scrollHeight, 320);
    const up = below < want && above > below;
    const w = Math.max(p.offsetWidth, r.width);
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    setPos({ left, top: up ? undefined : r.bottom + 4, bottom: up ? vh - r.top + 4 : undefined, minWidth: r.width, maxHeight: Math.max(140, up ? above : below) });
  }, [anchor]);
  useLayoutEffect(() => { place(); }, [place]);
  useEffect(() => {
    const down = (e) => {
      if (ref.current && ref.current.contains(e.target)) return;
      if (anchor.current && anchor.current.contains(e.target)) return;
      onClose();
    };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const move = (e) => { if (!(ref.current && ref.current.contains(e.target))) place(); };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', move, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', move, true);
    };
  }, [anchor, onClose, place]);
  return createPortal(
    <div ref={ref} className={'cx-pop ' + className} style={{ ...(pos || {}), visibility: pos ? 'visible' : 'hidden' }}>
      {children}
    </div>,
    document.body,
  );
}

const Chevron = () => <svg className="cx-chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.500 4.500 6 8l3.500-3.500" /></svg>;

// ---------- Select ----------
const textOf = (n) => (n == null || typeof n === 'boolean' ? '' : Array.isArray(n) ? n.map(textOf).join('') : typeof n === 'object' ? textOf(n.props && n.props.children) : String(n));
function readOptions(children, out = [], group = '') {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    if (c.type === Fragment) readOptions(c.props.children, out, group);
    else if (c.type === 'optgroup') readOptions(c.props.children, out, c.props.label || '');
    else if (c.type === 'option') {
      const label = textOf(c.props.children);
      out.push({ value: c.props.value !== undefined ? String(c.props.value) : label, label, disabled: !!c.props.disabled, group });
    }
  });
  return out;
}

export function Select({ value, onChange, children, className = '', disabled, id, style, name, title, 'aria-label': ariaLabel, autoFocus }) {
  const opts = readOptions(children);
  const cur = String(value == null ? '' : value);
  const sel = opts.find((o) => o.value === cur) || opts[0];
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const btn = useRef(null);
  const list = useRef(null);
  const typed = useRef({ s: '', t: 0 });
  const listId = useId();
  const close = useCallback(() => setOpen(false), []);

  const openList = () => { if (disabled || !opts.length) return; setHi(Math.max(0, opts.findIndex((o) => o.value === cur))); setOpen(true); };
  const pick = (o) => {
    if (!o || o.disabled) return;
    setOpen(false);
    if (btn.current) btn.current.focus();
    if (o.value !== cur && onChange) onChange(fire(o.value, name));
  };
  const step = (d, from = hi) => {
    let i = from;
    for (let n = 0; n < opts.length; n++) { i = (i + d + opts.length) % opts.length; if (!opts[i].disabled) break; }
    setHi(i);
  };
  const onKey = (e) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openList(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Home') { e.preventDefault(); step(1, -1); }
    else if (e.key === 'End') { e.preventDefault(); step(-1, 0); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(opts[hi]); }
    else if (e.key === 'Tab') setOpen(false);
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = typed.current, now = Date.now();
      t.s = (now - t.t > 700 ? '' : t.s) + e.key.toLowerCase(); t.t = now;
      const i = opts.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(t.s));
      if (i >= 0) setHi(i);
    }
  };
  useEffect(() => {
    if (!open || !list.current) return;
    const el = list.current.querySelector('[data-i="' + hi + '"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [open, hi]);

  let lastGroup = '';
  return (
    <>
      <button ref={btn} type="button" id={id} className={'cx-select ' + className} style={style} disabled={disabled} title={title} autoFocus={autoFocus}
        aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        onClick={() => (open ? setOpen(false) : openList())} onKeyDown={onKey}>
        <span className="cx-select-label">{sel ? sel.label : ''}</span>
        <Chevron />
      </button>
      {open && (
        <Popover anchor={btn} onClose={close} className="cx-list">
          <ul ref={list} id={listId} role="listbox" aria-label={ariaLabel} onMouseDown={(e) => e.preventDefault()}>
            {opts.map((o, i) => {
              const head = o.group && o.group !== lastGroup ? <li key={'g' + i} role="presentation" className="cx-group">{o.group}</li> : null;
              lastGroup = o.group;
              return (
                <Fragment key={i}>
                  {head}
                  <li role="option" data-i={i} aria-selected={o.value === cur} aria-disabled={o.disabled || undefined}
                    className={'cx-opt' + (o.value === cur ? ' on' : '') + (i === hi ? ' hi' : '') + (o.disabled ? ' off' : '')}
                    onPointerEnter={() => { if (!o.disabled) setHi(i); }} onClick={() => pick(o)}>
                    <span>{o.label}</span>
                    {o.value === cur && <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.500 7.500 5.500 10.500 11.500 3.500" /></svg>}
                  </li>
                </Fragment>
              );
            })}
          </ul>
        </Popover>
      )}
    </>
  );
}

// ---------- DateTimeInput ----------
const parseDT = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || '');
  return m ? { y: +m[1], mo: +m[2] - 1, d: +m[3], h: +m[4], mi: +m[5] } : null;
};
const fmtDT = (p) => `${p.y}-${pad(p.mo + 1)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
const H12 = (() => { try { return new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions().hour12 !== false; } catch { return false; } })();
const nowParts = () => { const n = new Date(); return { y: n.getFullYear(), mo: n.getMonth(), d: n.getDate(), h: n.getHours(), mi: Math.ceil(n.getMinutes() / 5) * 5 % 60 }; };

function TimeField({ label, value, min, max, onCommit }) {
  const [txt, setTxt] = useState(pad(value));
  useEffect(() => { setTxt(pad(value)); }, [value]);
  const commit = (n) => { const v = clamp(Number.isFinite(n) ? n : value, min, max); setTxt(pad(v)); if (v !== value) onCommit(v); };
  return (
    <div className="cx-tf">
      <button type="button" tabIndex={-1} aria-label={'More ' + label} onClick={() => commit(value >= max ? min : value + 1)}>▲</button>
      <input value={txt} inputMode="numeric" aria-label={label} onFocus={(e) => e.target.select()}
        onChange={(e) => setTxt(e.target.value.replace(/\D/g, '').slice(0, 2))}
        onBlur={() => commit(parseInt(txt, 10))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(parseInt(txt, 10)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); commit(value >= max ? min : value + 1); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); commit(value <= min ? max : value - 1); }
        }} />
      <button type="button" tabIndex={-1} aria-label={'Less ' + label} onClick={() => commit(value <= min ? max : value - 1)}>▼</button>
    </div>
  );
}

function CalendarPanel({ value, onPick, onClose, required }) {
  const have = parseDT(value);
  const base = have || nowParts();
  const [view, setView] = useState({ y: base.y, mo: base.mo });
  const monthName = new Date(view.y, view.mo, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
  const first = new Date(view.y, view.mo, 1).getDay();
  const days = new Date(view.y, view.mo + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  const wk = Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + i).toLocaleDateString([], { weekday: 'narrow' }));
  const today = new Date();
  const isToday = (d) => d && view.y === today.getFullYear() && view.mo === today.getMonth() && d === today.getDate();
  const shift = (n) => setView((v) => { const t = new Date(v.y, v.mo + n, 1); return { y: t.getFullYear(), mo: t.getMonth() }; });
  const setDay = (d) => onPick({ ...base, y: view.y, mo: view.mo, d });
  const setTime = (patch) => onPick({ ...base, ...patch });
  const pm = base.h >= 12;
  const h12 = base.h % 12 === 0 ? 12 : base.h % 12;
  return (
    <div className="cx-cal">
      <div className="cx-cal-head">
        <button type="button" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
        <b>{monthName}</b>
        <button type="button" onClick={() => shift(1)} aria-label="Next month">›</button>
      </div>
      <div className="cx-cal-grid" role="grid">
        {wk.map((w, i) => <span key={'w' + i} className="cx-wk">{w}</span>)}
        {cells.map((d, i) => (d
          ? <button key={i} type="button" className={'cx-day' + (have && have.y === view.y && have.mo === view.mo && have.d === d ? ' on' : '') + (isToday(d) ? ' today' : '')} onClick={() => setDay(d)}>{d}</button>
          : <span key={i} />))}
      </div>
      <div className="cx-time">
        <span className="cx-time-l">Time</span>
        {H12
          ? <TimeField label="Hour" value={h12} min={1} max={12} onCommit={(v) => setTime({ h: (v % 12) + (pm ? 12 : 0) })} />
          : <TimeField label="Hour" value={base.h} min={0} max={23} onCommit={(v) => setTime({ h: v })} />}
        <b>:</b>
        <TimeField label="Minute" value={base.mi} min={0} max={59} onCommit={(v) => setTime({ mi: v })} />
        {H12 && (
          <div className="cx-ampm" role="group" aria-label="AM or PM">
            <button type="button" className={!pm ? 'on' : ''} onClick={() => pm && setTime({ h: base.h - 12 })}>AM</button>
            <button type="button" className={pm ? 'on' : ''} onClick={() => !pm && setTime({ h: base.h + 12 })}>PM</button>
          </div>
        )}
      </div>
      <div className="cx-foot">
        {!required && have ? <button type="button" className="cx-link" onClick={() => { onPick(null); onClose(); }}>Clear</button> : <span />}
        <button type="button" className="cx-link" onClick={() => { const n = nowParts(); onPick({ ...n }); setView({ y: n.y, mo: n.mo }); }}>Now</button>
        <button type="button" className="cx-done" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

export function DateTimeInput({ value, onChange, className = '', id, style, disabled, required, 'aria-label': ariaLabel, title }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  const p = parseDT(value);
  const shown = p ? new Date(p.y, p.mo, p.d, p.h, p.mi).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const emit = (np) => onChange && onChange(fire(np ? fmtDT(np) : ''));
  return (
    <>
      <button ref={btn} type="button" id={id} className={'cx-select cx-date ' + className} style={style} disabled={disabled} title={title} aria-label={ariaLabel}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={'cx-select-label' + (shown ? '' : ' cx-empty')}>{shown || 'Pick a date and time'}</span>
        <svg className="cx-chev" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2" /><path d="M2 6.500h12M5.500 1.500v3M10.500 1.500v3" /></svg>
      </button>
      {required && <input className="cx-req" tabIndex={-1} aria-hidden="true" required value={value || ''} onChange={noop} />}
      {open && <Popover anchor={btn} onClose={close} className="cx-dialog"><CalendarPanel value={value} onPick={emit} onClose={close} required={required} /></Popover>}
    </>
  );
}

// ---------- ColorInput ----------
const hexToRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, max ? d / max : 0, max];
}
function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
const PRESETS = ['#e8743b', '#e5484d', '#f5a524', '#f2d14c', '#3fb950', '#2dd4bf', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#ffffff', '#9ca3af', '#374151', '#000000'];

function drag(el, fn) {
  return (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* not supported: moves still arrive while over the box */ }
    const go = (ev) => { const r = el.getBoundingClientRect(); fn(clamp((ev.clientX - r.left) / r.width), clamp((ev.clientY - r.top) / r.height)); };
    go(e);
    const up = () => { el.removeEventListener('pointermove', go); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', go); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
}

function ColorPanel({ value, onPick }) {
  const start = hexToRgb(value) || [0, 0, 0];
  const [hsv, setHsv] = useState(() => rgbToHsv(...start));
  const [hex, setHex] = useState(() => rgbToHex(...start));
  const last = useRef(rgbToHex(...start));
  const sv = useRef(null), hue = useRef(null);
  useEffect(() => {
    const rgb = hexToRgb(value);
    if (rgb && rgbToHex(...rgb) !== last.current) { last.current = rgbToHex(...rgb); setHsv(rgbToHsv(...rgb)); setHex(last.current); }
  }, [value]);
  const apply = (n) => { setHsv(n); const h = rgbToHex(...hsvToRgb(...n)); last.current = h; setHex(h); onPick(h); };
  const [h, s, v] = hsv;
  const typeHex = (t) => {
    setHex(t);
    const rgb = hexToRgb(t.startsWith('#') ? t : '#' + t);
    if (rgb) { const n = rgbToHsv(...rgb); last.current = rgbToHex(...rgb); setHsv(n[1] === 0 || n[2] === 0 ? [h, n[1], n[2]] : n); onPick(last.current); }
  };
  const nudge = (e, fn) => {
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (k) { e.preventDefault(); fn(k[0], k[1]); }
  };
  return (
    <div className="cx-color-panel">
      <div ref={sv} className="cx-sv" style={{ '--hue': `hsl(${h} 100% 50%)` }} tabIndex={0} role="slider" aria-label="Saturation and brightness"
        aria-valuetext={`Saturation ${Math.round(s * 100)}%, brightness ${Math.round(v * 100)}%`}
        onPointerDown={(e) => drag(sv.current, (x, y) => apply([h, x, 1 - y]))(e)}
        onKeyDown={(e) => nudge(e, (dx, dy) => apply([h, clamp(s + dx * 0.03), clamp(v - dy * 0.03)]))}>
        <i style={{ left: s * 100 + '%', top: (1 - v) * 100 + '%' }} />
      </div>
      <div ref={hue} className="cx-hue" tabIndex={0} role="slider" aria-label="Hue" aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(h)}
        onPointerDown={(e) => drag(hue.current, (x) => apply([x * 359.9, s, v]))(e)}
        onKeyDown={(e) => nudge(e, (dx) => apply([(h + dx * 6 + 360) % 360, s, v]))}>
        <i style={{ left: (h / 360) * 100 + '%' }} />
      </div>
      <div className="cx-hexrow">
        <span className="cx-chip" style={{ background: hex }} />
        <input value={hex} maxLength={7} spellCheck={false} aria-label="Hex colour" onChange={(e) => typeHex(e.target.value)} onBlur={() => setHex(last.current)} />
      </div>
      <div className="cx-presets">
        {PRESETS.map((c) => <button key={c} type="button" className={c === hex.toLowerCase() ? 'on' : ''} style={{ background: c }} aria-label={'Use ' + c} onClick={() => { const n = rgbToHsv(...hexToRgb(c)); last.current = c; setHex(c); setHsv(n[1] === 0 || n[2] === 0 ? [h, n[1], n[2]] : n); onPick(c); }} />)}
      </div>
    </div>
  );
}

export function ColorInput({ value, onChange, className = '', id, style, disabled, 'aria-label': ariaLabel, title }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  const rgb = hexToRgb(value);
  const col = rgb ? rgbToHex(...rgb) : '#000000';
  return (
    <>
      <button ref={btn} type="button" id={id} className={'cx-color ' + className} style={{ ...style, background: col }} disabled={disabled} title={title}
        aria-label={ariaLabel || 'Choose a colour'} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      {open && <Popover anchor={btn} onClose={close} className="cx-dialog"><ColorPanel value={col} onPick={(h) => onChange && onChange(fire(h))} /></Popover>}
    </>
  );
}
