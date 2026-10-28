import React, { useState } from 'react';
import { Avatar, BadgeIcons, Icon, Modal } from './ui.jsx';
import { askConfirm, toast } from './Dialogs.jsx';
import { NAME_MAX } from './groupkeys.js';

export const MAX_GROUP = 20; // people in one group chat (server/groups.js)

// A group has no picture: a round tile with the people icon on a tint that is stable per group.
export function GroupIcon({ group, size = 32 }) {
  let hue = 0;
  for (const ch of String(group?.id || '')) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return <span className="group-icon" style={{ width: size, height: size, '--sh': hue }}><Icon name="users" size={Math.round(size * 0.55)} /></span>;
}

const matches = (u, q) => (u.username + ' ' + u.displayName).toLowerCase().includes(q.trim().toLowerCase());

// Pick two or more friends (and, if you like, a name). Everything is encrypted in the browser by `onCreate` (useGroups.create).
export function NewGroupModal({ friends, onClose, onCreate }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pool = friends.filter((u) => !u.bot);
  const list = pool.filter((u) => matches(u, q));
  const toggle = (u) => setPicked((p) => (p.includes(u.id) ? p.filter((x) => x !== u.id) : p.length >= MAX_GROUP - 1 ? p : [...p, u.id]));
  async function create() {
    setBusy(true); setErr('');
    try { await onCreate(pool.filter((f) => picked.includes(f.id)), name.trim()); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title="New group chat" onClose={onClose}>
      {pool.length < 2 ? <p className="muted">A group is you and at least two friends. Add friends from the Friends page first; for one person, send a direct message.</p> : (
        <>
          <label className="gc-label" htmlFor="gc-name">Group name <span className="muted">(optional)</span></label>
          <input id="gc-name" value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="Weekend plans" />
          <div className="gc-label">Add friends <span className="muted">{picked.length} chosen · pick at least 2</span></div>
          {picked.length > 0 && (
            <div className="gc-picked">
              {picked.map((id) => { const u = pool.find((x) => x.id === id); return u && (
                <button key={id} className="gc-chip" onClick={() => toggle(u)} title={'Remove ' + u.displayName}><Avatar user={u} size={20} />{u.displayName}<Icon name="close" size={12} /></button>
              ); })}
            </div>
          )}
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your friends…" aria-label="Search your friends" />
          <div className="results gc-results">
            {list.map((u) => {
              const on = picked.includes(u.id), noKey = !u.publicKey;
              return (
                <button key={u.id} className={'result gc-row' + (on ? ' on' : '')} disabled={noKey} aria-pressed={on} onClick={() => toggle(u)}>
                  <Avatar user={u} size={32} />
                  <div className="grow"><b>{u.displayName}</b><span className="muted"> @{u.username}</span>{noKey && <div className="muted small">Has not set up encryption yet</div>}</div>
                  <span className={'gc-check' + (on ? ' on' : '')} aria-hidden="true">{on && <Icon name="check" size={14} />}</span>
                </button>
              );
            })}
            {list.length === 0 && <p className="muted">No friends match.</p>}
          </div>
          <p className="muted small gc-note"><Icon name="lock" size={13} className="inline-icon" /> Group messages are end-to-end encrypted. Only the people in the group can read them, and new people cannot read what was said before they joined.</p>
          {err && <div className="error">{err}</div>}
          <div className="modal-foot">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy || picked.length < 2} onClick={create}>{busy ? 'Creating…' : 'Create group'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// The group's people and settings: rename, add friends, (owner) remove people or delete, leave.
export function GroupInfoModal({ group, title, me, users, friends, statusOf, onClose, onRename, onAdd, onKick, onLeave, onDelete, onUser }) {
  const [name, setName] = useState(group.name || '');
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const isOwner = group.ownerId === me.id;
  const inGroup = new Set(group.members.map((m) => m.id));
  const room = MAX_GROUP - group.members.length;
  const candidates = friends.filter((u) => !u.bot && !inGroup.has(u.id) && matches(u, q));
  const run = async (what, fn, done) => {
    setBusy(what); setErr('');
    try { await fn(); done?.(); } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };
  const people = [...group.members].sort((a, b) => (b.id === group.ownerId) - (a.id === group.ownerId) || a.displayName.localeCompare(b.displayName));

  async function leave() {
    const last = group.members.length <= 2;
    if (!(await askConfirm({ title: 'Leave group', body: last ? `If you leave, ${title} is deleted, because only one other person would be left. Continue?` : `Leave ${title}? You will not be able to read new messages, and the others keep the history.`, confirmLabel: 'Leave', danger: true }))) return;
    run('leave', () => onLeave(), onClose);
  }
  async function destroy() {
    if (!(await askConfirm({ title: 'Delete group', body: `Delete ${title} for everyone? Its messages and files are removed and this cannot be undone.`, confirmLabel: 'Delete group', danger: true }))) return;
    run('delete', () => onDelete(), onClose);
  }
  async function kick(u) {
    if (!(await askConfirm({ title: 'Remove from group', body: `Remove ${u.displayName} from ${title}? They keep what they already read, but cannot read anything new.`, confirmLabel: 'Remove', danger: true }))) return;
    run('kick:' + u.id, () => onKick(u.id));
  }

  return (
    <Modal title="Group info" onClose={onClose}>
      <div className="gc-head">
        <GroupIcon group={group} size={56} />
        <div className="grow">
          {group.canRead ? (
            <div className="gc-rename">
              <input value={name} maxLength={NAME_MAX} placeholder={title} aria-label="Group name" onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() !== (group.name || '')) run('rename', () => onRename(name.trim())); }} />
              <button className="btn" disabled={busy === 'rename' || name.trim() === (group.name || '')} onClick={() => run('rename', () => onRename(name.trim()))}>Save</button>
            </div>
          ) : <b>{title}</b>}
          <div className="muted small">{group.members.length} people · <Icon name="lock" size={12} className="inline-icon" /> End-to-end encrypted</div>
        </div>
      </div>

      {!group.canRead && <div className="gc-warn" role="status"><Icon name="alert" size={16} /><span>You cannot read this group on this device yet. Another member’s Aduna will refresh its keys when they are online, and then new messages will open.</span></div>}

      <div className="gc-label">People · {group.members.length}</div>
      <div className="results gc-members">
        {people.map((m) => {
          const u = users[m.id] || m;
          return (
            <div key={m.id} className="result gc-member">
              <button className="gc-who" onClick={() => onUser(m.id)} title="View profile">
                <Avatar user={u} size={32} presence={statusOf(m.id) !== 'offline' ? statusOf(m.id) : undefined} />
                <span className="grow"><b>{u.displayName}</b>{m.id === me.id && <span className="muted"> (you)</span>}<BadgeIcons user={u} size={16} /></span>
              </button>
              {group.ownerId === m.id && <span className="owner" title="Owns this group"><Icon name="crown" size={15} /></span>}
              {isOwner && m.id !== me.id && <button className="icon-btn" title={'Remove ' + u.displayName} aria-label={'Remove ' + u.displayName} disabled={!!busy} onClick={() => kick(u)}><Icon name="close" size={15} /></button>}
            </div>
          );
        })}
      </div>

      {room > 0 && (
        adding ? (
          <>
            <div className="gc-label">Add friends <span className="muted">room for {room} more</span></div>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your friends…" aria-label="Search your friends" />
            <div className="results gc-results">
              {candidates.map((u) => {
                const on = picked.includes(u.id), noKey = !u.publicKey;
                return (
                  <button key={u.id} className={'result gc-row' + (on ? ' on' : '')} disabled={noKey} aria-pressed={on}
                    onClick={() => setPicked((p) => (p.includes(u.id) ? p.filter((x) => x !== u.id) : p.length >= room ? p : [...p, u.id]))}>
                    <Avatar user={u} size={32} />
                    <div className="grow"><b>{u.displayName}</b><span className="muted"> @{u.username}</span>{noKey && <div className="muted small">Has not set up encryption yet</div>}</div>
                    <span className={'gc-check' + (on ? ' on' : '')} aria-hidden="true">{on && <Icon name="check" size={14} />}</span>
                  </button>
                );
              })}
              {candidates.length === 0 && <p className="muted">No friends left to add.</p>}
            </div>
            <p className="muted small gc-note">New people cannot read what was said before they joined.</p>
            <div className="gc-actions">
              <button className="btn" onClick={() => { setAdding(false); setPicked([]); setQ(''); }}>Cancel</button>
              <button className="btn primary" disabled={!picked.length || busy === 'add'} onClick={() => run('add', () => onAdd(friends.filter((f) => picked.includes(f.id))), () => { setAdding(false); setPicked([]); setQ(''); toast('Added to the group'); })}>Add {picked.length || ''}</button>
            </div>
          </>
        ) : <button className="btn gc-add" onClick={() => setAdding(true)}><Icon name="plus" size={15} className="inline-icon" /> Add people</button>
      )}

      {err && <div className="error">{err}</div>}
      <div className="modal-foot gc-foot">
        <button className="btn danger-text" disabled={!!busy} onClick={leave}>Leave group</button>
        {isOwner && <button className="btn danger-text" disabled={!!busy} onClick={destroy}>Delete group</button>}
        <div className="spacer" />
        <button className="btn" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
