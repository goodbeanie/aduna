import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './ui.jsx';

// The server bar's scrolling list. A mouse wheel scrolls it sideways (it is a horizontal bar, and the scrollbar is hidden),
// and a soft fade on an edge shows there are more servers that way.
export function RailList({ children }) {
  const ref = useRef(null);
  const [fade, setFade] = useState({ l: false, r: false });
  const sync = useRef(() => {});
  sync.current = () => {
    const el = ref.current;
    if (!el) return;
    const l = el.scrollLeft > 2, r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setFade((f) => (f.l === l && f.r === r ? f : { l, r }));
  };
  useEffect(() => { sync.current(); }); // servers added or removed change the width without a scroll or resize
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onScroll = () => sync.current();
    const onWheel = (e) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; // nothing to scroll, or already a sideways gesture
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onScroll);
    return () => { el.removeEventListener('scroll', onScroll); el.removeEventListener('wheel', onWheel); window.removeEventListener('resize', onScroll); };
  }, []);
  return <div className={'rail-list' + (fade.l ? ' fade-l' : '') + (fade.r ? ' fade-r' : '')} ref={ref}>{children}</div>;
}

// A dropdown that closes on a click or tap outside it, on Escape, and when the pointer leaves it.
// `ignore` is a selector for the button that opens it, so pressing that button again toggles instead of closing and reopening.
export function PopMenu({ onClose, ignore = '.side-head', className = 'menu', children }) {
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const away = (e) => {
      if (!ref.current || ref.current.contains(e.target)) return;
      if (ignore && e.target.closest?.(ignore)) return;
      close.current();
    };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close.current(); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key); };
  }, [ignore]);
  return <div className={className} ref={ref} role="menu" onMouseLeave={() => close.current()}>{children}</div>;
}

// ---------- empty states and loading skeletons ----------
// A small icon, a line saying what this place is, an optional hint, and an optional button.
export function EmptyState({ icon, title, children, action, compact }) {
  return (
    <div className={'empty-state' + (compact ? ' compact' : '')}>
      <span className="empty-ico"><Icon name={icon} size={compact ? 20 : 26} /></span>
      <h4>{title}</h4>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

// Grey placeholder rows (a round picture and one or two lines) for a list that is still on its way: friends, members.
const SKEL_WIDTHS = [62, 48, 74, 40, 68, 55, 70, 45];
export function ListSkeleton({ rows = 6, avatar = 36, lines = 1, label = 'Loading' }) {
  return (
    <div className="skel-rows" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div className="skel-row" key={i} aria-hidden="true">
          <span className="skel skel-circle" style={{ width: avatar, height: avatar }} />
          <div className="skel-body">
            {Array.from({ length: lines }, (_, j) => <span key={j} className="skel skel-line" style={{ width: (j ? 36 : SKEL_WIDTHS[i % SKEL_WIDTHS.length]) + '%' }} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- tooltips ----------
// Replaces the browser's own title bubble on the server bar and on icon buttons: the same text, drawn by us, with an optional shortcut
// hint (data-kbd="Ctrl+F"). Anything with data-tip gets one too. Mouse and keyboard focus only: a tap on a phone must not leave one behind.
const TIP_SEL = '[data-tip], .rail-btn[title], .icon-btn[title], .toolbar button[title], .credit-chip[title], .send-btn[title]';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
export const kbd = (key) => (isMac ? '\u2318' + key : 'Ctrl+' + key); // the hint for "Ctrl + key" (Command on a Mac)
const savedTitles = new WeakMap(); // while a tooltip is pending or up, the element's title is taken off (so the browser shows nothing) and kept here

export function Tooltips() {
  const [tip, setTip] = useState(null); // { el, text, keys }
  const box = useRef(null);

  useEffect(() => {
    const s = { el: null, timer: 0, visible: false, shown: 0 };
    const give = (el) => { // put the title back, unless React has already written a new one
      const t = savedTitles.get(el);
      if (t === undefined) return;
      if (!el.hasAttribute('title')) el.setAttribute('title', t);
      savedTitles.delete(el);
    };
    const hide = () => {
      clearTimeout(s.timer);
      if (s.el) { give(s.el); s.el = null; }
      if (s.visible) { s.visible = false; s.shown = Date.now(); }
      setTip(null);
    };
    const start = (el, delay) => {
      hide();
      let text = el.getAttribute('data-tip');
      const title = el.getAttribute('title');
      if (title) { // take the browser's own bubble away at once, before it can appear
        savedTitles.set(el, title);
        el.removeAttribute('title');
        if (!el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', title); // the button keeps its name for screen readers
        if (text == null) text = title;
      }
      s.el = el;
      if (!text) return;
      s.timer = setTimeout(() => {
        if (s.el !== el || !el.isConnected) return;
        s.visible = true;
        setTip({ el, text, keys: el.getAttribute('data-kbd') || '' });
      }, delay);
    };
    const onOver = (e) => {
      if (e.pointerType !== 'mouse') return;
      const el = e.target.closest?.(TIP_SEL) || null;
      if (el === s.el) return;
      if (!el) return hide();
      start(el, Date.now() - s.shown < 400 ? 0 : 450); // right away when moving from one button to the next
    };
    const onFocus = (e) => { const el = e.target.closest?.(TIP_SEL); if (el && e.target.matches?.(':focus-visible')) start(el, 0); };
    const gone = setInterval(() => { if (s.el && !s.el.isConnected) hide(); }, 500); // the button left the page while its tooltip was up
    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', hide, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    document.addEventListener('wheel', hide, { capture: true, passive: true });
    document.addEventListener('scroll', hide, true);
    document.documentElement.addEventListener('pointerleave', hide);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      clearInterval(gone);
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', hide, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      document.removeEventListener('wheel', hide, true);
      document.removeEventListener('scroll', hide, true);
      document.documentElement.removeEventListener('pointerleave', hide);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
      hide();
    };
  }, []);

  // below the button, or above it when there is no room; kept inside the window
  useLayoutEffect(() => {
    const b = box.current;
    if (!tip || !b) return;
    const r = tip.el.getBoundingClientRect(), w = b.offsetWidth, h = b.offsetHeight;
    const below = r.bottom + 8 + h <= window.innerHeight - 8;
    b.style.top = Math.max(8, below ? r.bottom + 8 : r.top - h - 8) + 'px';
    b.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)) + 'px';
    b.dataset.place = below ? 'below' : 'above';
    b.style.visibility = 'visible';
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div className="tip" role="tooltip" ref={box} style={{ visibility: 'hidden' }}>
      <span>{tip.text}</span>
      {tip.keys && <span className="tip-keys">{tip.keys.split('+').map((k) => <kbd key={k}>{k}</kbd>)}</span>}
    </div>,
    document.body,
  );
}
