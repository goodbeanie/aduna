import React, { useState } from 'react';
import { PRESETS, SECTIONS, SLOTS, SLOT_NAME, canGo, evenPanel, getPanels, isDefaultPanels, defaultPanels, placePanel, sectionName, setPanels, slotOf, splitPanel, usePanels, useWide, without } from './panels.js';
import { openSection } from './SectionOptions.jsx';

// Settings > Appearance > Layout: a live map of the app (top, left, right, bottom, with the chat in the middle). Drag a part to
// another slot, or into the Hidden box to turn it off. Drop it on another part to share that part's space (side by side in a bar, stacked
// in a column), or between two bars or columns to give it one of its own. The divider between two parts that share space is dragged to
// size them. The change is applied as you drop and kept on this device.
const BAR = { top: true, bottom: true }; // a bar: its parts sit side by side and the bars stack; a column is the other way round
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Roughly how big each part is in the real app: the server bar is thin, the lists are wide, the bars are short.
const THIN = 28;
const widthOf = (g) => (g.ids.length === 1 && g.ids[0] === 'rail' ? THIN : 56);

export default function LayoutSettings() {
  const pan = usePanels();
  const wide = useWide();
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null); // { slot, kind: 'join', group, at } | { slot, kind: 'new', at } | { slot, kind: 'tray' }

  if (!wide) {
    return <p className="muted small hint">The layout can be arranged on wide screens (a laptop or desktop window at least 1051 px across). Widen this window to change it; phones and small tablets keep the standard layout.</p>;
  }

  const canDrop = (zone) => !!drag && canGo(drag, zone);
  // A bar or column that holds only the part being dragged disappears while it is lifted, so every position below counts without it.
  const mine = (g) => g.ids.length === 1 && g.ids[0] === drag;
  const lifted = (slot, upTo) => pan[slot].slice(0, upTo).filter(mine).length;

  // Where a drop would land: on a part (share its group), on the thin strip between groups (a group of its own), or into an empty slot.
  const targetAt = (name, e) => {
    const t = e.target instanceof Element ? e.target : null;
    const groups = pan[name];
    const chipEl = t?.closest('[data-chip]');
    if (chipEl) {
      const groupEl = chipEl.closest('[data-group]');
      const gi = Number(groupEl.dataset.group);
      if (mine(groups[gi])) return null;
      let at = 0;
      for (const c of groupEl.querySelectorAll('[data-chip]')) {
        if (c.dataset.chip === drag) continue;
        const r = c.getBoundingClientRect();
        if (BAR[name] ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2) at++;
      }
      return { slot: name, kind: 'join', group: gi - lifted(name, gi), at };
    }
    const insEl = t?.closest('[data-ins]');
    if (insEl) {
      const i = Number(insEl.dataset.ins);
      return { slot: name, kind: 'new', at: i - lifted(name, i) };
    }
    if (!groups.length) return { slot: name, kind: 'new', at: 0 };
    return null;
  };

  const slotZone = (name) => ({
    onDragOver: (e) => {
      if (!canDrop(name)) return;
      const tg = targetAt(name, e);
      if (!tg) { setOver((o) => (o?.slot === name ? null : o)); return; }
      e.preventDefault();
      setOver((o) => (o && o.slot === tg.slot && o.kind === tg.kind && o.group === tg.group && o.at === tg.at ? o : tg));
    },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver((o) => (o?.slot === name ? null : o)); },
    onDrop: (e) => {
      if (!canDrop(name)) return;
      const tg = targetAt(name, e);
      if (!tg) return;
      e.preventDefault();
      setPanels(placePanel(pan, drag, name, tg.kind === 'join' ? { group: tg.group, at: tg.at } : { newGroup: tg.at }));
      setDrag(null); setOver(null);
    },
  });

  const trayZone = (name) => ({
    onDragOver: (e) => {
      if (!canDrop(name)) return;
      e.preventDefault();
      setOver((o) => (o?.slot === name ? o : { slot: name, kind: 'tray' }));
    },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver((o) => (o?.slot === name ? null : o)); },
    onDrop: (e) => {
      if (!canDrop(name)) return;
      e.preventDefault();
      setPanels(placePanel(pan, drag, name));
      setDrag(null); setOver(null);
    },
  });

  // Arrow keys on a focused part: along its group they reorder it, across the groups they step it out into a group of its own or into the next group.
  const keyMove = (e, id) => {
    const name = slotOf(pan, id);
    if (!SLOTS.includes(name)) return;
    const bar = !!BAR[name];
    const itemBack = bar ? 'ArrowLeft' : 'ArrowUp', itemFwd = bar ? 'ArrowRight' : 'ArrowDown';
    const groupBack = bar ? 'ArrowUp' : 'ArrowLeft', groupFwd = bar ? 'ArrowDown' : 'ArrowRight';
    if (![itemBack, itemFwd, groupBack, groupFwd].includes(e.key)) return;
    e.preventDefault();
    const gi = pan[name].findIndex((g) => g.ids.includes(id));
    const g = pan[name][gi], k = g.ids.indexOf(id), alone = g.ids.length === 1;
    const rest = without(pan, id)[name];
    let target = null;
    if (e.key === itemBack || e.key === itemFwd) {
      const to = Math.max(0, Math.min(g.ids.length - 1, k + (e.key === itemFwd ? 1 : -1)));
      if (!alone && to !== k) target = { group: gi, at: to };
    } else if (e.key === groupBack) {
      if (!alone) target = { newGroup: gi };
      else if (gi > 0) target = { group: gi - 1, at: rest[gi - 1].ids.length };
    } else if (!alone) target = { newGroup: gi + 1 };
    else if (gi < rest.length) target = { group: gi, at: 0 };
    if (!target) return;
    setPanels(placePanel(pan, id, name, target));
    requestAnimationFrame(() => document.querySelector(`.lay [data-chip="${id}"]`)?.focus());
  };

  // The divider between part i and part i + 1 of a group: dragged, it moves to wherever the pointer is (the pair keeps its combined share).
  const startSplit = (e, name, gi, i) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const bar = !!BAR[name];
    const el = e.currentTarget, groupEl = el.closest('[data-group]');
    try { el.setPointerCapture(e.pointerId); } catch { /* the drag still works without capture */ }
    el.classList.add('on');
    const move = (ev) => {
      const chips = groupEl.querySelectorAll('[data-chip]');
      const a = chips[i]?.getBoundingClientRect(), b = chips[i + 1]?.getBoundingClientRect();
      if (!a || !b) return;
      const from = bar ? a.left : a.top, to = bar ? b.right : b.bottom;
      if (to <= from) return;
      const next = splitPanel(getPanels(), name, gi, i, ((bar ? ev.clientX : ev.clientY) - from) / (to - from));
      if (!same(next, getPanels())) setPanels(next);
    };
    const up = () => {
      el.classList.remove('on');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const nudge = (e, name, gi, i) => {
    const bar = !!BAR[name];
    const back = bar ? 'ArrowLeft' : 'ArrowUp', fwd = bar ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== back && e.key !== fwd) return;
    e.preventDefault();
    const g = getPanels()[name][gi];
    if (!g) return;
    setPanels(splitPanel(getPanels(), name, gi, i, g.fr[i] / (g.fr[i] + g.fr[i + 1]) + (e.key === fwd ? 0.05 : -0.05)));
  };

  const chip = (id, fr) => (
    <div key={id} data-chip={id} className={'lay-chip' + (drag === id ? ' drag' : '')} draggable tabIndex={0} role="button" title={SECTIONS.find((s) => s.id === id)?.hint}
      style={fr ? { flex: `${fr} 1 0px` } : undefined}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); setDrag(id); }}
      onDragEnd={() => { setDrag(null); setOver(null); }}
      onDoubleClick={() => openSection(id)}
      onKeyDown={(e) => (e.key === 'Enter' ? openSection(id) : keyMove(e, id))}>{sectionName(id)}</div>
  );

  const group = (name, g, gi) => {
    const bar = !!BAR[name];
    const joining = over?.slot === name && over.kind === 'join' && !mine(g) && over.group === gi - lifted(name, gi);
    const items = [];
    let j = 0; // parts shown without the one being dragged, to place the gap
    g.ids.forEach((id, k) => {
      if (k > 0) {
        items.push(
          <span key={'d' + k} className="lay-split" role="separator" aria-orientation={bar ? 'vertical' : 'horizontal'} tabIndex={0}
            aria-label={'Size of ' + sectionName(g.ids[k - 1]) + ' and ' + sectionName(id)} aria-valuemin={10} aria-valuemax={90}
            aria-valuenow={Math.round(100 * g.fr[k - 1] / (g.fr[k - 1] + g.fr[k]))}
            title="Drag to resize, double-click to even out"
            onPointerDown={(e) => startSplit(e, name, gi, k - 1)}
            onDoubleClick={() => setPanels(evenPanel(getPanels(), name, gi))}
            onKeyDown={(e) => nudge(e, name, gi, k - 1)} />,
        );
      }
      if (joining && id !== drag && j === over.at) items.push(<i key="gap" className="lay-gap" />);
      if (id !== drag) j++;
      items.push(chip(id, g.fr[k]));
    });
    if (joining && j === over.at) items.push(<i key="gap" className="lay-gap" />);
    return (
      <div key={gi} data-group={gi} className={'lay-group' + (g.ids.length > 1 ? ' shared' : '') + (joining ? ' joining' : '')} style={bar ? { height: THIN } : { width: widthOf(g) }}>
        {items}
      </div>
    );
  };

  const slot = (name) => {
    const groups = pan[name];
    const here = over?.slot === name;
    const blocked = !!drag && !canDrop(name);
    const parts = [];
    const ins = (i) => <i key={'i' + i} data-ins={i} className={'lay-ins' + (here && over.kind === 'new' && over.at === i - lifted(name, i) ? ' on' : '')} />;
    groups.forEach((g, gi) => { parts.push(ins(gi)); parts.push(group(name, g, gi)); });
    if (groups.length) parts.push(ins(groups.length));
    return (
      <div className={'lay-slot ' + (BAR[name] ? 'rows' : 'cols') + (here ? ' over' : '') + (canDrop(name) ? ' ready' : '') + (blocked ? ' no' : '')} role="group" aria-label={SLOT_NAME[name] + ' slot'} {...slotZone(name)}>
        {parts}
        {groups.length === 0 && <span className="lay-empty">{SLOT_NAME[name]}</span>}
      </div>
    );
  };

  const tray = (name, label, note) => (
    <div className={'lay-zone' + (over?.slot === name ? ' over' : '') + (canDrop(name) ? ' ready' : '')} role="group" aria-label={label} {...trayZone(name)}>
      <span className="lay-slot-name">{label}</span>
      {pan[name].map((id) => chip(id))}
      {pan[name].length === 0 && <span className="muted small">{note}</span>}
    </div>
  );

  return (
    <div className="lay">
      <p className="muted small hint">Arrange the parts of Aduna on this device. Drag a part to where you want it, or into Hidden to turn it off. Drop it on another part to share that part&rsquo;s space, or between two bars or columns to give it one of its own. Where parts share space, drag the divider between them to size them, or double-click it to even them out. On the top or bottom the lists become a slim bar that scrolls sideways. With a part focused, the arrow keys move it. Double-click a part here (or press Enter on it), or double-click an empty spot of it in the app, to choose how its things line up (left, centre or right) and which of them show.</p>

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
