import React, { useEffect, useState } from 'react';
import './founding.css';

// The Founding Member bar on the sign-up page: how many people have joined and the goal (the first 1,000 get the badge).
// The numbers come from GET /api/founding (a public head count). If the request fails the bar simply is not shown.
const n = (x) => Number(x).toLocaleString('en-US');

export default function FoundingBar() {
  const [p, setP] = useState(null);
  useEffect(() => {
    let off = false;
    fetch('/api/founding')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off && d && Number.isFinite(d.count) && Number.isFinite(d.goal) && d.goal > 0) setP(d); })
      .catch(() => { /* offline: no bar */ });
    return () => { off = true; };
  }, []);
  if (!p) return null;
  const shown = Math.min(p.count, p.goal);
  const pct = Math.min(100, Math.round((shown / p.goal) * 100));
  return (
    <div className="su-founding" role="group" aria-label="Founding Member badge">
      <img src="/badges/founding-member.png" alt="" width="40" height="40" draggable={false} />
      <div className="su-founding-body">
        <div className="su-founding-top">
          <b>Founding Member badge</b>
          <span>{n(shown)} / {n(p.goal)}</span>
        </div>
        <div className="su-founding-track" role="progressbar" aria-label="Founding members joined" aria-valuemin={0} aria-valuemax={p.goal} aria-valuenow={shown}>
          <i style={{ width: pct + '%' }} />
        </div>
        <p>{p.full ? `All ${n(p.goal)} Founding Member badges have been claimed. Thanks to everyone who joined early!` : `The first ${n(p.goal)} people to join get it, for good. ${n(p.left)} left.`}</p>
      </div>
    </div>
  );
}
