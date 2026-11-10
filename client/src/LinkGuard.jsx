import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Icon, Modal } from './ui.jsx';
import { api } from './api.js';
import { addressParts, analyzeLink, unicodeHost } from './linksafe.js';

// Unsafe link protection, what people see. Every link in a message goes through <SafeLink>:
//   nothing found      an ordinary link
//   suspicious         a muted chip, "Link hidden: looks unsafe", with a "Show anyway" button that opens a warning with the REAL address first
//   known bad          a chip with no way through (a blocklisted domain, or Google Safe Browsing lists it)
// The checks themselves are in linksafe.js (browser, so they also work on end-to-end encrypted DMs and groups). The blocklist comes from the server and
// is refreshed when a creator changes it. The live lookup (step 4) only runs for links that came out suspicious: by itself in server channels (`live`),
// and in DMs and groups only when the person presses "Check with Google", because the server cannot read those links otherwise.

// ---------- the blocklist, shared by every link on screen ----------
let blocked = new Set();
let lookupOn = false;     // the server has a Safe Browsing key
let version = 0, started = false;
const subs = new Set();
const subscribe = (f) => { subs.add(f); start(); return () => subs.delete(f); };
const getVersion = () => version;

function loadBlocklist() {
  api('/links/blocklist').then((r) => {
    blocked = new Set((r.domains || []).map((d) => String(d).toLowerCase()));
    lookupOn = !!r.lookup;
    version++; subs.forEach((f) => f());
  }).catch(() => { /* offline or signed out: the checks that need no list still work */ });
}
function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  loadBlocklist();
  window.addEventListener('aduna:links', loadBlocklist);           // a creator changed the list
  setInterval(loadBlocklist, 15 * 60_000);                          // and a slow refresh in case the push was missed
}

// ---------- the live lookup ----------
// url -> { threat: 'phishing' | 'malware' | ... | null, ran: boolean }. Asked once per address (the server remembers answers too).
const liveCache = new Map();
const liveBusy = new Map();
export function checkLive(url) {
  if (liveCache.has(url)) return Promise.resolve(liveCache.get(url));
  if (liveBusy.has(url)) return liveBusy.get(url);
  const p = api('/links/check', { method: 'POST', body: { urls: [url] } })
    .then((r) => {
      const hit = (r.results || []).find((x) => x.url === url && x.level === 'block');
      const out = { threat: hit ? String(hit.reason || 'unsafe') : null, ran: !!r.lookup || !!hit };
      if (liveCache.size > 300) liveCache.clear();
      liveCache.set(url, out);
      return out;
    })
    .catch(() => ({ threat: null, ran: false })) // not cached: a later press can try again
    .finally(() => liveBusy.delete(url));
  liveBusy.set(url, p);
  return p;
}

const THREAT_WORDS = { phishing: 'phishing (it tries to steal logins)', malware: 'malware', 'unwanted software': 'unwanted software', 'harmful app': 'a harmful app', listed: 'a known unsafe site' };

// ---------- the link ----------
// href: the address. shown: what the link says. live: true where the server may look the address up by itself (server channels). anchor: props for the <a>.
export function SafeLink({ href, shown, live = false, anchor }) {
  const v = useSyncExternalStore(subscribe, getVersion);
  const a = useMemo(() => analyzeLink(href, blocked), [href, v]); // eslint-disable-line react-hooks/exhaustive-deps
  const [verdict, setVerdict] = useState(() => liveCache.get(href) || null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (a.level !== 'warn' || !live || verdict) return undefined;
    let dead = false;
    checkLive(href).then((r) => { if (!dead) setVerdict(r); });
    return () => { dead = true; };
  }, [a.level, live, href, verdict]);

  if (a.level === 'ok') return <a href={href} target="_blank" rel="noopener noreferrer nofollow" {...anchor}>{shown}</a>;

  const threat = verdict && verdict.threat;
  const hard = a.level === 'block' || !!threat;
  const press = (e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); };
  const key = (e) => { if (e.key === 'Enter' || e.key === ' ') press(e); };
  return (
    <>
      {hard ? (
        <span className="lg-chip bad" role="button" tabIndex={0} onClick={press} onKeyDown={key} aria-label="A link was blocked because it is known to be unsafe. Press for details.">
          <Icon name="flag" size={13} /><span>Link blocked: known unsafe</span>
        </span>
      ) : (
        <span className="lg-chip warn">
          <Icon name="flag" size={13} /><span>Link hidden: looks unsafe</span>
          <button type="button" className="lg-show" onClick={press}>Show anyway</button>
        </span>
      )}
      {open && createPortal(<LinkWarning href={href} analysis={a} hard={hard} threat={threat} verdict={verdict} live={live} setVerdict={setVerdict} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function LinkWarning({ href, analysis, hard, threat, verdict, live, setVerdict, onClose }) {
  const [busy, setBusy] = useState(false);
  const { host, rest } = addressParts(href);
  const seen = unicodeHost(host);
  const canAsk = lookupOn && !live && !verdict && !hard;
  async function ask() { setBusy(true); setVerdict(await checkLive(href)); setBusy(false); }
  const open = () => { window.open(href, '_blank', 'noopener,noreferrer'); onClose(); };
  return (
    <Modal title={hard ? 'This link is blocked' : 'Open this link?'} onClose={onClose}>
      <p className="muted">{hard ? 'Aduna will not open this link. It is known to be unsafe.' : 'This link looks suspicious. Check where it really goes before you open it.'}</p>
      <div className="lg-addr" aria-label="The real address">
        <small>The real address</small>
        <code><b>{host}</b>{rest !== '/' ? rest : ''}</code>
        {seen !== host && <small>Shown as: {seen}</small>}
      </div>
      <ul className="lg-why">
        {analysis.reasons.map((r) => <li key={r.code}>{r.text}</li>)}
        {threat && <li>Google Safe Browsing lists this address as {THREAT_WORDS[threat] || threat}.</li>}
      </ul>
      {verdict && verdict.ran && !threat && !hard && <p className="muted small">Google Safe Browsing has no known threat for this address. That does not make it safe, because new scam sites take time to be listed.</p>}
      {canAsk && (
        <p className="small muted">
          <button type="button" className="btn small-btn" disabled={busy} onClick={ask}>{busy ? 'Checking…' : 'Check with Google'}</button>{' '}
          This sends only this one address to Aduna’s server, which asks Google. The rest of your chat stays encrypted.
        </p>
      )}
      <div className="modal-foot">
        <button type="button" className="btn" autoFocus onClick={onClose}>{hard ? 'Close' : 'Don’t open'}</button>
        {!hard && <button type="button" className="btn primary danger-fill" onClick={open}>Open anyway</button>}
      </div>
    </Modal>
  );
}

// Hand to renderMarkdown as ctx.link: (href, shown) => node
export const guardedLink = (live) => (href, shown) => <SafeLink href={href} shown={shown} live={live} />;
