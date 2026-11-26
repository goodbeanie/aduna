import React, { useEffect, useRef, useState } from 'react';
import { Icon, Modal } from './ui.jsx';
import { ITEMS, QUICK_GAP, QUICK_GAP_MAX, SECTIONS, SLOT_NAME, canAlign, canHide, canSwitchOff, getPanels, itemOn, placePanel, quickOrder, sectionName, setPanels, setSection, slotOf, useLayoutAllowed, useOpts, usePanels, useLayoutScreen, usePhone } from './panels.js';

// Customize one section of the app (the server bar, side list, member list, profile and voice, Shortcuts, Unread): double-click an empty spot of it,
// or double-click (on a phone, tap) its part in Settings > Appearance > Layout (openSection). Where it sits, whether it is light or dark, whether its things sit left, middle or right,
// and which of its things show. Everything applies as it is changed and is kept on this device (panels.js: setSection, setPanels).
// On wide screens and phones, and only for the accounts that have the layout editor, like the rest of the layout.
export const openSection = (id) => window.dispatchEvent(new CustomEvent('aduna:section', { detail: id }));

// a double-click on any of these is their own business (a button, a field, a channel), not a request to customize
const OWN = 'button, a, input, textarea, select, label, summary, [role=button], [role=slider], [role=switch], [contenteditable=true], .chan, .member';

const ALIGN = [[null, 'Default'], ['start', 'Left'], ['center', 'Center'], ['end', 'Right']];
const SCHEME_OPTIONS = [[null, 'Match theme'], ['light', 'Light'], ['dark', 'Dark']];

function Seg({ value, options, onPick, label }) {
  return (
    <div className="so-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button type="button" key={String(v)} role="radio" aria-checked={value === v} className={'so-seg-btn' + (value === v ? ' on' : '')} onClick={() => onPick(v)}>{text}</button>
      ))}
    </div>
  );
}

// The Shortcuts in a row, in the order they come in: drag one to a new place (mouse or touch), or focus one and use the arrow keys.
// The ones that are switched off stay in the row (dimmed), so turning one on later puts it where it was left.
function QuickOrder({ opts }) {
  const [drag, setDrag] = useState(null); // { id, at } while one is being dragged: `at` is the gap it would drop into (0 to list.length)
  const strip = useRef(null);
  const order = quickOrder(opts);
  const byId = Object.fromEntries(ITEMS.quick.map((it) => [it.id, it]));
  const list = order.filter((sid) => byId[sid]);

  const move = (sid, to) => { // `to` counts in the row without the one being moved
    const rest = list.filter((x) => x !== sid);
    rest.splice(Math.max(0, Math.min(rest.length, to)), 0, sid);
    setSection('quick', { order: rest });
  };
  const gapAt = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-so-chip]');
    if (!el || !strip.current?.contains(el)) return null;
    const i = list.indexOf(el.getAttribute('data-so-chip'));
    if (i < 0) return null;
    const r = el.getBoundingClientRect();
    return e.clientX < r.left + r.width / 2 ? i : i + 1;
  };
  const down = (e, sid) => {
    if (e.button) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* the drag still works without it */ }
    setDrag({ id: sid, at: null });
  };
  const over = (e) => {
    if (!drag) return;
    const at = gapAt(e);
    if (at !== null && at !== drag.at) setDrag({ ...drag, at });
  };
  const drop = () => {
    if (drag && drag.at !== null) {
      const from = list.indexOf(drag.id);
      move(drag.id, drag.at > from ? drag.at - 1 : drag.at);
    }
    setDrag(null);
  };
  const key = (e, sid, i) => {
    const to = e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    move(sid, to);
    requestAnimationFrame(() => document.getElementById('so-chip-' + sid)?.focus()); // moving the element can drop focus
  };

  return (
    <div className="so-order" ref={strip} role="group" aria-label="Order of the shortcuts">
      {list.map((sid, i) => {
        const it = byId[sid];
        const dragging = drag?.id === sid;
        const cls = 'so-chip' + (itemOn(opts, 'quick', it) ? '' : ' off') + (dragging ? ' drag' : '') + (drag && drag.at === i ? ' before' : '') + (drag && drag.at === i + 1 ? ' after' : '');
        return (
          <div key={sid} id={'so-chip-' + sid} data-so-chip={sid} className={cls} role="button" tabIndex={0}
            aria-label={`${it.name}, number ${i + 1} of ${list.length}. Use the left and right arrow keys to move it.`}
            onPointerDown={(e) => down(e, sid)} onPointerMove={over} onPointerUp={drop} onPointerCancel={() => setDrag(null)} onKeyDown={(e) => key(e, sid, i)}>
            <Icon name={it.icon} size={16} /><span>{it.name}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function SectionOptions() {
  const allowed = useLayoutAllowed();
  const screen = useLayoutScreen();
  const phone = usePhone();
  const pan = usePanels();
  const opts = useOpts();
  const [id, setId] = useState(null);

  useEffect(() => {
    const open = (e) => { if (ITEMS[e.detail]) setId(e.detail); };
    const dbl = (e) => {
      if (!allowed || !screen || !(e.target instanceof Element) || e.target.closest(OWN)) return;
      const sid = e.target.closest('[data-panel]')?.getAttribute('data-panel');
      if (!sid || !ITEMS[sid]) return;
      window.getSelection?.()?.removeAllRanges(); // the double-click would otherwise leave a word selected
      setId(sid);
    };
    window.addEventListener('aduna:section', open);
    document.addEventListener('dblclick', dbl);
    return () => { window.removeEventListener('aduna:section', open); document.removeEventListener('dblclick', dbl); };
  }, [allowed, screen]);

  useEffect(() => { if (id && (!allowed || !screen)) setId(null); }, [id, allowed, screen]);
  if (!id || !allowed || !screen) return null;

  const section = SECTIONS.find((s) => s.id === id);
  const slot = slotOf(pan, id);
  // Where it can go. Hidden is here too (a phone can't drag a part into the Hidden box), unless that would leave no Settings button.
  // On a phone the side list is the list screen and the member list is a slide-over, so they stay where they are: the member list can only be shown or hidden.
  const places = (section?.where || []).filter((k) => !phone || !['side', 'members'].includes(id));
  if (phone && id === 'members') places.push(slot === 'off' ? 'right' : slot);
  if (slot === 'off' || (canHide(pan, opts, id) && !(phone && id === 'side'))) places.push('off');
  const placeLabel = (k) => (phone && id === 'members' && k !== 'off' ? 'Slide-over' : SLOT_NAME[k]);
  const list = ITEMS[id];
  const align = opts[id]?.align || null;
  const textOn = opts.quick?.text !== false;
  const iconsOn = opts.quick?.icons !== false;

  return (
    <div className="dlg-layer">{/* lifts the dialog above full-screen settings (dialogs.css), where it is opened from Appearance > Layout */}
    <Modal title={'Customize ' + sectionName(id).toLowerCase()} onClose={() => setId(null)} wide={id === 'quick'}>
      <div className="so">
        <p className="muted small">{section?.hint}. Changes apply at once and are kept on this device.</p>

        {places.length > 0 ? (
          <>
            <div className="so-label">PLACE IT</div>
            <Seg label="Where it sits" value={slot} options={places.map((k) => [k, placeLabel(k)])} onPick={(k) => setPanels(placePanel(getPanels(), id, k))} />
          </>
        ) : (
          <p className="muted small">On a phone the side list is the list screen, so it stays where it is.</p>
        )}

        <div className="so-label">COLOURS</div>
        <Seg label="Light or dark" value={opts[id]?.scheme || null} options={SCHEME_OPTIONS} onPick={(v) => setSection(id, { scheme: v })} />
        <p className="muted small">Light or dark for this part only, whatever theme the rest of the app is using.</p>
        {canAlign(id, slot) && (
          <>
            <div className="so-label">ALIGN ITS THINGS</div>
            <Seg label="Alignment" value={align} options={ALIGN} onPick={(v) => setSection(id, { align: v })} />
          </>
        )}

        {id === 'quick' && (
          <>
            <div className="so-label">SPACING</div>
            <div className="so-row">
              <input type="range" className="so-range" min="0" max={QUICK_GAP_MAX} step="2" value={opts.quick?.gap ?? QUICK_GAP} aria-label="Space between shortcuts" onChange={(e) => setSection('quick', { gap: Number(e.target.value) })} />
              <span className="so-val">{opts.quick?.gap ?? QUICK_GAP} px</span>
            </div>

            <div className="so-label">EACH SHORTCUT SHOWS</div>
            <div className="so-checks">
              <label className="so-check">
                <input type="checkbox" checked={textOn} disabled={textOn && !iconsOn} onChange={(e) => setSection('quick', { text: e.target.checked ? null : false })} />
                <span>Text</span>
              </label>
              <label className="so-check">
                <input type="checkbox" checked={iconsOn} disabled={iconsOn && !textOn} onChange={(e) => setSection('quick', { icons: e.target.checked ? null : false })} />
                <span>Icon</span>
              </label>
            </div>

            <div className="so-label">ORDER</div>
            <p className="muted small">Drag to put them in order, or select one and press the left and right arrow keys. Dimmed ones are switched off below.</p>
            <QuickOrder opts={opts} />
          </>
        )}

        <div className="so-label">SHOW</div>
        <div className="so-items">
          {list.map((it) => {
            const on = itemOn(opts, id, it);
            const locked = on && !canSwitchOff(pan, opts, id, it.id); // the last Settings button on screen stays
            return (
              <button type="button" key={it.id} role="switch" aria-checked={on} disabled={locked} title={locked ? 'Kept on so Settings is always within reach. Turn on Settings in the other part first.' : undefined} className={'so-item' + (on ? ' on' : '')} onClick={() => setSection(id, { items: { [it.id]: !on } })}>
                <span className="so-name">{it.name}</span>
                <span className="so-switch" aria-hidden="true" />
              </button>
            );
          })}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn" disabled={!opts[id]} onClick={() => setSection(id, null)}>Reset this part</button>
          <button type="button" className="btn primary" onClick={() => setId(null)}>Done</button>
        </div>
      </div>
    </Modal>
    </div>
  );
}
