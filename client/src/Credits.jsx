import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon, Modal } from './ui.jsx';

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

// The two things everyone should know before paying. Shown on the Credits page and again inside the checkout.
function BuyNotices() {
  return (
    <div className="buy-notices">
      <div className="buy-note"><Icon name="shield" size={16} /><span><b>Nothing is saved for later.</b> For your security, Aduna doesn’t keep any payment details, so you’ll check out fresh each time you buy.</span></div>
      <div className="buy-note warn"><Icon name="alert" size={16} /><span><b>All purchases are final.</b> Credits are non-refundable once they’re added to your balance. Please check the pack and price before you pay.</span></div>
    </div>
  );
}

// Aduna's checkout step: the order, the notices, a required acknowledgement, then on to the payment provider's own page.
// Card and login details are only ever typed on PayPal's (or Stripe's) page, never here.
function Checkout({ pack, provider, busy, error, onPay, onClose }) {
  const [agree, setAgree] = useState(false);
  const who = provider === 'paypal' ? 'PayPal' : 'Stripe';
  return (
    <Modal title="Checkout" onClose={busy ? () => {} : onClose}>
      <div className="checkout">
        <div className="checkout-order">
          <div className="checkout-line"><span className="pack-amt"><Icon name="coin" size={20} />{pack.credits.toLocaleString()} credits</span><b>{money(pack.cents, pack.currency)}</b></div>
          <div className="checkout-line total"><span>Total today</span><b>{money(pack.cents, pack.currency)}</b></div>
        </div>
        <BuyNotices />
        <label className="check-row checkout-agree">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} disabled={busy} />
          <span>I understand that all purchases are final and non-refundable.</span>
        </label>
        <p className="muted small checkout-how">You’ll finish paying on {who}’s secure page, then come straight back to Aduna. Aduna never sees your card or {who} login. Credits are added once {who} confirms the payment.</p>
        {error && <p className="error-text">{error}</p>}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" disabled={!agree || busy} onClick={onPay}>{busy ? `Opening ${who}…` : `Continue to ${who}`}</button>
        </div>
      </div>
    </Modal>
  );
}

// Credits: balance, buying, the earning rules, quests and recent activity.
// `rev` goes up whenever the server says the balance changed, so this page refreshes itself.
export default function Credits({ onBack, rev, justPaid, paypalOrder }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [checkout, setCheckout] = useState(null); // the pack being checked out, or null
  const [coErr, setCoErr] = useState('');
  const captured = useRef('');

  const load = useCallback(() => api('/credits').then((r) => { setD(r); setErr(''); }).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load, rev]);
  // After paying, Stripe tells the server in the background; give it a moment, then stop looking.
  useEffect(() => {
    if (!justPaid) return undefined;
    let n = 0;
    const iv = setInterval(() => { load(); if (++n >= 10) clearInterval(iv); }, 3000);
    return () => clearInterval(iv);
  }, [justPaid, load]);

  // Back from PayPal with ?token=<order>: the server captures the order (that is when the money moves) and adds the credits.
  useEffect(() => {
    if (!paypalOrder || captured.current === paypalOrder) return;
    captured.current = paypalOrder; // once per visit; the server also ignores repeats
    setNote('Confirming your payment with PayPal…'); setErr('');
    api('/credits/paypal/capture', { method: 'POST', body: { orderId: paypalOrder } })
      .then((r) => { load(); setNote(r.status === 'completed' ? 'Payment received. Your credits have been added.' : 'PayPal is still processing your payment. Your credits are added as soon as it clears.'); })
      .catch((e) => { setNote(''); setErr(e.message); });
  }, [paypalOrder, load]);

  // The Buy buttons open the checkout; only its Continue button leaves for the payment provider.
  async function pay() {
    const p = checkout;
    setBusy(p.id); setCoErr('');
    try { const { url } = await api('/credits/checkout', { method: 'POST', body: { packId: p.id } }); window.location.assign(url); }
    catch (e) { setCoErr(e.message); setBusy(''); }
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
                  <button className="btn primary" disabled={!d.purchases} onClick={() => { setCoErr(''); setCheckout(p); }}>{money(p.cents, p.currency)}</button>
                </div>
              ))}
            </div>
            {d.purchases && <BuyNotices />}
            <p className="muted small">{d.purchases ? `Paid securely through ${d.provider === 'paypal' ? 'PayPal' : 'Stripe'}; Aduna never sees your card${d.provider === 'paypal' ? ' or PayPal login' : ''}. Credits are added to your balance once the payment is confirmed.` : 'Buying credits is not set up on this server yet.'}</p>

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
      {checkout && d && <Checkout pack={checkout} provider={d.provider} busy={!!busy} error={coErr} onPay={pay} onClose={() => { setCheckout(null); setBusy(''); }} />}
    </section>
  );
}
