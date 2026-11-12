import React, { useEffect, useRef, useState } from 'react';

let loading;
const loadScript = () => loading || (loading = new Promise((resolve, reject) => {
  if (window.turnstile) return resolve(window.turnstile);
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.async = true;
  s.onload = () => resolve(window.turnstile);
  s.onerror = () => { loading = null; reject(new Error('load')); };
  document.head.appendChild(s);
}));

// Cloudflare's "are you a person" box. onToken gets the token, or '' when it expires or fails. Change `resetKey` to ask for a fresh one.
export default function Turnstile({ siteKey, onToken, resetKey }) {
  const box = useRef(null);
  const widget = useRef(null);
  const tokenCb = useRef(onToken);
  const [failed, setFailed] = useState(false);
  tokenCb.current = onToken;

  useEffect(() => {
    let dead = false;
    loadScript().then((ts) => {
      if (dead || !box.current) return;
      widget.current = ts.render(box.current, {
        sitekey: siteKey,
        callback: (token) => tokenCb.current(token),
        'expired-callback': () => tokenCb.current(''),
        'error-callback': () => tokenCb.current(''),
      });
    }).catch(() => { if (!dead) setFailed(true); });
    return () => {
      dead = true;
      if (widget.current !== null && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (widget.current !== null && window.turnstile) window.turnstile.reset(widget.current);
  }, [resetKey]);

  return (
    <>
      <div ref={box} className="ts-box" />
      {failed && <p className="hint error-text" role="alert">The check could not load. Turn off any blocker for this page and refresh.</p>}
    </>
  );
}
