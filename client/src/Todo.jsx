import React, { useState } from 'react';
import { Icon } from './ui.jsx';
import { Select } from './Controls.jsx';
import { api } from './api.js';
import { can, heldRoles, isOwner } from './perms.js';

// To-do channel (the Business template has one): a shared task list. Roles chosen by the server (plus the owner and anyone with Manage channels)
// add tasks, assign them to a role and delete them. Whoever holds the assigned role can tick the task off. Everyone in the server can read the list.
// The server repeats every check; this only decides what to show. Rules for who may do what: server/todo.js.
const MAX_TEXT = 200;

export default function TodoView({ server, channel, me, users, onChange, onBack, headerExtra }) {
  const roles = server.roles || [];
  const roleOf = (id) => roles.find((r) => r.id === id);
  const addRoles = channel.addRoles || [];
  const todos = channel.todos || [];
  const held = heldRoles(server, me.id).map((r) => r.id);
  const manage = can(server, me.id, 'manageChannels');
  const adder = isOwner(server, me.id) || manage || addRoles.some((id) => held.includes(id));
  const mayTick = (t) => adder || (!!t.roleId && held.includes(t.roleId));
  const [text, setText] = useState('');
  const [roleId, setRoleId] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/servers/${server.id}/channels/${channel.id}`;

  const run = async (path, method, body) => {
    setErr(''); setBusy(true);
    try { const { server: s } = await api(path, { method, body }); onChange(s); return true; }
    catch (e) { setErr(e.message); return false; }
    finally { setBusy(false); }
  };
  const add = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    if (await run(base + '/todos', 'POST', { text, roleId: roleId || null })) setText('');
  };
  const toggleAdder = (id) => run(base + '/todo-settings', 'PUT', { addRoles: addRoles.includes(id) ? addRoles.filter((x) => x !== id) : [...addRoles, id] });
  const open = todos.filter((t) => !t.done), done = todos.filter((t) => t.done);

  const row = (t) => {
    const r = roleOf(t.roleId);
    const who = t.done && t.doneBy ? users?.[t.doneBy]?.displayName : '';
    return (
      <li key={t.id} className={'todo-row' + (t.done ? ' done' : '')}>
        <button type="button" role="checkbox" aria-checked={t.done} className="todo-check" disabled={busy || !mayTick(t)}
          title={mayTick(t) ? (t.done ? 'Mark as not done' : 'Mark as done') : 'Only the assigned role or people who add tasks can tick this'}
          aria-label={(t.done ? 'Mark as not done: ' : 'Mark as done: ') + t.text} onClick={() => run(`${base}/todos/${t.id}`, 'PATCH', { done: !t.done })}>
          {t.done && <Icon name="check" size={14} />}
        </button>
        <div className="todo-main">
          <span className="todo-text">{t.text}</span>
          <span className="todo-meta">
            {r ? <span className="todo-role" style={r.color ? { '--rc': r.color } : undefined}>{r.name}</span> : <span className="muted small">Anyone</span>}
            {who && <span className="muted small">Done by {who}</span>}
          </span>
        </div>
        {adder && (
          <span className="todo-tools">
            <Select className="todo-assign" value={t.roleId || ''} aria-label={`Assign "${t.text}" to a role`} disabled={busy} onChange={(e) => run(`${base}/todos/${t.id}`, 'PATCH', { roleId: e.target.value || null })}>
              <option value="">Anyone</option>
              {roles.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
            <button type="button" className="icon-btn" title="Delete task" aria-label={`Delete task: ${t.text}`} disabled={busy} onClick={() => run(`${base}/todos/${t.id}`, 'DELETE')}><Icon name="trash" size={16} /></button>
          </span>
        )}
      </li>
    );
  };

  return (
    <section className="chat todo-panel">
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title="Back" aria-label="Back to list" onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash"><Icon name="todo" size={20} /></span>
        <h3>{channel.name}</h3>
        <div className="spacer" />
        {headerExtra}
      </header>
      <div className="todo-body">
        <div className="todo-inner">
          <h2>Tasks</h2>
          <p className="muted todo-count">{open.length} open{done.length ? ` · ${done.length} done` : ''}</p>

          {adder ? (
            <form className="todo-add" onSubmit={add}>
              <input value={text} maxLength={MAX_TEXT} placeholder="Add a task" aria-label="New task" onChange={(e) => { setText(e.target.value); setErr(''); }} />
              <Select className="todo-assign" value={roleId} aria-label="Assign the new task to a role" onChange={(e) => setRoleId(e.target.value)}>
                <option value="">Anyone</option>
                {roles.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
              <button className="btn primary" disabled={busy || !text.trim()}>Add</button>
            </form>
          ) : (
            <p className="muted small todo-hint">You can tick tasks assigned to your role. Only roles chosen for this channel can add tasks.</p>
          )}
          {err && <div className="error" role="alert">{err}</div>}

          {todos.length === 0 && <p className="muted">{adder ? 'No tasks yet. Add the first one above.' : 'No tasks yet.'}</p>}
          {open.length > 0 && <ul className="todo-list">{open.map(row)}</ul>}
          {done.length > 0 && (<><h4 className="todo-sub">Done</h4><ul className="todo-list">{done.map(row)}</ul></>)}

          {manage && (
            <details className="todo-settings">
              <summary>Who can add tasks</summary>
              <p className="muted small">The owner and anyone with Manage channels can always add tasks. Pick the roles that can too.</p>
              {roles.length === 0 && <p className="muted small">This server has no roles yet. Make some in Server settings.</p>}
              {roles.map((r) => (
                <label key={r.id} className="todo-pick">
                  <input type="checkbox" checked={addRoles.includes(r.id)} disabled={busy} onChange={() => toggleAdder(r.id)} />
                  <span className="todo-role" style={r.color ? { '--rc': r.color } : undefined}>{r.name}</span>
                </label>
              ))}
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
