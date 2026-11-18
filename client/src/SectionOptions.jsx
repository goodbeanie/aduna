import React, { useEffect, useState } from 'react';
import { Modal } from './ui.jsx';
import { CLIPS_ENABLED } from './features.js';
import { ITEMS, SECTIONS, SLOT_NAME, canAlign, getPanels, itemOn, placePanel, sectionName, setPanels, setSection, slotOf, useLayoutAllowed, useOpts, usePanels, useWide } from './panels.js';

// Customize one section of the app (the server bar, side list, member list, profile and voice, Shortcuts, Unread): double-click an empty spot of it,
// or double-click its part in Settings > Appearance > Layout (openSection). Where it sits, whether its things sit left, middle or right,
// and which of its things show. Everything applies as it is changed and is kept on this device (panels.js: setSection, setPanels).
// Only on wide screens and only for the accounts that have the layout editor, like the rest of the layout.
export const openSection = (id) => window.dispatchEvent(new CustomEvent('aduna:section', { detail: id }));

// a double-click on any of these is their own business (a button, a field, a channel), not a request to customize
const OWN = 'button, a, input, textarea, select, label, summary, [role=button], [role=slider], [role=switch], [contenteditable=true], .chan, .member';

const ALIGN = [[null, 'Default'], ['start', 'Left'], ['center', 'Center'], ['end', 'Right']];

function Seg({ value, options, onPick, label }) {
  return (
    <div className="so-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button type="button" key={String(v)} role="radio" aria-checked={value === v} className={'so-seg-btn' + (value === v ? ' on' : '')} onClick={() => onPick(v)}>{text}</button>
      ))}
    </div>
  );
}

export default function SectionOptions() {
  const allowed = useLayoutAllowed();
  const wide = useWide();
  const pan = usePanels();
  const opts = useOpts();
  const [id, setId] = useState(null);

  useEffect(() => {
    const open = (e) => { if (ITEMS[e.detail]) setId(e.detail); };
    const dbl = (e) => {
      if (!allowed || !wide || !(e.target instanceof Element) || e.target.closest(OWN)) return;
      const sid = e.target.closest('[data-panel]')?.getAttribute('data-panel');
      if (!sid || !ITEMS[sid]) return;
      window.getSelection?.()?.removeAllRanges(); // the double-click would otherwise leave a word selected
      setId(sid);
    };
    window.addEventListener('aduna:section', open);
    document.addEventListener('dblclick', dbl);
    return () => { window.removeEventListener('aduna:section', open); document.removeEventListener('dblclick', dbl); };
  }, [allowed, wide]);

  useEffect(() => { if (id && (!allowed || !wide)) setId(null); }, [id, allowed, wide]);
  if (!id || !allowed || !wide) return null;

  const section = SECTIONS.find((s) => s.id === id);
  const slot = slotOf(pan, id);
  const list = ITEMS[id].filter((it) => !it.clips || CLIPS_ENABLED);
  const align = opts[id]?.align || null;

  return (
    <Modal title={'Customize ' + sectionName(id).toLowerCase()} onClose={() => setId(null)}>
      <div className="so">
        <p className="muted small">{section?.hint}. Changes apply at once and are kept on this device.</p>

        <div className="so-label">PLACE IT</div>
        <Seg label="Where it sits" value={slot} options={(section?.where || []).map((k) => [k, SLOT_NAME[k]])} onPick={(k) => setPanels(placePanel(getPanels(), id, k))} />

        {canAlign(id, slot) && (
          <>
            <div className="so-label">ALIGN ITS THINGS</div>
            <Seg label="Alignment" value={align} options={ALIGN} onPick={(v) => setSection(id, { align: v })} />
          </>
        )}

        <div className="so-label">SHOW</div>
        <div className="so-items">
          {list.map((it) => {
            const on = itemOn(opts, id, it);
            return (
              <button type="button" key={it.id} role="switch" aria-checked={on} className={'so-item' + (on ? ' on' : '')} onClick={() => setSection(id, { items: { [it.id]: !on } })}>
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
  );
}
