import React, { useEffect, useState } from 'react';
import { Select } from './Controls.jsx';
import { api } from './api.js';
import { hasFeature } from './features.js';
import { homeCountry, priceFor, rememberCountry } from './region.js';

// Sponsored servers: a paid, gold-labelled slot at the top of the explorer. The rules and prices are on the server (server/sponsored.js);
// this draws them and sends the owner to Stripe Checkout.

const DAY = 24 * 3600 * 1000;
const day = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const COUNTRY_NAME = { CA: 'Canada (CAD)', US: 'United States (USD)' };

export const SponsoredTag = () => <span className="sponsored-tag" title="A paid placement">Sponsored</span>;

// `visibility` is the server's current visibility, so the panel asks again after the owner publishes or unpublishes
export function SponsorPanel({ server, me, visibility }) {
  const [info, setInfo] = useState(null);
  const [country, setCountry] = useState('US');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const on = hasFeature(me, 'sponsored-servers');

  useEffect(() => {
    if (!on) return undefined;
    let live = true;
    api(`/servers/${server.id}/sponsored`)
      .then((r) => {
        if (!live) return;
        setInfo(r.sponsored);
        if (r.sponsored.regions) setCountry(homeCountry(r.sponsored.regions.countries));
      })
      .catch((e) => { if (live && e.status !== 404) setErr(e.message); });
    return () => { live = false; };
  }, [server.id, visibility, on]);

  if (!on || (!info && !err)) return null;
  if (!info) return <p className="sp-err">{err}</p>;

  const { plans, slots, maxAheadDays, current, fit, purchases, paused, regions } = info;
  const left = current.active ? current.until - Date.now() : 0;
  const full = !current.active && slots.open === 0;
  const blocked = (plan) => !fit.ok || full || left + plan.days * DAY > maxAheadDays * DAY;
  const tooFar = plans.every((p) => left + p.days * DAY > maxAheadDays * DAY);
  const hint = !fit.ok ? fit.error
    : full ? 'All sponsored slots are taken right now. Try again when one ends.'
      : paused ? 'Buying is paused for now.'
        : !purchases ? 'Buying is not set up yet.'
          : tooFar ? 'You already have close to the most days you can book.' : '';

  async function buy(plan) {
    setBusy(plan.id); setErr('');
    try {
      rememberCountry(country);
      const { url } = await api(`/servers/${server.id}/sponsored/checkout`, { method: 'POST', body: { planId: plan.id, country } });
      window.location.assign(url);
    } catch (e) { setErr(e.message); setBusy(''); }
  }

  return (
    <div className="sp-panel">
      <label>SPONSOR THIS SERVER</label>
      <p className="sp-note">Sponsored servers get their own gold section at the top of the explorer, marked “Sponsored”. The order turns every hour.</p>
      <p className="sp-note"><span>Free slots right now</span>: <b>{slots.open}/{slots.max}</b></p>
      {current.since && (
        <div className={'sp-status' + (current.active ? ' on' : '')}>
          {current.active ? <span><span>Sponsored until</span> <b>{day(current.until)}</b></span> : <span>Not sponsored right now</span>}
          <span><span>{current.active ? 'This run' : 'Last run'}</span>: <b>{current.views.toLocaleString()}</b> <span>views</span>, <b>{current.joins.toLocaleString()}</b> <span>joins</span></span>
        </div>
      )}
      {regions && regions.countries.length > 1 && (
        <Select value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Your country">
          {regions.countries.map((c) => <option key={c} value={c}>{COUNTRY_NAME[c] || c}</option>)}
        </Select>
      )}
      <div className="sp-plans">
        {plans.map((plan) => {
          const price = priceFor(plan, regions ? country : 'US');
          return (
            <div className="sp-plan" key={plan.id}>
              <b>{plan.days} <span>days</span></b>
              <span className="sp-price">{price.text}<small>{regions ? price.code : ''}</small></span>
              <button type="button" className="btn primary" disabled={!!busy || !purchases || blocked(plan)} onClick={() => buy(plan)}>{busy === plan.id ? 'Opening…' : current.active ? 'Add days' : 'Sponsor'}</button>
            </div>
          );
        })}
      </div>
      {hint && <p className="sp-note">{hint}</p>}
      <p className="sp-note"><span>Buying again adds days to the end of the run, up to</span> <b>{maxAheadDays}</b> <span>days ahead.</span> <span>Tax is added at checkout. A full refund takes those days off again.</span></p>
      {err && <p className="sp-err">{err}</p>}
    </div>
  );
}
