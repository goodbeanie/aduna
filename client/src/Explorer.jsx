import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon, Modal } from './ui.jsx';
import { InviteBox } from './Invite.jsx';
import { AddToServerModal } from './Bots.jsx';

const REASONS = [
  ['inappropriate', 'Inappropriate or offensive', 'Name, description, tags or pictures'],
  ['spam', 'Spam or scam', 'Advertising, phishing, fake giveaways'],
  ['illegal', 'Illegal or dangerous', 'Threats, exploitation, anything that puts people at risk'],
  ['impersonation', 'Impersonation', 'Pretends to be a person, brand or another server'],
  ['other', 'Something else', 'Tell us below'],
];

// Report a public listing. Owners never learn who reported; enough reports from established accounts hide it until a moderator looks.
function ReportModal({ info, path, onClose }) {
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const send = async () => {
    setBusy(true); setErr('');
    try { await api(path, { method: 'POST', body: { reason, details } }); setDone(true); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <Modal title={`Report ${info.name}`} onClose={onClose}>
      {done ? (
        <>
          <p>Thank you. Your report was sent. The server owner is not told who reported.</p>
          <div className="modal-foot"><button className="btn primary" autoFocus onClick={onClose}>Done</button></div>
        </>
      ) : (
        <>
          <p className="muted small">What is wrong with this listing?</p>
          <div className="report-reasons">
            {REASONS.map(([id, label, hint]) => (
              <label key={id} className={'report-reason' + (reason === id ? ' on' : '')}>
                <input type="radio" name="report-reason" checked={reason === id} disabled={busy} onChange={() => setReason(id)} />
                <span><b>{label}</b><span className="muted small"> {hint}</span></span>
              </label>
            ))}
          </div>
          <label className="field">Details {reason === 'other' ? '' : '(optional)'}
            <textarea rows={3} maxLength={500} value={details} disabled={busy} onChange={(e) => setDetails(e.target.value)} />
          </label>
          {err && <div className="error">{err}</div>}
          <div className="modal-foot">
            <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="btn primary danger-fill" disabled={busy || !reason || (reason === 'other' && !details.trim())} onClick={send}>{busy ? 'Sending…' : 'Send report'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

const SORTS = [['popular', 'Most popular'], ['az', 'A to Z'], ['za', 'Z to A']];

// Server explorer: public servers, drawn with the same join box as a direct invite.
// Search matches name, description and tags (tags rank highest); the default sort is most popular.
function ServerList() {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('popular');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [more, setMore] = useState(false);
  const [err, setErr] = useState('');
  const [reporting, setReporting] = useState(null);
  const seq = useRef(0);

  const fetchPage = (offset) => api(`/explore?q=${encodeURIComponent(q.trim())}&sort=${sort}&offset=${offset}`);
  // new search or sort: start over (debounced while typing)
  useEffect(() => {
    const my = ++seq.current;
    setState('loading');
    const t = setTimeout(() => {
      fetchPage(0)
        .then((r) => { if (my !== seq.current) return; setItems(r.servers); setTotal(r.total); setNext(r.next); setState('ready'); })
        .catch((e) => { if (my !== seq.current) return; setErr(e.message); setState('error'); });
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadMore() {
    const my = seq.current;
    setMore(true);
    try { const r = await fetchPage(next); if (my === seq.current) { setItems((p) => [...p, ...r.servers]); setNext(r.next); } }
    catch (e) { setErr(e.message); }
    setMore(false);
  }

  return (
    <>
      <div className="explore-body">
        <div className="explore-bar">
          <div className="explore-search">
            <Icon name="search" size={18} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search servers by name, description or tag" aria-label="Search servers" maxLength={60} />
            {q && <button className="icon-btn" title="Clear search" aria-label="Clear search" onClick={() => setQ('')}><Icon name="close" size={16} /></button>}
          </div>
          <label className="explore-sort">
            <span className="muted small">Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by">
              {SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
        </div>
        {state === 'error' && <div className="error">{err}</div>}
        {state === 'ready' && <p className="muted small explore-count">{total === 0 ? '' : `${total} server${total === 1 ? '' : 's'}${q.trim() ? ` matching “${q.trim()}”` : ''}`}</p>}
        {state === 'ready' && items.length === 0 && (
          <div className="empty">{q.trim() ? `No public servers match “${q.trim()}”.` : 'No public servers yet. Owners can publish theirs from Server settings > Publish.'}</div>
        )}
        <div className={'explore-grid' + (state === 'loading' ? ' busy' : '')}>
          {items.map((info) => (
            <InviteBox key={info.serverId} info={info} label="Public server" extra={(
              <>
                {info.description && <p className="ex-desc">{info.description}</p>}
                {info.tags.length > 0 && <div className="tag-row">{info.tags.map((t) => <button key={t} className="tag" onClick={() => setQ(t)} title={`Search #${t}`}>#{t}</button>)}</div>}
                {!info.mine && <button className="link-btn report-link" onClick={() => setReporting(info)}><Icon name="flag" size={13} /> Report</button>}
              </>
            )} />
          ))}
        </div>
        {state === 'ready' && next !== null && <div className="explore-more"><button className="btn" disabled={more} onClick={loadMore}>{more ? 'Loading…' : 'Show more'}</button></div>}
      </div>
      {reporting && <ReportModal info={reporting} path={`/servers/${reporting.serverId}/report`} onClose={() => setReporting(null)} />}
    </>
  );
}

// The Bots tab: public bots with search, "Add to server" for people who manage a server, and Report.
function BotList({ servers, me, onServerUpdate }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('popular');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState(null);
  const [state, setState] = useState('loading');
  const [more, setMore] = useState(false);
  const [err, setErr] = useState('');
  const [reporting, setReporting] = useState(null);
  const [adding, setAdding] = useState(null);
  const seq = useRef(0);
  const fetchPage = (offset) => api(`/explore/bots?q=${encodeURIComponent(q.trim())}&sort=${sort}&offset=${offset}`);
  useEffect(() => {
    const my = ++seq.current;
    setState('loading');
    const t = setTimeout(() => {
      fetchPage(0)
        .then((r) => { if (my !== seq.current) return; setItems(r.bots); setTotal(r.total); setNext(r.next); setState('ready'); })
        .catch((e) => { if (my !== seq.current) return; setErr(e.message); setState('error'); });
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  async function loadMore() {
    const my = seq.current;
    setMore(true);
    try { const r = await fetchPage(next); if (my === seq.current) { setItems((p) => [...p, ...r.bots]); setNext(r.next); } }
    catch (e) { setErr(e.message); }
    setMore(false);
  }
  return (
    <>
      <div className="explore-body">
        <div className="explore-bar">
          <div className="explore-search">
            <Icon name="search" size={18} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search bots by name, description or tag" aria-label="Search bots" maxLength={60} />
            {q && <button className="icon-btn" title="Clear search" aria-label="Clear search" onClick={() => setQ('')}><Icon name="close" size={16} /></button>}
          </div>
          <label className="explore-sort">
            <span className="muted small">Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by">
              {[...SORTS, ['new', 'Newest']].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
        </div>
        {state === 'error' && <div className="error">{err}</div>}
        {state === 'ready' && items.length === 0 && <div className="empty">{q.trim() ? `No public bots match “${q.trim()}”.` : 'No public bots yet.'}</div>}
        {state === 'ready' && total > 0 && <p className="muted small explore-count">{total} bot{total === 1 ? '' : 's'}</p>}
        <div className={'explore-grid' + (state === 'loading' ? ' busy' : '')}>
          {items.map((b) => (
            <div key={b.id} className="bot-card">
              <div className="bot-head"><b className="bot-name">{b.name}</b><span className="bot-tag">BOT</span></div>
              <div className="muted small">by {b.developer ? (b.developer.displayName || b.developer.username) : 'a developer'} · {b.installs} server{b.installs === 1 ? '' : 's'}</div>
              {b.description && <p className="ex-desc">{b.description}</p>}
              {b.tags.length > 0 && <div className="tag-row">{b.tags.map((t) => <button key={t} className="tag" onClick={() => setQ(t)} title={`Search #${t}`}>#{t}</button>)}</div>}
              <div className="bot-card-foot">
                <button className="btn small-btn primary" onClick={() => setAdding(b)}><Icon name="plus" size={14} className="inline-icon" /> Add to server</button>
                {!b.mine && <button className="link-btn report-link" onClick={() => setReporting(b)}><Icon name="flag" size={13} /> Report</button>}
              </div>
            </div>
          ))}
        </div>
        {state === 'ready' && next !== null && <div className="explore-more"><button className="btn" disabled={more} onClick={loadMore}>{more ? 'Loading…' : 'Show more'}</button></div>}
      </div>
      {adding && <AddToServerModal bot={adding} servers={servers || []} me={me} onAdded={onServerUpdate} onClose={() => setAdding(null)} />}
      {reporting && <ReportModal info={{ ...reporting, serverId: reporting.id }} path={`/bots/${reporting.id}/report`} onClose={() => setReporting(null)} />}
    </>
  );
}

// Server explorer: Servers tab and Bots tab.
export default function Explorer({ onBack, servers, me, onServerUpdate }) {
  const [tab, setTab] = useState('servers');
  return (
    <section className="chat explorer">
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title="Back" aria-label="Back to list" onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash"><Icon name="globe" size={20} /></span>
        <h3>Explorer</h3>
        <div className="explore-tabs" role="tablist">
          {[['servers', 'Servers'], ['bots', 'Bots']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={'explore-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>{label}</button>)}
        </div>
      </header>
      {tab === 'servers' ? <ServerList /> : <BotList servers={servers} me={me} onServerUpdate={onServerUpdate} />}
    </section>
  );
}
