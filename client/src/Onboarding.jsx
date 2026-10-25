import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon } from './ui.jsx';

const LIMITS = { questions: 5, options: 8, roles: 5 };
const blank = () => ({ enabled: false, required: false, welcome: '', questions: [] });
const newOption = () => ({ key: Math.random().toString(36).slice(2), label: '', emoji: '', roles: [] });
const newQuestion = () => ({ key: Math.random().toString(36).slice(2), title: '', multi: false, required: false, options: [newOption(), newOption()] });
// keep a stable React key for rows (the server assigns ids; new rows have none yet)
const withKeys = (c) => ({ ...blank(), ...c, questions: (c?.questions || []).map((q) => ({ ...q, key: q.id, options: q.options.map((o) => ({ ...o, key: o.id })) })) });
const strip = (c) => ({ ...c, questions: c.questions.map(({ key, ...q }) => ({ ...q, options: q.options.map(({ key: k, ...o }) => o) })) });

// ---------- owner: Server settings > Onboarding ----------
export function OnboardingTab({ server, onChange }) {
  const [draft, setDraft] = useState(() => withKeys(server.onboarding));
  const [saved, setSaved] = useState(() => JSON.stringify(strip(withKeys(server.onboarding))));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const plainRoles = (server.roles || []).filter((r) => r.perms.length === 0); // an answer may only hand out roles that carry no permissions
  const dirty = JSON.stringify(strip(draft)) !== saved;

  const setQ = (i, patch) => setDraft((d) => ({ ...d, questions: d.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) }));
  const setO = (i, k, patch) => setDraft((d) => ({ ...d, questions: d.questions.map((q, j) => (j === i ? { ...q, options: q.options.map((o, m) => (m === k ? { ...o, ...patch } : o)) } : q)) }));
  const move = (i, dir) => setDraft((d) => {
    const qs = [...d.questions], j = i + dir;
    if (j < 0 || j >= qs.length) return d;
    [qs[i], qs[j]] = [qs[j], qs[i]];
    return { ...d, questions: qs };
  });
  const toggleRole = (i, k, rid) => {
    const cur = draft.questions[i].options[k].roles;
    if (!cur.includes(rid) && cur.length >= LIMITS.roles) return;
    setO(i, k, { roles: cur.includes(rid) ? cur.filter((x) => x !== rid) : [...cur, rid] });
  };

  async function save() {
    setErr(''); setBusy(true);
    try {
      const r = await api(`/servers/${server.id}/onboarding`, { method: 'PUT', body: strip(draft) });
      const next = withKeys(r.server.onboarding);
      setDraft(next); setSaved(JSON.stringify(strip(next)));
      onChange(r.server);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="onb-tab">
      <p className="muted small hint">New members answer a few questions when they join. Each answer can give them roles, so people sort themselves into the right groups. Answers can only give roles that have no permissions.</p>
      <label className="check-row"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> <span><b>Turn onboarding on</b></span></label>
      <label className="check-row"><input type="checkbox" checked={draft.required} onChange={(e) => setDraft({ ...draft, required: e.target.checked })} /> <span className="onb-check-text"><b>Make it required for new members</b><span className="muted small"> People who join after you turn this on must answer before they can look around. Members already here are asked but can skip.</span></span></label>
      <label>WELCOME MESSAGE</label>
      <textarea rows={3} maxLength={500} aria-label="Welcome message" value={draft.welcome} onChange={(e) => setDraft({ ...draft, welcome: e.target.value })} placeholder="Welcome! Tell us a bit about yourself." />

      <label>QUESTIONS ({draft.questions.length}/{LIMITS.questions})</label>
      {plainRoles.length === 0 && <p className="muted small hint">You have no roles without permissions yet. Create some in the Roles tab (leave every permission off), then pick them for answers here.</p>}
      {draft.questions.map((q, i) => (
        <div className="onb-q" key={q.key}>
          <div className="onb-q-head">
            <input className="grow" value={q.title} maxLength={120} placeholder="Question, for example: What are you into?" aria-label={`Question ${i + 1}`} onChange={(e) => setQ(i, { title: e.target.value })} />
            <button className="icon-btn" title="Move up" aria-label="Move question up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="chevron" size={16} className="flip" /></button>
            <button className="icon-btn" title="Move down" aria-label="Move question down" disabled={i === draft.questions.length - 1} onClick={() => move(i, 1)}><Icon name="chevron" size={16} /></button>
            <button className="icon-btn" title="Delete question" aria-label="Delete question" onClick={() => setDraft({ ...draft, questions: draft.questions.filter((_, j) => j !== i) })}><Icon name="trash" size={16} /></button>
          </div>
          <div className="onb-flags">
            <label className="check-row small"><input type="checkbox" checked={q.multi} onChange={(e) => setQ(i, { multi: e.target.checked })} /> Allow several answers</label>
            <label className="check-row small"><input type="checkbox" checked={q.required} onChange={(e) => setQ(i, { required: e.target.checked })} /> Must answer</label>
          </div>
          {q.options.map((o, k) => (
            <div className="onb-opt" key={o.key}>
              <div className="onb-opt-head">
                <input className="onb-emoji" value={o.emoji} maxLength={8} placeholder="Emoji" aria-label="Emoji (optional)" onChange={(e) => setO(i, k, { emoji: e.target.value })} />
                <input className="grow" value={o.label} maxLength={60} placeholder="Answer" aria-label={`Answer ${k + 1}`} onChange={(e) => setO(i, k, { label: e.target.value })} />
                <button className="icon-btn" title="Remove answer" aria-label="Remove answer" disabled={q.options.length <= 1} onClick={() => setQ(i, { options: q.options.filter((_, m) => m !== k) })}><Icon name="close" size={16} /></button>
              </div>
              {plainRoles.length > 0 && (
                <div className="onb-roles" role="group" aria-label="Roles this answer gives">
                  <span className="muted small">Gives:</span>
                  {plainRoles.map((r) => (
                    <button type="button" key={r.id} className={'chip' + (o.roles.includes(r.id) ? ' on' : '')} aria-pressed={o.roles.includes(r.id)} onClick={() => toggleRole(i, k, r.id)}>
                      <i className="role-dot" style={{ background: r.color || 'var(--muted)' }} />{r.name}
                    </button>
                  ))}
                </div>
              )}
              {o.roles.some((id) => !plainRoles.some((r) => r.id === id)) && <p className="code-hint invalid">This answer gives a role that now has permissions. Remove it.</p>}
            </div>
          ))}
          {q.options.length < LIMITS.options && <button className="btn small-btn" onClick={() => setQ(i, { options: [...q.options, newOption()] })}><Icon name="plus" size={14} /> Add answer</button>}
        </div>
      ))}
      {draft.questions.length < LIMITS.questions && <button className="btn" onClick={() => setDraft({ ...draft, questions: [...draft.questions, newQuestion()] })}><Icon name="plus" size={14} /> Add question</button>}

      {err && <div className="error">{err}</div>}
      <div className="settings-foot">
        <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

// ---------- member: the questions screen ----------
// state = { done, answers, blocking } from GET /servers/:id/onboarding. Blocking = required and not answered yet: no close button, no skip.
export function OnboardingFlow({ server, state, onDone, onClose }) {
  const cfg = server.onboarding;
  const qs = cfg.questions;
  const hasWelcome = !!cfg.welcome;
  const [step, setStep] = useState(hasWelcome && !state.done ? -1 : 0);
  const [answers, setAnswers] = useState(() => ({ ...(state.answers || {}) }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const q = qs[step];
  const last = step === qs.length - 1;
  const picked = q ? answers[q.id] || [] : [];

  useEffect(() => {
    ref.current?.focus();
    if (state.blocking) return undefined; // required: Escape does not close it
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [state.blocking, onClose]);

  const pick = (oid) => setAnswers((a) => {
    const cur = a[q.id] || [];
    const next = q.multi ? (cur.includes(oid) ? cur.filter((x) => x !== oid) : [...cur, oid]) : cur[0] === oid && !q.required ? [] : [oid];
    return { ...a, [q.id]: next };
  });
  async function send(body) {
    setErr(''); setBusy(true);
    try { const r = await api(`/servers/${server.id}/onboarding/answers`, { method: 'POST', body }); onDone(r); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const next = () => {
    if (q.required && !picked.length) return setErr('Pick an answer to continue');
    setErr('');
    if (last) send({ answers });
    else setStep(step + 1);
  };

  return (
    <div className="overlay onb-overlay" role="presentation">
      <div className="modal onb" role="dialog" aria-modal="true" aria-label={`Welcome to ${server.name}`} tabIndex={-1} ref={ref}>
        {step === -1 ? (
          <>
            <h2 className="onb-title">Welcome to {server.name}</h2>
            <p className="onb-welcome">{cfg.welcome}</p>
          </>
        ) : (
          <>
            <div className="onb-dots" aria-label={`Question ${step + 1} of ${qs.length}`}>{qs.map((x, i) => <span key={x.id} className={'onb-dot' + (i === step ? ' on' : i < step ? ' past' : '')} />)}</div>
            <h2 className="onb-title">{q.title}{q.required && <span className="onb-req" title="Required"> *</span>}</h2>
            <p className="muted small">{q.multi ? 'Pick as many as you like.' : 'Pick one.'}</p>
            <div className="onb-choices" role={q.multi ? 'group' : 'radiogroup'}>
              {q.options.map((o) => {
                const on = picked.includes(o.id);
                return (
                  <button type="button" key={o.id} role={q.multi ? 'checkbox' : 'radio'} aria-checked={on} className={'onb-choice' + (on ? ' on' : '')} onClick={() => pick(o.id)}>
                    {o.emoji && <span className="onb-choice-emoji" aria-hidden="true">{o.emoji}</span>}
                    <span className="grow">{o.label}</span>
                    {on && <Icon name="check" size={16} />}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {err && <div className="error" role="alert">{err}</div>}
        <div className="modal-foot onb-foot">
          {!state.blocking && <button className="btn" disabled={busy} onClick={() => (state.done ? onClose() : send({ skip: true }))}>{state.done ? 'Cancel' : 'Skip for now'}</button>}
          {step > 0 && <button className="btn" disabled={busy} onClick={() => setStep(step - 1)}>Back</button>}
          {step === -1
            ? <button className="btn primary" onClick={() => setStep(0)}>Start</button>
            : <button className="btn primary" disabled={busy} onClick={next}>{last ? (busy ? 'Saving…' : 'Finish') : 'Next'}</button>}
        </div>
      </div>
    </div>
  );
}
