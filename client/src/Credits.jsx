import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon, Modal } from './ui.jsx';
import { PanelSkeleton } from './ShellBits.jsx';
import { askConfirm } from './Dialogs.jsx';
import { AddBadgeModal, BuyConfirm, Celebration, EditBadgeModal, ShopTile, useCountUp } from './Shop.jsx';

const money = (cents, currency) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: String(currency || 'usd').toUpperCase() });
const REASON = { message: 'Messages', purchase: 'Bought credits', refund: 'Refund', chargeback: 'Payment reversed', shop: 'Shop', artist: 'Artist sale' };
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

// The daily check-in streak (Quests page): the current run, the best run, a warning when it is about to end, and the bonuses waiting along the way.
// The server decides everything shown here (credits.js streakView); this only draws it.
function StreakCard({ s }) {
  if (!s) return null;
  const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;
  return (
    <div className="streak-card">
      <div className="streak-top">
        <span className="streak-flame" aria-hidden="true"><Icon name="flame" size={24} /></span>
        <span className="streak-num">{s.current}</span>
        <b>{s.current === 1 ? 'day streak' : 'days streak'}</b>
        <span className="muted small">Best: {days(s.best)}</span>
      </div>
      <div className="muted small">
        {s.current === 0
          ? 'Check in today to start a streak. Every day in a row adds to your reward.'
          : `Every day in a row adds +2 to your check-in, up to +${s.dailyBonusMax}.`}
        {s.next && ` ${days(s.next.left)} to go for the ${s.next.days}-day bonus of +${s.next.bonus}.`}
      </div>
      {s.atRisk && <div className="streak-warn" role="status">You have not checked in today. Check in to keep your {days(s.current)} streak.</div>}
      <div className="streak-track" aria-label="Streak bonuses">
        {s.milestones.map((m) => (
          <div key={m.days} className={'streak-step' + (m.reached ? ' reached' : '') + (s.next && s.next.days === m.days ? ' next' : '')} title={m.reached ? 'Reached' : `${days(m.days)} in a row`}>
            <b>{m.days}d</b>+{m.bonus}
          </div>
        ))}
      </div>
    </div>
  );
}

// The one notice shown before paying. Shown on the Credits page and again inside the checkout.
function BuyNotices() {
  return (
    <div className="buy-notices">
      <div className="buy-note"><Icon name="shield" size={16} /><span>Aduna does not save your payment information, your security is our priority.</span></div>
    </div>
  );
}

// Loads PayPal's script once. The card boxes and the PayPal button come from it; card details are typed into boxes that PayPal
// serves inside Aduna's checkout, so they go straight to PayPal and never reach Aduna.
let sdkPromise = null;
function loadPaypal(clientId) {
  if (window.paypal?.CardFields) return Promise.resolve(window.paypal);
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&components=buttons,card-fields&currency=USD&intent=capture&disable-funding=paylater,venmo`;
      el.async = true;
      el.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error('PayPal did not load')));
      el.onerror = () => reject(new Error('PayPal did not load'));
      document.head.appendChild(el);
    }).catch((e) => { sdkPromise = null; throw e; });
  }
  return sdkPromise;
}

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// The card form and PayPal button inside Aduna's checkout. onPaid(result) runs after the server has captured the order.
function PayForm({ pack, clientId, getBuyer, blocked, total, onPaid, onFallback, onError }) {
  const [ready, setReady] = useState(false);
  const [cardOk, setCardOk] = useState(true);
  const [noCard, setNoCard] = useState(false);
  const [paying, setPaying] = useState(false);
  const [live, setLive] = useState(false); // card boxes fade in once PayPal has drawn them (no white flash)
  const cf = useRef(null);
  const blockedRef = useRef(blocked); blockedRef.current = blocked;

  useEffect(() => {
    let dead = false, buttons = null;
    const makeOrder = (method) => () => api('/credits/paypal/order', { method: 'POST', body: { packId: pack.id, method, ...getBuyer() } }).then((r) => r.orderId);
    const approved = ({ orderID }) => api('/credits/paypal/capture', { method: 'POST', body: { orderId: orderID } }).then((r) => { if (!dead) onPaid(r); });
    const fail = (e) => { if (!dead) { setPaying(false); onError(e?.message && !/^\s*\{/.test(e.message) && e.message.length < 160 ? e.message : 'The payment did not go through. Check your details or try another way to pay.'); } };
    loadPaypal(clientId).then((paypal) => {
      if (dead) return;
      const input = { 'font-size': '16px', 'font-family': 'inherit', color: css('--head', '#222'), background: 'transparent', padding: '0 14px', outline: 'none' };
      const fields = paypal.CardFields({
        createOrder: makeOrder('card'),
        onApprove: approved,
        onError: fail,
        style: { input, '.invalid': { color: css('--err-fg', '#c00') }, ':focus': { color: css('--head', '#222') } },
      });
      if (fields.isEligible()) {
        cf.current = fields;
        const shown = [
          fields.NameField({ placeholder: 'Name on card' }).render('#pp-name'),
          fields.NumberField({ placeholder: 'Card number' }).render('#pp-number'),
          fields.ExpiryField({ placeholder: 'MM / YY' }).render('#pp-expiry'),
          fields.CVVField({ placeholder: 'CVV' }).render('#pp-cvv'),
        ];
        const reveal = () => { if (!dead) setTimeout(() => { if (!dead) setLive(true); }, 120); }; // a beat for the iframe to paint its own background
        Promise.allSettled(shown).then(reveal);
        setTimeout(() => { if (!dead) setLive(true); }, 3000); // never leave the boxes hidden
      } else { setCardOk(false); setNoCard(true); console.warn('PayPal card fields are not available for this account/browser'); }
      buttons = paypal.Buttons({
        fundingSource: paypal.FUNDING.PAYPAL,
        style: { layout: 'vertical', shape: 'rect', height: 44, label: 'paypal' },
        onClick: (_d, actions) => { if (blockedRef.current) { onError('Choose where you are first so the right tax is added.'); return actions.reject(); } onError(''); return actions.resolve(); },
        createOrder: makeOrder('paypal'),
        onApprove: approved,
        onError: fail,
      });
      if (buttons.isEligible()) buttons.render('#pp-button');
      setReady(true);
    }).catch((e) => { console.error('PayPal checkout setup failed:', e); if (!dead) onFallback(e?.message || 'PayPal could not be set up'); });
    return () => { dead = true; try { buttons?.close(); } catch { /* already gone */ } cf.current = null; };
  }, [pack.id, clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  function payByCard() {
    if (!cf.current) return;
    onError(''); setPaying(true);
    cf.current.submit().catch((e) => { setPaying(false); onError(e?.message && e.message.length < 160 ? e.message : 'Check your card details and try again.'); });
  }

  return (
    <div className="pay-form">
      {!ready && <p className="muted small">Loading secure checkout…</p>}
      {noCard && <p className="error-text">Card payments are not switched on for this PayPal account yet, so only the PayPal button is available. (PayPal Business account: Advanced Credit and Debit Card Payments.)</p>}
      <div className={'pay-card' + (cardOk ? '' : ' hidden') + (live ? ' live' : '')}>
        <div className="pp-field" id="pp-name" />
        <div className="pp-field" id="pp-number" />
        <div className="pp-row"><div className="pp-field" id="pp-expiry" /><div className="pp-field" id="pp-cvv" /></div>
        <button type="button" className="btn primary pay-btn" disabled={!ready || paying || blocked} onClick={payByCard}>{paying ? 'Processing…' : `Pay ${total}`}</button>
      </div>
      <div className={'pay-or' + (ready ? '' : ' hidden')}><span>{cardOk ? 'or' : 'pay with'}</span></div>
      <div id="pp-button" className="pp-button" />
    </div>
  );
}

// Aduna's own full-screen checkout, laid out like Stripe's: the payment form on the left, the receipt on the right, an X to leave.
// With PayPal set up it shows the card boxes and a PayPal button; otherwise (Stripe, or if PayPal's script cannot load) a plain hand-off button.
const PROVINCES = { AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon' };
const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
const REGIONS = { CA: PROVINCES, US: STATES };
const countryName = (c) => { try { return new Intl.DisplayNames(undefined, { type: 'region' }).of(c) || c; } catch { return c; } };

// Asks the browser where the buyer is, then turns the coordinates into a country and state/province (BigDataCloud, no key needed).
// It only fills in the pickers; the buyer can change them, and the server still works out the tax from what they chose.
function locate(tax) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser cannot share its location.'));
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${pos.coords.latitude}&longitude=${pos.coords.longitude}&localityLanguage=en`);
        const j = await r.json();
        const country = String(j.countryCode || '').toUpperCase();
        if (!country) throw new Error('no country');
        const sub = String(j.principalSubdivisionCode || '').toUpperCase().split('-')[1] || '';
        resolve({ country: tax.countries.includes(country) ? country : 'ZZ', region: sub });
      } catch { reject(new Error('Could not work out where you are. Please choose below.')); }
    }, (e) => reject(new Error(e.code === 1 ? 'Location is blocked for this site. Please choose below.' : 'Could not get your location. Please choose below.')), { timeout: 10000, maximumAge: 600000 });
  });
}

function Checkout({ pack, provider, clientId, tax, busy, error, onPay, onPaid, onError, onClose }) {
  const [country, setCountry] = useState('');
  const [region, setRegion] = useState('');
  const [locBusy, setLocBusy] = useState(false);
  const [locMsg, setLocMsg] = useState('');
  const buyerRef = useRef({}); buyerRef.current = { country, region: REGIONS[country] ? region : '' };
  const [fallback, setFallback] = useState(''); // why the card form could not start; the buyer is then offered PayPal's own page
  const who = provider === 'paypal' ? 'PayPal' : 'Stripe';
  const embedded = provider === 'paypal' && !!clientId && !fallback;
  const needsRegion = !!tax && !!REGIONS[country] && Object.keys(tax.rates).some((k) => k.startsWith(country + '-'));
  const code = needsRegion ? (region ? country + '-' + region : '') : country;
  const picked = !tax || (!!country && !(needsRegion && !region));
  const hit = tax && picked ? tax.rates[code] : null;
  const parts = hit ? (hit.parts || [{ label: hit.label, rate: hit.rate }]).map((x) => ({ ...x, amount: Math.round((pack.cents * x.rate) / 100) })) : [];
  const taxCents = parts.reduce((t, x) => t + x.amount, 0);
  const price = money(pack.cents, pack.currency), total = money(pack.cents + taxCents, pack.currency);
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [busy, onClose]);
  return (
    <div className="co" role="dialog" aria-label="Checkout">
      <div className="co-top">
        <span className="co-logo" role="img" aria-label="Aduna" />
        <button type="button" className="icon-btn co-x" aria-label="Cancel checkout" title="Cancel" onClick={onClose} disabled={busy}><Icon name="close" size={22} /></button>
      </div>
      <div className="co-grid">
        <main className="co-form">
          <h1 className="co-h">{embedded ? 'Pay with card' : `Pay with ${who}`}</h1>
          {tax && (
            <div className="co-where">
              <label className="muted small" htmlFor="co-country">Where are you? (sets the tax)</label>
              <button type="button" className="btn co-loc" disabled={busy || locBusy} onClick={async () => {
                setLocBusy(true); setLocMsg('');
                try { const r = await locate(tax); setCountry(r.country); setRegion(REGIONS[r.country] && REGIONS[r.country][r.region] ? r.region : ''); setLocMsg('Filled in from your location. Change it below if it is wrong.'); }
                catch (e) { setLocMsg(e.message); }
                setLocBusy(false);
              }}><Icon name="pin" size={16} /> {locBusy ? 'Finding you…' : 'Use my location'}</button>
              {locMsg && <p className="muted small co-locmsg">{locMsg}</p>}
              <select id="co-country" className="co-select" value={country} onChange={(e) => { setCountry(e.target.value); setRegion(''); }} disabled={busy}>
                <option value="" disabled>Choose your country</option>
                {tax.countries.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}
                <option value="ZZ">Somewhere else</option>
              </select>
              {needsRegion && (
                <select className="co-select" aria-label={country === 'US' ? 'State' : 'Province'} value={region} onChange={(e) => setRegion(e.target.value)} disabled={busy}>
                  <option value="" disabled>{country === 'US' ? 'Choose your state' : 'Choose your province'}</option>
                  {Object.entries(REGIONS[country]).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                </select>
              )}
            </div>
          )}
          {embedded && <PayForm pack={pack} clientId={clientId} getBuyer={() => buyerRef.current} blocked={!picked} total={total} onPaid={onPaid} onError={onError} onFallback={setFallback} />}
          {provider === 'paypal' && !clientId && <p className="error-text">The server did not send a PayPal client id, so the card form is off. Redeploy the server with the latest code.</p>}
          {fallback && provider === 'paypal' && <p className="error-text">The card form could not start ({fallback}). You can still pay on PayPal's own page.</p>}
          {!embedded && <button type="button" className="btn primary pay-btn" disabled={busy || !picked} onClick={() => onPay(buyerRef.current)}>{busy ? `Opening ${who}…` : `Pay ${total} with ${who}`}</button>}
          {error && <p className="error-text">{error}</p>}
          <BuyNotices />
        </main>
        <aside className="co-receipt">
          <div className="co-rcpt-in">
            <div className="muted small">Order summary</div>
            <div className="co-total">{total}</div>
            <div className="co-item">
              <span className="co-item-ic"><Icon name="coin" size={22} /></span>
              <div className="co-item-t"><b>Aduna credits</b><span className="muted small">{pack.credits.toLocaleString()} credits · Qty 1</span></div>
              <b>{price}</b>
            </div>
            <div className="co-line"><span>Subtotal</span><span>{price}</span></div>
            {tax && !picked && <div className="co-line"><span>Tax</span><span className="muted small">Choose where you are</span></div>}
            {tax && picked && !parts.length && <div className="co-line"><span>Tax</span><span>{money(0, pack.currency)}</span></div>}
            {parts.map((x) => <div key={x.label} className="co-line"><span>{x.label} ({x.rate}%)</span><span>{money(x.amount, pack.currency)}</span></div>)}
            <div className="co-line total"><span>Total due today</span><b>{total}</b></div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// A limited-time event (Halloween, Christmas): its quests and, at Christmas, the Advent calendar. The server decides what is open;
// in a developer's test mode (ev.test) claims are dry runs that pay nothing.
const dayLabel = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
function EventSection({ ev, locked, busy, onClaim, onDoor }) {
  const adv = ev.advent;
  return (
    <div className={'event-card ' + ev.id + (ev.test ? ' test' : '')}>
      <div className="event-head">
        <span className="event-ico" aria-hidden="true">{ev.icon}</span>
        <div className="grow">
          <h4 className="credit-h">{ev.label} event</h4>
          <div className="muted small">{ev.until ? `Until ${dayLabel(ev.until)}` : 'Test mode'}{ev.badge ? ` · finish Trick or Treat for the ${ev.badge.emoji} ${ev.badge.name} badge` : ''}</div>
        </div>
        {ev.test && <span className="event-test">TEST MODE</span>}
      </div>
      {ev.test && <p className="muted small event-note">Test mode is on for your developer account. Claims here are a dry run: they show the reward but pay no credits and give no badge. Turn it off or reset it in Settings &gt; Developer.</p>}
      <div className="quests">{ev.quests.map((q) => <Quest key={q.id} q={q} locked={locked} busy={busy} onClaim={onClaim} />)}</div>
      {adv && (
        <>
          <h4 className="credit-h advent-h">Advent calendar <span className="muted small">· {adv.opened} of {adv.total} doors opened</span></h4>
          <div className="advent" role="list">
            {adv.doors.map((dr) => (
              <button key={dr.day} role="listitem" type="button" className={'door ' + dr.state + (dr.day === adv.total ? ' last' : '')}
                disabled={dr.state !== 'ready' || locked || busy === 'door' + dr.day}
                title={dr.state === 'locked' ? `Opens on ${dr.day} December` : dr.state === 'opened' ? `Door ${dr.day}: +${dr.reward} credits` : `Open door ${dr.day}`}
                onClick={() => onDoor(dr)}>
                <span className="door-n">{dr.day}</span>
                <span className="door-r">{dr.state === 'opened' ? <Icon name="check" size={13} /> : dr.state === 'locked' ? <Icon name="lock" size={13} /> : <><Icon name="coin" size={11} />{dr.reward}</>}</span>
              </button>
            ))}
          </div>
          <p className="muted small">A door opens on its own day in December and stays open until the event ends, so a missed one can still be opened. Open all {adv.total} doors for the {adv.badge.emoji} {adv.badge.name} badge.</p>
        </>
      )}
    </div>
  );
}

// Credits: balance, buying, the earning rules, quests and recent activity.
// `rev` goes up whenever the server says the balance changed, so this page refreshes itself.
// `page` picks the tab: 'shop' (buy credits, spend them on badges, recent activity) or 'quests' (earn credits: events, chatting, quests).
export default function Credits({ page = 'shop', onBack, rev, justPaid, paypalOrder, creator = false }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [buying, setBuying] = useState(false); // the "Buy credits" window (the packs) is open
  const [confirm, setConfirm] = useState(null); // the badge the person is about to buy, or null
  const [won, setWon] = useState(null); // the badge just bought (the celebration), or null
  const [adding, setAdding] = useState(false); // a creator's "add a badge" window
  const [editing, setEditing] = useState(null); // the shop badge a creator is editing, or null
  const [, setTick] = useState(0);
  const [checkout, setCheckout] = useState(null); // the pack being checked out, or null
  const [coErr, setCoErr] = useState('');
  const captured = useRef('');
  const shownBalance = useCountUp(d ? d.balance : null);
  const [bump, setBump] = useState(0);
  useEffect(() => { if (d) setBump((n) => n + 1); }, [d?.balance]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => api('/credits').then((r) => { setD(r); setErr(''); }).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load, rev]);
  // The daily shop changes at a set time: keep the countdown moving, and refresh the shop when the time passes (also when an end date passes).
  const resetsAt = d?.shopInfo?.resetsAt;
  useEffect(() => {
    const iv = setInterval(() => { setTick((n) => n + 1); if (resetsAt && Date.now() >= resetsAt) load(); }, 30_000);
    return () => clearInterval(iv);
  }, [resetsAt, load]);
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
  async function pay(buyer = {}) {
    const p = checkout;
    setBusy(p.id); setCoErr('');
    try { const { url } = await api('/credits/checkout', { method: 'POST', body: { packId: p.id, ...buyer } }); window.location.assign(url); }
    catch (e) { setCoErr(e.message); setBusy(''); }
  }
  // Paid inside Aduna's checkout: the server already captured the order, so close the window and show the result.
  function paid(r) {
    setCheckout(null); setBusy(''); setCoErr(''); load();
    setNote(r.status === 'completed' ? 'Payment received. Your credits have been added.' : 'PayPal is still processing your payment. Your credits are added as soon as it clears.');
  }
  async function claim(q) {
    setBusy(q.id); setErr(''); setNote('');
    try {
      const r = await api(`/credits/quests/${q.id}/claim`, { method: 'POST' });
      setD(r);
      setNote(`+${r.amount} credits for “${q.title}”${r.milestone ? `, including a +${r.milestone} bonus for ${r.milestoneStreak} days in a row!` : ''}`);
    }
    catch (e) { setErr(e.message); }
    setBusy('');
  }

  // Tapping a badge opens the confirm window; only its Buy button spends credits. The server holds the price and does the buying.
  async function buyItem(item) {
    setBusy(item.id); setErr(''); setNote('');
    try { const r = await api(`/credits/shop/${item.id}/buy`, { method: 'POST' }); setD(r); setConfirm(null); setWon(item); }
    catch (e) { setErr(e.message); setConfirm(null); }
    setBusy('');
  }
  async function takeOffSale(item) {
    if (!(await askConfirm({ title: 'Take off sale', body: `Take the ${item.name} badge off sale? People who already have it keep it.`, confirmLabel: 'Take off sale' }))) return;
    setErr(''); setNote('');
    try { await api('/badges/' + item.id, { method: 'PATCH', body: { price: null } }); load(); setNote(`${item.name} is off sale.`); }
    catch (e) { setErr(e.message); }
  }
  // A creator's quick controls on a shop tile. The server holds the truth; the page just reloads.
  async function patchBadge(item, body, msg) {
    setErr(''); setNote('');
    try { await api('/badges/' + item.id, { method: 'PATCH', body }); load(); setNote(msg); }
    catch (e) { setErr(e.message); }
  }
  const togglePin = (item) => patchBadge(item, { pinned: !item.pinned }, item.pinned ? `${item.name} is unpinned.` : `${item.name} is pinned to the top of the shop.`);
  const toggleDaily = (item) => patchBadge(item, { daily: !item.daily }, item.daily ? `${item.name} is back in the regular shop.` : `${item.name} is now part of the daily shop.`);
  const timeLeft = (ms) => { const m = Math.max(1, Math.ceil(ms / 60_000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

  const seasonNote = (r, what) => (r.test
    ? `Test mode: ${what} would pay +${r.amount} credits (nothing was paid)`
    : `+${r.amount} credits for ${what}${r.badge ? ` and the ${r.badge} badge` : ''}`);
  async function claimSeason(q) {
    setBusy(q.id); setErr(''); setNote('');
    try { const r = await api(`/credits/season/quests/${q.id}/claim`, { method: 'POST' }); setD(r); setNote(seasonNote(r, `“${q.title}”`)); }
    catch (e) { setErr(e.message); }
    setBusy('');
  }
  async function openDoor(door) {
    setBusy('door' + door.day); setErr(''); setNote('');
    try { const r = await api(`/credits/season/advent/${door.day}/open`, { method: 'POST' }); setD(r); setNote(seasonNote(r, `Advent door ${door.day}`)); }
    catch (e) { setErr(e.message); }
    setBusy('');
  }

  const locked = d?.unlocksAt && d.unlocksAt > Date.now();
  const mins = locked ? Math.max(1, Math.ceil((d.unlocksAt - Date.now()) / 60000)) : 0;
  const m = d?.messaging;

  if (checkout && d) return <Checkout pack={checkout} provider={d.provider} clientId={d.paypalClientId} tax={d.tax} busy={!!busy} error={coErr} onPay={pay} onPaid={paid} onError={setCoErr} onClose={() => { setCheckout(null); setBusy(''); }} />;

  return (
    <section className="chat">
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title="Back" aria-label="Back to list" onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash"><Icon name={page === 'quests' ? 'flag' : 'bag'} size={20} /></span>
        <h3>{page === 'quests' ? 'Quests' : 'Shop'}</h3>
      </header>
      <div className="credits-body">
        {!d && !err && <PanelSkeleton label="Loading" />}
        {err && <p className="error-text">{err}</p>}
        {justPaid && <p className="ok-text">Thank you! Your credits are added as soon as the payment is confirmed, usually within seconds.</p>}
        {note && <p className="ok-text">{note}</p>}
        {confirm && d && <BuyConfirm item={confirm} balance={d.balance} busy={busy === confirm.id} onConfirm={() => buyItem(confirm)} onClose={() => setConfirm(null)} />}
        {won && <Celebration item={won} onClose={() => setWon(null)} />}
        {adding && <AddBadgeModal onClose={() => setAdding(false)} onAdded={(name) => { setAdding(false); load(); setNote(`${name} is in the shop.`); }} />}
        {editing && <EditBadgeModal item={editing} onClose={() => setEditing(null)} onSaved={(name) => { setEditing(null); load(); setNote(`${name} is updated.`); }} />}
        {buying && d && (
          <Modal title="Buy credits" onClose={() => setBuying(false)}>
            <div className="credit-packs">
              {d.packs.map((p) => (
                <div key={p.id} className="credit-pack">
                  <div className="pack-amt"><Icon name="coin" size={20} />{p.credits.toLocaleString()}</div>
                  <button className="btn primary" disabled={!d.purchases} onClick={() => { setBuying(false); setCoErr(''); setCheckout(p); }}>{money(p.cents, p.currency)}</button>
                </div>
              ))}
            </div>
            {d.purchases && <BuyNotices />}
            {!d.purchases && <p className="muted small">Buying credits is not set up on this server yet.</p>}
          </Modal>
        )}
        {d && (
          <>
            <div className="credit-balance">
              <Icon name="coin" size={34} />
              <div><div key={bump} className="credit-num bump">{shownBalance.toLocaleString()}</div><div className="muted small">your credits</div></div>
              <button className="btn primary small-btn buy-credits-btn" onClick={() => setBuying(true)}><Icon name="coin" size={14} /><span>Buy credits</span></button>
              <div className="credit-stats muted small">
                <span>{d.lifetime.earned.toLocaleString()} earned</span><span>{d.lifetime.bought.toLocaleString()} bought</span><span>{d.lifetime.spent.toLocaleString()} spent</span>
                {d.streak > 1 && <span><Icon name="flame" size={14} className="inline-icon" /> {d.streak}-day streak</span>}
              </div>
            </div>
            {locked && page === 'quests' && <p className="muted notice-line">New accounts can earn and claim rewards after 30 minutes. About {mins} min to go.</p>}
            {page === 'quests' && d.streakInfo && <StreakCard s={d.streakInfo} />}
            {page === 'quests' && d.event && <EventSection ev={d.event} locked={locked && !d.event.test} busy={busy} onClaim={claimSeason} onDoor={openDoor} />}

            {page === 'shop' && <>
            <div className="shop-head">
              <h4 className="credit-h">Badges</h4>
              {creator && <button className="btn primary small-btn" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add a badge</button>}
            </div>
            <p className="muted small shop-intro">Spend your credits on badges that show next to your name everywhere in Aduna, and on profile frames that go around your picture. Each one is yours to keep.</p>
            {d.shop.length === 0
              ? <div className="shop-empty muted">{creator ? 'No badges are for sale yet. Add one with a picture and a price.' : 'No badges are for sale right now. Check back soon.'}</div>
              : (() => {
                const tile = (it) => <ShopTile key={it.id} item={it} balance={d.balance} busy={busy} creator={creator} onOpen={setConfirm} onOffSale={takeOffSale} onPin={togglePin} onDaily={toggleDaily} onEdit={setEditing} />;
                const regular = d.shop.filter((it) => !it.daily), daily = d.shop.filter((it) => it.daily);
                const max = d.shopInfo?.dailyMax || 5;
                return (
                  <>
                    {regular.length > 0 && <div className="shop tiles">{regular.map(tile)}</div>}
                    {daily.length > 0 && (
                      <>
                        <div className="shop-head daily-head">
                          <h4 className="credit-h">Daily shop</h4>
                          {d.shopInfo?.resetsAt && <span className="muted small">New picks in {timeLeft(d.shopInfo.resetsAt - Date.now())}</span>}
                        </div>
                        <p className="muted small shop-intro">{creator
                          ? `Up to ${max} of these badges are picked at random each day. The others rest until a later day. ${daily.length} ${daily.length === 1 ? 'badge is' : 'badges are'} ticked as daily.`
                          : `A few badges show up here each day, picked at random. Come back tomorrow to see what’s new.`}</p>
                        <div className="shop tiles">{daily.map(tile)}</div>
                      </>
                    )}
                  </>
                );
              })()}

            <h4 className="credit-h">Recent activity</h4>
            {d.ledger.length === 0 && <p className="muted small">Nothing yet.</p>}
            <div className="ledger">
              {d.ledger.map((l, i) => (
                <div key={i} className="ledger-row">
                  <span className="grow">{l.reason === 'quest' ? l.note : l.reason === 'shop' ? `Shop: ${l.note || 'purchase'}` : l.reason === 'artist' ? `Artist sale: ${l.note || 'badge'}` : REASON[l.reason] || l.reason}{l.reason === 'message' && l.n > 1 ? ` (${l.n})` : ''}<span className="muted small"> · {when(l.t)}</span></span>
                  <b className={l.amount > 0 ? 'plus' : 'minus'}>{l.amount > 0 ? '+' : '−'}{Math.abs(l.amount).toLocaleString()}</b>
                </div>
              ))}
            </div>
            </>}

            {page === 'quests' && <>
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
            </>}
          </>
        )}
      </div>
    </section>
  );
}
