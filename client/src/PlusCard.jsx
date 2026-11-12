import React from 'react';
import { priceFor } from './region.js';
import { FREE_CHARS, PLUS_CHARS } from './msgLimit.js';

// The Aduna Plus card: logo, price, everything the plan includes. Used in the Storage window and at the bottom of the Shop.

export function PlusLogo({ height = 34 }) {
  return (
    <span className="pc-logo" style={{ '--pc-h': height + 'px' }} role="img" aria-label="Aduna Plus">
      <span className="pc-icon" aria-hidden="true">
        <i className="pc-body" />
        <svg className="pc-star" viewBox="0 0 100 100">
          <defs><linearGradient id="pc-star-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#c96fe8" /><stop offset="1" stopColor="#f2a8fb" /></linearGradient></defs>
          <path fill="url(#pc-star-fill)" d="M50 2C54 2 56 5 58 8C66 20 80 34 92 42C98 46 98 54 92 58C80 66 66 80 58 92C56 95 54 98 50 98C46 98 44 95 42 92C34 80 20 66 8 58C2 54 2 46 8 42C20 34 34 20 42 8C44 5 46 2 50 2Z" />
        </svg>
      </span>
      <span className="pc-word" aria-hidden="true"><i /><b /></span>
    </span>
  );
}

export function plusPerks(bytes) {
  const gb = Math.round(bytes / 1024 ** 3);
  return [
    `${gb} GB that's just yours. Nothing gets deleted or expires while you have Plus`,
    'When it fills up, you pick what to delete. You can also set your own upload limit',
    `Longer messages: ${PLUS_CHARS.toLocaleString()} characters instead of ${FREE_CHARS.toLocaleString()}`,
    'Screen share at 1080p, or 60 fps in Smooth mode',
    'Earn 1.5x credits from messages and quests, no daily cap',
    'Quests only Plus members can do',
    'A Plus badge on your profile',
    'Cancel whenever you want',
  ];
}

export default function PlusCard({ plan, country, regions, subscriber, purchases, paused, busy, onGet }) {
  const price = priceFor(plan, regions ? country : 'US');
  const label = subscriber ? 'Manage plan' : purchases ? 'Get Aduna Plus' : paused ? 'Paused for now' : 'Not available yet';
  return (
    <div className="pc-card">
      <div className="pc-head">
        <PlusLogo />
        <div className="st-price">{price.text}<small>/month{regions ? ' ' + price.code : ''}</small></div>
      </div>
      <ul className="st-perks">
        {plusPerks(plan.bytes).map((p) => <li key={p}>{p}</li>)}
      </ul>
      <button className="btn primary st-cta" onClick={onGet} disabled={busy || (!subscriber && !purchases)}>{label}</button>
    </div>
  );
}
