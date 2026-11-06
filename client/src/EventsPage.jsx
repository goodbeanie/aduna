import React, { useEffect, useRef, useState } from 'react';
import { DateTimeInput, Select } from './Controls.jsx';
import { Avatar, Icon, Modal } from './ui.jsx';
import { toast, askConfirm } from './Dialogs.jsx';
import { EmptyState } from './ShellBits.jsx';
import { nameProps } from './namestyle.js';
import * as G from './gatherings.js';

// Events: a game night on Friday at eight. Make it, answer Going or Maybe, get a reminder, tap once to be in the voice channel.
// The events come with the server (server.gatherings); every change answers { server } and the app swaps it in through onChange.

function EventForm({ server, event, onClose, onDone }) {
  const voices = server.channels.filter((c) => c.type === 'voice');
  const first = event ? event.startsAt : G.defaultStart();
  const [title, setTitle] = useState(event?.title || '');
  const [desc, setDesc] = useState(event?.desc || '');
  const [start, setStart] = useState(G.toInput(first));
  const [end, setEnd] = useState(G.toInput(event ? event.endsAt : first + 2 * G.HOUR));
  const [channelId, setChannelId] = useState(event ? event.channelId || '' : voices[0]?.id || '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const moveStart = (v) => { // the length of the event stays the same when the start moves
    const a = G.fromInput(start), b = G.fromInput(end), n = G.fromInput(v);
    setStart(v);
    if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(n)) setEnd(G.toInput(n + (b - a)));
    setErr('');
  };
  async function go(e) {
    e.preventDefault();
    if (busy) return;
    let s = G.fromInput(start), en = G.fromInput(end);
    if (!Number.isFinite(s)) return setErr('Choose when the event starts');
    if (!Number.isFinite(en)) return setErr('Choose when the event ends');
    if (event && start === G.toInput(event.startsAt)) s = event.startsAt; // untouched times keep their exact value
    if (event && end === G.toInput(event.endsAt)) en = event.endsAt;
    setBusy(true); setErr('');
    try {
      const body = { title, desc, startsAt: s, endsAt: en, channelId: channelId || null };
      const r = event ? await G.changeEvent(server.id, event.id, body) : await G.createEvent(server.id, body);
      onDone(r.server);
    } catch (e2) { setErr(e2.message || 'Could not save that'); setBusy(false); }
  }
  return (
    <Modal title={event ? 'Edit event' : 'New event'} onClose={onClose}>
      <form onSubmit={go}>
        <label htmlFor="ev-title">EVENT NAME</label>
        <input id="ev-title" autoFocus value={title} onChange={(e) => { setTitle(e.target.value); setErr(''); }} maxLength={G.LIMITS.title} required placeholder="Game night" />
        <label htmlFor="ev-start">STARTS</label>
        <DateTimeInput id="ev-start" value={start} onChange={(e) => moveStart(e.target.value)} required />
        <label htmlFor="ev-end">ENDS</label>
        <DateTimeInput id="ev-end" value={end} onChange={(e) => { setEnd(e.target.value); setErr(''); }} required />
        <label htmlFor="ev-chan">VOICE CHANNEL</label>
        <Select id="ev-chan" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          <option value="">No voice channel</option>
          {voices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        {voices.length === 0 && <p className="muted small hint">This server has no voice channel yet. Add one and the reminder will carry a one-tap Join voice button.</p>}
        <label htmlFor="ev-desc">DETAILS (OPTIONAL)</label>
        <textarea id="ev-desc" rows={3} value={desc} onChange={(e) => { setDesc(e.target.value); setErr(''); }} maxLength={G.LIMITS.desc} placeholder="What are we playing?" />
        {err && <p className="error-text field-error" role="alert">{err}</p>}
        <div className="modal-foot"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{event ? 'Save' : 'Create event'}</button></div>
      </form>
    </Modal>
  );
}

function EventCard({ g, server, users, me, now, canEdit, inChannel, inVoice, onAnswer, onJoin, onEdit, onCancel }) {
  const phase = G.phaseOf(g, now);
  const mine = G.myAnswer(g, me.id);
  const over = phase === 'over';
  const ch = g.channelId ? server.channels.find((c) => c.id === g.channelId) : null;
  const d = G.dateBlock(g.startsAt);
  const people = [...g.yes, ...g.maybe].map((id) => users[id] || server.members.find((m) => m.id === id)).filter(Boolean);
  const host = users[g.by] || server.members.find((m) => m.id === g.by);
  return (
    <article className={'ev-card ' + phase}>
      <div className="ev-date" aria-hidden="true"><span>{d.month}</span><b>{d.day}</b></div>
      <div className="ev-main">
        <div className="ev-top">
          <h4 className="ev-title">{g.title}</h4>
          <span className={'ev-when-pill ' + phase}>{G.countdown(g, now)}</span>
        </div>
        <div className="ev-time muted small"><Icon name="clock" size={14} className="inline-icon" /> {G.rangeLabel(g, now)}{host && <> · by <span {...nameProps(host)}>{host.displayName}</span></>}</div>
        {g.desc && <p className="ev-desc">{g.desc}</p>}
        {ch && (
          <div className="ev-chan"><Icon name="speaker" size={15} className="inline-icon" /> {ch.name}{inChannel.length > 0 && <span className="ev-live"> · {inChannel.length} in voice now</span>}</div>
        )}
        <div className="ev-who">
          <div className="ev-faces" aria-hidden="true">{people.slice(0, 6).map((u) => <Avatar key={u.id} user={u} size={24} />)}</div>
          <span className="small muted">{g.yes.length} going{g.maybe.length > 0 ? ` · ${g.maybe.length} maybe` : ''}{people.length === 0 ? ' · be the first to answer' : ''}</span>
        </div>
        {!over && (
          <div className="ev-actions">
            <button type="button" className={'btn ev-rsvp' + (mine === 'yes' ? ' on' : '')} aria-pressed={mine === 'yes'} onClick={() => onAnswer(g, mine === 'yes' ? null : 'yes')}><Icon name="check" size={16} className="inline-icon" /> Going</button>
            <button type="button" className={'btn ev-rsvp' + (mine === 'maybe' ? ' on' : '')} aria-pressed={mine === 'maybe'} onClick={() => onAnswer(g, mine === 'maybe' ? null : 'maybe')}>Maybe</button>
            {ch && <button type="button" className={'btn ev-join' + (phase === 'live' || phase === 'soon' ? ' primary' : '')} onClick={() => onJoin(ch)}><Icon name="speaker" size={16} className="inline-icon" /> {inVoice ? 'Open voice' : 'Join voice'}</button>}
            <span className="grow" />
            {canEdit && <>
              <button type="button" className="icon-btn" title="Edit event" aria-label="Edit event" onClick={() => onEdit(g)}><Icon name="edit" size={16} /></button>
              <button type="button" className="icon-btn" title="Cancel event" aria-label="Cancel event" onClick={() => onCancel(g)}><Icon name="trash" size={16} /></button>
            </>}
          </div>
        )}
      </div>
    </article>
  );
}

export default function EventsPage({ server, users, me, voice, canManage, onBack, headerExtra, onChange, onJoin, startNew }) {
  const [, setTick] = useState(0);
  const [form, setForm] = useState(startNew ? { event: null } : null);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 20_000); return () => clearInterval(t); }, []);
  const asked = useRef(false);
  useEffect(() => { if (startNew && !asked.current) { asked.current = true; setForm({ event: null }); } }, [startNew]);

  const now = Date.now();
  const list = G.listFor(server, now);
  const live = list.filter((g) => G.phaseOf(g, now) === 'live');
  const next = list.filter((g) => ['soon', 'upcoming'].includes(G.phaseOf(g, now)));
  const over = list.filter((g) => G.phaseOf(g, now) === 'over');

  const answer = async (g, status) => {
    const before = server;
    const strip = (a) => a.filter((id) => id !== me.id);
    onChange({ ...server, gatherings: server.gatherings.map((x) => (x.id === g.id ? { ...x, yes: status === 'yes' ? [...strip(x.yes), me.id] : strip(x.yes), maybe: status === 'maybe' ? [...strip(x.maybe), me.id] : strip(x.maybe) } : x)) });
    try { onChange((await G.answerEvent(server.id, g.id, status)).server); }
    catch (e) { onChange(before); toast(e.message || 'Could not save your answer', 'error'); }
  };
  const cancel = async (g) => {
    if (!(await askConfirm({ title: 'Cancel event', body: `Cancel “${g.title}”? Everyone who said they are coming will no longer get a reminder.`, confirmLabel: 'Cancel event', danger: true }))) return;
    try { onChange((await G.cancelEvent(server.id, g.id)).server); } catch (e) { toast(e.message || 'Could not cancel that', 'error'); }
  };
  const card = (g) => (
    <EventCard key={g.id} g={g} server={server} users={users} me={me} now={now}
      canEdit={g.by === me.id || canManage}
      inChannel={g.channelId ? voice.members[g.channelId] || [] : []} inVoice={!!g.channelId && voice.state.channelId === g.channelId}
      onAnswer={answer} onJoin={onJoin} onEdit={(x) => setForm({ event: x })} onCancel={cancel} />
  );
  const section = (label, items) => items.length > 0 && <section className="ev-section" key={label}><h5 className="ev-h">{label}</h5>{items.map(card)}</section>;

  return (
    <section className="chat events-panel">
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title="Back" aria-label="Back to list" onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash"><Icon name="calendar" size={20} /></span>
        <h3>Events</h3>
        <div className="spacer" />
        <button className="btn primary small-btn" onClick={() => setForm({ event: null })}><Icon name="plus" size={16} className="inline-icon" /> New event</button>
        {headerExtra}
      </header>
      <div className="ev-body">
        {list.length === 0 ? (
          <EmptyState icon="calendar" title="Nothing planned yet" action={<button className="btn primary" onClick={() => setForm({ event: null })}>Plan something</button>}>
            Pick a time, say which voice channel, and everyone who says they are coming gets a reminder with a button to jump straight in.
          </EmptyState>
        ) : (
          <div className="ev-list">
            {section('Happening now', live)}
            {section('Coming up', next)}
            {section('Just ended', over)}
          </div>
        )}
      </div>
      {form && <EventForm server={server} event={form.event} onClose={() => setForm(null)} onDone={(sv) => { onChange(sv); setForm(null); }} />}
    </section>
  );
}
