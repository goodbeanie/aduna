import React, { useEffect, useRef, useState } from 'react';
import { Select } from './Controls.jsx';
import { api } from './api.js';
import { Icon } from './ui.jsx';

// The chat simulator in the bot editor: a pretend channel where you talk to your bot as yourself or as two made-up people, watch it answer
// and react, make people join and leave, let its timers go off and answer its web requests. Every step is one run of the bot's code in the
// same sandbox as the real thing (POST /api/developer/test); nothing is posted, stored or requested for real. The saved data and timers one
// run leaves behind are sent back with the next run (the server rebuilds them under the real limits), so a conversation builds up.

const PEOPLE = [['me', 'You'], ['alex', 'Alex'], ['sam', 'Sam']];
const NAME = { me: 'You', alex: 'Alex', sam: 'Sam' };
const EMPTY = { kv: {}, timers: [] };
const KEEP = 200; // messages kept on screen
const HOOK_SAMPLE = '{"event": "deploy", "status": "ok"}'; // what the webhook box starts with (and goes back to on "Start over")

const timerLabel = (t) => (t.kind === 'after' ? 'once' : t.kind === 'every' ? `every ${t.everySec} s` : `daily at ${t.time}${t.tz ? ' ' + t.tz : ''}`);
const countEmoji = (list) => { const m = new Map(); for (const e of list) m.set(e, (m.get(e) || 0) + 1); return [...m]; };

export default function BotSim({ code, fetchHosts }) {
  const [log, setLog] = useState([]); // { id, who: 'me'|'alex'|'sam'|'bot', text, mention, edited, replyTo, reactions: [] } or { id, note }
  const [state, setState] = useState(EMPTY); // saved data and timers the bot has left behind so far
  const [pending, setPending] = useState([]); // web requests the bot asked for that wait for a pretend answer: { name, url }
  const [answers, setAnswers] = useState({}); // pretend answer text, by request name
  const [last, setLast] = useState(null); // the last run: { label, res }
  const [as, setAs] = useState('me');
  const [text, setText] = useState('!ping');
  const [mention, setMention] = useState(false);
  const [editing, setEditing] = useState(null); // id of the message being edited
  const [busy, setBusy] = useState(false);
  const [hookSource, setHookSource] = useState('generic'); // webhook test: 'generic' (the text is JSON or plain text) or 'github' (a made-up push)
  const [hookName, setHookName] = useState('');
  const [hookText, setHookText] = useState(HOOK_SAMPLE);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  const box = useRef(null);
  const blank = !code.trim();

  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [log]);

  const note = (s) => ({ id: 'n' + (++seq.current), note: s });

  // One run. `body` says what happened; `st` is the saved data and timers the bot starts with; `before` is what to put on screen first.
  async function run(body, label, { st = state, before = [] } = {}) {
    setErr(''); setBusy(true);
    if (before.length) setLog((l) => [...l, ...before].slice(-KEEP));
    try {
      const r = (await api('/developer/test', { method: 'POST', body: { code, ...body, state: { kv: st.kv, timers: st.timers } } })).result;
      const made = (r.actions || []).map((a) => ({ id: 'b' + (++seq.current), who: 'bot', text: a.text, replyTo: a.replyTo || null, reactions: [] }));
      setLog((l) => {
        let next = [...l, ...made];
        for (const x of r.reactions || []) next = next.map((m) => (m.id === x.messageId ? { ...m, reactions: [...(m.reactions || []), x.emoji] } : m));
        return next.slice(-KEEP);
      });
      if (r.ok && r.state) setState(r.state); // a run that failed leaves the saved data as it was, like a real one
      else if (!r.ok) setState(st);
      setPending((p) => [...(body.event === 'fetch' ? p.filter((x) => x.name !== body.name) : p), ...(r.fetches || []).map((f) => ({ name: f.name, url: f.url }))]);
      setLast({ label, res: r });
    } catch (e) {
      setErr(e.code === 'sandbox_missing' ? 'The bot sandbox is not installed on this server.' : e.message);
    } finally { setBusy(false); }
  }

  function send() {
    const t = text.trim();
    if (!t || busy || blank) return;
    if (editing) {
      const m = log.find((x) => x.id === editing);
      if (m) {
        setLog((l) => l.map((x) => (x.id === editing ? { ...x, text: t, mention, edited: true } : x)));
        const id = editing;
        setEditing(null); setText('');
        run({ event: 'messageEdit', as: m.who, text: t, messageId: id, mentionBot: mention }, 'message edited');
        return;
      }
      setEditing(null);
    }
    const id = 'm' + (++seq.current);
    setText('');
    run({ event: 'message', as, text: t, messageId: id, mentionBot: mention }, 'message', { before: [{ id, who: as, text: t, mention, reactions: [] }] });
  }
  function startEdit(m) { setEditing(m.id); setAs(m.who); setText(m.text); setMention(!!m.mention); }
  function cancelEdit() { setEditing(null); setText(''); }

  const join = (who) => run({ event: 'memberJoin', as: who }, 'member joined', { before: [note(`${NAME[who]} joined the server`)] });
  const leave = (who) => run({ event: 'memberLeave', as: who }, 'member left', { before: [note(`${NAME[who]} left the server`)] });
  const install = () => run({ event: 'install' }, 'bot added', { before: [note('Your bot was added to the server')] });
  function fire(t) {
    // a one-time timer is used up when it goes off; a repeating one stays
    const st = t.kind === 'after' ? { kv: state.kv, timers: state.timers.filter((x) => x !== t) } : state;
    run({ event: 'timer', name: t.name, kind: t.kind, data: t.data || undefined }, `timer ${t.name}`, { st, before: [note(`Timer “${t.name}” went off`)] });
  }
  const answer = (p) => run({ event: 'fetch', name: p.name, url: p.url, text: answers[p.name] || '' }, `web answer ${p.name}`, { before: [note(`Pretend answer for “${p.name}” arrived`)] });
  // a person reacts to a message: the bot gets a reactionAdd (mine = the message is one the bot wrote). Reactions by bots never reach a real bot.
  const react = (m, emoji) => {
    if (busy || blank) return;
    setLog((l) => l.map((x) => (x.id === m.id ? { ...x, reactions: [...(x.reactions || []), emoji] } : x)));
    run({ event: 'reactionAdd', as, text: m.text, messageId: m.id, emoji, mine: m.who === 'bot' }, `reaction ${emoji}`, { before: [note(`${NAME[as]} reacted ${emoji}`)] });
  };
  // a webhook delivers: made-up data, nothing is received from anywhere
  const sendHook = () => {
    if (busy || blank) return;
    run({ event: 'webhook', source: hookSource, name: hookName.trim() || undefined, text: hookText }, 'webhook', { before: [note(hookSource === 'github' ? 'A GitHub push webhook arrived' : 'A webhook arrived')] });
  };

  function reset() {
    setLog([]); setState(EMPTY); setPending([]); setAnswers({}); setLast(null); setErr(''); setEditing(null); setMention(false); setText('!ping'); setAs('me');
    setHookSource('generic'); setHookName(''); setHookText(HOOK_SAMPLE);
  }

  const byId = new Map(log.map((m) => [m.id, m]));
  const res = last?.res;
  const stored = Object.entries(state.kv || {});
  const idle = !log.length && !last;

  return (
    <section className="bot-panel bot-sim">
      <div className="bot-panel-head">
        <h3>Try it</h3>
        <button className="btn small-btn" disabled={busy || idle} onClick={reset}>Start over</button>
      </div>
      <p className="muted small hint">A pretend channel. It runs the code above, saved or not, in the same sandbox as the real thing, one step at a time. Saved data and timers carry over from step to step. Nothing is posted, stored or requested for real.</p>

      <div className="sim-chat" ref={box} role="log" aria-live="polite" aria-label="Test conversation">
        {idle && <div className="muted small sim-empty">Say something below to see your bot answer. Try <b>!ping</b>, or make someone join the server.</div>}
        {log.map((m) => {
          if (m.note) return <div key={m.id} className="sim-note">{m.note}</div>;
          const re = m.replyTo ? byId.get(m.replyTo) : null;
          const isBot = m.who === 'bot';
          return (
            <div key={m.id} className={'sim-msg' + (isBot ? ' is-bot' : '')}>
              {m.replyTo && <div className="sim-reply muted small"><Icon name="reply" size={12} className="inline-icon" /> {re ? `${re.who === 'bot' ? 'Your bot' : NAME[re.who]}: ${re.text.slice(0, 60)}` : 'a message'}</div>}
              <div className="sim-head">
                <b>{isBot ? 'Your bot' : NAME[m.who]}</b>
                {isBot && <span className="bot-tag">BOT</span>}
                {!isBot && <button type="button" className="icon-btn sim-edit" title="Edit this message" aria-label="Edit this message" disabled={busy} onClick={() => startEdit(m)}><Icon name="edit" size={13} /></button>}
              </div>
              <div className="sim-text">{m.mention && <span className="sim-mention">@Bot </span>}{m.text}{m.edited && <span className="muted small"> (edited)</span>}</div>
              {m.reactions?.length > 0 && <div className="sim-reacts">{countEmoji(m.reactions).map(([e, n]) => <span key={e} className="sim-react">{e}{n > 1 ? ` ${n}` : ''}</span>)}</div>}
              <div className="sim-react-add" role="group" aria-label="React as the person chosen below">
                {['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F389}'].map((e) => <button key={e} type="button" className="icon-btn sim-edit" title={`React with ${e}`} aria-label={`React with ${e}`} disabled={busy || blank} onClick={() => react(m, e)}>{e}</button>)}
              </div>
            </div>
          );
        })}
        {busy && <div className="sim-note">Running…</div>}
      </div>
      {err && <div className="error">{err}</div>}
      {blank && <div className="muted small">There is no code to run yet.</div>}

      {editing && <div className="muted small">Editing a message. <button type="button" className="link-btn" onClick={cancelEdit}>Cancel</button></div>}
      <div className="bot-test-row sim-compose">
        <Select value={as} disabled={!!editing} onChange={(e) => setAs(e.target.value)} aria-label="Who is writing">
          {PEOPLE.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <input value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} aria-label="Test message" placeholder="Write a message" onKeyDown={(e) => e.key === 'Enter' && send()} />
        <button className="btn primary" disabled={busy || blank || !text.trim()} onClick={send}><Icon name="send" size={14} className="inline-icon" /> {editing ? 'Save edit' : 'Send'}</button>
      </div>
      <label className="check-row"><input type="checkbox" checked={mention} onChange={(e) => setMention(e.target.checked)} /> <span>This message mentions the bot (<code>m.mentionsBot</code>)</span></label>

      <div className="sim-events" role="group" aria-label="Other things that can happen">
        <button className="btn small-btn" disabled={busy || blank} onClick={() => join('alex')}>Alex joins</button>
        <button className="btn small-btn" disabled={busy || blank} onClick={() => join('sam')}>Sam joins</button>
        <button className="btn small-btn" disabled={busy || blank} onClick={() => leave('alex')}>Alex leaves</button>
        <button className="btn small-btn" disabled={busy || blank} onClick={install}>Bot is added</button>
      </div>

      <div className="sim-block sim-hook">
        <div className="muted small"><Icon name="link" size={13} className="inline-icon" /> A webhook delivers data to your bot (<code>webhook</code> event). Made up here: nothing is received from anywhere.</div>
        <div className="bot-test-row">
          <Select value={hookSource} onChange={(e) => setHookSource(e.target.value)} aria-label="Kind of webhook">
            <option value="generic">Generic JSON</option>
            <option value="github">GitHub push</option>
          </Select>
          <input value={hookName} maxLength={32} onChange={(e) => setHookName(e.target.value)} aria-label="Webhook name" placeholder={hookSource === 'github' ? 'GitHub' : 'Test webhook'} />
        </div>
        <div className="bot-test-row">
          <input value={hookText} maxLength={2000} onChange={(e) => setHookText(e.target.value)} aria-label={hookSource === 'github' ? 'Commit message' : 'Webhook body'}
            placeholder={hookSource === 'github' ? 'Commit message' : 'JSON or plain text'} onKeyDown={(e) => e.key === 'Enter' && sendHook()} />
          <button className="btn small-btn" disabled={busy || blank} onClick={sendHook}>Send webhook</button>
        </div>
      </div>

      {state.timers?.length > 0 && (
        <div className="sim-block">
          <div className="muted small"><Icon name="clock" size={13} className="inline-icon" /> Timers waiting. Pressing the button makes one go off now.</div>
          {state.timers.map((t) => (
            <div key={t.name} className="sim-row">
              <span><b>{t.name}</b> <span className="muted small">{timerLabel(t)}</span></span>
              <button className="btn small-btn" disabled={busy || blank} onClick={() => fire(t)}>Go off now</button>
            </div>
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div className="sim-block">
          <div className="muted small"><Icon name="link" size={13} className="inline-icon" /> Web requests waiting. Nothing goes out: type the answer the site would give (text, or JSON like {'{"stars": 3}'}).{fetchHosts?.length ? ` Sites allowed on this server: ${fetchHosts.join(', ')}.` : ''}</div>
          {pending.map((p) => (
            <div key={p.name} className="sim-ask">
              <div className="small sim-url"><b>{p.name}</b> · {p.url}</div>
              <div className="bot-test-row">
                <input value={answers[p.name] || ''} maxLength={2000} onChange={(e) => setAnswers((a) => ({ ...a, [p.name]: e.target.value }))} aria-label={`Pretend answer for ${p.name}`} placeholder="Pretend answer" onKeyDown={(e) => e.key === 'Enter' && !busy && answer(p)} />
                <button className="btn small-btn" disabled={busy || blank} onClick={() => answer(p)}>Send answer</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {stored.length > 0 && <pre className="bot-logs">{'Saved data so far:\n' + stored.map(([k, v]) => `${k} = ${v}`).join('\n')}</pre>}

      {res && (
        <div className="bot-result" aria-live="polite">
          <div className="muted small">Last step ({last.label}): {res.ok ? 'finished' : res.timedOut ? 'stopped, it ran out of time' : 'failed'} in {res.ms} ms</div>
          {res.error && <pre className="bot-err">{res.error}</pre>}
          {res.ok && !res.actions?.length && !res.reactions?.length && !res.fetches?.length && !res.stored?.length && !res.timersSet?.length && <div className="muted small">The bot did not do anything.</div>}
          {res.dropped?.length > 0 && <div className="bot-dropped">A real server would refuse: {res.dropped.join('; ')}</div>}
          {res.logs?.length > 0 && <pre className="bot-logs">{res.logs.join('\n')}</pre>}
        </div>
      )}
    </section>
  );
}
