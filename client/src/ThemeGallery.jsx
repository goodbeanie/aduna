import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon, Modal } from './ui.jsx';
import { askConfirm } from './Dialogs.jsx';
import { previewColors } from './themes.js';

// The theme gallery: themes other people published. A theme is only { dark, bg, accent } (rules and limits: server/themegallery.js),
// so picking one is the same as choosing those colours yourself. In Appearance it becomes your own custom theme on this device;
// in Server settings it becomes the draft server theme (previewed live, saved with the server).

export const sameSeed = (a, b) => !!a && !!b && a.dark === b.dark && a.bg.toLowerCase() === b.bg.toLowerCase() && a.accent.toLowerCase() === b.accent.toLowerCase();

function Preview({ seed }) {
  const c = previewColors({ id: 'gallery', ...seed });
  return (
    <span className="theme-prev" style={{ background: c.bg, borderColor: c.bg2 }} aria-hidden="true">
      <i style={{ background: c.bg2 }} />
      <b style={{ background: c.accent }} />
    </span>
  );
}

function Card({ t, on, onPick, onDelete, onReport, busy }) {
  return (
    <div className={'gallery-card' + (on ? ' on' : '')}>
      <button type="button" className="gallery-pick" onClick={() => onPick(t)} aria-pressed={on} title={t.description || t.name}>
        <Preview seed={t.seed} />
        <span className="theme-name">{t.name}</span>
        <span className="gallery-by muted small">by {t.mine ? 'you' : t.author.displayName} · {t.uses} {t.uses === 1 ? 'use' : 'uses'}</span>
      </button>
      {t.mine
        ? <button type="button" className="gallery-act" disabled={busy} onClick={() => onDelete(t)} title="Delete this theme from the gallery" aria-label={'Delete ' + t.name}><Icon name="trash" size={14} /></button>
        : <button type="button" className="gallery-act" disabled={busy} onClick={() => onReport(t)} title="Report this theme" aria-label={'Report ' + t.name}><Icon name="flag" size={14} /></button>}
    </div>
  );
}

export function ThemeGallery({ current, onPick }) {
  const [tab, setTab] = useState('browse'); // browse | mine
  const [q, setQ] = useState('');
  const [mode, setMode] = useState('');
  const [sort, setSort] = useState('popular');
  const [rows, setRows] = useState([]);
  const [more, setMore] = useState(false);
  const [state, setState] = useState('loading'); // loading | ready | failed
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0); // a slow answer for an old search must not overwrite a newer one

  const load = useCallback(async (offset) => {
    const mine = ++seq.current;
    setState((s) => (offset ? s : 'loading'));
    try {
      const r = tab === 'mine'
        ? await api('/themes/mine')
        : await api('/themes?' + new URLSearchParams({ sort, ...(mode ? { mode } : {}), ...(q.trim() ? { q: q.trim() } : {}), ...(offset ? { offset } : {}) }));
      if (mine !== seq.current) return;
      setRows((p) => (offset ? [...p, ...r.themes] : r.themes));
      setMore(!!r.more);
      setState('ready');
    } catch { if (mine === seq.current) setState('failed'); }
  }, [tab, q, mode, sort]);

  useEffect(() => { const t = setTimeout(() => load(0), q ? 250 : 0); return () => clearTimeout(t); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (t) => { onPick(t.seed, t); api(`/themes/${t.id}/use`, { method: 'POST' }).then((r) => setRows((p) => p.map((x) => (x.id === t.id ? { ...x, uses: r.theme.uses } : x)))).catch(() => {}); };
  const del = async (t) => {
    if (!(await askConfirm({ title: 'Delete theme', body: `Delete "${t.name}" from the gallery? People already using its colours keep them.`, confirmLabel: 'Delete', danger: true }))) return;
    setBusy(true); setNote('');
    try { await api(`/themes/${t.id}`, { method: 'DELETE' }); setRows((p) => p.filter((x) => x.id !== t.id)); } catch (e) { setNote(e.message || 'Could not delete that.'); } finally { setBusy(false); }
  };
  const report = async (t) => {
    if (!(await askConfirm({ title: 'Report theme', body: `Report "${t.name}"? Themes with enough reports from established accounts are hidden.`, confirmLabel: 'Report', danger: true }))) return;
    setBusy(true); setNote('');
    try { await api(`/themes/${t.id}/report`, { method: 'POST' }); setRows((p) => p.filter((x) => x.id !== t.id)); setNote('Thanks, it was reported and is hidden for you.'); } catch (e) { setNote(e.message || 'Could not report that.'); } finally { setBusy(false); }
  };

  return (
    <div className="gallery">
      <div className="mode-pick" role="tablist" aria-label="Gallery">
        <button type="button" role="tab" aria-selected={tab === 'browse'} className={tab === 'browse' ? 'on' : ''} onClick={() => setTab('browse')}>Browse</button>
        <button type="button" role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>My published themes</button>
      </div>
      {tab === 'browse' && (
        <div className="gallery-filters">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search themes or authors" maxLength={40} aria-label="Search themes" />
          <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Light or dark"><option value="">Light and dark</option><option value="light">Light</option><option value="dark">Dark</option></select>
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort"><option value="popular">Most used</option><option value="new">Newest</option></select>
        </div>
      )}
      {state === 'loading' && <p className="muted small" role="status">Loading themes…</p>}
      {state === 'failed' && <p className="error-text small">Could not load themes. <button type="button" className="linkish" onClick={() => load(0)}>Try again</button></p>}
      {state === 'ready' && !rows.length && <p className="muted small">{tab === 'mine' ? 'You have not published a theme yet. Make one with the colour pickers, then press Publish.' : q || mode ? 'No themes match.' : 'No themes have been published yet. Be the first!'}</p>}
      {!!rows.length && (
        <div className="gallery-grid">
          {rows.map((t) => <Card key={t.id} t={t} on={sameSeed(current, t.seed)} onPick={pick} onDelete={del} onReport={report} busy={busy} />)}
        </div>
      )}
      {more && tab === 'browse' && <button type="button" className="btn small-btn gallery-more" onClick={() => load(rows.length)}>Show more</button>}
      {note && <p className="muted small" role="status">{note}</p>}
    </div>
  );
}

export function PublishTheme({ seed, onClose }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr('');
    try { await api('/themes', { method: 'PUT', body: { name, description, seed } }); setDone(true); }
    catch (ex) { setErr(ex.message || 'Could not publish that theme.'); } finally { setBusy(false); }
  }

  return (
    <Modal title="Publish this theme" onClose={onClose}>
      {done ? (
        <>
          <p>Published! Anyone can now find <strong>{name.trim()}</strong> in the gallery and use it for themselves or for a server. You can delete it any time from “My published themes”.</p>
          <div className="modal-foot"><button className="btn primary" onClick={onClose}>Done</button></div>
        </>
      ) : (
        <form onSubmit={submit}>
          <Preview seed={seed} />
          <label>NAME</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={30} placeholder="Night Owl" />
          <label>DESCRIPTION (OPTIONAL)</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={120} placeholder="Dark blue with a pink accent" />
          <p className="hint">A theme is only its colours: two colours and light or dark. It is public, and shows your display name as the author. Names and descriptions cannot contain links. Themes with unreadable text are refused.</p>
          {err && <div className="error" role="alert">{err}</div>}
          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy || name.trim().length < 2}>{busy ? 'Publishing…' : 'Publish'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
