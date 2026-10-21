import React, { useState } from 'react';
import { Avatar, Icon, STATUS_LABEL } from './ui.jsx';

const TABS = [['all', 'All'], ['online', 'Online'], ['pending', 'Pending'], ['add', 'Add Friend']];

// Friends list order: Online, then Idle, then Offline, then Do Not Disturb.
const STATUS_ORDER = { online: 0, idle: 1, offline: 2, dnd: 3 };
const rankOf = (st) => (st in STATUS_ORDER ? STATUS_ORDER[st] : STATUS_ORDER.offline);

export default function Friends({ fr, statusOf, onMessage, onUser, onRequest, onAccept, onRemove, onBack }) {
  const [tab, setTab] = useState('all');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState(null); // { ok, text }
  const [busy, setBusy] = useState(false);

  const byStatus = (a, b) =>
    rankOf(statusOf(a.id)) - rankOf(statusOf(b.id)) || a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  const sorted = [...fr.friends].sort(byStatus);
  const online = sorted.filter((u) => statusOf(u.id) !== 'offline');
  const shown = tab === 'online' ? online : sorted;
  const pending = fr.incoming.length + fr.outgoing.length;

  async function add(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const r = await onRequest(name.trim());
      setMsg({ ok: true, text: r.result === 'friends' ? `You and ${r.user.displayName} are now friends!` : `Friend request sent to ${r.user.displayName}.` });
      setName('');
    } catch (err) { setMsg({ ok: false, text: err.message }); }
    setBusy(false);
  }

  const row = (u, sub, actions, onMain = () => onUser(u.id)) => (
    <div className="frow" key={u.id}>
      <button className="frow-main" onClick={onMain}>
        <Avatar user={u} size={36} presence={statusOf(u.id)} />
        <div className="frow-text">
          <b data-nc style={{ '--nc': u.accentColor }}>{u.displayName}</b><span className="muted"> @{u.username}</span>
          <div className="muted small">{sub}</div>
        </div>
      </button>
      <div className="frow-actions">{actions}</div>
    </div>
  );

  return (
    <section className="chat">
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title="Back" aria-label="Back to list" onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash"><Icon name="users" size={20} /></span>
        <h3 className="fh">Friends</h3>
        <div className="ftabs">
          {TABS.map(([k, label]) => (
            <button key={k} className={'ftab' + (tab === k ? ' on' : '') + (k === 'add' ? ' add' : '')} onClick={() => { setTab(k); setMsg(null); }}>
              {label}{k === 'pending' && fr.incoming.length > 0 && <span className="badge inline">{fr.incoming.length}</span>}
            </button>
          ))}
        </div>
      </header>

      <div className="friends-body">
        {tab === 'add' && (
          <form onSubmit={add} className="add-friend">
            <h3>Add Friend</h3>
            <p className="muted">You can add friends with their Aduna username.</p>
            <div className="add-row">
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter a username" maxLength={21} />
              <button className="btn primary" disabled={busy || !name.trim()}>Send Friend Request</button>
            </div>
            {msg && <p className={msg.ok ? 'ok-text' : 'error-text'}>{msg.text}</p>}
          </form>
        )}

        {(tab === 'online' || tab === 'all') && (
          <>
            <div className="side-label">{tab === 'online' ? 'ONLINE' : 'ALL FRIENDS'} — {shown.length}</div>
            {shown.map((u) => row(u, STATUS_LABEL[statusOf(u.id)],
              <>
                <button className="icon-btn" title="Message" onClick={() => onMessage(u)}><Icon name="message" size={17} /></button>
                <button className="icon-btn" title="Remove friend" onClick={() => confirm(`Remove ${u.displayName} from your friends?`) && onRemove(u.id)}><Icon name="close" size={16} /></button>
              </>,
              () => onMessage(u)))}
            {shown.length === 0 && (
              <div className="friends-empty">
                <p className="muted">{fr.friends.length === 0 ? 'No friends yet. Add someone by their username to start chatting.' : 'No one is online right now.'}</p>
                {fr.friends.length === 0 && <button className="btn primary" onClick={() => setTab('add')}>Add Friend</button>}
              </div>
            )}
          </>
        )}

        {tab === 'pending' && (
          <>
            {pending === 0 && <div className="friends-empty"><p className="muted">There are no pending friend requests.</p></div>}
            {fr.incoming.length > 0 && <div className="side-label">INCOMING — {fr.incoming.length}</div>}
            {fr.incoming.map(({ user }) => row(user, 'Incoming friend request',
              <>
                <button className="icon-btn ok" title="Accept" onClick={() => onAccept(user.id)}><Icon name="check" size={17} /></button>
                <button className="icon-btn" title="Decline" onClick={() => onRemove(user.id)}><Icon name="close" size={16} /></button>
              </>))}
            {fr.outgoing.length > 0 && <div className="side-label">OUTGOING — {fr.outgoing.length}</div>}
            {fr.outgoing.map(({ user }) => row(user, 'Outgoing friend request',
              <button className="icon-btn" title="Cancel request" onClick={() => onRemove(user.id)}><Icon name="close" size={16} /></button>))}
          </>
        )}
      </div>
    </section>
  );
}
