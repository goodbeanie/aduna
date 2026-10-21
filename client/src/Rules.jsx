import React, { useState } from 'react';
import { Icon } from './ui.jsx';
import { api } from './api.js';

// Rules channel: a numbered list. The owner adds with +, edits in place, and deletes; everyone else reads.
export default function RulesView({ server, channel, isOwner, onChange, onBack, headerExtra }) {
  const rules = channel.rules || [];
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(null); // { id, text }
  const [err, setErr] = useState('');
  const base = `/servers/${server.id}/channels/${channel.id}/rules`;
  const run = async (path, method, body) => {
    setErr('');
    try { const { server: s } = await api(path, { method, body }); onChange(s); return true; }
    catch (e) { setErr(e.message); return false; }
  };
  const add = async (e) => { e.preventDefault(); if (draft.trim() && await run(base, 'POST', { text: draft })) { setDraft(''); setAdding(false); } };
  const save = async (e) => { e.preventDefault(); if (editing.text.trim() && await run(`${base}/${editing.id}`, 'PATCH', { text: editing.text })) setEditing(null); };

  return (
    <section className="chat rules-panel">
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title="Back" aria-label="Back to list" onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash"><Icon name="rules" size={20} /></span>
        <h3>{channel.name}</h3>
        <div className="spacer" />
        {headerExtra}
      </header>
      <div className="rules-body">
        <div className="rules-inner">
          <h2>Rules of {server.name}</h2>
          {rules.length === 0 && <p className="muted">{isOwner ? 'No rules yet. Press + to add the first one.' : 'The owner has not added any rules yet.'}</p>}
          <ol className="rules-list">
            {rules.map((r) => (
              <li key={r.id}>
                {editing?.id === r.id ? (
                  <form className="rule-edit" onSubmit={save}>
                    <textarea autoFocus value={editing.text} maxLength={300} rows={2} onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); if (e.key === 'Enter' && !e.shiftKey) save(e); }} />
                    <div className="rule-actions"><button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button><button className="btn primary">Save</button></div>
                  </form>
                ) : (
                  <>
                    <span className="rule-text">{r.text}</span>
                    {isOwner && (
                      <span className="rule-tools">
                        <button className="icon-btn" title="Edit rule" aria-label="Edit rule" onClick={() => setEditing({ id: r.id, text: r.text })}><Icon name="edit" size={16} /></button>
                        <button className="icon-btn" title="Delete rule" aria-label="Delete rule" onClick={() => run(`${base}/${r.id}`, 'DELETE')}><Icon name="trash" size={16} /></button>
                      </span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ol>
          {err && <div className="error">{err}</div>}
          {isOwner && (adding ? (
            <form className="rule-edit" onSubmit={add}>
              <textarea autoFocus value={draft} maxLength={300} rows={2} placeholder="Write a rule" onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setAdding(false); setDraft(''); } if (e.key === 'Enter' && !e.shiftKey) add(e); }} />
              <div className="rule-actions"><button type="button" className="btn" onClick={() => { setAdding(false); setDraft(''); }}>Cancel</button><button className="btn primary" disabled={!draft.trim()}>Add rule</button></div>
            </form>
          ) : (
            rules.length < 25
              ? <button className="add-rule" onClick={() => setAdding(true)}><Icon name="plus" size={18} /><span>Add rule</span></button>
              : <p className="muted small">Rule limit reached (25).</p>
          ))}
        </div>
      </div>
    </section>
  );
}
