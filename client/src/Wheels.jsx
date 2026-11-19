import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DateTimeInput } from './Controls.jsx';
import { fromInput, toInput } from './gatherings.js';
import { Icon, Modal } from './ui.jsx';

// Spin the wheel on channel messages (rules and storage: server/wheels.js). The poster picks the options and the time. The server picks the
// winner when that time comes and sends the finished wheel to everyone in the channel as `wheel:update`. A card that is on screen at that moment
// plays the spin; anyone who opens the channel later just sees where it stopped.

const MAX_OPTIONS = 500, MAX_TITLE = 200, MAX_OPTION = 100, MAX_DAYS = 30;
const SPIN_MS = 6000, TURNS = 5, LABELS_UNTIL = 24, STROKES_UNTIL = 60;
const R = 96;
const SOON = [['In 5 min', 5], ['In 30 min', 30], ['In 1 hour', 60], ['Tomorrow', 1440]];

const clean = (s) => s.replace(/\s+/g, ' ').trim();

function timeLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ' + (s % 60) + ' s';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  const d = Math.floor(h / 24);
  return d + ' d' + (h % 24 ? ' ' + (h % 24) + ' h' : '');
}
const whenLabel = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// Angles run clockwise from the top, where the pointer is. Slice i covers [i, i + 1) steps.
const point = (deg, r) => { const a = (deg * Math.PI) / 180; return [(r * Math.sin(a)).toFixed(2), (-r * Math.cos(a)).toFixed(2)]; };
function slicePath(i, n) {
  const step = 360 / n;
  const [x0, y0] = point(i * step, R), [x1, y1] = point((i + 1) * step, R);
  return `M0 0L${x0} ${y0}A${R} ${R} 0 ${step > 180 ? 1 : 0} 1 ${x1} ${y1}Z`;
}
const sliceColor = (i) => `hsl(${Math.round((i * 137.5) % 360)} 58% ${i % 2 ? 40 : 46}%)`;

// Where the wheel rests with the winner under the pointer. The small offset comes from the message id so every viewer sees the same stop.
function restAngle(winner, n, id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const offset = ((h % 1000) / 1000) * 0.7 - 0.35;
  return -(winner + 0.5 + offset) * (360 / n);
}

export function WheelCard({ m }) {
  const wheel = m.wheel;
  const n = wheel.options.length;
  const spun = wheel.spunAt !== null && wheel.winner !== null;
  const [, tick] = useState(0);
  const [turning, setTurning] = useState(false);
  const [angle, setAngle] = useState(() => (spun ? restAngle(wheel.winner, n, m.id) : 0));
  const [listOpen, setListOpen] = useState(false);
  const played = useRef(spun); // a wheel that had already stopped when the card first showed has no spin to play
  const timer = useRef(0);
  const left = wheel.spinAt - Date.now();
  const far = left > 3600_000;

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (spun) return undefined;
    const t = setInterval(() => tick((x) => x + 1), far ? 30_000 : 1000);
    return () => clearInterval(t);
  }, [spun, far]);
  useEffect(() => {
    if (!spun || played.current) return;
    played.current = true;
    const rest = restAngle(wheel.winner, n, m.id);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setAngle(rest); return; }
    setTurning(true);
    setAngle(rest + 360 * TURNS);
    timer.current = setTimeout(() => setTurning(false), SPIN_MS + 200);
  }, [spun, wheel.winner, n, m.id]);

  const playing = turning || (spun && !played.current); // the second part covers the render before the effect above starts the spin
  const done = spun && !playing;

  const slices = useMemo(() => {
    const step = 360 / n;
    const size = Math.min(9, 220 / n);
    const fit = Math.max(4, Math.floor(58 / (size * 0.56)));
    const stroke = n <= STROKES_UNTIL;
    return wheel.options.map((o, i) => (
      <g key={i}>
        <path d={slicePath(i, n)} fill={sliceColor(i)} stroke={stroke ? 'rgba(0,0,0,.25)' : 'none'} strokeWidth=".6" />
        {n <= LABELS_UNTIL && (
          <text className="wheel-label" transform={`rotate(${(i + 0.5) * step - 90})`} x="88" y="0" textAnchor="end" dominantBaseline="central" fontSize={size}>
            {o.length > fit ? o.slice(0, fit - 1) + '\u2026' : o}
          </text>
        )}
      </g>
    ));
  }, [wheel.options, n]);

  const status = spun ? (playing ? 'Spinning\u2026' : 'Spun ' + whenLabel(wheel.spunAt))
    : left > 0 ? 'Spins in ' + timeLeft(left) + ' \u00b7 ' + whenLabel(wheel.spinAt)
      : left > -20_000 ? 'Spinning\u2026' : 'Waiting for the result\u2026';

  return (
    <div className={'poll wheel' + (done ? ' ended' : '')}>
      <div className="poll-q"><Icon name="wheel" size={16} className="inline-icon" /> {wheel.title}</div>
      <div className="poll-sub muted small" aria-live="polite">{status}</div>
      <div className="wheel-stage">
        <div className="wheel-pointer" aria-hidden="true" />
        <div className="wheel-disc" style={{ transform: `rotate(${angle}deg)`, transition: turning ? `transform ${SPIN_MS}ms cubic-bezier(.12,.62,.12,1)` : 'none' }}>
          <svg viewBox="-100 -100 200 200" role="img" aria-label={`Wheel with ${n} options`}>
            {slices}
            {done && <path d={slicePath(wheel.winner, n)} className="wheel-win" />}
            <circle r={R} fill="none" stroke="rgba(0,0,0,.35)" strokeWidth="1.2" />
          </svg>
        </div>
        <div className="wheel-hub" aria-hidden="true" />
      </div>
      {done && <div className="wheel-result"><Icon name="crown" size={16} className="inline-icon" /> <b>{wheel.options[wheel.winner]}</b> won</div>}
      <details className="wheel-all" onToggle={(e) => setListOpen(e.currentTarget.open)}>
        <summary className="muted small">{n} options</summary>
        {listOpen && <ol className="wheel-list">{wheel.options.map((o, i) => <li key={i} className={done && i === wheel.winner ? 'win' : ''}>{o}</li>)}</ol>}
      </details>
    </div>
  );
}

export function WheelModal({ onSubmit, onClose }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [when, setWhen] = useState(() => toInput(Date.now() + 3600_000));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const options = text.split('\n').map(clean).filter(Boolean);
  const at = fromInput(when);
  const timeOk = Number.isFinite(at) && at > Date.now() + 10_000 && at < Date.now() + MAX_DAYS * 86400_000;
  const tooLong = options.some((o) => o.length > MAX_OPTION);
  const ready = clean(title) && options.length >= 2 && options.length <= MAX_OPTIONS && !tooLong && timeOk && !busy;

  async function submit(e) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setErr('');
    try { await onSubmit({ title: clean(title), options, spinAt: at }); onClose(); }
    catch (ex) { setErr(ex.message || 'Could not post the wheel'); setBusy(false); }
  }

  return (
    <Modal title="Spin the wheel" onClose={onClose}>
      <form onSubmit={submit}>
        <label>TITLE</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={MAX_TITLE} placeholder="Who picks the game?" />
        <label>OPTIONS</label>
        <textarea className="wheel-opts" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={'One option per line\nAnn\nBen\nCy'} aria-label="Options, one per line" />
        <p className={'hint' + (tooLong || options.length > MAX_OPTIONS ? ' error-text' : '')}>
          {options.length} {options.length === 1 ? 'option' : 'options'}
          {options.length < 2 && ' \u00b7 add at least 2'}
          {options.length > MAX_OPTIONS && ` \u00b7 at most ${MAX_OPTIONS}`}
          {tooLong && ` \u00b7 each option can be up to ${MAX_OPTION} characters`}
        </p>
        <label>SPINS AT</label>
        <DateTimeInput value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Spin time" required />
        <div className="wheel-soon">
          {SOON.map(([t, min]) => <button type="button" key={t} className="btn small-btn" onClick={() => setWhen(toInput(Date.now() + min * 60_000))}>{t}</button>)}
        </div>
        {!timeOk && <p className="error-text small">{`Pick a time in the future, up to ${MAX_DAYS} days away.`}</p>}
        <p className="hint">The wheel spins on its own at that time and the winner is picked then, so nobody knows it beforehand. Everyone in the channel sees the result.</p>
        {err && <div className="error">{err}</div>}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ready}>{busy ? 'Posting\u2026' : 'Post wheel'}</button>
        </div>
      </form>
    </Modal>
  );
}
