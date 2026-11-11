import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Select } from './Controls.jsx';
import { api } from './api.js';
import { Icon, Modal } from './ui.jsx';
import { EmptyState, PanelSkeleton } from './ShellBits.jsx';
import { askConfirm, toast } from './Dialogs.jsx';
import { AddBadgeModal, BuyConfirm, Celebration, EditBadgeModal, ShopTile, useCountUp } from './Shop.jsx';
import { homeCountry, rememberCountry, priceFor, rateNote } from './region.js';

const money = (cents, currency) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: String(currency || 'usd').toUpperCase() });

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
        : <button className="btn primary small-btn" disabled={!q.done || locked || busy === q.id} onClick={() => onClaim(q)}>{busy === q.id ? 'Claiming…' : q.done ? 'Claim' : `${q.have}/${q.need}`}</button>}
    </div>
  );
}

// ---- Sponsors (see server/ads.js). Nothing here ever shows in chat, voice or profiles; it only appears on this page, and only when the server has sponsors. ----
// The quiet card: one picture, a label, no sound, no autoplay.
// `big` is the roomier layout used while someone is watching: a wide picture on top, then the text and a "Learn more" line.
function SponsorCard({ ad, big = false }) {
  if (!ad) return null;
  return (
    <a className={`sponsor-card${big ? ' big' : ''}`} href={ad.url} target="_blank" rel="noopener noreferrer sponsored">
      {ad.image && <img src={ad.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
      <div className="sponsor-text">
        <span className="sponsor-tag">Sponsored · {ad.sponsor}</span>
        <b>{ad.title}</b>
        {ad.body && <span className="muted small">{ad.body}</span>}
        {big && <span className="sponsor-cta">Learn more ↗</span>}
      </div>
    </a>
  );
}

// A Google AdSense display unit (see server/ads.js adsenseConfig). Only drawn when the server hands over a publisher id and slot, which it does
// only for people the 'sponsored-card' switch is on for. If Google or an ad blocker refuses, the box simply stays empty.
function AdSenseUnit({ cfg }) {
  useEffect(() => {
    if (!cfg) return;
    try {
      if (!document.querySelector('script[data-adsense]')) {
        const s = document.createElement('script');
        s.async = true; s.crossOrigin = 'anonymous'; s.dataset.adsense = '1';
        s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(cfg.client)}`;
        document.head.appendChild(s);
      }
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch { /* blocked: no ad, no problem */ }
  }, [cfg && cfg.client, cfg && cfg.slot]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cfg) return null;
  return (
    <div className="adsense-wrap">
      <span className="sponsor-tag">Sponsored</span>
      <ins className="adsbygoogle adsense-unit" data-ad-client={cfg.client} data-ad-slot={cfg.slot} data-ad-format="auto" data-full-width-responsive="true" />
    </div>
  );
}

// "Watch a sponsor, earn credits". Opt-in: nothing starts until the button is pressed. The server runs the timer and pays; this only counts down.
function WatchSponsor({ a, locked, onDone }) {
  const [run, setRun] = useState(null);   // { token, ad, seconds }
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!run) return undefined;
    setLeft(run.seconds);
    const iv = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(iv);
  }, [run]);
  async function start() {
    setBusy(true); setErr('');
    try { const r = await api('/credits/ads/start', { method: 'POST' }); setLeft(r.seconds); setRun(r); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  }
  async function finish() {
    setBusy(true); setErr('');
    try { const r = await api('/credits/ads/complete', { method: 'POST', body: { token: run.token } }); setRun(null); onDone(r); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  }
  const cooling = a.nextAt && a.nextAt > Date.now();
  return (
    <div className="earn-card sponsor-watch">
      <p>Watch a short sponsor for <b>{a.reward} credits</b>. Up to <b>{a.dailyMax} a day</b>. It is always your choice; nothing plays on its own.</p>
      {!run && (
        <>
          <button className="btn primary small-btn" disabled={busy || locked || a.left <= 0 || cooling} onClick={start}>
            {a.left <= 0 ? 'All done for today' : cooling ? 'Next one in a minute' : locked ? 'Unlocks after 30 minutes' : `Watch a sponsor (+${a.reward})`}
          </button>
          <div className="muted small">{a.watchedToday} of {a.dailyMax} watched today · resets at midnight UTC</div>
        </>
      )}
      {run && (
        <div className="sponsor-run">
          <SponsorCard ad={run.ad} big />
          <div className="sponsor-bar" role="progressbar" aria-label="Time until your reward" aria-valuemin={0} aria-valuemax={run.seconds} aria-valuenow={run.seconds - left}>
            <div className={`sponsor-bar-fill${left === 0 ? ' done' : ''}`} style={{ width: `${Math.round(((run.seconds - left) / run.seconds) * 100)}%` }} />
          </div>
          <div className="muted small sponsor-bar-text">{left > 0 ? `${left}s left to earn +${a.reward} credits` : 'All done. Collect your reward below.'}</div>
          <div className="sponsor-actions">
            <button className="btn primary small-btn" disabled={busy || left > 0} onClick={finish}>{left > 0 ? 'Keep this open…' : `Collect +${a.reward} credits`}</button>
            <button className="btn small-btn" onClick={() => setRun(null)}>Cancel</button>
          </div>
        </div>
      )}
      {err && <p className="error-text">{err}</p>}
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

// The notices shown before paying. Shown on the Credits page and again inside the checkout, where `paypal` and `tax` add the two notes below.
function BuyNotices({ paypal = false, tax = false, place = false, saved = false, fee = false }) {
  return (
    <div className="buy-notices">
      {saved
        ? <div className="buy-note"><Icon name="shield" size={16} /><span>Your card is saved securely by PayPal, not by Aduna. Aduna never sees or stores your card details. Your plan renews every month and you can cancel any time in Storage.</span></div>
        : <div className="buy-note"><Icon name="shield" size={16} /><span>Aduna does not save your payment information, your security is our priority.</span></div>}
      {paypal && <div className="buy-note"><Icon name="shield" size={16} /><span>Secure checkout is provided by PayPal. Your card details are entered directly with PayPal and are never seen or stored by Aduna.</span></div>}
      {fee && <div className="buy-note"><Icon name="coin" size={16} /><span>The processing fee is what PayPal charges to handle your payment. Aduna adds it so the price of the item stays the same for us.</span></div>}
      {tax && <div className="buy-note"><Icon name="pin" size={16} /><span>We ask for your billing location only to calculate the sales tax that applies to your order. Your postal code stays in your browser; only your country and province or state are sent with the order.</span></div>}
      {place && <div className="buy-note"><Icon name="pin" size={16} /><span>Aduna sells to Canada and the US, and prices are in Canadian or US dollars depending on where you are. Your postal code stays in your browser; only your country and province or state are sent with the order.</span></div>}
    </div>
  );
}

// Loads PayPal's script once per currency. The card boxes and the PayPal button come from it; card details are typed into boxes that
// PayPal serves inside Aduna's checkout, so they go straight to PayPal and never reach Aduna.
// Each currency gets its own namespace: a second copy of the script under window.paypal does not start and leaves no CardFields.
const sdkLoads = {};
function loadPaypal(clientId, currency = 'usd') {
  const cur = String(currency).toUpperCase();
  const ns = 'paypal_' + cur.toLowerCase();
  if (!sdkLoads[cur]) {
    sdkLoads[cur] = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&components=buttons,card-fields&currency=${cur}&intent=capture&disable-funding=paylater,venmo`;
      el.dataset.ppSdk = '1';
      el.dataset.namespace = ns;
      el.async = true;
      el.onload = () => (window[ns] ? resolve(window[ns]) : (el.remove(), reject(new Error('PayPal did not load'))));
      el.onerror = () => { el.remove(); reject(new Error('PayPal did not load')); };
      document.head.appendChild(el);
    }).catch((e) => { delete sdkLoads[cur]; throw e; });
  }
  return sdkLoads[cur];
}

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// The card form and PayPal button inside Aduna's checkout. onPaid(result) runs after the server has captured the order.
// For a monthly plan (`recurring`) the card is saved by PayPal (the server asks for it) and charged by the server every month; PayPal's
// button cannot do that, so instead there is a button that opens PayPal's own subscription page (`onPaypalPage`) for PayPal-account payers.
function PayForm({ pack, clientId, currency, getBuyer, blocked, total, recurring = false, onPaypalPage, onPaid, onFallback, onError }) {
  const [ready, setReady] = useState(false);
  const [cardOk, setCardOk] = useState(true);
  const [noCard, setNoCard] = useState(false);
  const [paying, setPaying] = useState(false);
  const [live, setLive] = useState(false); // card boxes fade in once PayPal has drawn them (no white flash)
  const cf = useRef(null);
  const blockedRef = useRef(blocked); blockedRef.current = blocked;

  useEffect(() => {
    let dead = false, buttons = null;
    const makeOrder = (method) => () => (recurring
      ? api('/storage/vault/order', { method: 'POST', body: { ...getBuyer() } })
      : api('/credits/paypal/order', { method: 'POST', body: { packId: pack.id, method, ...getBuyer() } })).then((r) => r.orderId);
    const approved = ({ orderID }) => api(recurring ? '/storage/vault/capture' : '/credits/paypal/capture', { method: 'POST', body: { orderId: orderID } }).then((r) => { if (!dead) onPaid(r); });
    const fail = (e) => { console.error('PayPal card error:', e?.message || e); if (!dead) { setPaying(false); onError(e?.message && !/^\s*\{/.test(e.message) && e.message.length < 160 ? e.message : 'The payment did not go through. Check your details or try another way to pay.'); } };
    loadPaypal(clientId, currency).then((paypal) => {
      if (dead) return;
      const input = { 'font-size': '15px', 'font-family': 'inherit', 'font-weight': '500', 'letter-spacing': '0.01em', color: css('--head', '#222'), background: 'transparent', border: 'none', 'border-radius': '0', 'box-shadow': 'none', appearance: 'none', '-webkit-appearance': 'none', padding: '0 16px', outline: 'none' };
      // CardFields is missing when PayPal has cards off for this account or currency; the PayPal button still works.
      const fields = typeof paypal.CardFields !== 'function' ? null : paypal.CardFields({
        createOrder: makeOrder('card'),
        onApprove: approved,
        onError: fail,
        style: { input, '.invalid': { color: css('--err-fg', '#c00') }, ':focus': { color: css('--head', '#222') } },
      });
      if (fields?.isEligible()) {
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
      if (!recurring) {
        buttons = paypal.Buttons({
          fundingSource: paypal.FUNDING.PAYPAL,
          style: { layout: 'vertical', shape: 'rect', height: 44, label: 'paypal' },
          onClick: (_d, actions) => { if (blockedRef.current) { onError('Choose your country and province or state first.'); return actions.reject(); } onError(''); return actions.resolve(); },
          createOrder: makeOrder('paypal'),
          onApprove: approved,
          onError: fail,
        });
        if (buttons.isEligible()) buttons.render('#pp-button');
      }
      setReady(true);
    }).catch((e) => { console.error('PayPal checkout setup failed:', e); if (!dead) onFallback(e?.message || 'PayPal could not be set up'); });
    return () => { dead = true; try { buttons?.close(); } catch { /* already gone */ } cf.current = null; };
  }, [pack.id, clientId, recurring, currency]); // eslint-disable-line react-hooks/exhaustive-deps

  function payByCard() {
    if (!cf.current) return;
    onError(''); setPaying(true);
    cf.current.submit().catch((e) => { console.error('PayPal card error:', e?.message || e); setPaying(false); onError(e?.message && e.message.length < 160 ? e.message : 'Check your card details and try again.'); });
  }

  return (
    <div className="pay-form">
      {!ready && <p className="muted small">Loading secure checkout…</p>}
      {noCard && <p className="error-text">Card payments are not switched on for this PayPal account yet, so only the PayPal button is available. (PayPal Business account: Advanced Credit and Debit Card Payments.)</p>}
      <div className={'pay-card' + (cardOk ? '' : ' hidden') + (live ? ' live' : '')}>
        <div className="pp-field" id="pp-name" />
        <div className="pp-field" id="pp-number" />
        <div className="pp-row"><div className="pp-field" id="pp-expiry" /><div className="pp-field" id="pp-cvv" /></div>
        <button type="button" className="btn primary pay-btn" disabled={!ready || paying || blocked} onClick={payByCard}>{paying ? 'Processing…' : recurring ? `Subscribe ${total} a month` : `Pay ${total}`}</button>
      </div>
      <div className={'pay-or' + (ready ? '' : ' hidden')}><span>{cardOk ? 'or' : 'pay with'}</span></div>
      {recurring
        ? <button type="button" className={'btn pay-btn pay-pp' + (ready ? '' : ' hidden')} disabled={paying || blocked} onClick={onPaypalPage}>Subscribe with a PayPal account</button>
        : <div id="pp-button" className="pp-button" />}
    </div>
  );
}

// Aduna's own full-screen checkout, laid out like Stripe's: the payment form on the left, the receipt on the right, an X to leave.
// With PayPal set up it shows the card boxes and a PayPal button; otherwise (Stripe, or if PayPal's script cannot load) a plain hand-off button.
const PROVINCES = { AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon' };
const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
const REGIONS = { CA: PROVINCES, US: STATES };
// What PayPal's cut adds to `net` cents so the sale still nets `net` (same whole-number maths as server/fee.js). `fee` = { percent, fixedCents } from the server.
const processingFee = (net, fee) => { const den = 10000 - Math.round(fee.percent * 100); return Math.floor(((net + fee.fixedCents) * 10000 + den - 1) / den) - net; };
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

// Works out the country and state/province from a postal or ZIP code, right here in the browser: nothing is sent anywhere and Aduna never
// receives the code. Canada: the first letter names the province. US: the first three digits name the state. It only fills in the pickers.
const CA_FIRST = { A: 'NL', B: 'NS', C: 'PE', E: 'NB', G: 'QC', H: 'QC', J: 'QC', K: 'ON', L: 'ON', M: 'ON', N: 'ON', P: 'ON', R: 'MB', S: 'SK', T: 'AB', V: 'BC', Y: 'YT' };
const US_ZIP3 = [
  [5, 5, 'NY'], [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'], [50, 59, 'VT'], [60, 69, 'CT'], [70, 89, 'NJ'],
  [100, 149, 'NY'], [150, 196, 'PA'], [197, 199, 'DE'], [200, 200, 'DC'], [201, 201, 'VA'], [202, 205, 'DC'], [206, 219, 'MD'],
  [220, 246, 'VA'], [247, 268, 'WV'], [270, 289, 'NC'], [290, 299, 'SC'], [300, 319, 'GA'], [320, 349, 'FL'], [350, 369, 'AL'],
  [370, 385, 'TN'], [386, 397, 'MS'], [398, 399, 'GA'], [400, 427, 'KY'], [430, 459, 'OH'], [460, 479, 'IN'], [480, 499, 'MI'],
  [500, 528, 'IA'], [530, 549, 'WI'], [550, 567, 'MN'], [569, 569, 'DC'], [570, 577, 'SD'], [580, 588, 'ND'], [590, 599, 'MT'],
  [600, 629, 'IL'], [630, 658, 'MO'], [660, 679, 'KS'], [680, 693, 'NE'], [700, 715, 'LA'], [716, 729, 'AR'], [730, 749, 'OK'],
  [750, 799, 'TX'], [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'], [840, 847, 'UT'], [850, 865, 'AZ'], [870, 884, 'NM'],
  [885, 885, 'TX'], [889, 898, 'NV'], [900, 961, 'CA'], [967, 968, 'HI'], [970, 979, 'OR'], [980, 994, 'WA'], [995, 999, 'AK'],
];
function fromPostal(raw, tax) {
  const s = String(raw || '').toUpperCase().replace(/[\s-]/g, '');
  let country = '', region = '';
  if (/^[ABCEGHJKLMNPRSTVXY]\d[A-Z]/.test(s)) {                    // Canada: A1A 1A1
    country = 'CA';
    region = s[0] === 'X' ? (/^X0[ABC]/.test(s) ? 'NU' : 'NT') : CA_FIRST[s[0]] || '';
  } else if (/^\d{5}(\d{4})?$/.test(s)) {                           // US: 12345 or 12345-6789
    country = 'US';
    const n = Number(s.slice(0, 3));
    region = (US_ZIP3.find(([lo, hi]) => n >= lo && n <= hi) || [])[2] || '';
  } else return null;
  if (!tax.countries.includes(country)) return { country: 'ZZ', region: '' }; // somewhere the shop does not collect tax
  return { country, region };
}

// `pack` is a credit pack, or (Storage.jsx) a plan: { cents, currency, recurring: true, title, subtitle, icon }, billed every month.
// A plan with a PayPal client id uses the same card boxes: PayPal saves the card and the server charges it each month. Without the client id,
// or if the card form cannot start, the buyer is sent to PayPal's own page to approve a PayPal subscription instead.
export function Checkout({ pack, provider, clientId, tax, fee, regions, busy, error, onPay, onPaid, onError, onClose }) {
  const [country, setCountry] = useState(() => (regions ? homeCountry(regions.countries) : '')); // the country whose price was shown, so the price does not change under the buyer
  useEffect(() => { if (regions && country) rememberCountry(country); }, [regions, country]); // next time the shop shows this country's price
  const [region, setRegion] = useState('');
  const [locBusy, setLocBusy] = useState(false);
  const [locMsg, setLocMsg] = useState('');
  const [postal, setPostal] = useState(''); // typed here only; it fills in the pickers and is never sent to the server
  const buyerRef = useRef({}); buyerRef.current = { country, region: REGIONS[country] ? region : '' };
  const [fallback, setFallback] = useState(''); // why the card form could not start; the buyer is then offered PayPal's own page
  const who = provider === 'paypal' ? 'PayPal' : 'Stripe';
  const embedded = provider === 'paypal' && !!clientId && !fallback;
  const where = regions || tax;                  // the countries Aduna sells to, or else the ones it collects tax in
  const asks = !!where;
  const needsRegion = !!REGIONS[country] && (!!regions || (!!tax && Object.keys(tax.rates).some((k) => k.startsWith(country + '-'))));
  const code = needsRegion ? (region ? country + '-' + region : '') : country;
  const picked = !asks || (!!country && !(needsRegion && !region));
  const cur = regions && country ? regions.currency[country] || 'usd' : pack.currency || 'usd';
  const cents = cur === 'cad' && pack.cadCents ? pack.cadCents : pack.cents;
  const sellsOnly = regions ? `Aduna only sells to ${regions.countries.map(countryName).join(' and ')} for now.` : '';
  const hit = tax && picked ? tax.rates[code] : null;
  const parts = hit ? (hit.parts || [{ label: hit.label, rate: hit.rate }]).map((x) => ({ ...x, amount: Math.round((cents * x.rate) / 100) })) : [];
  const taxCents = parts.reduce((t, x) => t + x.amount, 0);
  // PayPal's processing fee, worked out the same way as the server does (server/fee.js); the server's amount is the one charged.
  // Where the buyer's country is not known yet, the fee waits until it is.
  const net = cents + taxCents;
  const feeCents = fee && picked && !(country && fee.skip.includes(country)) ? processingFee(net, fee) : 0;
  const price = money(cents, cur), total = money(net + feeCents, cur);
  // a postal code or location that is outside what Aduna sells to clears the picker and says so
  const fill = (r, msg) => {
    if (regions && r.country === 'ZZ') { setCountry(''); setRegion(''); setLocMsg(sellsOnly); return; }
    setCountry(r.country); setRegion(REGIONS[r.country] && REGIONS[r.country][r.region] ? r.region : ''); setLocMsg(msg);
  };
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
          {asks && (
            <div className="co-where">
              <label className="muted small" htmlFor="co-postal">Billing location</label>
              <p className="muted small co-locmsg">Enter your postal or ZIP code and we will find your {regions ? 'province or state' : 'tax region'}, or choose it below.</p>
              <input id="co-postal" className="co-select" type="text" autoComplete="postal-code" maxLength={10} placeholder="Postal or ZIP code" value={postal} disabled={busy}
                onChange={(e) => {
                  const v = e.target.value; setPostal(v);
                  const r = fromPostal(v, where);
                  if (r) fill(r, r.region ? (regions ? 'Found from your postal code. Please check it below.' : 'Tax region found from your postal code. Please check it below.') : '');
                }} />
              <button type="button" className="btn co-loc" disabled={busy || locBusy} onClick={async () => {
                setLocBusy(true); setLocMsg('');
                try { fill(await locate(where), 'Filled in from your location. Change it below if it is wrong.'); }
                catch (e) { setLocMsg(e.message); }
                setLocBusy(false);
              }}><Icon name="pin" size={16} /> {locBusy ? 'Finding you…' : 'Use my location'}</button>
              {locMsg && <p className="muted small co-locmsg">{locMsg}</p>}
              <Select id="co-country" aria-label="Country" className="co-select" value={country} onChange={(e) => { setCountry(e.target.value); setRegion(''); }} disabled={busy}>
                <option value="" disabled>Choose your country</option>
                {where.countries.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}
                {!regions && <option value="ZZ">Somewhere else</option>}
              </Select>
              {needsRegion && (
                <Select className="co-select" aria-label={country === 'US' ? 'State' : 'Province'} value={region} onChange={(e) => setRegion(e.target.value)} disabled={busy}>
                  <option value="" disabled>{country === 'US' ? 'Choose your state' : 'Choose your province'}</option>
                  {Object.entries(REGIONS[country]).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                </Select>
              )}
            </div>
          )}
          {embedded && !picked && <p className="muted small">Choose your country and {country === 'US' ? 'state' : 'province or state'} above to pay.</p>}
          {embedded && picked && <PayForm key={cur} pack={pack} clientId={clientId} currency={cur} getBuyer={() => buyerRef.current} blocked={!picked} total={total} recurring={!!pack.recurring} onPaypalPage={() => onPay(buyerRef.current)} onPaid={onPaid} onError={onError} onFallback={setFallback} />}
          {provider === 'paypal' && !clientId && !pack.recurring && <p className="error-text">The server did not send a PayPal client id, so the card form is off. Redeploy the server with the latest code.</p>}
          {fallback && provider === 'paypal' && <p className="error-text">The card form could not start ({fallback}). You can still pay on PayPal's own page.</p>}
          {!embedded && <button type="button" className="btn primary pay-btn" disabled={busy || !picked} onClick={() => onPay(buyerRef.current)}>{busy ? `Opening ${who}…` : pack.recurring ? `Subscribe for ${total} a month with ${who}` : `Pay ${total} with ${who}`}</button>}
          {error && <p className="error-text">{error}</p>}
          <BuyNotices paypal={provider === 'paypal'} tax={!!tax} place={!!regions && !tax} fee={feeCents > 0} saved={!!pack.recurring && embedded} />
        </main>
        <aside className="co-receipt">
          <div className="co-rcpt-in">
            <div className="muted small">Order summary</div>
            <div className="co-total">{total}</div>
            <div className="co-item">
              <span className="co-item-ic"><Icon name={pack.icon || 'coin'} size={22} /></span>
              <div className="co-item-t"><b>{pack.title || 'Aduna credits'}</b><span className="muted small">{pack.recurring ? pack.subtitle : `${pack.credits.toLocaleString()} credits · Qty 1`}</span></div>
              <b>{price}</b>
            </div>
            <div className="co-line"><span>Subtotal</span><span>{price}</span></div>
            {tax && !picked && <div className="co-line"><span>Tax</span><span className="muted small">Choose where you are</span></div>}
            {tax && picked && !parts.length && <div className="co-line"><span>Tax</span><span>{money(0, cur)}</span></div>}
            {parts.map((x) => <div key={x.label} className="co-line"><span>{x.label} ({x.rate}%)</span><span>{money(x.amount, cur)}</span></div>)}
            {feeCents > 0 && <div className="co-line"><span>Processing fee</span><span>{money(feeCents, cur)}</span></div>}
            <div className="co-line total"><span>Total due today</span><b>{total}</b></div>
            {pack.recurring && <p className="muted small">Then {total} every month until you cancel. You can cancel any time in Storage; you keep the plan until the month you paid for ends.</p>}
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
        <span className="event-ico" aria-hidden="true"><Icon name="star" size={22} /></span>
        <div className="grow">
          <h4 className="credit-h">{ev.label} event</h4>
          <div className="muted small">{ev.until ? `Until ${dayLabel(ev.until)}` : 'Test mode'}{ev.badge ? ` · finish Trick or Treat for the ${ev.badge.name} badge` : ''}</div>
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
          <p className="muted small">A door opens on its own day in December and stays open until the event ends, so a missed one can still be opened. Open all {adv.total} doors for the {adv.badge.name} badge.</p>
        </>
      )}
    </div>
  );
}

// Credits: balance, buying, the earning rules, quests and recent activity.
// `rev` goes up whenever the server says the balance changed, so this page refreshes itself.
// `page` picks the tab: 'shop' (buy credits, spend them on badges, recent activity) or 'quests' (earn credits: events, chatting, quests).
export default function Credits({ page = 'shop', onBack, rev, justPaid, paypalOrder, creator = false, artistId = null, onAllItems }) {
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
  const [homePick, setHomePick] = useState(null); // 'CA' or 'US' when the person flips the price switch; otherwise the guess in region.js
  const shownBalance = useCountUp(d ? d.balance : null);
  const [bump, setBump] = useState(0);
  useEffect(() => { if (d) setBump((n) => n + 1); }, [d?.balance]); // eslint-disable-line react-hooks/exhaustive-deps
  // The messages sit at the top of the page, which may be scrolled out of sight (you claimed a quest further down): also show them as a toast,
  // and let the inline copy fade away by itself.
  useEffect(() => { if (!note) return undefined; toast(note); const t = setTimeout(() => setNote(''), 8000); return () => clearTimeout(t); }, [note]);
  useEffect(() => { if (err) toast(err, 'error'); }, [err]);

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
  const home = homePick || homeCountry(d?.regions?.countries); // whose price to show: Canadians see CAD, people in the US see USD
  const m = d?.messaging;
  // an artist's marketplace shows only their items; otherwise the whole shop
  const shopItems = d ? (artistId ? d.shop.filter((it) => it.byId === artistId) : d.shop) : [];
  if (checkout && d) return <Checkout pack={checkout} provider={d.provider} clientId={d.paypalClientId} tax={d.tax} fee={d.fee} regions={d.regions} busy={!!busy} error={coErr} onPay={pay} onPaid={paid} onError={setCoErr} onClose={() => { setCheckout(null); setBusy(''); }} />;

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
                  <button className="btn primary" disabled={!d.purchases} onClick={() => { setBuying(false); setCoErr(''); setCheckout(p); }}>{priceFor(p, d.regions ? home : 'US').text}{d.regions ? <small className="buy-cad"> {priceFor(p, home).code}</small> : null}</button>
                </div>
              ))}
            </div>
            {d.regions && d.regions.countries.length > 1 && (
              <p className="muted small">
                Prices in {home === 'US' ? 'US dollars' : 'Canadian dollars'}.{' '}
                <button type="button" className="link-btn" onClick={() => { const n = home === 'US' ? 'CA' : 'US'; rememberCountry(n); setHomePick(n); }}>Show {home === 'US' ? 'Canadian' : 'US'} prices</button>
                {home === 'US' && rateNote(d.fx) ? ' ' + rateNote(d.fx) : ''}
              </p>
            )}
            {d.purchases && <BuyNotices />}
            {!d.purchases && <p className="muted small">{d.paused ? 'Payments are paused right now. Please check back soon.' : 'Buying credits is not set up on this server yet.'}</p>}
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
            {page === 'quests' && d.ads?.enabled && d.ads.rewarded && (
              <>
                <h4 className="credit-h">Sponsors</h4>
                <WatchSponsor a={d.ads} locked={locked} onDone={(r) => { setD(r); setNote(`+${r.amount} credits for watching a sponsor`); }} />
              </>
            )}

            {page === 'shop' && <>
            <div className="shop-head">
              <h4 className="credit-h">{artistId ? `Marketplace${shopItems[0]?.by ? ': ' + shopItems[0].by : ''}` : 'Badges'}</h4>
              {artistId
                ? <button className="btn small-btn" onClick={() => onAllItems?.()}>Show all items</button>
                : creator && <button className="btn primary small-btn" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add a badge</button>}
            </div>
            <p className="muted small shop-intro">{artistId ? 'Everything this artist has for sale. Each one is yours to keep.' : 'Spend your credits on badges that show next to your name everywhere in Aduna, and on profile frames that go around your picture. Each one is yours to keep.'}</p>
            {shopItems.length === 0
              ? <EmptyState compact icon="bag" title={artistId ? 'Nothing for sale right now' : creator ? 'No badges for sale yet' : 'Nothing for sale right now'}>{artistId ? 'This artist has no items on sale at the moment.' : creator ? 'Add one with a picture and a price.' : 'Check back soon.'}</EmptyState>
              : (() => {
                const tile = (it) => <ShopTile key={it.id} item={it} balance={d.balance} busy={busy} creator={creator} onOpen={setConfirm} onOffSale={takeOffSale} onPin={togglePin} onDaily={toggleDaily} onEdit={setEditing} />;
                const regular = shopItems.filter((it) => !it.daily), daily = shopItems.filter((it) => it.daily);
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

            {d.ads?.enabled && d.ads.sponsored && <SponsorCard ad={d.ads.sponsored} />}
            {d.ads?.enabled && d.ads.adsense && <AdSenseUnit cfg={d.ads.adsense} />}

            <a className="pay-link" href="/payments" style={d.paused ? { display: 'none' } : undefined}>
              <span className="pay-link-ico"><Icon name="bag" size={18} /></span>
              <span className="grow"><b>Purchase history and plans</b><span className="muted small"> See what you bought and manage your plan</span></span>
              <Icon name="chevron" size={18} className="pay-link-go" />
            </a>
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
