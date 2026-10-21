import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { Icon } from './ui.jsx';

const money = (cents, currency) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: String(currency || 'usd').toUpperCase() });
const REASON = { message: 'Messages', purchase: 'Bought credits', refund: 'Refund', chargeback: 'Payment reversed' };
const when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function Quest({ q, locked, busy, onClaim }) {
  const pct = Math.round((q.have / q.need) * 100);
  return (
    <div className={'quest' + (q.claimed ? ' claimed' : '')}>
      <div className="quest-main">
        <b>{q.title}</b>
        <div className="muted small">{q.desc}</div>
        {q.need > 1 && !q.claimed && <div className="quest-bar" title={`${q.have} of ${q.need}`}><i style={{ width: pct + '%' }} /></div>}
      </div>
      <span className="reward"><Icon name="coin" size={15} />{q.reward}</span>
      {q.claimed
        ? <span className="quest-done"><Icon name="check" size={16} /> {q.daily ? 'Done today' : 'Claimed'}</span>
        : <button className="btn primary small-btn" disabled={!q.done || locked || busy === q.id} onClick={() => onClaim(q)}>{q.done ? 'Claim' : `${q.have}/${q.need}`}</button>}
    </div>
  );
}

// Credits: balance, buying, the earning rules, quests and recent activity.
// `rev` goes up whenever the server says the balance changed, so this page refreshes itself.
export default function Credits({ onBack, rev, justPaid }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(() => api('/credits').then((r) => { setD(r); setErr(''); }).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load, rev]);
  // After paying, Stripe tells the server in the background; give it a moment, then stop looking.
  useEffect(() => {
    if (!justPaid) return undefined;
    let n = 0;
    const iv = setInterval(() => { load(); if (++n >= 10) clearInterval(iv); }, 3000);
    return () => clearInterval(iv);
  }, [justPaid, load]);

  async function buy(p) {
    setBusy(p.id); setErr('');
    try { const { url } = await api('/credits/checkout', { method: 'POST', body: { packId: p.id } }); window.location.assign(url); }
    catch (e) { setErr(e.message); setBusy(''); }
  }
  async function claim(q) {
    setBusy(q.id); setErr(''); setNote('');
    try { const r = await api(`/credits/quests/${q.id}/claim`, { method: 'POST' }); setD(r); setNote(`+${r.amount} credits for “${q.title}”`); }
    catch (e) { setErr(e.message); }
    setBusy('');
  }

  const locked = d?.unlocksAt && d.unlocksAt > Date.now();
  const mins = locked ? Math.max(1, Math.ceil((d.unlocksAt - Date.now()) / 60000)) : 0;
  const m = d?.messaging;

  return (
    <section className="chat">
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title="Back" aria-label="Back to list" onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash"><Icon name="coin" size={20} /></span>
        <h3>Credits</h3>
      </header>
      <div className="credits-body">
        {!d && !err && <p className="muted">Loading…</p>}
        {err && <p className="error-text">{err}</p>}
        {justPaid && <p className="ok-text">Thank you! Your credits are added as soon as the payment is confirmed, usually within seconds.</p>}
        {note && <p className="ok-text">{note}</p>}
        {d && (
          <>
            <div className="credit-balance">
              <Icon name="coin" size={34} />
              <div><div className="credit-num">{d.balance.toLocaleString()}</div><div className="muted small">your credits</div></div>
              <div className="credit-stats muted small">
                <span>{d.lifetime.earned.toLocaleString()} earned</span><span>{d.lifetime.bought.toLocaleString()} bought</span><span>{d.lifetime.spent.toLocaleString()} spent</span>
                {d.streak > 1 && <span>🔥 {d.streak}-day streak</span>}
              </div>
            </div>
            {locked && <p className="muted notice-line">New accounts can earn and claim rewards after 30 minutes. About {mins} min to go.</p>}

            <h4 className="credit-h">Buy credits</h4>
            <div className="credit-packs">
              {d.packs.map((p) => (
                <div key={p.id} className="credit-pack">
                  <div className="pack-amt"><Icon name="coin" size={20} />{p.credits.toLocaleString()}</div>
                  <button className="btn primary" disabled={!d.purchases || busy === p.id} onClick={() => buy(p)}>{busy === p.id ? 'Opening checkout…' : money(p.cents, p.currency)}</button>
                </div>
              ))}
            </div>
            <p className="muted small">{d.purchases ? 'Paid securely through Stripe; Aduna never sees your card. Credits are added to your balance once the payment is confirmed.' : 'Buying credits is not set up on this server yet.'}</p>

            <h4 className="credit-h">Earn by chatting</h4>
            <div className="earn-card">
              <p>Write real messages in server channels and earn <b>{m.reward} credits</b> each, up to <b>{m.cap} a day</b>.</p>
              <div className="quest-bar big" title={`${m.earnedToday} of ${m.cap} today`}><i style={{ width: Math.min(100, (m.earnedToday / m.cap) * 100) + '%' }} /></div>
              <div className="muted small">{m.earnedToday} of {m.cap} earned today · resets at midnight UTC</div>
              <ul className="earn-rules muted small">
                <li>Type it yourself. Pasted or auto-typed text earns nothing.</li>
                <li>Say something. A full sentence, not “lol” or the same thing again; every message has to be different.</li>
                <li>Talk with people. Someone else must have spoken in that channel recently, in a server with at least {m.minMembers} members.</li>
                <li>One rewarded message every {Math.round(m.cooldownMs / 1000)} seconds. Direct messages are private, so they do not earn credits.</li>
              </ul>
            </div>

            <h4 className="credit-h">Daily quests</h4>
            <div className="quests">{d.quests.filter((q) => q.daily).map((q) => <Quest key={q.id} q={q} locked={locked} busy={busy} onClaim={claim} />)}</div>
            <h4 className="credit-h">Quests</h4>
            <div className="quests">{d.quests.filter((q) => !q.daily).map((q) => <Quest key={q.id} q={q} locked={locked} busy={busy} onClaim={claim} />)}</div>

            <h4 className="credit-h">Recent activity</h4>
            {d.ledger.length === 0 && <p className="muted small">Nothing yet.</p>}
            <div className="ledger">
              {d.ledger.map((l, i) => (
                <div key={i} className="ledger-row">
                  <span className="grow">{l.reason === 'quest' ? l.note : REASON[l.reason] || l.reason}{l.reason === 'message' && l.n > 1 ? ` (${l.n})` : ''}<span className="muted small"> · {when(l.t)}</span></span>
                  <b className={l.amount > 0 ? 'plus' : 'minus'}>{l.amount > 0 ? '+' : '−'}{Math.abs(l.amount).toLocaleString()}</b>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
