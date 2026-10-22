import React, { useEffect, useRef, useState } from 'react';
import { Icon, Modal } from './ui.jsx';

// Polls on channel messages (rules and storage: server/polls.js). The server owns the truth: a vote is sent, and the new tallies
// come back to everyone in the channel as `poll:update`, so what you see is always what was counted.

const MAX_OPTIONS = 10, MAX_QUESTION = 300, MAX_OPTION = 100;
const DURATIONS = [['', 'No time limit'], ['1', '1 hour'], ['6', '6 hours'], ['24', '1 day'], ['72', '3 days'], ['168', '7 days']];

const pollEnded = (poll, now = Date.now()) => poll.closed === true || (typeof poll.closesAt === 'number' && poll.closesAt <= now);

function timeLeft(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  const d = Math.floor(h / 24);
  return d + ' d' + (h % 24 ? ' ' + (h % 24) + ' h' : '');
}

export function PollCard({ m, users, me, onVote, onClose, canClose }) {
  const poll = m.poll;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false); // state only changes after a re-render, so two clicks in the same moment could both pass a `busy` check
  const [err, setErr] = useState('');
  const [, tick] = useState(0);
  const ended = pollEnded(poll);
  // when the time limit passes, redraw once so the poll switches to its final results without anyone reloading
  useEffect(() => {
    if (ended || typeof poll.closesAt !== 'number') return undefined;
    const t = setTimeout(() => tick((n) => n + 1), Math.min(Math.max(poll.closesAt - Date.now(), 0) + 50, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [ended, poll.closesAt]);

  const mine = poll.options.filter((o) => o.votes.includes(me.id)).map((o) => o.id);
  const voters = new Set(poll.options.flatMap((o) => o.votes));
  const total = voters.size;
  const top = ended ? Math.max(...poll.options.map((o) => o.votes.length)) : -1;

  async function pick(id) {
    if (ended || busyRef.current) return;
    const next = poll.multi ? (mine.includes(id) ? mine.filter((x) => x !== id) : [...mine, id]) : (mine.includes(id) ? [] : [id]);
    busyRef.current = true; setBusy(true); setErr('');
    try { await onVote(m.id, next); } catch (e) { setErr(e.message || 'Could not vote'); } finally { busyRef.current = false; setBusy(false); }
  }
  async function endNow() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setErr('');
    try { await onClose(m.id); } catch (e) { setErr(e.message || 'Could not end the poll'); } finally { busyRef.current = false; setBusy(false); }
  }
  const names = (o) => o.votes.slice(0, 12).map((id) => users[id]?.displayName || 'Someone').join(', ') + (o.votes.length > 12 ? ` and ${o.votes.length - 12} more` : '');

  return (
    <div className={'poll' + (ended ? ' ended' : '')}>
      <div className="poll-q"><Icon name="poll" size={16} className="inline-icon" /> {poll.question}</div>
      <div className="poll-sub muted small">{ended ? 'Final results' : poll.multi ? 'Select one or more' : 'Select one'}</div>
      <div className="poll-opts" role={poll.multi ? 'group' : 'radiogroup'} aria-label={poll.question}>
        {poll.options.map((o) => {
          const n = o.votes.length, pct = total ? Math.round((n / total) * 100) : 0, sel = mine.includes(o.id);
          return (
            <button key={o.id} type="button" className={'poll-opt' + (sel ? ' sel' : '') + (ended && n === top && n > 0 ? ' win' : '')} disabled={ended || busy}
              role={poll.multi ? 'checkbox' : 'radio'} aria-checked={sel} title={n ? names(o) : 'No votes yet'} onClick={() => pick(o.id)}>
              <i className="poll-fill" style={{ width: pct + '%' }} />
              <span className={'poll-mark' + (poll.multi ? ' sq' : '')}>{sel && <Icon name="check" size={12} />}</span>
              <span className="poll-text">{o.text}</span>
              <span className="poll-num">{n} · {pct}%</span>
            </button>
          );
        })}
      </div>
      <div className="poll-foot muted small">
        <span>{total} {total === 1 ? 'person' : 'people'} voted</span>
        {!ended && typeof poll.closesAt === 'number' && <span> · ends in {timeLeft(poll.closesAt - Date.now())}</span>}
        {ended && poll.closed && <span> · ended by {users[poll.closedBy]?.displayName || 'someone'}</span>}
        {ended && !poll.closed && <span> · time is up</span>}
        {!ended && canClose && <button type="button" className="poll-end" disabled={busy} onClick={endNow}>End poll</button>}
      </div>
      {err && <div className="error-text small">{err}</div>}
    </div>
  );
}

export function PollModal({ onSubmit, onClose }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const [hours, setHours] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const dup = new Set(filled.map((o) => o.toLowerCase())).size !== filled.length;
  const ready = question.trim() && filled.length >= 2 && !dup && !busy;
  const setOpt = (i, v) => setOptions((l) => l.map((x, j) => (j === i ? v : x)));

  async function submit(e) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setErr('');
    try { await onSubmit({ question: question.trim(), options: filled, multi, hours: hours ? Number(hours) : null }); onClose(); }
    catch (ex) { setErr(ex.message || 'Could not post the poll'); setBusy(false); }
  }

  return (
    <Modal title="Create a poll" onClose={onClose}>
      <form onSubmit={submit}>
        <label>QUESTION</label>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} autoFocus maxLength={MAX_QUESTION} placeholder="What should we play tonight?" />
        <label>ANSWERS</label>
        <div className="poll-edit">
          {options.map((o, i) => (
            <div className="poll-edit-row" key={i}>
              <input value={o} onChange={(e) => setOpt(i, e.target.value)} maxLength={MAX_OPTION} placeholder={'Answer ' + (i + 1)} aria-label={'Answer ' + (i + 1)} />
              {options.length > 2 && <button type="button" className="icon-btn" title="Remove answer" aria-label={'Remove answer ' + (i + 1)} onClick={() => setOptions((l) => l.filter((_, j) => j !== i))}><Icon name="close" size={15} /></button>}
            </div>
          ))}
        </div>
        {options.length < MAX_OPTIONS && <button type="button" className="btn small-btn poll-add" onClick={() => setOptions((l) => [...l, ''])}><Icon name="plus" size={13} className="inline-icon" /> Add an answer</button>}
        {dup && <p className="error-text small">Every answer must be different.</p>}
        <label className="check-row"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> Allow picking more than one answer</label>
        <label>DURATION</label>
        <select value={hours} onChange={(e) => setHours(e.target.value)}>
          {DURATIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
        <p className="hint">Everyone in the channel can see who voted for what. You (or anyone who can manage messages) can end it early.</p>
        {err && <div className="error">{err}</div>}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ready}>{busy ? 'Posting…' : 'Post poll'}</button>
        </div>
      </form>
    </Modal>
  );
}
