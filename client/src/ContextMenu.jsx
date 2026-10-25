import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './ui.jsx';

// One right-click menu for the whole app. A screen asks for it with `open(event, { header, items })`:
//   header  optional: anything to show at the top (a picture and a name, say)
//   items   a list of { label, icon, onClick, danger, disabled } and 'sep' for a divider. Anything falsy is skipped, so
//           `canDelete && { ... }` works, and dividers that would sit first, last or twice in a row are dropped.
// It closes on Escape, a click or tap elsewhere, scrolling, resizing and Tab; arrow keys move between items.
// On a touch screen a long press sends the same "contextmenu" event, so it works there too.
const Ctx = createContext({ open: () => {}, copy: () => {}, flash: () => {} });
export const useContextMenu = () => useContext(Ctx);

// Places where the browser's own menu is the more useful one (open a link, save a picture, edit text), so we leave it alone.
// Custom emoji pictures are not in the list: those belong to the message.
const NATIVE = 'a[href], input, textarea, select, video, audio, [contenteditable="true"], img:not(.cemoji)';
export function wantsNative(e) {
  if (e.target?.closest?.(NATIVE)) return true;
  const sel = window.getSelection?.();
  return !!sel && !sel.isCollapsed && !!String(sel).trim() && !!e.currentTarget?.contains?.(sel.anchorNode); // text is selected here: let them copy it
}

async function writeClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through to the old way */ }
  try {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(t); t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  } catch { return false; }
}

const tidy = (items) => {
  const out = [];
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') { if (out.length && out[out.length - 1] !== 'sep') out.push('sep'); continue; }
    out.push(it);
  }
  while (out[out.length - 1] === 'sep') out.pop();
  return out;
};

function Menu({ menu, close }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  // Measure, then keep the menu on screen: flip to the left of / above the pointer when it would run off the edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, m = 8;
    let left = menu.x, top = menu.y;
    if (left + width > vw - m) left = Math.max(m, menu.x - width);
    if (top + height > vh - m) top = menu.y - height >= m ? menu.y - height : Math.max(m, vh - height - m);
    setPos({ left, top });
  }, [menu]);

  // Focus only once the menu is visible: a hidden element can't take focus, so doing it during the measuring pass did nothing.
  useEffect(() => {
    if (pos) ref.current?.focus({ preventScroll: true }); // so the arrow keys work right away
  }, [pos]);

  useEffect(() => {
    const inside = (e) => !!ref.current && ref.current.contains(e.target);
    const away = (e) => { if (!inside(e)) close(); };
    const gesture = (e) => { if (!inside(e)) close(); }; // wheel / touch scrolling elsewhere
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'Tab') { close(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !ref.current) return;
      const btns = [...ref.current.querySelectorAll('button:not(:disabled)')];
      if (!btns.length) return;
      e.preventDefault();
      const i = btns.indexOf(document.activeElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : e.key === 'ArrowDown' ? (i + 1) % btns.length : (i <= 0 ? btns.length - 1 : i - 1);
      btns[next].focus();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('wheel', gesture, { passive: true });
    window.addEventListener('touchmove', gesture, { passive: true });
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('wheel', gesture);
      window.removeEventListener('touchmove', gesture);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [close]);

  const run = (it) => { close(); it.onClick?.(); };
  return (
    <div className="cmenu" role="menu" ref={ref} tabIndex={-1} onContextMenu={(e) => e.preventDefault()}
      style={pos ? { left: pos.left, top: pos.top } : { left: menu.x, top: menu.y, visibility: 'hidden' }}>
      {menu.header && <div className="cmenu-head">{menu.header}</div>}
      {menu.items.map((it, i) => it === 'sep'
        ? <div key={'s' + i} className="cmenu-sep" role="separator" />
        : (
          <button key={i} type="button" role="menuitem" className={'cmenu-item' + (it.danger ? ' danger' : '')} disabled={it.disabled} onClick={() => run(it)}>
            {it.icon && <Icon name={it.icon} size={16} />}<span>{it.label}</span>
          </button>
        ))}
    </div>
  );
}

export function ContextMenuProvider({ children }) {
  const [menu, setMenu] = useState(null); // { id, x, y, header, items }
  const seq = useRef(0); // a new id per opening, so a menu opened over another starts fresh
  const [note, setNote] = useState('');
  const noteTimer = useRef(0);
  const close = useCallback(() => setMenu(null), []);

  const open = useCallback((e, spec) => {
    const items = tidy(spec.items || []);
    if (!items.length) return;
    e.preventDefault(); e.stopPropagation(); // ours replaces the browser's menu, and the innermost thing under the pointer wins
    setMenu({ id: ++seq.current, x: e.clientX, y: e.clientY, header: spec.header || null, items });
  }, []);

  const flash = useCallback((text) => {
    setNote(text);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 1800);
  }, []);
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  const copy = useCallback(async (text) => { flash((await writeClipboard(String(text))) ? 'Copied' : 'Could not copy'); }, [flash]);

  const value = useMemo(() => ({ open, copy, flash }), [open, copy, flash]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {menu && <Menu key={menu.id} menu={menu} close={close} />}
      {note && <div className="cmenu-toast" role="status">{note}</div>}
    </Ctx.Provider>
  );
}
