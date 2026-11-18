import React, { useState } from 'react';
import { PRESETS, SECTIONS, SLOTS, SLOT_NAME, canGo, defaultPanels, isDefaultPanels, placePanel, sectionName, setPanels, slotOf, usePanels, useWide } from './panels.js';

// Settings > Appearance > Layout: a live map of the app (top, left, right, bottom, with the chat in the middle). Drag a part to
// another slot, or into the Hidden box to turn it off; or pick its position from the list under the map. The change is applied as you drop and kept on this device.
const AXIS = { top: 'rows', bottom: 'rows', left: 'cols', right: 'cols' };
const PLACES = [...SLOTS, 'dock', 'off'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Roughly how big each part is in the real app: the server bar is thin, the lists are wide, the bars are short.
const THIN = 28;
const sizeOf = (id, axis) => (axis === 'cols' && id !== 'rail' ? 56 : THIN);

// Where a drop would land in a slot: the number of parts (not counting the one being dragged) that sit before the pointer.
const indexAt = (slotEl, axis, x, y, dragged) => {
  let at = 0;
  for (const c of slotEl.querySelectorAll('[data-chip]')) {
    if (c.dataset.chip === dragged) continue;
    const r = c.getBoundingClientRect();
    const mid = axis === 'rows' ? r.top + r.height / 2 : r.left + r.width / 2;
    if ((axis === 'rows' ? y : x) > mid) at++;
  }
  return at;
};

export default function LayoutSettings() {
  const pan = usePanels();
  const wide = useWide();
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);

  if (!wide) {
    return <p className="muted small hint">The layout can be arranged on wide screens (a laptop or desktop window at least 1051 px across). Widen this window to change it; phones and small tablets keep the standard layout.</p>;
  }

  const canDrop = (zone) => !!drag && canGo(drag, zone);
  const zone = (name) => ({
    onDragOver: (e) => {
      if (!canDrop(name)) return;
      e.preventDefault();
      setOver({ zone: name, at: AXIS[name] ? indexAt(e.currentTarget, AXIS[name], e.clientX, e.clientY, drag) : undefined });
    },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver((o) => (o?.zone === name ? null : o)); },
    onDrop: (e) => {
      if (!canDrop(name)) return;
      e.preventDefault();
      const at = AXIS[name] ? indexAt(e.currentTarget, AXIS[name], e.clientX, e.clientY, drag) : undefined;
      setPanels(placePanel(pan, drag, name, at));
      setDrag(null); setOver(null);
    },
  });

  const keyMove = (e, id) => {
    const k = slotOf(pan, id), axis = AXIS[k];
    if (!axis) return;
    const back = axis === 'rows' ? 'ArrowUp' : 'ArrowLeft', fwd = axis === 'rows' ? 'ArrowDown' : 'ArrowRight';
    if (e.key !== back && e.key !== fwd) return;
    e.preventDefault();
    setPanels(placePanel(pan, id, k, pan[k].indexOf(id) + (e.key === fwd ? 1 : -1)));
  };

  const chip = (id, axis) => (
    <div key={id} data-chip={id} className={'lay-chip' + (drag === id ? ' drag' : '')} draggable tabIndex={0} role="button" title={SECTIONS.find((s) => s.id === id)?.hint}
      style={axis ? (axis === 'cols' ? { width: sizeOf(id, axis) } : { height: sizeOf(id, axis) }) : undefined}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); setDrag(id); }}
      onDragEnd={() => { setDrag(null); setOver(null); }}
      onKeyDown={(e) => keyMove(e, id)}>{sectionName(id)}</div>
  );

  const slot = (name) => {
    const axis = AXIS[name];
    const here = over?.zone === name;
    const blocked = !!drag && !canDrop(name);
    const items = [];
    let j = 0;
    for (const id of pan[name]) {
      if (here && id !== drag && j === over.at) items.push(<i key="gap" className="lay-gap" />);
      if (id !== drag) j++;
      items.push(chip(id, axis));
    }
    if (here && j === over.at) items.push(<i key="gap" className="lay-gap" />);
    return (
      <div className={'lay-slot ' + axis + (here ? ' over' : '') + (canDrop(name) ? ' ready' : '') + (blocked ? ' no' : '')} role="group" aria-label={SLOT_NAME[name] + ' slot'} {...zone(name)}>
        {items}
        {pan[name].length === 0 && !here && <span className="lay-empty">{SLOT_NAME[name]}</span>}
      </div>
    );
  };

  const tray = (name, label, note) => (
    <div className={'lay-zone' + (over?.zone === name ? ' over' : '') + (canDrop(name) ? ' ready' : '')} role="group" aria-label={label} {...zone(name)}>
      <span className="lay-slot-name">{label}</span>
      {pan[name].map((id) => chip(id))}
      {pan[name].length === 0 && <span className="muted small">{note}</span>}
    </div>
  );

  return (
    <div className="lay">
      <p className="muted small hint">Arrange the parts of Aduna on this device. Drag a part to where you want it, or into Hidden to turn it off, or choose a position for it in the list below the map. Every part goes on any side; on the top or bottom the lists become a slim bar that scrolls sideways. With a part focused, the arrow keys move it within its slot. Phones and small tablets keep the standard layout.</p>

      <div className="lay-presets" role="group" aria-label="Layout presets">
        {PRESETS.map(([name, l]) => (
          <button type="button" key={name} className={'btn small-btn' + (same(l, pan) ? ' primary' : '')} onClick={() => setPanels(l)}>{name}</button>
        ))}
      </div>

      <div className="lay-map" role="group" aria-label="Layout map">
        {slot('top')}
        <div className="lay-mid">
          {slot('left')}
          <div className="lay-center">Chat</div>
          {slot('right')}
        </div>
        {slot('bottom')}
      </div>

      <div className="lay-pos" role="group" aria-label="Position of each part">
        {SECTIONS.map((s) => {
          const at = slotOf(pan, s.id);
          return (
            <div className="lay-pos-row" key={s.id}>
              <span className="lay-pos-name" title={s.hint}>{s.name}</span>
              <div className="lay-seg" role="group" aria-label={s.name + ' position'}>
                {PLACES.filter((k) => canGo(s.id, k)).map((k) => (
                  <button type="button" key={k} className={'btn small-btn' + (at === k ? ' primary' : '')} aria-pressed={at === k}
                    onClick={() => { if (at !== k) setPanels(placePanel(pan, s.id, k)); }}>{SLOT_NAME[k]}</button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="lay-tray">
        {tray('dock', 'Under side list', 'Profile and voice only')}
        {tray('off', 'Hidden', 'nothing')}
      </div>

      <div className="lay-moves">
        <button type="button" className="btn small-btn" disabled={isDefaultPanels(pan)} onClick={() => setPanels(defaultPanels())}>Reset layout</button>
        <span className="muted small">Hiding the side list moves Profile and voice to the left edge so it stays within reach.</span>
      </div>
    </div>
  );
}
