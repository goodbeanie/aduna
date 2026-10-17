import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './ui.jsx';
import EmojiPicker from './EmojiPicker.jsx';
import { api } from './api.js';
import { useEmoji } from './Emoji.jsx';
import { keepDays, kindOf, loadBlob, safeGif, saveAttachment, sizeLabel } from './files.js';

function fit(w, h, maxW = 380, maxH = 320) {
  if (!w || !h) return null;
  const s = Math.min(1, maxW / w, maxH / h);
  return { width: Math.round(w * s), height: Math.round(h * s) };
}

function useBlobUrl(att, dm, enabled) {
  const [state, setState] = useState({ url: null, err: false, expired: false });
  useEffect(() => {
    if (!enabled) return undefined;
    let url, dead = false;
    loadBlob(att, dm).then((b) => { if (!dead) { url = URL.createObjectURL(b); setState({ url, err: false, expired: false }); } })
      .catch((e) => !dead && setState({ url: null, err: true, expired: !!e?.expired }));
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [att.id, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

function Expired({ att }) {
  return (
    <div className="att-file att-expired" title={`Files are removed ${keepDays(att.size)} days after they are sent`}>
      <Icon name="clock" size={26} />
      <div className="att-meta"><div className="att-name">{att.name || 'Attachment'}</div><div className="muted small">Expired and removed after {keepDays(att.size)} days</div></div>
    </div>
  );
}

function ImageAtt({ att, dm, onOpen }) {
  const { url, err, expired } = useBlobUrl(att, dm, true);
  if (expired) return <Expired att={att} />;
  const box = fit(att.w, att.h) || { width: 300, height: 180 };
  return (
    <button className="att-img" style={url && !att.w ? undefined : box} onClick={() => url && onOpen({ url, name: att.name, att })} title={att.name}>
      {url ? <img src={url} alt={att.name} draggable={false} /> : <span className="att-wait">{err ? 'Could not load image' : 'Loading…'}</span>}
    </button>
  );
}

function MediaAtt({ att, dm, kind }) {
  const { url, err, expired } = useBlobUrl(att, dm, true);
  if (expired) return <Expired att={att} />;
  if (err) return <div className="att-file muted">Could not load {att.name}</div>;
  if (!url) return <div className="att-file muted">Loading {att.name}…</div>;
  return kind === 'video'
    ? <video className="att-video" src={url} controls preload="metadata" />
    : <div className="att-audio"><div className="att-name">{att.name}</div><audio src={url} controls preload="metadata" /></div>;
}

function FileAtt({ att, dm }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [expired, setExpired] = useState(false);
  async function download() {
    setBusy(true); setErr('');
    try { await saveAttachment(att, dm); } catch (e) { if (e?.expired) setExpired(true); else setErr(e.message); }
    setBusy(false);
  }
  if (expired) return <Expired att={att} />;
  return (
    <div className="att-file">
      <Icon name="file" size={26} />
      <div className="att-meta"><div className="att-name" title={att.name}>{att.name}</div><div className="muted small">{err || `${sizeLabel(att.size)} · removed ${keepDays(att.size)} days after sending`}</div></div>
      <button className="icon-btn" title="Download" onClick={download} disabled={busy}><Icon name="download" size={18} /></button>
    </div>
  );
}

export function Attachments({ atts, dm, onOpen }) {
  if (!atts?.length) return null;
  return (
    <div className="atts">
      {atts.map((a, i) => {
        if (a.gif) {
          if (!safeGif(a.url)) return null;
          return <button key={i} className="att-img" style={fit(a.w, a.h, 320, 260)} onClick={() => onOpen({ url: a.url, name: a.title || 'GIF' })} title={a.title}>
            <img src={a.url} alt={a.title || 'GIF'} loading="lazy" referrerPolicy="no-referrer" draggable={false} />
          </button>;
        }
        if (a.expired) return <Expired key={a.id} att={a} />;
        const kind = kindOf(a.type);
        if (kind === 'image') return <ImageAtt key={a.id} att={a} dm={dm} onOpen={onOpen} />;
        if (kind === 'video' || kind === 'audio') return <MediaAtt key={a.id} att={a} dm={dm} kind={kind} />;
        return <FileAtt key={a.id} att={a} dm={dm} />;
      })}
    </div>
  );
}

export function Lightbox({ view, onClose }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="lightbox" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <img src={view.url} alt={view.name} referrerPolicy="no-referrer" />
      <div className="lightbox-bar">
        <span>{view.name}</span>
        {view.att && <button className="icon-btn" title="Download" onClick={() => saveAttachment(view.att, view.dm)}><Icon name="download" size={18} /></button>}
        <button className="icon-btn" title="Close" onClick={onClose}><Icon name="close" size={18} /></button>
      </div>
    </div>
  );
}

function Popover({ onClose, className = '', children }) {
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => ref.current && !ref.current.contains(e.target) && onClose();
    const k = (e) => e.key === 'Escape' && onClose();
    const t = setTimeout(() => document.addEventListener('mousedown', h), 0);
    document.addEventListener('keydown', k);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [onClose]);
  return <div className={'pop ' + className} ref={ref}>{children}</div>;
}

export function EmojiPop({ onPick, onClose }) {
  const { openManager } = useEmoji();
  return (
    <Popover onClose={onClose} className="emoji-pop">
      <EmojiPicker onPick={onPick} onCustom={(e) => onPick(`:${e.name}: `)} onManage={() => { onClose(); openManager(); }} />
    </Popover>
  );
}

// Splits GIFs into two columns, always adding the next one to the shorter column, so earlier ones never move when more load.
function columns(list) {
  const cols = [[], []], h = [0, 0];
  for (const g of list) {
    const i = h[0] <= h[1] ? 0 : 1;
    cols[i].push(g); h[i] += g.h / g.w;
  }
  return cols;
}

export function GifPop({ onPick, onClose, enabled }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState([]);
  const [next, setNext] = useState(0);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const gen = useRef(0);
  const grid = useRef(null);

  const run = useCallback((query, offset) => {
    const id = ++gen.current;
    setLoading(true); setErr('');
    api(`/gifs?q=${encodeURIComponent(query)}&offset=${offset}`).then((r) => {
      if (id !== gen.current) return;
      setList((prev) => (offset === 0 ? r.gifs : [...prev, ...r.gifs.filter((g) => !prev.some((p) => p.id === g.id))]));
      setNext(r.next ?? 0); setMore(r.next != null); setLoading(false);
    }).catch((e) => { if (id !== gen.current) return; setErr(e.message); setMore(false); setLoading(false); });
  }, []);

  // new search text: throw away anything still loading, start again from the top
  useEffect(() => {
    if (!enabled) return;
    gen.current++;
    setList([]); setMore(true); setNext(0);
    const t = setTimeout(() => run(q.trim(), 0), q ? 350 : 0);
    return () => clearTimeout(t);
  }, [q, enabled, run]);

  function loadMore() { if (!loading && more && list.length) run(q.trim(), next); }
  const onScroll = (e) => { const el = e.currentTarget; if (el.scrollTop + el.clientHeight > el.scrollHeight - 240) loadMore(); };
  // a tall window can show the first page without scrolling; keep loading until it is full
  useEffect(() => { const el = grid.current; if (el && !loading && more && list.length && el.scrollHeight <= el.clientHeight + 40) loadMore(); });

  const cols = useMemo(() => columns(list), [list]);
  return (
    <Popover onClose={onClose} className="gif-pop">
      {!enabled ? (
        <div className="gif-setup">
          <b>GIF search isn’t set up yet</b>
          <p className="muted small">GIFs come from GIPHY. Whoever runs this Aduna server needs a free API key from developers.giphy.com, then starts the server with <code>GIPHY_API_KEY=your_key</code>. After a restart, this button opens a searchable, endlessly scrolling GIF library.</p>
        </div>
      ) : (
        <>
          <div className="gif-search">
            <Icon name="search" size={16} className="ep-search-ic" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search GIFs" maxLength={60} />
          </div>
          <div className="gif-label muted small">{q.trim() ? `Results for “${q.trim()}”` : 'Trending'}</div>
          <div className="gif-grid" ref={grid} onScroll={onScroll}>
            {list.length > 0 && (
              <div className="gif-cols">
                {cols.map((col, i) => (
                  <div className="gif-col" key={i}>
                    {col.map((g) => (
                      <button key={g.id} type="button" onClick={() => onPick(g)} title={g.title} style={{ aspectRatio: `${g.w} / ${g.h}` }}>
                        <img src={g.url} alt={g.title} loading="lazy" referrerPolicy="no-referrer" />
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {loading && <div className="muted pad center">Loading…</div>}
            {err && <div className="error-text pad center">{err}</div>}
            {!loading && !err && list.length === 0 && <div className="muted pad center">No GIFs found.</div>}
            {!loading && !more && list.length > 0 && <div className="muted small pad center">That’s everything.</div>}
          </div>
          <div className="gif-credit muted small">Powered by GIPHY. Viewing a GIF loads it from GIPHY.</div>
        </>
      )}
    </Popover>
  );
}
