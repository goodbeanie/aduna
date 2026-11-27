import React from 'react';
import { priceFor } from './region.js';
import { FREE_CHARS, PLUS_CHARS } from './msgLimit.js';

// The supporter plans (Spark, Plus, Premium): one card each with the price, what it includes and a button. Used in the Storage window and at the
// bottom of the Shop. What each one costs and gives is decided by the server (server/storage.js, server/supporter.js).

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

const RATE = { spark: '1.1x', plus: '1.5x', premium: '1.75x' };
const RANK_NAME = { spark: 'Spark', plus: 'Plus', premium: 'Premium' };

function PlanBadge({ rank, height = 20 }) {
  return <span className={'ubadge sup sup-' + rank} aria-hidden="true" style={{ '--pb': height + 'px' }}><i className="sup-body" /><i className="sup-star" /></span>;
}

// what a plan ({ rank, bytes } from the server) includes
export function perksFor(plan) {
  if (plan.rank === 'spark') {
    return [
      'A Spark badge on your profile',
      `Earn ${RATE.spark} credits from messages and quests`,
      'Cancel whenever you want',
    ];
  }
  const gb = Math.round(plan.bytes / 1024 ** 3);
  return [
    `${gb} GB that's just yours. Nothing gets deleted or expires while you have ${RANK_NAME[plan.rank]}`,
    'When it fills up, you pick what to delete. You can also set your own upload limit',
    `Longer messages: ${PLUS_CHARS.toLocaleString()} characters instead of ${FREE_CHARS.toLocaleString()}`,
    'Screen share at 1080p, or 60 fps in Smooth mode',
    `Earn ${RATE[plan.rank]} credits from messages and quests, no daily cap`,
    'Quests only Plus and Premium members can do',
    'A free level 3 server boost every month, on any server you are in',
    `A ${RANK_NAME[plan.rank]} badge on your profile`,
    'Cancel whenever you want',
  ];
}

// `storage` is what /api/storage sends. onGet(planId) starts the checkout for a plan; onManage (optional) is for the plan the person already has.
export default function Plans({ storage: s, country, busy, onGet, onManage }) {
  const plans = s.plans && s.plans.length ? s.plans : [s.plan];
  const have = s.planId || null;
  const locked = !!have && (s.lifetime || s.status === 'active'); // a running plan has to end (or be cancelled) before another one can start
  return (
    <div className="pl-list">
      {plans.map((plan) => {
        const price = priceFor(plan, s.regions ? country : 'US');
        const mine = have === plan.rank;
        let label = `Get ${plan.name}`, off = busy || !s.purchases;
        if (mine) { label = onManage ? 'Manage plan' : 'Your plan'; off = busy || !onManage; }
        else if (locked) { label = 'Cancel your plan to switch'; off = true; }
        else if (!s.purchases) label = s.paused ? 'Paused for now' : 'Not available yet';
        return (
          <div className={'pc-card' + (mine ? ' mine' : '')} key={plan.id}>
            <div className="pc-head">
              {plan.rank === 'plus' ? <PlusLogo /> : <span className="pc-title"><PlanBadge rank={plan.rank} />{plan.name}</span>}
              <div className="st-price">{price.text}<small>/month{s.regions ? ' ' + price.code : ''}</small></div>
            </div>
            <ul className="st-perks">
              {perksFor(plan).map((p) => <li key={p}>{p}</li>)}
            </ul>
            <button className="btn primary st-cta" onClick={() => (mine ? onManage() : onGet(plan.rank))} disabled={off}>{label}</button>
          </div>
        );
      })}
    </div>
  );
}
