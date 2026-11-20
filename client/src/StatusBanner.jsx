import React, { useEffect, useState } from 'react';
import './status-banner.css';

// The notice an admin posts in /admin > Status: red when the server is down or restarting, yellow for a warning. Hidden when there is none.
// Read every 30 seconds while the tab is open; a failed read keeps what is already showing.
function text(n) {
  let t = String(n.message || '').trim();
  if (n.backAt) {
    const at = Date.parse(n.backAt);
    if (!isNaN(at)) {
      if (!/[.!?]$/.test(t)) t += '.';
      t += at > Date.now() ? ' Back up around ' + new Date(at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '.' : ' Should be back any moment.';
    }
  }
  return t;
}

export default function StatusBanner() {
  const [n, setN] = useState(null);
  useEffect(() => {
    let dead = false;
    const read = () => {
      if (document.hidden) return;
      fetch('/api/public/status-notice', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (!dead && j) setN(j.message ? j : null); })
        .catch(() => { /* keep what is showing */ });
    };
    read();
    const id = setInterval(read, 30000);
    document.addEventListener('visibilitychange', read);
    return () => { dead = true; clearInterval(id); document.removeEventListener('visibilitychange', read); };
  }, []);
  if (!n) return null;
  return <div className={'status-banner ' + (n.down ? 'down' : 'warn')} role="status" aria-live="polite" data-ui="status-banner">{text(n)}</div>;
}
