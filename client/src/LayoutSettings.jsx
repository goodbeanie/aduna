import React, { useState } from 'react';
import { PRESETS, SECTIONS, SLOTS, SLOT_NAME, defaultPanels, isDefaultPanels, nudgePanel, placePanel, sectionName, setPanels, slotOf, usePanels, useWide } from './panels.js';

// Settings > Appearance > Layout: a live map of the app (top, left, right, bottom, with the chat in the middle). Tap a section on the map,
// then choose its slot and its place in that slot. The change is applied as you tap and kept on this device.
const AXIS = { top: 'rows', bottom: 'rows', left: 'cols', right: 'cols' };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default function LayoutSettings() {
  const pan = usePanels();
  const wide = useWide();
  const [picked, setPicked] = useState('rail');

  if (!wide) {
    return <p className="muted small hint">The layout can be arranged on wide screens (a laptop or desktop window at least 1051 px across). Widen this window to change it; phones and small tablets keep the standard layout.</p>;
  }

  const sec = SECTIONS.find((s) => s.id === picked) || SECTIONS[0];
  const at = slotOf(pan, sec.id);
  const list = pan[at] || [];
  const i = list.indexOf(sec.id);
  const vertical = at === 'top' || at === 'bottom';
  const places = [...SLOTS, ...(sec.canDock ? ['dock'] : []), 'off'];
  const move = (to) => setPanels(placePanel(pan, sec.id, to));
  const nudge = (d) => setPanels(nudgePanel(pan, sec.id, d));

  const chip = (id) => (
    <button type="button" key={id} className={'lay-chip' + (picked === id ? ' on' : '')} aria-pressed={picked === id} onClick={() => setPicked(id)}>{sectionName(id)}</button>
  );
  const slot = (name) => (
    <div className={'lay-slot ' + AXIS[name]} role="group" aria-label={SLOT_NAME[name] + ' slot'}>
      {pan[name].map(chip)}
      {pan[name].length === 0 && (
        <button type="button" className="lay-empty" title={`Put ${sec.name.toLowerCase()} here`} aria-label={`Put ${sec.name.toLowerCase()} in the ${SLOT_NAME[name].toLowerCase()} slot`}
          onClick={() => move(name)}>{AXIS[name] === 'rows' ? 'Put here' : '+'}</button>
      )}
    </div>
  );

  return (
    <div className="lay">
      <p className="muted small hint">Arrange the parts of Aduna on this device. Tap a part on the map, then pick where it goes. Phones and small tablets keep the standard layout.</p>

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

      <div className="lay-tray">
        {pan.dock.length > 0 && <><span className="lay-slot-name">Under side list</span>{pan.dock.map(chip)}</>}
        <span className="lay-slot-name">Hidden</span>
        {pan.off.length ? pan.off.map(chip) : <span className="muted small">nothing</span>}
      </div>

      <div className="lay-picked">
        <h4>{sec.name}</h4>
        <p className="muted small hint">{sec.hint}</p>
        <div className="mode-pick" role="radiogroup" aria-label={`Where the ${sec.name.toLowerCase()} goes`}>
          {places.map((w) => (
            <button type="button" role="radio" key={w} aria-checked={at === w} className={at === w ? 'on' : ''} onClick={() => move(w)}>{SLOT_NAME[w]}</button>
          ))}
        </div>
        {list.length > 1 && at !== 'dock' && at !== 'off' && (
          <div className="lay-moves">
            <button type="button" className="btn small-btn" disabled={i <= 0} onClick={() => nudge(-1)}>{vertical ? 'Move up' : 'Move left'}</button>
            <button type="button" className="btn small-btn" disabled={i >= list.length - 1} onClick={() => nudge(1)}>{vertical ? 'Move down' : 'Move right'}</button>
            <span className="muted small">{i + 1} of {list.length} in this slot</span>
          </div>
        )}
      </div>

      <div className="lay-moves">
        <button type="button" className="btn small-btn" disabled={isDefaultPanels(pan)} onClick={() => setPanels(defaultPanels())}>Reset layout</button>
        <span className="muted small">Hiding the side list moves Profile and voice to the left edge so it stays within reach.</span>
      </div>
    </div>
  );
}
