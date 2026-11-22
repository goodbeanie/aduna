import React, { useEffect, useRef, useState } from 'react';
import { Avatar, Icon, Modal } from './ui.jsx';
import { api } from './api.js';
import ChessPiece from './ChessPiece.jsx';

// Chess puzzle: a forced mate in 1, 2 or 3 moves. The server owns the truth (the rules, the opponent's replies, the answer and the standings
// are in server/puzzle.js): this only sends the move you tried and draws the board it sends back, so the answer is never in the browser until
// you have used up your tries.
// There are two ways to play: the daily puzzle (the same one for everybody, one for Aduna and one for the current server when you open it
// from a channel) and practice, which gives you as many puzzles as you like at the depth you pick.
// "scopes" is what can be played as a daily from here, like Wordle.

const NAME = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
const PROMO = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
const LEVELS = [[1, 'Mate in 1'], [2, 'Mate in 2'], [3, 'Mate in 3']];
const HARDNESS = [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']];

// A result shared into a chat is a plain message: puzzle:1:<g|s>:<day>:<1|2|3>:<S|X>:<wrong moves 0-3>
// (g = Aduna's puzzle, s = a server's puzzle; S = solved, X = not solved). Clients draw it as a card, so it works in end-to-end encrypted chats too.
const SHARE_RE = /^puzzle:1:([gs]):(\d{1,5}):([123]):([SX]):([0-3])$/;
export function parsePuzzleShare(content) {
  const m = SHARE_RE.exec(String(content || '').trim());
  return m ? { kind: m[1], day: Number(m[2]), n: Number(m[3]), solved: m[4] === 'S', wrong: Number(m[5]) } : null;
}
export const puzzleToken = (d) => ['puzzle', '1', d.scope === 'global' ? 'g' : 's', d.day, d.n, d.status === 'solved' ? 'S' : 'X', Math.min(3, d.wrong)].join(':');

export function PuzzleShareCard({ share }) {
  const name = share.kind === 'g' ? 'Aduna chess puzzle' : 'Server chess puzzle';
  const result = share.solved ? (share.wrong === 0 ? 'Solved first try' : `Solved with ${share.wrong} wrong ${share.wrong === 1 ? 'move' : 'moves'}`) : 'Not solved';
  return (
    <div className="wd-card" role="img" aria-label={`${name} number ${share.day}, mate in ${share.n}: ${result}`}>
      <div className="wd-card-head"><Icon name="chess" size={18} /><span>{name} No. {share.day}</span><b>{share.solved ? '♚ ✓' : '✗'}</b></div>
      <div className="pz-card-body"><b>Mate in {share.n}</b><span className="muted"> · {result}</span></div>
    </div>
  );
}

const noFocus = (e) => e.preventDefault(); // a tap on a square must not leave focus on it

function timeLeft(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000)), h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${m} min`;
}
const sqName = (i) => String.fromCharCode(97 + (i % 8)) + (8 - Math.floor(i / 8));
function parsePlacement(fen) {
  const out = [];
  for (const ch of fen) { if (ch === '/') continue; if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) out.push(''); else out.push(ch); }
  return out;
}
const lineText = (moves) => moves.map((m) => (m.by === 'them' ? `(${m.san})` : m.san)).join(' ');

export function PuzzleModal({ scopes, users = {}, onShare, onClose }) {
  const [mode, setMode] = useState(scopes[0].id); // a scope id (the daily) or 'practice'
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(null); // the square of the piece being moved
  const [promo, setPromo] = useState(null); // { from, to, options } while a promotion piece is being chosen
  const [wrongSq, setWrongSq] = useState(null); // the last wrong move, shown in red for a moment
  const [msg, setMsg] = useState('');
  const [shared, setShared] = useState(false);
  const [err, setErr] = useState('');
  const [, tick] = useState(0);
  const dataRef = useRef(null), busy = useRef(false), modeRef = useRef(mode), flashTimer = useRef(null);
  dataRef.current = data; modeRef.current = mode;

  const practice = mode === 'practice';
  const path = (id) => '/puzzle/' + id;

  function reset() { setSel(null); setPromo(null); setWrongSq(null); setMsg(''); setShared(false); }
  async function load(id) {
    setErr('');
    try { const r = await api(path(id)); if (modeRef.current === id) setData(r); }
    catch (e) { if (modeRef.current === id) setErr(e.message || 'Could not load the puzzle'); }
  }
  useEffect(() => { setData(null); reset(); load(mode); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // a new daily puzzle at the end of the day: refresh when the time is up
    const t = setInterval(() => { tick((n) => n + 1); const d = dataRef.current; if (d && d.resetsAt && Date.now() >= d.resetsAt) load(modeRef.current); }, 30000);
    return () => { clearInterval(t); clearTimeout(flashTimer.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function send(uci) {
    const d = dataRef.current;
    if (!d || d.status !== 'playing' || busy.current) return;
    busy.current = true; setMsg(''); setSel(null); setPromo(null);
    const id = modeRef.current;
    try {
      const r = await api(`${path(id)}/move`, { method: 'POST', body: { move: uci } });
      if (modeRef.current !== id) return;
      setData(r);
      if (r.wrongMove) {
        setWrongSq({ from: r.wrongMove.slice(0, 2), to: r.wrongMove.slice(2, 4) });
        clearTimeout(flashTimer.current); flashTimer.current = setTimeout(() => setWrongSq(null), 1100);
        const left = r.maxWrong - r.wrong;
        setMsg(r.status === 'failed' ? '' : `That does not force mate in ${r.n}. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
      } else if (r.status === 'playing') setMsg(`Good. Keep going: mate in ${r.n - Math.ceil(r.moves.length / 2)}.`);
    } catch (e) { setMsg(e.message || 'Could not send that move'); }
    finally { busy.current = false; }
  }

  async function newPuzzle(n, h) {
    if (busy.current) return;
    busy.current = true; reset();
    try { const r = await api('/puzzle/practice/next', { method: 'POST', body: { ...(n ? { n } : {}), ...(h ? { h } : {}) } }); if (modeRef.current === 'practice') setData(r); }
    catch (e) { setMsg(e.message || 'Could not get a new puzzle'); }
    finally { busy.current = false; }
  }

  const playing = !data || data.status === 'playing';
  const legal = data?.legal || [];
  const targets = sel ? legal.filter((u) => u.startsWith(sel)).map((u) => u.slice(2, 4)) : [];
  function pressSquare(name) {
    if (!data || data.status !== 'playing' || busy.current) return;
    if (sel && targets.includes(name)) {
      const options = legal.filter((u) => u.startsWith(sel + name) && u.length === 5).map((u) => u[4]);
      if (options.length) setPromo({ from: sel, to: name, options }); else send(sel + name);
      return;
    }
    setPromo(null);
    setSel(name !== sel && legal.some((u) => u.startsWith(name)) ? name : null);
  }

  const cells = data ? parsePlacement(data.fen) : Array(64).fill('');
  const flip = data && data.side === 'b'; // the side that moves is always at the bottom
  const order = Array.from({ length: 64 }, (_, i) => (flip ? 63 - i : i));
  const stats = data?.stats;
  const st = data?.server?.standings;
  const done = data && data.status !== 'playing';
  const scopeName = scopes.find((s) => s.id === mode)?.label || '';
  const sideName = data ? (data.side === 'w' ? 'White' : 'Black') : '';

  async function share() {
    try { await onShare(puzzleToken(data)); setShared(true); } catch (e) { setMsg(e.message || 'Could not share that'); }
  }

  return (
    <Modal title="Chess puzzle" wide onClose={onClose}>
      <div className="wd pz">
        <div className={'wd-main' + (done ? ' done' : '')}>
          <div className="wd-tabs" role="tablist">
            {scopes.map((s) => <button key={s.id} role="tab" aria-selected={s.id === mode} className={s.id === mode ? 'on' : ''} onMouseDown={noFocus} onClick={() => setMode(s.id)}>{s.id === 'global' ? 'Daily' : s.label}</button>)}
            <button role="tab" aria-selected={practice} className={practice ? 'on' : ''} onMouseDown={noFocus} onClick={() => setMode('practice')}>Practice</button>
          </div>
          {practice && (
            <>
              <div className="pz-levels" role="group" aria-label="How many moves to mate">
                {LEVELS.map(([n, label]) => <button key={n} className={data && data.n === n ? 'on' : ''} aria-pressed={!!data && data.n === n} onMouseDown={noFocus} onClick={() => newPuzzle(n)}>{label}</button>)}
              </div>
              <div className="pz-levels" role="group" aria-label="How hard the puzzle is">
                {HARDNESS.map(([h, label]) => <button key={h} className={data && data.hardness === h ? 'on' : ''} aria-pressed={!!data && data.hardness === h} onMouseDown={noFocus} onClick={() => newPuzzle(undefined, h)}>{label}</button>)}
              </div>
            </>
          )}
          <div className="wd-sub muted small">
            {practice ? 'As many puzzles as you like' : mode === 'global' ? 'The same puzzle for everyone on Aduna' : `A puzzle just for ${scopeName}`}{data && data.day ? ` · No. ${data.day}` : ''}
          </div>
          {!practice && stats && stats.streak > 0 && <div className="wd-streak" title={`Best: ${stats.best} ${stats.best === 1 ? 'day' : 'days'}`}><span aria-hidden="true">🔥</span> {stats.streak}-day streak{data.status === 'playing' ? ' · keep it going' : ''}</div>}
          {practice && stats && stats.streak > 1 && <div className="wd-streak" title={`Best: ${stats.best} in a row`}><span aria-hidden="true">🔥</span> {stats.streak} in a row</div>}
          {err && <div className="error">{err} <button className="link-btn" onClick={() => load(mode)}>Try again</button></div>}

          <div className="pz-info" aria-live="polite">
            {data ? <><b>{data.label}</b><span className="muted"> · {sideName} to move{playing ? ` · ${data.wrong} of ${data.maxWrong} wrong moves used` : ''}</span></> : <span className="muted">Loading…</span>}
          </div>
          <div className={'pz-board' + (flip ? ' flip' : '')} role="grid" aria-label="Chess board">
            {order.map((i) => {
              const name = sqName(i), ch = cells[i], isW = ch && ch === ch.toUpperCase(), kind = ch.toLowerCase();
              const dark = (Math.floor(i / 8) + (i % 8)) % 2 === 1;
              const cls = ['pz-sq', dark ? 'd' : 'l', sel === name ? 'sel' : '', targets.includes(name) ? (ch ? 'cap' : 'dot') : '',
                data?.last && (data.last.from === name || data.last.to === name) ? 'last' : '', wrongSq && (wrongSq.from === name || wrongSq.to === name) ? 'bad' : ''].filter(Boolean).join(' ');
              return (
                <button key={name} role="gridcell" className={cls} onMouseDown={noFocus} onClick={() => pressSquare(name)} tabIndex={-1}
                  aria-label={name + (ch ? `, ${isW ? 'white' : 'black'} ${NAME[kind]}` : ', empty') + (sel === name ? ', selected' : targets.includes(name) ? ', you can move here' : '')}>
                  {ch && <ChessPiece kind={kind} white={isW} />}
                </button>
              );
            })}
          </div>
          {promo && (
            <div className="pz-promo" role="group" aria-label="Promote the pawn to">
              <span className="muted small">Promote to</span>
              {promo.options.map((o) => <button key={o} className="btn" onClick={() => send(promo.from + promo.to + o)} aria-label={PROMO[o]}><ChessPiece kind={o} white={data.side === 'w'} /></button>)}
              <button className="link-btn" onClick={() => setPromo(null)}>Cancel</button>
            </div>
          )}

          <div className="wd-msg" aria-live="polite">
            {done
              ? <><b>{data.status === 'solved' ? (data.wrong === 0 ? 'Solved first try' : `Solved with ${data.wrong} wrong ${data.wrong === 1 ? 'move' : 'moves'}`) : 'Out of tries'}</b></>
              : msg || (data ? 'Tap a piece, then where it goes. Find the mate.' : '')}
          </div>
          {data && data.status === 'failed' && data.solution && (
            <div className="pz-solution small"><span className="muted">The way through: </span><b>{lineText(data.solution)}</b><span className="muted"> (replies in brackets)</span></div>
          )}
          {data && data.moves.length > 0 && <div className="pz-moves small muted">Played: {lineText(data.moves)}</div>}
          <div className="wd-actions pz-actions">
            {done && !practice && onShare && <button className="btn" disabled={shared} onClick={share}><Icon name={shared ? 'check' : 'send'} size={15} className="inline-icon" /> {shared ? 'Shared' : 'Share to chat'}</button>}
            {practice && data && <button className={'btn' + (done ? ' primary' : '')} onClick={() => newPuzzle()}>{done ? 'Next puzzle' : 'Skip'}</button>}
          </div>
          {!practice && <div className="wd-foot muted small">
            <span><Icon name="clock" size={13} className="inline-icon" /> New puzzle in {data && data.resetsAt ? timeLeft(data.resetsAt - Date.now()) : '…'}</span>
            <span />
          </div>}
        </div>

        <aside className={'wd-side show'} aria-label="Your results">
          <h3>{practice ? 'This session' : 'Your results'}</h3>
          <div className="wd-stats">
            {(practice
              ? [['Solved', stats?.solved ?? 0], ['Missed', stats?.failed ?? 0], ['Streak', stats?.streak ?? 0], ['Best', stats?.best ?? 0]]
              : [['Played', stats?.played ?? 0], ['Solved', stats?.solved ?? 0], ['Streak', stats?.streak ?? 0], ['Best', stats?.best ?? 0]]
            ).map(([l, v]) => <div key={l}><b>{v}</b><span>{l}</span></div>)}
          </div>
          {!practice && stats && stats.dist && (
            <>
              <div className="muted small">Solved, by wrong moves made first</div>
              <div className="wd-dist" aria-label="Puzzles solved by number of wrong moves">
                {stats.dist.map((n, i) => {
                  const max = Math.max(1, ...stats.dist);
                  return <div key={i} className="wd-bar"><span>{i}</span><i className={data.status === 'solved' && data.wrong === i ? 'me' : ''} style={{ width: Math.max(8, (n / max) * 100) + '%' }}>{n}</i></div>;
                })}
              </div>
            </>
          )}
          {practice && <p className="muted small">Practice puzzles are made fresh each time. Easy, Medium and Hard go by how many pieces are on the board and how far the king is from the edge. Three wrong moves end one and show the answer. Nothing here is shared or counts toward the daily streak.</p>}
          {!practice && st && (
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
                    <span className={'small ' + (r.status === 'solved' ? '' : 'muted')}>{r.status === 'solved' ? (r.wrong === 0 ? 'First try' : `${r.wrong} wrong`) : 'Missed it'}</span>
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
