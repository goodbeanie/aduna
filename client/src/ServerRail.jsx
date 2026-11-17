import React, { useMemo, useState } from 'react';
import { ColorInput } from './Controls.jsx';
import { Icon, Modal } from './ui.jsx';
import { RailList } from './ShellBits.jsx';
import { FOLDER_COLORS, arrange, deleteFolder, editFolder, groupInto, keyOf, loadRail, reorder, reorderIn, saveRail, takeOut } from './railfolders.js';

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

// The server list of the server bar: drag to reorder, drop one server on another to make a folder, click a folder to open it.
// `renderServer(server, dnd)` draws one server button; spread `dnd` on it. `stats(server)` gives { unread, mentions }.
export default function ServerRail({ userId, servers, activeId, renderServer, stats, fmt, children }) {
  const [saved, setSaved] = useState(() => loadRail(userId));
  const [drag, setDrag] = useState(null); // { key, folder }
  const [over, setOver] = useState(null); // { key, mode: 'before' | 'after' | 'into' }
  const [openId, setOpenId] = useState(null);
  const [dialog, setDialog] = useState(null); // { serverId, overKey } for a new folder, { folderId } for an edit

  // saved is only rewritten by a change, so a server list that has not loaded yet cannot wipe it
  const layout = useMemo(() => arrange(saved, servers), [saved, servers]);
  const byId = useMemo(() => new Map(servers.map((s) => [s.id, s])), [servers]);
  const open = layout.find((it) => it.f && it.f === openId);

  const commit = (fn) => { const next = fn(layout); setSaved(next); saveRail(userId, next); };

  const zone = (e, twoWay) => {
    const r = e.currentTarget.getBoundingClientRect();
    const across = getComputedStyle(e.currentTarget.parentElement).flexDirection !== 'column';
    const t = across ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    if (twoWay) return t < 0.5 ? 'before' : 'after';
    return t < 0.25 ? 'before' : t > 0.75 ? 'after' : 'into';
  };

  const drop = (key, folderId) => {
    const d = drag, o = over;
    setDrag(null); setOver(null);
    if (!d || !o || o.key !== key) return;
    if (folderId) { commit((l) => reorderIn(l, folderId, d.key.slice(2), key.slice(2), o.mode === 'after')); return; }
    if (o.mode === 'into' && d.key.startsWith('s:')) {
      if (layout.find((it) => keyOf(it) === key)?.f) commit((l) => groupInto(l, d.key.slice(2), key));
      else setDialog({ serverId: d.key.slice(2), overKey: key });
      return;
    }
    commit((l) => reorder(l, d.key, key, o.mode === 'after'));
  };

  const dnd = (key, folderId = null) => ({
    draggable: true,
    'data-drag': drag?.key === key ? '' : undefined,
    'data-drop': drag && drag.key !== key && over?.key === key ? over.mode : undefined,
    onDragStart: (e) => { setDrag({ key, folder: folderId }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', key); },
    onDragEnd: () => { setDrag(null); setOver(null); },
    onDragOver: (e) => {
      if (!drag || drag.key === key || drag.folder !== folderId) return;
      e.preventDefault();
      const mode = zone(e, !!folderId || drag.key.startsWith('f:'));
      setOver((o) => (o && o.key === key && o.mode === mode ? o : { key, mode }));
    },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver((o) => (o?.key === key ? null : o)); },
    onDrop: (e) => { e.preventDefault(); drop(key, folderId); },
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
          <button className="rail-btn rail-exit" title="Back to all servers (right-click to edit this folder)" aria-label="Close folder"
            data-drop={drag?.folder === open.f && over?.key === 'exit' ? 'into' : undefined}
            onClick={() => setOpenId(null)} onContextMenu={(e) => { e.preventDefault(); setDialog({ folderId: open.f }); }}
            onDragOver={(e) => { if (drag?.folder === open.f) { e.preventDefault(); setOver((o) => (o?.key === 'exit' ? o : { key: 'exit', mode: 'into' })); } }}
            onDragLeave={() => setOver((o) => (o?.key === 'exit' ? null : o))}
            onDrop={(e) => { e.preventDefault(); const d = drag; setDrag(null); setOver(null); if (d?.folder === open.f) { commit((l) => takeOut(l, open.f, d.key.slice(2))); if (open.ids.length === 1) setOpenId(null); } }}>
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
