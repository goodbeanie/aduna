import React, { useState } from 'react';
import { Icon } from './ui.jsx';
import { api } from './api.js';

// Goals channel: goals the owner (or anyone with Manage server) writes and keeps up to date by hand; everyone in the server sees them.
// A goal with a target is a progress bar, one without is a checkbox. The server repeats every check; rules: server/goals.js.
const n = (x) => Number(x).toLocaleString('en-US');
const pct = (g) => (g.target > 0 ? Math.min(100, Math.floor((g.progress / g.target) * 100)) : g.done ? 100 : 0);

export default function GoalsView({ server, channel, canEdit, onChange, onBack, headerExtra }) {
  const goals = channel.goals || [];
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [editing, setEditing] = useState(null); // { id, title, target }
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/servers/${server.id}/channels/${channel.id}/goals`;

  const run = async (path, method, body) => {
    setErr(''); setBusy(true);
    try { const { server: s } = await api(path, { method, body }); onChange(s); return true; }
    catch (e) { setErr(e.message); return false; }
    finally { setBusy(false); }
  };
  const asTarget = (v) => (String(v).trim() === '' ? 0 : Number(v));
  const add = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (await run(base, 'POST', { title, target: asTarget(target) })) { setTitle(''); setTarget(''); }
  };
  const save = async (e) => {
    e.preventDefault();
    if (editing.title.trim() && await run(`${base}/${editing.id}`, 'PATCH', { title: editing.title, target: asTarget(editing.target) })) setEditing(null);
  };
  const setProgress = (g, v) => { const x = Number(v); if (String(v).trim() !== '' && Number.isInteger(x) && x >= 0 && x !== g.progress) run(`${base}/${g.id}`, 'PATCH', { progress: x }); };

  const done = goals.filter((g) => g.done).length;
  return (
    <section className="chat goals-panel">
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title="Back" aria-label="Back to list" onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash"><Icon name="goal" size={20} /></span>
        <h3>{channel.name}</h3>
        <div className="spacer" />
        {headerExtra}
      </header>
      <div className="goals-body">
        <div className="goals-inner">
          <h2>Goals of {server.name}</h2>
          {goals.length > 0 && <p className="muted goals-count">{done} of {goals.length} reached</p>}
          {goals.length === 0 && <p className="muted">{canEdit ? 'No goals yet. Add the first one below.' : 'The owner has not set any goals yet.'}</p>}

          <ul className="goals-list">
            {goals.map((g) => (
              <li key={g.id} className={'goal' + (g.done ? ' done' : '')}>
                {editing?.id === g.id ? (
                  <form className="goal-edit" onSubmit={save}>
                    <input autoFocus value={editing.title} maxLength={80} aria-label="Goal" onChange={(e) => setEditing({ ...editing, title: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }} />
                    <input type="number" min="0" step="1" value={editing.target} placeholder="Target (empty = checkbox)" aria-label="Target" onChange={(e) => setEditing({ ...editing, target: e.target.value })} />
                    <div className="goal-actions"><button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button><button className="btn primary" disabled={busy || !editing.title.trim()}>Save</button></div>
                  </form>
                ) : (
                  <>
                    <div className="goal-top">
                      <span className="goal-title">{g.title}</span>
                      {g.done && <span className="goal-tag">Reached</span>}
                      {canEdit && (
                        <span className="goal-tools">
                          <button type="button" className="icon-btn" title="Edit goal" aria-label={`Edit goal: ${g.title}`} onClick={() => setEditing({ id: g.id, title: g.title, target: g.target || '' })}><Icon name="edit" size={16} /></button>
                          <button type="button" className="icon-btn" title="Delete goal" aria-label={`Delete goal: ${g.title}`} disabled={busy} onClick={() => run(`${base}/${g.id}`, 'DELETE')}><Icon name="trash" size={16} /></button>
                        </span>
                      )}
                    </div>
                    {g.target > 0 ? (
                      <>
                        <div className="goal-track" role="progressbar" aria-label={g.title} aria-valuemin={0} aria-valuemax={g.target} aria-valuenow={g.progress}><i style={{ width: pct(g) + '%' }} /></div>
                        <div className="goal-line">
                          <span className="muted">{n(g.progress)} / {n(g.target)} · {pct(g)}%</span>
                          {canEdit && (
                            <span className="goal-step">
                              <button type="button" className="btn" disabled={busy || g.progress <= 0} aria-label="Take one off" onClick={() => run(`${base}/${g.id}`, 'PATCH', { progress: g.progress - 1 })}>−1</button>
                              <button type="button" className="btn" disabled={busy || g.progress >= g.target} aria-label="Add one" onClick={() => run(`${base}/${g.id}`, 'PATCH', { progress: g.progress + 1 })}>+1</button>
                              <input type="number" min="0" max={g.target} step="1" aria-label="Set progress" key={g.id + ':' + g.progress} defaultValue={g.progress} disabled={busy}
                                onBlur={(e) => setProgress(g, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setProgress(g, e.target.value); } }} />
                            </span>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="goal-line">
                        <button type="button" role="checkbox" aria-checked={g.done} className="todo-check" disabled={busy || !canEdit} aria-label={(g.done ? 'Not reached yet: ' : 'Mark as reached: ') + g.title}
                          title={canEdit ? (g.done ? 'Mark as not reached' : 'Mark as reached') : undefined} onClick={() => run(`${base}/${g.id}`, 'PATCH', { done: !g.done })}>
                          {g.done && <Icon name="check" size={14} />}
                        </button>
                        <span className="muted">{g.done ? 'Done' : 'Not yet'}</span>
                      </div>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
          {err && <div className="error" role="alert">{err}</div>}

          {canEdit && (goals.length < 20 ? (
            <form className="goal-add" onSubmit={add}>
              <input value={title} maxLength={80} placeholder="Add a goal, like “Reach 100 members”" aria-label="New goal" onChange={(e) => { setTitle(e.target.value); setErr(''); }} />
              <input type="number" min="1" step="1" value={target} placeholder="Target (optional)" aria-label="Target number" onChange={(e) => setTarget(e.target.value)} />
              <button className="btn primary" disabled={busy || !title.trim()}>Add goal</button>
            </form>
          ) : <p className="muted small">Goal limit reached (20).</p>)}
          {canEdit && <p className="muted small goal-hint">A goal with a target number shows a progress bar you move by hand. Leave the target empty for a plain checkbox.</p>}
        </div>
      </div>
    </section>
  );
}
