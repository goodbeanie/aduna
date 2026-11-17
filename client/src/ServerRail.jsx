import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ColorInput } from './Controls.jsx';
import { Icon, Modal } from './ui.jsx';
import { RailList } from './ShellBits.jsx';
import { FOLDER_COLORS, arrange, deleteFolder, editFolder, groupInto, keyOf, loadRail, pushRail, reorder, reorderIn, saveRail, takeOut } from './railfolders.js';

function FolderModal({ folder, onSave, onDelete, onClose }) {
  const [name, setName] = useState(folder?.name || '');
  const [color, setColor] = useState(folder?.color || FOLDER_COLORS[0]);
  const go = (e) => { e.preventDefault(); onSave({ name: name.trim() || 'Folder', color }); };
  return (
    <Modal title={folder ? 'Edit folder' : 'New folder'} onClose={onClose}>
      <form onSubmit={go}>
        <label htmlFor="folder-name">FOLDER NAME</label>
        <input id="folder-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={30} placeholder="Folder" />
        <label>COLOUR</label>
        <div className="color-row"><div className="swatches">
          {FOLDER_COLORS.map((c) => <button key={c} type="button" className={'swatch' + (color === c ? ' on' : '')} style={{ background: c }} aria-label={c} onClick={() => setColor(c)} />)}
          <ColorInput value={color} onChange={(e) => setColor(e.target.value)} aria-label="Custom colour" />
        </div></div>
        <div className="modal-foot">
          {onDelete && <button type="button" className="btn danger" onClick={onDelete}>Delete folder</button>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">{folder ? 'Save' : 'Create folder'}</button>
        </div>
      </form>
    </Modal>
  );
}

const MOVE_PX = 5; // a mouse press has to move this far before it counts as a drag
const HOLD_MS = 320; // touch and pen: press and hold, so a swipe along the bar still scrolls it
const EDGE_PX = 40; // near either end of the bar the list scrolls by itself
const SLACK_PX = 24; // how far outside the bar a drop still counts

const sameAim = (a, b) => a === b || (!!a && !!b && a.key === b.key && a.mode === b.mode
  && a.rect.left === b.rect.left && a.rect.top === b.rect.top && a.rect.width === b.rect.width && a.rect.height === b.rect.height);

function aimAt(el, key, mode, vertical) {
  const r = el.getBoundingClientRect();
  return { key, mode, vertical, radius: mode === 'into' ? getComputedStyle(el).borderRadius : '', rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
}

// What a drop at x, y would do: the button closest along the bar, and whether it lands before it, after it or on it.
// The gaps and the ends of the bar count too, so a drop never has to hit a button exactly. null = nothing happens.
function aim(drag, x, y) {
  const root = drag.root;
  const bar = root.closest('.rail') || root;
  const b = bar.getBoundingClientRect();
  if (x < b.left - SLACK_PX || x > b.right + SLACK_PX || y < b.top - SLACK_PX || y > b.bottom + SLACK_PX) return null;
  const own = drag.el.getBoundingClientRect();
  if (x >= own.left && x <= own.right && y >= own.top && y <= own.bottom) return null;

  const vertical = getComputedStyle(root).flexDirection === 'column';
  const exit = drag.folder ? root.querySelector('[data-rail-key=exit]') : null;
  if (exit) {
    const r = exit.getBoundingClientRect();
    if (x > r.left - 8 && x < r.right + 8 && y > r.top - 8 && y < r.bottom + 8) return aimAt(exit, 'exit', 'into', vertical);
  }

  const at = vertical ? y : x;
  let best = null, bestDist = Infinity;
  for (const el of root.querySelectorAll('[data-rail-key]')) {
    const key = el.dataset.railKey;
    if (el === drag.el || key === 'exit') continue;
    const r = el.getBoundingClientRect();
    const from = vertical ? r.top : r.left, to = vertical ? r.bottom : r.right;
    const dist = at < from ? from - at : at > to ? at - to : 0;
    if (dist < bestDist) { best = { el, key, from, to }; bestDist = dist; }
  }
  if (!best) return null;
  const t = Math.max(0, Math.min(1, (at - best.from) / (best.to - best.from)));
  const twoWay = !!drag.folder || drag.key.startsWith('f:'); // only a server can be dropped onto something
  const mode = twoWay ? (t < 0.5 ? 'before' : 'after') : t < 0.3 ? 'before' : t > 0.7 ? 'after' : 'into';
  return aimAt(best.el, best.key, mode, vertical);
}

// Pointer based drag for the server bar. Native drag and drop only fires on the exact button under the pointer, loses the drop when the
// pointer is in a gap, does nothing on touch screens and is drawn by the browser, so the bar does its own: a copy of the button follows the
// pointer, one marker shows where it will land, and it works the same on the top, bottom, left and right of the screen.
function makeDragger(latest, setDrag, setOver) {
  let s = null;

  const block = (e) => { if (e.cancelable) e.preventDefault(); };
  const noMenu = (e) => e.preventDefault();

  const scroll = () => {
    const r = s.root.getBoundingClientRect();
    const vertical = getComputedStyle(s.root).flexDirection === 'column';
    const at = vertical ? s.y : s.x, from = vertical ? r.top : r.left, to = vertical ? r.bottom : r.right;
    let px = 0;
    if (at < from + EDGE_PX) px = -Math.min(1, (from + EDGE_PX - at) / EDGE_PX) * 14;
    else if (at > to - EDGE_PX) px = Math.min(1, (at - (to - EDGE_PX)) / EDGE_PX) * 14;
    if (px) s.root[vertical ? 'scrollTop' : 'scrollLeft'] += px;
  };

  const frame = () => {
    if (!s || !s.live) return;
    if (!s.el.isConnected) { stop(); return; }
    s.ghost.style.transform = 'translate(' + (s.x - s.dx) + 'px, ' + (s.y - s.dy) + 'px) scale(1.08)';
    scroll();
    const next = aim(s, s.x, s.y);
    if (!sameAim(next, s.target)) { s.target = next; setOver(next); }
    s.raf = requestAnimationFrame(frame);
  };

  const lift = () => {
    if (!s || s.live) return;
    clearTimeout(s.timer);
    s.live = true;
    const r = s.el.getBoundingClientRect();
    s.dx = s.x - r.left;
    s.dy = s.y - r.top;
    const ghost = s.el.cloneNode(true);
    for (const a of ['data-drag', 'data-rail-key', 'title', 'id']) ghost.removeAttribute(a);
    ghost.classList.add('rail-ghost');
    ghost.style.width = r.width + 'px';
    ghost.style.height = r.height + 'px';
    document.body.appendChild(ghost);
    s.ghost = ghost;
    document.body.classList.add('rail-dragging');
    try { s.el.setPointerCapture(s.id); } catch { /* the button is already gone */ }
    if (s.type !== 'mouse') navigator.vibrate?.(12);
    document.addEventListener('touchmove', block, { passive: false });
    setDrag({ key: s.key, folder: s.folder });
    frame();
  };

  const swallowClick = () => {
    const eat = (e) => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', eat, true);
    setTimeout(() => window.removeEventListener('click', eat, true), 60);
  };

  const move = (e) => {
    if (!s || e.pointerId !== s.id) return;
    s.x = e.clientX;
    s.y = e.clientY;
    if (s.live) return;
    const far = Math.hypot(s.x - s.x0, s.y - s.y0);
    if (s.type === 'mouse') { if (far > MOVE_PX) lift(); } else if (far > 10) stop(); // a swipe: leave the scrolling to the bar
  };

  const up = (e) => {
    if (!s || e.pointerId !== s.id) return;
    const d = s;
    const target = d.live ? aim(d, e.clientX, e.clientY) : null;
    const still = Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 10;
    stop();
    if (!d.live) return;
    swallowClick();
    if (target) latest.current.land(d, target);
    else if (still && d.type !== 'mouse' && d.key.startsWith('f:')) latest.current.edit(d.key.slice(2)); // long press on a folder, no right click on a phone
  };

  const key = (e) => { if (e.key === 'Escape') stop(); };

  function stop() {
    if (!s) return;
    const d = s;
    s = null;
    clearTimeout(d.timer);
    cancelAnimationFrame(d.raf);
    d.ghost?.remove();
    document.body.classList.remove('rail-dragging');
    try { d.el.releasePointerCapture(d.id); } catch { /* not captured */ }
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', stop);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('contextmenu', noMenu, true);
    document.removeEventListener('touchmove', block);
    if (d.live) { setDrag(null); setOver(null); }
  }

  const begin = (e, itemKey, folder) => {
    if (s || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const el = e.currentTarget;
    const root = el.closest('.rail-list');
    if (!root) return;
    s = { key: itemKey, folder, el, root, id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, live: false, target: null, ghost: null, timer: 0, raf: 0, dx: 0, dy: 0 };
    if (s.type !== 'mouse') s.timer = setTimeout(lift, HOLD_MS);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('keydown', key, true);
    window.addEventListener('contextmenu', noMenu, true);
  };

  return { begin, stop };
}

// The marker for where the dragged button will land. It sits in the page, not in the bar, so the bar's scrolling and clipping never cut it off.
function DropMark({ at }) {
  const r = at.rect;
  if (at.mode === 'into') {
    return <div className="rail-drop ring" style={{ left: r.left - 3, top: r.top - 3, width: r.width + 6, height: r.height + 6, borderRadius: at.radius }} />;
  }
  const before = at.mode === 'before';
  const style = at.vertical
    ? { left: r.left - 2, width: r.width + 4, height: 4, top: before ? r.top - 6 : r.top + r.height + 2 }
    : { top: r.top - 2, height: r.height + 4, width: 4, left: before ? r.left - 6 : r.left + r.width + 2 };
  return <div className="rail-drop line" style={style} />;
}

// The server list of the server bar: drag to reorder, drop one server on another to make a folder, click a folder to open it.
// `renderServer(server, dnd)` draws one server button; spread `dnd` on it. `stats(server)` gives { unread, mentions }.
export default function ServerRail({ userId, remote, servers, activeId, renderServer, stats, fmt, children }) {
  const [saved, setSaved] = useState(() => loadRail(userId));
  const sent = useRef(new Set()); // layouts this device sent itself: their echo from the server must not redraw the bar again
  const [drag, setDrag] = useState(null); // { key, folder } while a button is picked up
  const [over, setOver] = useState(null); // where it would land: { key, mode: 'before' | 'after' | 'into', rect, vertical }
  const [openId, setOpenId] = useState(null);
  const [dialog, setDialog] = useState(null); // { serverId, overKey } for a new folder, { folderId } for an edit

  // The account's layout wins: a folder made on another device shows up here. An account that has none yet takes this device's
  // (folders made before they followed the account), so nobody has to build them again.
  useEffect(() => {
    if (remote === undefined) return; // the profile has not loaded yet
    if (remote === null) { if (saved.length) pushRail(saved); return; }
    const text = JSON.stringify(remote);
    if (sent.current.delete(text) || text === JSON.stringify(saved)) return;
    setSaved(remote); saveRail(userId, remote);
  }, [remote]); // eslint-disable-line react-hooks/exhaustive-deps

  // saved is only rewritten by a change, so a server list that has not loaded yet cannot wipe it
  const layout = useMemo(() => arrange(saved, servers), [saved, servers]);
  const byId = useMemo(() => new Map(servers.map((s) => [s.id, s])), [servers]);
  const open = layout.find((it) => it.f && it.f === openId);

  const commit = (fn) => {
    const next = fn(layout);
    if (JSON.stringify(next) === JSON.stringify(layout)) return;
    setSaved(next); saveRail(userId, next);
    sent.current.add(JSON.stringify(next));
    pushRail(next);
  };

  const land = (d, t) => {
    const after = t.mode === 'after';
    if (t.key === 'exit') {
      commit((l) => takeOut(l, d.folder, d.key.slice(2)));
      if (open?.ids.length === 1) setOpenId(null);
      return;
    }
    if (d.folder) { commit((l) => reorderIn(l, d.folder, d.key.slice(2), t.key.slice(2), after)); return; }
    if (t.mode === 'into' && d.key.startsWith('s:')) {
      if (layout.find((it) => keyOf(it) === t.key)?.f) commit((l) => groupInto(l, d.key.slice(2), t.key));
      else setDialog({ serverId: d.key.slice(2), overKey: t.key });
      return;
    }
    commit((l) => reorder(l, d.key, t.key, after));
  };

  const latest = useRef(null);
  latest.current = { land, edit: (folderId) => setDialog({ folderId }) };
  const dragger = useRef(null);
  if (!dragger.current) dragger.current = makeDragger(latest, setDrag, setOver);
  useEffect(() => () => dragger.current.stop(), []);

  const dnd = (key, folderId = null) => ({
    'data-rail-key': key,
    'data-drag': drag?.key === key ? '' : undefined,
    onPointerDown: (e) => dragger.current.begin(e, key, folderId),
    onDragStart: (e) => e.preventDefault(), // the browser's own picture drag (server icons are images) would fight ours
  });

  const sum = (ids) => ids.reduce((a, id) => { const s = byId.get(id); const x = s ? stats(s) : null; return { unread: a.unread + (x?.unread || 0), mentions: a.mentions + (x?.mentions || 0) }; }, { unread: 0, mentions: 0 });

  const folderBtn = (f) => {
    const n = sum(f.ids);
    const key = 'f:' + f.f;
    return (
      <button key={key} className={'rail-btn rail-folder' + (f.ids.includes(activeId) ? ' on' : '')} title={f.name || 'Folder'} aria-label={'Folder: ' + (f.name || 'Folder')}
        onClick={() => setOpenId(f.f)} onContextMenu={(e) => { e.preventDefault(); setDialog({ folderId: f.f }); }} {...dnd(key)}>
        <Icon name="folder" size={26} fill="currentColor" fillOpacity=".3" style={{ color: f.color }} />
        {n.unread > 0 && <span className="badge">{fmt(n.unread)}</span>}
        {n.mentions > 0 && <span className="badge at">@{fmt(n.mentions)}</span>}
      </button>
    );
  };

  const editing = dialog?.folderId ? layout.find((it) => it.f === dialog.folderId) : null;

  return (
    <>
      {open ? (
        <RailList>
          <button className="rail-btn rail-exit" data-rail-key="exit" title="Back to all servers (right-click to edit this folder)" aria-label="Close folder"
            onClick={() => setOpenId(null)} onContextMenu={(e) => { e.preventDefault(); setDialog({ folderId: open.f }); }}>
            <Icon name="exit" size={22} />
          </button>
          {open.ids.map((id) => byId.get(id)).filter(Boolean).map((s) => renderServer(s, dnd('s:' + s.id, open.f)))}
        </RailList>
      ) : (
        <RailList>
          {layout.map((it) => (it.f ? folderBtn(it) : byId.get(it.s) ? renderServer(byId.get(it.s), dnd(keyOf(it))) : null))}
          {children}
        </RailList>
      )}

      {over && createPortal(<DropMark at={over} />, document.body)}

      {dialog && !dialog.folderId && (
        <FolderModal onClose={() => setDialog(null)} onSave={(info) => { commit((l) => groupInto(l, dialog.serverId, dialog.overKey, info)); setDialog(null); }} />
      )}
      {editing && (
        <FolderModal folder={editing} onClose={() => setDialog(null)}
          onSave={(info) => { commit((l) => editFolder(l, editing.f, info)); setDialog(null); }}
          onDelete={() => { commit((l) => deleteFolder(l, editing.f)); setOpenId(null); setDialog(null); }} />
      )}
    </>
  );
}
