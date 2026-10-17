import React, { useState } from 'react';
import { api } from './api.js';
import { Avatar, Icon, Modal } from './ui.jsx';
import { PERMS, can, permsOf, rankOf, belowMe, heldRoles } from './perms.js';

const COLORS = ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e91e63', '#95a5a6'];
const sameList = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

// Roles: a list (highest first, with @everyone at the end) and an editor for the one you pick. Like the Channels tab,
// changes apply when you press the role's own Save button, not the page's Save.
export function RolesTab({ server, me, onChange }) {
  const [sel, setSel] = useState(null); // role id | 'everyone' | null
  const [draft, setDraft] = useState(null); // { name, color, perms }
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const roles = server.roles || [];
  const isOwner = server.ownerId === me.id;
  const mine = permsOf(server, me.id);
  const base = `/servers/${server.id}`;

  const run = async (fn) => {
    setErr(''); setBusy(true);
    try { const r = await fn(); onChange(r.server); return r.server; }
    catch (e) { setErr(e.message); return null; }
    finally { setBusy(false); }
  };

  const open = (id) => {
    setErr(''); setSel(id);
    if (id === 'everyone') setDraft({ perms: [...(server.everyone || [])] });
    else { const r = roles.find((x) => x.id === id); setDraft(r ? { name: r.name, color: r.color || null, perms: [...r.perms] } : null); }
  };
  const create = async () => {
    const sv = await run(() => api(`${base}/roles`, { method: 'POST', body: { name: 'new role' } }));
    if (sv) { const r = sv.roles[sv.roles.length - 1]; setSel(r.id); setDraft({ name: r.name, color: r.color || null, perms: [...r.perms] }); }
  };
  const role = sel && sel !== 'everyone' ? roles.find((r) => r.id === sel) : null;
  const editable = sel === 'everyone' ? true : !!role && belowMe(server, me.id, role.id);
  const canGive = (p) => mine.has(p); // you can only switch on or off what you hold yourself
  const dirty = draft && (sel === 'everyone' ? !sameList(draft.perms, server.everyone || [])
    : role && (draft.name !== role.name || (draft.color || null) !== (role.color || null) || !sameList(draft.perms, role.perms)));
  const save = () => (sel === 'everyone'
    ? run(() => api(`${base}/everyone`, { method: 'PUT', body: { perms: draft.perms } }))
    : run(() => api(`${base}/roles/${role.id}`, { method: 'PATCH', body: { name: draft.name, color: draft.color, perms: draft.perms } })));
  const del = async () => { if (await run(() => api(`${base}/roles/${role.id}`, { method: 'DELETE' }))) { setConfirm(false); setSel(null); setDraft(null); } };
  const move = (i, d) => {
    const ids = roles.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    run(() => api(`${base}/roles-order`, { method: 'PUT', body: { ids } }));
  };
  const toggle = (p) => setDraft((d) => ({ ...d, perms: d.perms.includes(p) ? d.perms.filter((x) => x !== p) : [...d.perms, p] }));
  const count = (id) => Object.values(server.memberRoles || {}).filter((l) => l.includes(id)).length;

  return (
    <>
      <h1>Roles</h1>
      <p className="muted small hint">Roles give members permissions and a name colour. The top role is the most powerful: you can only change roles below your own, and only give permissions you have yourself. The owner can do everything.</p>
      <div className="roles-layout">
        <div className="roles-list">
          {roles.map((r, i) => {
            const mv = belowMe(server, me.id, r.id);
            return (
              <div key={r.id} className={'role-row' + (sel === r.id ? ' on' : '')}>
                <button className="role-main" onClick={() => open(r.id)}>
                  <span className="role-dot" style={{ background: r.color || 'var(--muted)' }} />
                  <span className="role-name">{r.name}</span>
                  <span className="muted small">{count(r.id)}</span>
                </button>
                {mv && <span className="role-move">
                  <button className="icon-btn" title="Move up" aria-label="Move up" disabled={busy || i === 0 || !belowMe(server, me.id, roles[i - 1].id)} onClick={() => move(i, -1)}>↑</button>
                  <button className="icon-btn" title="Move down" aria-label="Move down" disabled={busy || i === roles.length - 1} onClick={() => move(i, 1)}>↓</button>
                </span>}
              </div>
            );
          })}
          <div className={'role-row' + (sel === 'everyone' ? ' on' : '')}>
            <button className="role-main" onClick={() => open('everyone')}><span className="role-dot" style={{ background: 'var(--muted)' }} /><span className="role-name">@everyone</span><span className="muted small">all</span></button>
          </div>
          <button className="btn small-btn add-role" onClick={create} disabled={busy || roles.length >= 25}><Icon name="plus" size={15} /> Create role</button>
        </div>

        <div className="role-edit">
          {!draft && <p className="muted">Pick a role to edit it, or create a new one.</p>}
          {draft && (
            <>
              {sel === 'everyone' ? <h2 className="role-title">@everyone</h2> : (
                <>
                  <label>ROLE NAME</label>
                  <input value={draft.name} maxLength={30} disabled={!editable} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  <label>COLOUR</label>
                  <div className="color-row"><div className="swatches">
                    <button type="button" className={'swatch none' + (!draft.color ? ' on' : '')} title="No colour" aria-label="No colour" disabled={!editable} onClick={() => setDraft({ ...draft, color: null })} />
                    {COLORS.map((c) => <button key={c} type="button" className={'swatch' + (draft.color === c ? ' on' : '')} style={{ background: c }} aria-label={c} disabled={!editable} onClick={() => setDraft({ ...draft, color: c })} />)}
                    <input type="color" className="role-color-input" value={draft.color || '#888888'} disabled={!editable} onChange={(e) => setDraft({ ...draft, color: e.target.value })} aria-label="Custom colour" />
                  </div></div>
                </>
              )}
              <label>PERMISSIONS</label>
              {sel === 'everyone' && <p className="muted small hint">Everyone in the server has these, whatever their roles.</p>}
              {!editable && <p className="muted small hint">This role is at or above your own, so you can only look at it.</p>}
              <div className="perm-list">
                {PERMS.map((p) => {
                  const off = !editable || !canGive(p.id) || (sel === 'everyone' && p.id === 'administrator' && !isOwner);
                  return (
                    <label key={p.id} className={'perm-row' + (off ? ' off' : '') + (p.danger ? ' danger' : '')}>
                      <span className="perm-text"><b>{p.label}</b><span className="muted small">{p.desc}</span></span>
                      <input type="checkbox" checked={draft.perms.includes(p.id)} disabled={off} onChange={() => toggle(p.id)} />
                    </label>
                  );
                })}
              </div>
              {err && <div className="error">{err}</div>}
              {editable && (
                <div className="role-foot">
                  {role && <button className="btn danger" onClick={() => setConfirm(true)} disabled={busy}><Icon name="trash" size={15} /> Delete role</button>}
                  <span className="grow" />
                  <button className="btn primary" onClick={save} disabled={busy || !dirty || (role && !draft.name.trim())}>{busy ? 'Saving…' : 'Save role'}</button>
                </div>
              )}
            </>
          )}
          {!draft && err && <div className="error">{err}</div>}
        </div>
      </div>
      {confirm && role && (
        <Modal title="Delete role" onClose={() => setConfirm(false)}>
          <p className="muted">Delete <b>{role.name}</b>? Everyone who has it loses it, and the permissions it gave.</p>
          {err && <div className="error">{err}</div>}
          <div className="modal-foot"><button className="btn" onClick={() => setConfirm(false)}>Cancel</button><button className="btn primary danger-fill" autoFocus disabled={busy} onClick={del}>Delete</button></div>
        </Modal>
      )}
    </>
  );
}

// Members: give people roles and remove them from the server.
export function MembersTab({ server, me, onChange }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // member id whose roles are being edited
  const [kick, setKick] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/servers/${server.id}`;
  const isOwner = server.ownerId === me.id;
  const myRank = rankOf(server, me.id);
  const canRoles = can(server, me.id, 'manageRoles');
  const canKick = can(server, me.id, 'kickMembers');
  const list = server.members.filter((u) => (u.username + ' ' + u.displayName).toLowerCase().includes(q.trim().toLowerCase()));
  const below = (u) => u.id !== server.ownerId && (isOwner || u.id === me.id || rankOf(server, u.id) > myRank);

  const run = async (fn) => {
    setErr(''); setBusy(true);
    try { const r = await fn(); onChange(r.server); return true; }
    catch (e) { setErr(e.message); return false; }
    finally { setBusy(false); }
  };
  const setRoles = (u, id, on) => {
    const have = heldRoles(server, u.id).map((r) => r.id);
    const next = on ? [...have, id] : have.filter((x) => x !== id);
    return run(() => api(`${base}/members/${u.id}/roles`, { method: 'PUT', body: { roles: next } }));
  };

  return (
    <>
      <h1>Members</h1>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search members…" />
      {err && <div className="error">{err}</div>}
      <div className="member-admin">
        {list.map((u) => {
          const held = heldRoles(server, u.id);
          const editable = canRoles && below(u);
          return (
            <div key={u.id} className="ma-item">
              <div className="ma-row">
                <Avatar user={u} size={34} />
                <div className="ma-who">
                  <b data-nc style={{ '--nc': held.find((r) => r.color)?.color || u.accentColor }}>{u.displayName}</b>
                  <span className="muted small"> @{u.username}</span>
                  {u.id === server.ownerId && <span className="owner" title="Server owner"><Icon name="crown" size={14} /></span>}
                  <div className="ma-roles">{held.map((r) => <span key={r.id} className="role-chip"><span className="role-dot" style={{ background: r.color || 'var(--muted)' }} />{r.name}</span>)}</div>
                </div>
                {canRoles && <button className="btn small-btn" disabled={!editable || busy} title={editable ? '' : 'Their role is at or above yours'} onClick={() => setOpen(open === u.id ? null : u.id)}>Roles</button>}
                {canKick && <button className="btn small-btn danger" disabled={busy || u.id === me.id || u.id === server.ownerId || (!isOwner && rankOf(server, u.id) <= myRank)} onClick={() => setKick(u)}>Kick</button>}
              </div>
              {open === u.id && editable && (
                <div className="ma-pick">
                  {(server.roles || []).length === 0 && <p className="muted small">No roles yet. Create one in the Roles tab.</p>}
                  {(server.roles || []).map((r) => {
                    const ok = belowMe(server, me.id, r.id);
                    return (
                      <label key={r.id} className={'ma-check' + (ok ? '' : ' off')}>
                        <input type="checkbox" checked={held.some((h) => h.id === r.id)} disabled={!ok || busy} onChange={(e) => setRoles(u, r.id, e.target.checked)} />
                        <span className="role-dot" style={{ background: r.color || 'var(--muted)' }} />{r.name}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {list.length === 0 && <p className="muted">No members match.</p>}
      </div>
      {kick && (
        <Modal title="Kick member" onClose={() => setKick(null)}>
          <p className="muted">Remove <b>{kick.displayName}</b> from {server.name}? They can join again with the invite link{server.visibility === 'private' ? ', unless the server is private and you do not add them back to its list' : ''}.</p>
          {err && <div className="error">{err}</div>}
          <div className="modal-foot"><button className="btn" onClick={() => setKick(null)}>Cancel</button>
            <button className="btn primary danger-fill" autoFocus disabled={busy} onClick={async () => { if (await run(() => api(`${base}/members/${kick.id}/kick`, { method: 'POST' }))) setKick(null); }}>Kick</button></div>
        </Modal>
      )}
    </>
  );
}
