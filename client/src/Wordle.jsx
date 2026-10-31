import React, { useEffect, useRef, useState } from 'react';
import { Avatar, Icon, Modal } from './ui.jsx';
import { api } from './api.js';

// Wordle: one word a day. The server owns the truth (rules, the answer and the standings are in server/wordle.js): this only sends
// guesses and draws what comes back, so the answer is never in the browser until you have finished.
// "scopes" is what can be played from here: Aduna's own daily word, plus the current server's word when you open it from a channel.

const ROWS = 6, LEN = 5;
const KEYS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const RANK = { x: 1, y: 2, g: 3 };
const WORD = { g: 'correct', y: 'in the word, wrong place', x: 'not in the word' };

// A result shared into a chat is a plain message: wordle:1:<g|s>:<day>:<tries or X>:<one row of marks per guess, comma separated>
// (g = Aduna's word, s = a server's word). Clients draw it as a card, so it works in end-to-end encrypted chats too.
const SHARE_RE = /^wordle:1:([gs]):(\d{1,5}):([1-6X]):((?:[gyx]{5},){0,5}[gyx]{5})$/;
export function parseWordleShare(content) {
  const m = SHARE_RE.exec(String(content || '').trim());
  return m ? { kind: m[1], day: Number(m[2]), tries: m[3], rows: m[4].split(',') } : null;
}
export const wordleToken = (d) => ['wordle', '1', d.scope === 'global' ? 'g' : 's', d.day, d.status === 'won' ? d.tries : 'X', d.rows.map((r) => r.marks).join(',')].join(':');

export function WordleShareCard({ share }) {
  const name = share.kind === 'g' ? 'Aduna Wordle' : 'Server Wordle';
  return (
    <div className="wd-card" role="img" aria-label={`${name} number ${share.day}, ${share.tries === 'X' ? 'not solved' : 'solved in ' + share.tries + ' of 6'}`}>
      <div className="wd-card-head"><Icon name="wordle" size={18} /><span>{name} No. {share.day}</span><b>{share.tries}/6</b></div>
      <div className="wd-mini" aria-hidden="true">{share.rows.map((r, i) => <div key={i}>{[...r].map((c, j) => <span key={j} className={'wd-m ' + c} />)}</div>)}</div>
    </div>
  );
}

// Pressing a key or tab with the mouse or a finger must not move focus onto it: otherwise the next Enter or Space from a real keyboard
// would press that button a second time on top of the game's own key handling.
const noFocus = (e) => e.preventDefault();

function timeLeft(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000)), h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${m} min`;
}

export function WordleModal({ scopes, users = {}, onShare, onClose }) {
  const [scope, setScope] = useState(scopes[0].id);
  const [data, setData] = useState(null);
  const [cur, setCur] = useState('');
  const [msg, setMsg] = useState('');
  const [bad, setBad] = useState(0); // counts refused guesses, to shake the row again each time
  const [fresh, setFresh] = useState(null); // index of the row that was just scored (it flips open)
  const [shared, setShared] = useState(false);
  const [err, setErr] = useState('');
  const [, tick] = useState(0);
  const curRef = useRef(''), dataRef = useRef(null), busy = useRef(false), scopeRef = useRef(scope);
  dataRef.current = data; scopeRef.current = scope;
  const setWord = (w) => { curRef.current = w; setCur(w); };

  async function load(id) {
    setErr('');
    try { const r = await api('/wordle/' + id); if (scopeRef.current === id) { setData(r); setFresh(null); } }
    catch (e) { if (scopeRef.current === id) setErr(e.message || 'Could not load Wordle'); }
  }
  useEffect(() => { setData(null); setWord(''); setMsg(''); setShared(false); load(scope); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // a new word at the end of the day: refresh when the time is up
    const t = setInterval(() => { tick((n) => n + 1); const d = dataRef.current; if (d && Date.now() >= d.resetsAt) load(scopeRef.current); }, 30000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (t) => { setMsg(t); setBad((n) => n + 1); };
  async function submit() {
    const d = dataRef.current;
    if (!d || d.status !== 'playing' || busy.current) return;
    if (curRef.current.length < LEN) return flash('Not enough letters');
    busy.current = true; setMsg('');
    const id = scopeRef.current;
    try {
      const r = await api(`/wordle/${id}/guess`, { method: 'POST', body: { word: curRef.current } });
      if (scopeRef.current !== id) return;
      setData(r); setFresh(r.rows.length - 1); setWord('');
      setMsg(r.status === 'won' ? ['Genius', 'Magnificent', 'Impressive', 'Splendid', 'Great', 'Phew'][r.tries - 1] : '');
    } catch (e) { flash(e.message || 'Could not send that guess'); }
    finally { busy.current = false; }
  }
  function press(k) {
    const d = dataRef.current;
    if (!d || d.status !== 'playing') return;
    if (k === 'enter') submit();
    else if (k === 'del') { setMsg(''); setWord(curRef.current.slice(0, -1)); }
    else if (curRef.current.length < LEN) { setMsg(''); setWord(curRef.current + k); }
  }
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      // a button reached with Tab keeps its own Enter (switch tab, share, close); clicking never leaves focus on a button, see noFocus
      if (e.key === 'Enter') { if (e.target.closest && e.target.closest('button, a')) return; e.preventDefault(); press('enter'); }
      else if (e.key === 'Backspace') { e.preventDefault(); press('del'); }
      else if (/^[a-zA-Z]$/.test(e.key)) press(e.key.toLowerCase());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = data?.rows || [];
  const playing = !data || data.status === 'playing';
  const keyMark = {};
  for (const r of rows) [...r.word].forEach((ch, i) => { if ((RANK[r.marks[i]] || 0) > (RANK[keyMark[ch]] || 0)) keyMark[ch] = r.marks[i]; });
  const stats = data?.stats, max = stats ? Math.max(1, ...stats.dist) : 1;
  const scopeName = scopes.find((s) => s.id === scope)?.label || '';
  const st = data?.server?.standings;

  async function share() {
    try { await onShare(wordleToken(data)); setShared(true); } catch (e) { setMsg(e.message || 'Could not share that'); }
  }

  return (
    <Modal title="Wordle" wide onClose={onClose}>
      <div className="wd">
        <div className={'wd-main' + (data && data.status !== 'playing' ? ' done' : '')}>
          {scopes.length > 1 && (
            <div className="wd-tabs" role="tablist">
              {scopes.map((s) => <button key={s.id} role="tab" aria-selected={s.id === scope} className={s.id === scope ? 'on' : ''} onMouseDown={noFocus} onClick={() => setScope(s.id)}>{s.label}</button>)}
            </div>
          )}
          <div className="wd-sub muted small">{scope === 'global' ? 'The same word for everyone on Aduna' : `A word just for ${scopeName}`}{data ? ` · No. ${data.day}` : ''}</div>
          {stats && stats.streak > 0 && <div className="wd-streak" title={`Best: ${stats.best} ${stats.best === 1 ? 'day' : 'days'}`}><span aria-hidden="true">🔥</span> {stats.streak}-day streak{data.status === 'playing' ? ' · keep it going' : ''}</div>}
          {err && <div className="error">{err} <button className="link-btn" onClick={() => load(scope)}>Try again</button></div>}
          <div className="wd-board" role="grid" aria-label="Wordle board">
            {Array.from({ length: ROWS }, (_, r) => {
              const sc = r < rows.length ? rows[r] : null, typing = r === rows.length && playing;
              return (
                <div key={r + '-' + (typing ? bad : 0)} className={'wd-row' + (typing && bad ? ' shake' : '')} role="row">
                  {Array.from({ length: LEN }, (_, c) => {
                    const ch = sc ? sc.word[c] : typing ? cur[c] : '';
                    return <div key={c} role="gridcell" aria-label={ch ? `${ch}, ${sc ? WORD[sc.marks[c]] : 'typed'}` : 'empty'} className={'wd-t' + (sc ? ' ' + sc.marks[c] : ch ? ' fill' : '') + (sc && r === fresh ? ' rev' : '')} style={sc && r === fresh ? { animationDelay: c * 130 + 'ms' } : undefined}>{ch}</div>;
                  })}
                </div>
              );
            })}
          </div>
          <div className="wd-msg" aria-live="polite">
            {data && data.status !== 'playing'
              ? <><b>{data.status === 'won' ? `Solved in ${data.tries}` : 'Out of tries'}</b><span className="muted small">{data.status === 'won' ? '' : ' · '}{data.status === 'lost' ? <>The word was <b className="wd-answer">{data.answer}</b></> : ''}</span></>
              : msg || (data ? 'Type a five-letter word' : 'Loading…')}
          </div>
          {data && data.status !== 'playing' && onShare && (
            <div className="wd-actions"><button className="btn" disabled={shared} onClick={share}><Icon name={shared ? 'check' : 'send'} size={15} className="inline-icon" /> {shared ? 'Shared' : 'Share to chat'}</button></div>
          )}
          <div className="wd-kb" aria-label="Keyboard">
            {KEYS.map((row, i) => (
              <div className="wd-kr" key={i}>
                {i === 1 && <span className="wd-gap" />}
                {i === 2 && <button className="wd-k wide" onMouseDown={noFocus} onClick={() => press('enter')} tabIndex={-1}>Enter</button>}
                {[...row].map((ch) => <button key={ch} className={'wd-k' + (keyMark[ch] ? ' ' + keyMark[ch] : '')} onMouseDown={noFocus} onClick={() => press(ch)} tabIndex={-1} aria-label={ch + (keyMark[ch] ? ', ' + WORD[keyMark[ch]] : '')}>{ch}</button>)}
                {i === 2 && <button className="wd-k wide" onMouseDown={noFocus} onClick={() => press('del')} tabIndex={-1} aria-label="Delete">Del</button>}
                {i === 1 && <span className="wd-gap" />}
              </div>
            ))}
          </div>
          <div className="wd-foot muted small">
            <span><Icon name="clock" size={13} className="inline-icon" /> New word in {data ? timeLeft(data.resetsAt - Date.now()) : '…'}</span>
            <span>{data && data.status === 'playing' ? `Guess ${Math.min(rows.length + 1, ROWS)} of ${ROWS}` : ''}</span>
          </div>
        </div>

        <aside className={'wd-side' + (data && data.status !== 'playing' ? ' show' : '')} aria-label="Your results">
          <h3>Your results</h3>
          <div className="wd-stats">
            {[['Played', stats?.played ?? 0], ['Won', stats && stats.played ? Math.round((stats.won / stats.played) * 100) + '%' : '0%'], ['Streak', stats?.streak ?? 0], ['Best', stats?.best ?? 0]].map(([l, v]) => <div key={l}><b>{v}</b><span>{l}</span></div>)}
          </div>
          <div className="wd-dist" aria-label="Games won by number of guesses">
            {(stats?.dist || Array(ROWS).fill(0)).map((n, i) => (
              <div key={i} className="wd-bar"><span>{i + 1}</span><i className={data && data.status === 'won' && data.tries === i + 1 ? 'me' : ''} style={{ width: Math.max(8, (n / max) * 100) + '%' }}>{n}</i></div>
            ))}
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
                    {r.streak > 1 && <span className="wd-flame small" title={`${r.streak} days in a row`}>🔥 {r.streak}</span>}
                    <span className={'small ' + (r.status === 'won' ? '' : 'muted')}>{r.status === 'won' ? `${r.tries} ${r.tries === 1 ? 'try' : 'tries'}` : 'Missed it'}</span>
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
