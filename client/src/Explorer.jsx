import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon } from './ui.jsx';
import { InviteBox } from './Invite.jsx';

const SORTS = [['popular', 'Most popular'], ['az', 'A to Z'], ['za', 'Z to A']];

// Server explorer: public servers, drawn with the same join box as a direct invite.
// Search matches name, description and tags (tags rank highest); the default sort is most popular.
export default function Explorer({ onBack }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('popular');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [more, setMore] = useState(false);
  const [err, setErr] = useState('');
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
    <section className="chat explorer">
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title="Back" aria-label="Back to list" onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash"><Icon name="globe" size={20} /></span>
        <h3>Server explorer</h3>
      </header>
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
              </>
            )} />
          ))}
        </div>
        {state === 'ready' && next !== null && <div className="explore-more"><button className="btn" disabled={more} onClick={loadMore}>{more ? 'Loading…' : 'Show more'}</button></div>}
      </div>
    </section>
  );
}
