import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { Icon, Modal } from './ui.jsx';
import { EmptyState, PanelSkeleton } from './ShellBits.jsx';
import { toast } from './Dialogs.jsx';
import { AddBadgeModal, BuyConfirm, Celebration, ShopTile, useCountUp } from './Shop.jsx';
import PlusCard from './PlusCard.jsx';
import { homeCountry, rememberCountry, priceFor, money, REGIONS, savedRegion, rememberRegion } from './region.js';

function Quest({ q, locked, busy, onClaim }) {
  const pct = Math.round((q.have / q.need) * 100);
  return (
    <div className={'quest' + (q.claimed ? ' claimed' : '')}>
      <div className="quest-main">
        <b>{q.plusOnly && <span className="plus-tag">Plus</span>}{q.title}</b>
        <div className="muted small">{q.desc}</div>
        {q.need > 1 && !q.claimed && !q.locked && <div className="quest-bar" title={`${q.have} of ${q.need}`}><i style={{ width: pct + '%' }} /></div>}
      </div>
      <span className="reward"><Icon name="coin" size={15} />{q.reward}</span>
      {q.claimed
        ? <span className="quest-done"><Icon name="check" size={16} /> {q.daily ? 'Done today' : 'Claimed'}</span>
        : q.locked
          ? <span className="muted small">Plus only</span>
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

// The notices shown before paying. Stripe's own page takes the billing address and adds the sales tax for it.
function BuyNotices() {
  return (
    <div className="buy-notices">
      <div className="buy-note"><Icon name="shield" size={16} /><span>Aduna does not save your payment information, your security is our priority.</span></div>
      <div className="buy-note"><Icon name="shield" size={16} /><span>Secure checkout is provided by Stripe. Your card details are entered on Stripe's page and are never seen or stored by Aduna.</span></div>
      <div className="buy-note"><Icon name="pin" size={16} /><span>Aduna sells to Canada and the US, and prices are in Canadian or US dollars. Stripe asks for your billing address on its page and adds any sales tax that applies there.</span></div>
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
export default function Credits({ page = 'shop', storage = null, onBack, rev, justPaid, creator = false, artistId = null, onAllItems, me = null }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [buying, setBuying] = useState(false); // the "Buy credits" window (the packs) is open
  const [confirm, setConfirm] = useState(null); // the badge the person is about to buy, or null
  const [won, setWon] = useState(null); // the badge just bought (the celebration), or null
  const [adding, setAdding] = useState(false); // a creator's "add a badge" window
  const [, setTick] = useState(0);
  const [coErr, setCoErr] = useState('');
  const [homePick, setHomePick] = useState(null); // 'CA' or 'US' when the person flips the price switch; otherwise the guess in region.js
  const [region, setRegion] = useState('');   // the province or state they picked (only asked for when a card fee is on)
  const [quote, setQuote] = useState(null);   // what each pack costs for that place, card fee included: { currency, fee, packs: [{ id, total, surcharge }] }
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

  // Buying sends the person straight to Stripe's checkout. The country only picks the currency; Stripe asks for the address and adds the tax.
  async function pay(p) {
    setBusy(p.id); setCoErr('');
    try { const { url } = await api('/credits/checkout', { method: 'POST', body: { packId: p.id, country: d?.regions ? home : 'US', ...(region ? { region } : {}) } }); window.location.assign(url); }
    catch (e) { setCoErr(e.message); setBusy(''); }
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
  // The shop is view-only. Removing items is done on the admin page (/admin > Shop), and the server only allows it for admin accounts.
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
  useEffect(() => { setRegion(savedRegion(home)); }, [home]);
  // The card fee (when the server has one on): what each pack costs here. It is the server's sum, never worked out in the browser.
  const sells = !!d?.regions, canBuy = !!d?.purchases;
  useEffect(() => {
    if (!buying || !canBuy || !sells) { setQuote(null); return undefined; }
    let live = true;
    api('/credits/quote', { method: 'POST', body: { country: home, region: region || undefined } }).then((q) => { if (live) setQuote(q); }).catch(() => { if (live) setQuote(null); });
    return () => { live = false; };
  }, [buying, canBuy, sells, home, region]);
  const qFor = (p) => (quote?.fee ? quote.packs.find((x) => x.id === p.id) || null : null);
  const m = d?.messaging;
  // an artist's marketplace shows only their items; otherwise the whole shop
  const shopItems = d ? (artistId ? d.shop.filter((it) => it.byId === artistId) : d.shop) : [];

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
        {confirm && d && <BuyConfirm item={confirm} balance={d.balance} busy={busy === confirm.id} onConfirm={() => buyItem(confirm)} onClose={() => setConfirm(null)} viewer={me} />}
        {won && <Celebration item={won} onClose={() => setWon(null)} viewer={me} />}
        {adding && <AddBadgeModal onClose={() => setAdding(false)} onAdded={(name) => { setAdding(false); load(); setNote(`${name} is in the shop.`); }} />}
        {buying && d && (
          <Modal title="Buy credits" onClose={() => setBuying(false)}>
            <div className="credit-packs">
              {d.packs.map((p) => (
                <div key={p.id} className="credit-pack">
                  <div className="pack-amt"><Icon name="coin" size={20} />{p.credits.toLocaleString()}</div>
                  <button className="btn primary" disabled={!d.purchases || !!busy} onClick={() => pay(p)}>{busy === p.id ? 'Opening Stripe…' : (qFor(p) ? money(qFor(p).total, quote.currency) : priceFor(p, d.regions ? home : 'US').text)}{busy !== p.id && d.regions ? <small className="buy-cad"> {priceFor(p, home).code}</small> : null}</button>
                  {qFor(p)?.surcharge > 0 && <small className="muted">{money(qFor(p).total - qFor(p).surcharge, quote.currency)} + {money(qFor(p).surcharge, quote.currency)} card fee</small>}
                </div>
              ))}
            </div>
            {d.regions && d.regions.countries.length > 1 && (
              <p className="muted small">
                Prices in {home === 'US' ? 'US dollars' : 'Canadian dollars'}.{' '}
                <button type="button" className="link-btn" onClick={() => { const n = home === 'US' ? 'CA' : 'US'; rememberCountry(n); setHomePick(n); }}>Show {home === 'US' ? 'Canadian' : 'US'} prices</button>
              </p>
            )}
            {quote?.fee && REGIONS[home] && (
              <label className="field keep-case">{REGIONS[home].label}
                <select value={region} onChange={(e) => { setRegion(e.target.value); rememberRegion(home, e.target.value); }}>
                  <option value="">Choose…</option>
                  {REGIONS[home].list.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                </select>
              </label>
            )}
            {quote?.fee && <p className="muted small">{quote.packs.some((x) => x.surcharge > 0) ? 'Where the law allows it, the card fee is added as its own line at checkout.' : 'A small card processing fee is included in these prices.'}</p>}
            {coErr && <p className="error-text">{coErr}</p>}
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
                const tile = (it) => <ShopTile key={it.id} item={it} balance={d.balance} busy={busy} onOpen={setConfirm} viewer={me} />;
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
            {storage && storage.plan && !artistId && (
              <div className="shop-plus">
                <h4 className="credit-h">Aduna Plus</h4>
                <PlusCard plan={storage.plan} country={storage.regions ? homeCountry(storage.regions.countries) : 'US'} regions={storage.regions} subscriber={storage.subscriber} purchases={storage.purchases} paused={storage.paused} onGet={() => window.dispatchEvent(new Event('aduna:plus'))} />
              </div>
            )}
            </>}

            {page === 'quests' && <>
            <h4 className="credit-h">Earn by chatting</h4>
            <div className="earn-card">
              {m.plus ? <>
                <p>Write real messages in server channels. With Plus, your first <b>{m.plus.limit} a day</b> earn <b>{m.plus.rate} credits</b> each, then <b>{m.plus.after} credit</b> each until midnight UTC.</p>
                <div className="quest-bar big" title={`${Math.min(m.plus.messagesToday, m.plus.limit)} of ${m.plus.limit} today`}><i style={{ width: Math.min(100, (m.plus.messagesToday / m.plus.limit) * 100) + '%' }} /></div>
                <div className="muted small">{Math.min(m.plus.messagesToday, m.plus.limit)} of {m.plus.limit} messages at the Plus rate · {m.earnedToday} credits earned today · resets at midnight UTC</div>
              </> : <>
                <p>Write real messages in server channels and earn <b>{m.reward} credits</b> each, up to <b>{m.cap} a day</b>.</p>
                <div className="quest-bar big" title={`${m.earnedToday} of ${m.cap} today`}><i style={{ width: Math.min(100, (m.earnedToday / m.cap) * 100) + '%' }} /></div>
                <div className="muted small">{m.earnedToday} of {m.cap} earned today · resets at midnight UTC</div>
              </>}
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
