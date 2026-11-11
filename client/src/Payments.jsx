import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { Icon, Modal } from './ui.jsx';
import './payments.css';

// /payments. The plan comes from /api/storage, the history from /api/payments. The page is outside the app shell, so it has its own message line.
const GB = 1024 ** 3;
const day = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const money = (cents, cur = 'usd') => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: String(cur).toUpperCase() });

function PlanCard({ s, busy, onCancel }) {
  let state = 'none', line = 'You do not have a plan right now.';
  if (s.lifetime) { state = 'on'; line = 'Plus is on for this account for good. There is nothing to pay or cancel.'; }
  else if (s.subscriber && s.renews) { state = 'on'; line = `Renews around ${day(s.paidThrough)} for ${money(s.currency === 'cad' ? s.plan.cadCents : s.plan.cents, s.currency || 'usd')}.`; }
  else if (s.subscriber) { state = 'ending'; line = `Your plan will not renew. You keep Plus until ${day(s.paidThrough)}, and your files are kept for 14 days after that.`; }
  else if (s.status === 'ended') line = `Your last plan ended${s.paidThrough ? ' on ' + day(s.paidThrough) : ''}.`;
  const label = state === 'on' ? 'Active' : state === 'ending' ? 'Ends ' + day(s.paidThrough) : 'No plan';
  return (
    <div className="pay-card">
      <div className="pay-card-top">
        <span className="pay-ico"><Icon name="bag" size={20} /></span>
        <div className="pay-card-main">
          <b>Aduna Plus</b>
          <span className="pay-sub">{Math.round(s.plan.bytes / GB)} GB of your own, billed monthly</span>
        </div>
        <span className={'pay-pill ' + state}>{label}</span>
      </div>
      <p className="pay-line">{line}</p>
      {s.status === 'past_due' && s.subscriber && <p className="pay-line pay-warn">Your last payment did not go through. We will try again. If it keeps failing, update your card in PayPal.</p>}
      <div className="pay-actions">
        {s.subscriber && s.renews && !s.lifetime && <button type="button" className="btn danger" onClick={onCancel} disabled={busy}>Cancel plan</button>}
        {!s.subscriber && !s.lifetime && <a className="btn primary" href="/app">Get Plus in the app</a>}
      </div>
    </div>
  );
}

function rowOf(it, currency) {
  if (it.kind === 'storage') return { at: it.at, name: it.renewal ? 'Aduna Plus, monthly renewal' : 'Aduna Plus', sub: 'Paid by card', amount: money(it.cents, it.currency || currency) };
  if (it.kind === 'credits') return { at: it.at, name: `Bought ${it.credits.toLocaleString()} credits`, sub: it.reversed ? 'Refunded or reversed' : 'Paid by card', amount: money(it.cents, it.currency || currency) };
  return { at: it.t, name: `Shop: ${it.note || 'purchase'}`, sub: 'Paid with credits', amount: '−' + Math.abs(it.amount).toLocaleString() + ' credits' };
}

export default function Payments() {
  const [plan, setPlan] = useState(null);
  const [hist, setHist] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(false);

  const load = useCallback(() => Promise.all([api('/storage'), api('/payments')]).then(([s, h]) => { setPlan(s); setHist(h); setErr(''); }).catch((e) => {
    if (e.status === 401) { location.replace('/app'); return; }
    setErr(e.message);
  }), []);
  useEffect(() => { document.title = 'Payments - Aduna'; load(); }, [load]);

  async function cancelPlan() {
    setBusy(true); setErr(''); setNote('');
    try { await api('/storage/cancel', { method: 'POST' }); setNote('Your plan will not renew.'); await load(); }
    catch (e) { setErr(e.message); }
    setAsk(false); setBusy(false);
  }

  // shop buys only: credit packs are listed from the payments, so their ledger lines would repeat them
  const rows = hist ? [
    ...hist.payments,
    ...hist.ledger.filter((l) => l.reason === 'shop'),
  ].map((it) => rowOf(it, hist.currency)).sort((a, b) => b.at - a.at) : [];

  return (
    <div className="pay-page">
      <div className="pay-wrap">
        <header className="pay-head">
          <a className="pay-back" href="/app" aria-label="Back to Aduna" title="Back to Aduna"><Icon name="back" size={20} /></a>
          <h1>Payments</h1>
        </header>
        {err && <p className="pay-msg error" role="alert">{err}</p>}
        {note && <p className="pay-msg ok" role="status">{note}</p>}
        {!plan && !err && <p className="pay-quiet">Loading…</p>}
        {plan && hist && (
          <>
            <h2 className="pay-h">Plans</h2>
            <PlanCard s={plan} busy={busy} onCancel={() => setAsk(true)} />

            <h2 className="pay-h">Purchase history</h2>
            {rows.length === 0
              ? <div className="pay-empty"><Icon name="bag" size={22} /><b>No purchases yet</b><span>Plus payments, credit packs and shop buys will show up here.</span></div>
              : (
                <ul className="pay-list">
                  {rows.map((r, i) => (
                    <li key={i} className="pay-row">
                      <div className="pay-row-main">
                        <b>{r.name}</b>
                        <span className="pay-sub">{day(r.at)}, {clock(r.at)} · {r.sub}</span>
                      </div>
                      <b className="pay-amt">{r.amount}</b>
                    </li>
                  ))}
                </ul>
              )}
            <p className="pay-quiet pay-foot">PayPal keeps your card. Aduna never sees it.</p>
          </>
        )}
      </div>
      {ask && (
        <Modal title="Cancel storage plan" onClose={() => !busy && setAsk(false)}>
          <p className="pay-line">You keep the plan until the month you paid for ends{plan?.paidThrough ? ` (${day(plan.paidThrough)})` : ''}. After that your files are kept for 14 more days.</p>
          <div className="pay-actions">
            <button type="button" className="btn" onClick={() => setAsk(false)} disabled={busy}>Keep my plan</button>
            <button type="button" className="btn danger" onClick={cancelPlan} disabled={busy}>{busy ? 'Cancelling…' : 'Cancel plan'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
