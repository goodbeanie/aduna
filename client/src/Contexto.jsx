import React, { useEffect, useRef, useState } from 'react';
import { Avatar, Icon, Modal } from './ui.jsx';
import { api } from './api.js';

// Contexto: one secret word a day, found by meaning. Type any word and it gets a number: how close its meaning is to the secret word
// (1 is the word itself, so lower is closer). The server owns the truth (ranks, hints and the answer are in server/contexto.js): this only
// sends guesses and draws what comes back, so the answer is never in the browser until you have found it or given up.
// "scopes" is what can be played from here: Aduna's own daily word, plus the current server's word when you open it from a channel.
// It reuses Wordle's dialog layout (wordle.css); contexto.css adds the guess list.

const GREEN = 300, ORANGE = 1500, VOCAB = 30000; // the same bands as server/contexto.js
export const bandOf = (rank) => (rank <= GREEN ? 'g' : rank <= ORANGE ? 'o' : 'r');
const NAME = { g: 'close', o: 'near', r: 'far' };
const barWidth = (rank) => Math.max(3, Math.round(100 * (1 - Math.log(rank) / Math.log(VOCAB)))); // rank 1 fills the bar, the last word is a sliver

// A result shared into a chat is a plain message: contexto:1:<g|s>:<day>:<guesses or X>:<hints>:<close>,<near>,<far>
// (g = Aduna's word, s = a server's word; the three counts are how many guesses fell in each colour). Clients draw it as a card, so it
// works in end-to-end encrypted chats too, and it never contains the word.
const SHARE_RE = /^contexto:1:([gs]):(\d{1,5}):(\d{1,4}|X):(\d{1,3}):(\d{1,4}),(\d{1,4}),(\d{1,4})$/;
export function parseContextoShare(content) {
  const m = SHARE_RE.exec(String(content || '').trim());
  return m ? { kind: m[1], day: Number(m[2]), tries: m[3], hints: Number(m[4]), g: Number(m[5]), o: Number(m[6]), r: Number(m[7]) } : null;
}
export function contextoToken(d) {
  const c = { g: 0, o: 0, r: 0 };
  for (const r of d.rows) c[bandOf(r.rank)]++;
  return `contexto:1:${d.scope === 'global' ? 'g' : 's'}:${d.day}:${d.status === 'won' ? d.tries : 'X'}:${Math.min(d.hints, 999)}:${c.g},${c.o},${c.r}`;
}

export function ContextoShareCard({ share }) {
  const name = share.kind === 'g' ? 'Aduna Contexto' : 'Server Contexto';
  const total = share.g + share.o + share.r || 1;
  const solved = share.tries !== 'X';
  return (
    <div className="wd-card cx-card" role="img" aria-label={`${name} number ${share.day}, ${solved ? 'found in ' + share.tries + ' guesses' : 'gave up'}, ${share.g} close, ${share.o} near, ${share.r} far guesses${share.hints ? ', ' + share.hints + ' hints' : ''}`}>
      <div className="wd-card-head"><Icon name="contexto" size={18} /><span>{name} No. {share.day}</span><b>{solved ? share.tries : 'Gave up'}</b></div>
      <div className="cx-split" aria-hidden="true">
        {['g', 'o', 'r'].map((k) => share[k] > 0 && <i key={k} className={k} style={{ flexGrow: share[k] / total }} />)}
      </div>
      <div className="cx-legend small" aria-hidden="true">
        <span><u className="g" />{share.g}</span><span><u className="o" />{share.o}</span><span><u className="r" />{share.r}</span>
        {share.hints > 0 && <span className="muted">{share.hints} {share.hints === 1 ? 'hint' : 'hints'}</span>}
      </div>
    </div>
  );
}

function timeLeft(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000)), h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${m} min`;
}

function GuessRow({ r, last }) {
  const b = bandOf(r.rank);
  return (
    <div className={'cx-row ' + b + (last ? ' last' : '')} role="listitem" aria-label={`${r.word}, number ${r.rank}, ${NAME[b]}`}>
      <i className="cx-fill" style={{ width: barWidth(r.rank) + '%' }} aria-hidden="true" />
      <span className="cx-word">{r.word}{r.hint && <small>hint</small>}</span>
      <b className="cx-rank">{r.rank}</b>
    </div>
  );
}

export function ContextoModal({ scopes, users = {}, onShare, onClose }) {
  const [scope, setScope] = useState(scopes[0].id);
  const [data, setData] = useState(null);
  const [word, setWord] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false); // "Give up" asks once more before it reveals the word
  const [last, setLast] = useState(null); // the word just guessed, shown at the top of the list
  const [shared, setShared] = useState(false);
  const [err, setErr] = useState('');
  const [, tick] = useState(0);
  const dataRef = useRef(null), scopeRef = useRef(scope), busyRef = useRef(false), inputRef = useRef(null);
  dataRef.current = data; scopeRef.current = scope;

  async function load(id) {
    setErr('');
    try { const r = await api('/contexto/' + id); if (scopeRef.current === id) setData(r); }
    catch (e) { if (scopeRef.current === id) setErr(e.message || 'Could not load Contexto'); }
  }
  useEffect(() => { setData(null); setLast(null); setWord(''); setMsg(''); setSure(false); setShared(false); load(scope); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (data && data.status === 'playing') inputRef.current?.focus(); }, [!!data, scope]); // eslint-disable-line react-hooks/exhaustive-deps -- the box is disabled while loading, so autoFocus alone misses
  useEffect(() => { // a new word at the end of the day: refresh when the time is up
    const t = setInterval(() => { tick((n) => n + 1); const d = dataRef.current; if (d && Date.now() >= d.resetsAt) { setLast(null); load(scopeRef.current); } }, 30000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // one request at a time: a guess, a hint or giving up
  async function act(path, body, after) {
    const d = dataRef.current;
    if (!d || d.status !== 'playing' || busyRef.current) return;
    busyRef.current = true; setBusy(true); setMsg('');
    const id = scopeRef.current;
    try {
      const r = await api(`/contexto/${id}/${path}`, { method: 'POST', body: body || {} });
      if (scopeRef.current !== id) return;
      setData(r); setLast(r.last ? r.last.word : null);
      if (after) after(r);
    } catch (e) { setMsg(e.message || 'Something went wrong'); }
    finally { busyRef.current = false; setBusy(false); if (inputRef.current && dataRef.current?.status === 'playing') inputRef.current.focus(); }
  }
  const submit = () => {
    const w = word.trim().toLowerCase();
    if (!w) return;
    setSure(false);
    act('guess', { word: w }, (r) => {
      setWord('');
      if (r.last && r.last.repeat) setMsg('You already tried that word');
      else if (r.status === 'won') setMsg('Found it');
    });
  };
  const hint = () => { setSure(false); act('hint', {}, () => setMsg('')); };
  const giveUp = () => { if (!sure) { setSure(true); return; } setSure(false); act('giveup', {}, () => setMsg('')); };

  const rows = data?.rows || [];
  const playing = !data || data.status === 'playing';
  const sorted = rows.slice().sort((a, b) => a.rank - b.rank);
  const lastRow = playing && last ? rows.find((r) => r.word === last) : null;
  const best = sorted[0];
  const stats = data?.stats;
  const scopeName = scopes.find((s) => s.id === scope)?.label || '';
  const st = data?.server?.standings;
  const done = data && data.status !== 'playing';

  async function share() {
    try { await onShare(contextoToken(data)); setShared(true); } catch (e) { setMsg(e.message || 'Could not share that'); }
  }

  return (
    <Modal title="Contexto" wide onClose={onClose}>
      <div className="wd cx">
        <div className={'wd-main' + (done ? ' done' : '')}>
          {scopes.length > 1 && (
            <div className="wd-tabs" role="tablist">
              {scopes.map((s) => <button key={s.id} role="tab" aria-selected={s.id === scope} className={s.id === scope ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => setScope(s.id)}>{s.label}</button>)}
            </div>
          )}
          <div className="wd-sub muted small">{scope === 'global' ? 'The same word for everyone on Aduna' : `A word just for ${scopeName}`}{data ? ` · No. ${data.day}` : ''}</div>
          {stats && stats.streak > 0 && <div className="wd-streak" title={`Best: ${stats.best} ${stats.best === 1 ? 'day' : 'days'}`}>{stats.streak}-day streak{playing ? ' · keep it going' : ''}</div>}
          {err && <div className="error">{err} <button className="link-btn" onClick={() => load(scope)}>Try again</button></div>}

          {done ? (
            <div className="cx-done" aria-live="polite">
              <div className="cx-answer-line">
                {data.status === 'won' ? <><b>Found it in {data.tries} {data.tries === 1 ? 'guess' : 'guesses'}</b>{data.hints > 0 && <span className="muted small"> · {data.hints} {data.hints === 1 ? 'hint' : 'hints'}</span>}</> : <b>You gave up</b>}
              </div>
              <div className="cx-answer">{data.answer}</div>
              <div className="muted small cx-near-title">Closest words</div>
              <div className="cx-chips">
                {data.closest.slice(1, 21).map((w, i) => <span key={w} className={'cx-chip' + (rows.some((r) => r.word === w) ? ' mine' : '')}><b>{i + 2}</b> {w}</span>)}
              </div>
              {onShare && <div className="wd-actions"><button className="btn" disabled={shared} onClick={share}><Icon name={shared ? 'check' : 'send'} size={15} className="inline-icon" /> {shared ? 'Shared' : 'Share to chat'}</button></div>}
            </div>
          ) : (
            <div className="cx-play">
              <div className="cx-input-row">
                <input ref={inputRef} className="cx-input" value={word} placeholder={data ? 'Type a word' : 'Loading…'} disabled={!data} readOnly={busy} maxLength={14} autoFocus
                  autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} enterKeyHint="go" aria-label="Your guess"
                  onChange={(e) => { setWord(e.target.value.replace(/[^a-zA-Z]/g, '')); setMsg(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
                <button className="btn primary" disabled={!data || busy || !word.trim()} onClick={submit}>Guess</button>
              </div>
              <div className="wd-msg" aria-live="polite">{msg || (data ? (rows.length ? `Best so far: ${best.word} (${best.rank})` : 'The closer its meaning, the lower the number') : '')}</div>
              <div className="cx-tools">
                <button className="btn" disabled={!data || busy} onClick={hint} title="Reveals a word closer than your best guess. It counts as a guess.">Hint</button>
                <button className={'btn' + (sure ? ' danger' : '')} disabled={!data || busy} onClick={giveUp} onBlur={() => setSure(false)}>{sure ? 'Reveal the word?' : 'Give up'}</button>
              </div>
            </div>
          )}

          <div className="cx-key small muted" aria-hidden="true"><span><u className="g" />Close, 1 to {GREEN}</span><span><u className="o" />Near, to {ORANGE}</span><span><u className="r" />Far</span></div>
          <div className="cx-list" role="list" aria-label="Your guesses, closest first">
            {lastRow && <GuessRow r={lastRow} last />}
            {sorted.filter((r) => !lastRow || r.word !== lastRow.word).map((r) => <GuessRow key={r.word} r={r} />)}
          </div>
          <div className="wd-foot muted small">
            <span><Icon name="clock" size={13} className="inline-icon" /> New word in {data ? timeLeft(data.resetsAt - Date.now()) : '…'}</span>
            <span>{data ? `${data.tries} ${data.tries === 1 ? 'guess' : 'guesses'}` : ''}</span>
          </div>
        </div>

        <aside className={'wd-side' + (done ? ' show' : '')} aria-label="Your results">
          <h3>Your results</h3>
          <div className="wd-stats">
            {[['Played', stats?.played ?? 0], ['Found', stats && stats.played ? Math.round((stats.won / stats.played) * 100) + '%' : '0%'], ['Streak', stats?.streak ?? 0], ['Fewest', stats?.fewest || '-']].map(([l, v]) => <div key={l}><b>{v}</b><span>{l}</span></div>)}
          </div>
          {st && (
            <>
              <h3>Today in {data.server.name}</h3>
              <div className="muted small wd-count">{st.finished} of {st.members} {st.members === 1 ? 'member has' : 'members have'} finished</div>
              {st.rows.length === 0 && <p className="muted small">Nobody has finished yet. Be the first.</p>}
              <ol className="wd-list">
                {st.rows.map((r) => (
                  <li key={r.userId}>
                    <Avatar user={users[r.userId]} size={24} />
                    <span className="grow">{users[r.userId]?.displayName || 'Someone'}</span>
                    {r.streak > 1 && <span className="wd-flame small" title={`${r.streak} days in a row`}>{r.streak} days</span>}
                    <span className={'small ' + (r.status === 'won' ? '' : 'muted')}>{r.status === 'won' ? `${r.tries} ${r.tries === 1 ? 'guess' : 'guesses'}` : 'Gave up'}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </aside>
      </div>
    </Modal>
  );
}
