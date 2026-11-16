import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon } from './ui.jsx';
import { PanelSkeleton, EmptyState } from './ShellBits.jsx';
import { askConfirm } from './Dialogs.jsx';
import { loadTheme, applyTheme, previewColors } from './themes.js';
import { applyDevTheme, clearDevTheme, currentDevTheme, previewDevTheme, stopPreview, previewingId, previewHeld, holdPreview, UI_HOOKS, CSS_VARS } from './devtheme.js';
import './devthemes.css';

// Developer themes. Settings > Developer > Themes: write a theme as CSS with its own pictures, preview it on this page, send it for review.
// Explorer > Themes: the verified ones, which anyone can use. Every rule (what the CSS may contain, who sees what) is on the server
// (server/devthemes.js); this file only asks, and shows the server's answers as plain text.

const STATUS = {
  draft: ['Draft', ''], pending: ['Waiting for review', 'warn'], approved: ['Verified', 'ok'], rejected: ['Turned down', 'bad'],
};
const kb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

// "My Photo.PNG" -> "my-photo.png": the names the CSS refers to are lower case letters, numbers, - and _ (up to 30), then .png, .jpg or .webp
function pictureName(file) {
  const m = /^(.*)\.([a-z0-9]+)$/i.exec(file.name || '');
  if (!m) return null;
  const ext = m[2].toLowerCase();
  if (!MIME[ext]) return null;
  const stem = m[1].toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 30) || 'picture';
  return `${stem}.${ext}`;
}

const STARTER = `/* Everything in the app can be restyled. Start with the palette: */
:root {
  --bg: #12101c;
  --ink: #ff7ad9;
}

/* The regions have steady hooks that will not change: */
[data-ui="server-bar"] { background: linear-gradient(90deg, #2a1646, #12101c); }
[data-ui="sidebar"]    { border-right: 1px solid var(--line2); }
[data-ui="message"]    { border-radius: 14px; }
[data-ui="composer"]   { border-radius: 18px; }

/* A picture you upload below is used by its name: */
/* [data-ui="chat"] { background: url("background.png") center / cover; } */
`;

function useActive() {
  const [a, setA] = useState(currentDevTheme());
  useEffect(() => {
    const h = () => setA(currentDevTheme());
    window.addEventListener('aduna:devtheme', h);
    return () => window.removeEventListener('aduna:devtheme', h);
  }, []);
  return a;
}

// the person's own look with this theme's colours (nothing is saved unless `save`)
function showSeed(seed, save) {
  const s = loadTheme();
  applyTheme({ ...s, id: 'custom', custom: { ...s.custom, dark: seed.dark, bg: seed.bg, accent: seed.accent, grad: null, stops: null } }, { save });
}
const restoreLook = () => applyTheme(loadTheme());

function Rules() {
  return (
    <details className="dt-ref">
      <summary>What you can use, and what is refused</summary>
      <p className="muted small">A theme is one stylesheet. Anything in the app can be restyled: every selector, variable, media query and animation works.</p>
      <p className="small"><b>Steady hooks</b> (they stay when the app is reworked):</p>
      <ul className="dt-list small">{UI_HOOKS.map(([h, what]) => <li key={h}><code>[data-ui="{h}"]</code> {what}</li>)}</ul>
      <p className="small"><b>Palette variables</b> (set them on <code>:root</code>):</p>
      <ul className="dt-list small">{CSS_VARS.map(([v, what]) => <li key={v}><code>{v}</code> {what}</li>)}</ul>
      <p className="small"><b>Refused,</b> so that no theme can load something from outside or cover the app: <code>@import</code>, <code>@font-face</code>, <code>url()</code> to anything but a picture you uploaded here,
        <code> position: fixed</code>, a <code>z-index</code> above 20, and text longer than 40 characters inside quotes (so a theme cannot put a message or a fake form on the screen).
        An admin reads the CSS and sees the pictures before anyone else can use it, and any change you make afterwards needs a new review.</p>
    </details>
  );
}

function Editor({ theme, limits, onChange, onDeleted, onBack }) {
  const [f, setF] = useState(() => ({
    name: theme?.name || '', description: theme?.description || '', dark: theme ? theme.seed.dark : true, bg: theme?.seed.bg || '#12101c', accent: theme?.seed.accent || '#ff7ad9', css: theme ? theme.css : STARTER,
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [prev, setPrev] = useState(() => !!theme && previewingId() === theme.id);
  const fileRef = useRef(null);
  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })); setNote(''); };
  const body = () => ({ name: f.name, description: f.description, seed: { dark: f.dark, bg: f.bg, accent: f.accent }, css: f.css });
  const dirty = !theme || theme.name !== f.name.trim() || theme.description !== f.description.trim() || theme.seed.dark !== f.dark || theme.seed.bg !== f.bg || theme.seed.accent !== f.accent || theme.css !== f.css;

  // leaving the editor puts the person's own look back, unless they asked to preview the whole site
  useEffect(() => () => { if (previewingId() && !previewHeld()) { stopPreview(); restoreLook(); } }, []);

  const showPreview = (t) => { showSeed(t.seed, false); previewDevTheme(t.id, t.key); setPrev(true); };
  const run = async (fn) => { setBusy(true); setErr(''); try { return await fn(); } catch (e) { setErr(e.message || 'That did not work.'); return null; } finally { setBusy(false); } };

  const save = () => run(async () => {
    const r = theme ? await api(`/devthemes/${theme.id}`, { method: 'PATCH', body: body() }) : await api('/devthemes', { method: 'POST', body: body() });
    onChange(r.theme);
    if (prev) showPreview(r.theme); // the preview key changes with every save
    setNote('Saved.');
    return r.theme;
  });
  const togglePreview = async () => {
    if (prev) { stopPreview(); restoreLook(); setPrev(false); return; }
    const t = dirty ? await save() : theme;
    if (t) showPreview(t);
  };
  // closes Settings and keeps the preview on, so the whole app can be looked at; the bar at the bottom ends it
  const previewSite = async () => {
    const t = dirty ? await save() : theme;
    if (!t) return;
    showPreview(t);
    holdPreview(t.name);
    window.dispatchEvent(new CustomEvent('aduna:closesettings'));
  };
  const submit = () => run(async () => { const r = await api(`/devthemes/${theme.id}/submit`, { method: 'POST' }); onChange(r.theme); setNote('Sent. An admin will read it.'); });
  const withdraw = () => run(async () => { const r = await api(`/devthemes/${theme.id}/withdraw`, { method: 'POST' }); onChange(r.theme); setNote(''); });
  const remove = async () => {
    if (!(await askConfirm({ title: 'Delete theme', body: `Delete "${theme.name}" and its pictures? People already using it lose it.`, confirmLabel: 'Delete', danger: true }))) return;
    if (await run(() => api(`/devthemes/${theme.id}`, { method: 'DELETE' }))) onDeleted(theme.id);
  };
  const upload = (file) => run(async () => {
    const name = pictureName(file);
    if (!name) throw new Error('Choose a PNG, JPEG or WebP picture.');
    if (file.size > limits.imageBytes) throw new Error(`That picture is too big (${kb(limits.imageBytes)} at most).`);
    const res = await fetch(`/api/devthemes/${theme.id}/images/${name}`, { method: 'PUT', headers: { 'Content-Type': MIME[name.split('.').pop()] }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not upload that picture.');
    onChange(data.theme);
    if (prev) showPreview(data.theme);
    setNote(`Uploaded. Use it in the CSS as url("${name}").`);
  });
  const dropPicture = (p) => run(async () => { const r = await api(`/devthemes/${theme.id}/images/${p.name}`, { method: 'DELETE' }); onChange(r.theme); if (prev) showPreview(r.theme); });

  const st = STATUS[theme ? theme.status : 'draft'];
  const c = previewColors({ id: 'dt', dark: f.dark, bg: f.bg, accent: f.accent });
  return (
    <div className="dt-edit">
      <button type="button" className="linkish dt-back" onClick={onBack}><Icon name="back" size={16} className="inline-icon" /> All themes</button>
      <div className="dt-head">
        <h2>{theme ? theme.name : 'New theme'}</h2>
        <span className={'bchip dt-' + (st[1] || 'draft')}>{st[0]}</span>
      </div>
      {theme?.status === 'rejected' && <p className="error-text small">An admin turned this theme down{theme.note ? ': ' + theme.note : '.'} Change something in it to send it again.</p>}
      {theme?.status === 'pending' && <p className="muted small">An admin will read the CSS and look at the pictures. Changing anything takes it out of the queue.</p>}
      {theme?.status === 'approved' && <p className="muted small">Verified: anyone can use it from the Explorer &rsaquo; Themes. Changing the CSS, a picture, the name or the colours makes it a draft again until it is reviewed again.</p>}

      <label>NAME</label>
      <input value={f.name} onChange={set('name')} maxLength={limits.name} placeholder="Neon Rain" />
      <label>DESCRIPTION (OPTIONAL)</label>
      <input value={f.description} onChange={set('description')} maxLength={limits.description} placeholder="Dark purple with a pink glow" />
      <label>BASE COLOURS</label>
      <div className="dt-colours">
        <label className="check-row"><input type="checkbox" checked={f.dark} onChange={set('dark')} /> <span>Dark</span></label>
        <label className="dt-colour"><span>Background</span><input type="color" value={f.bg} onChange={set('bg')} /></label>
        <label className="dt-colour"><span>Accent</span><input type="color" value={f.accent} onChange={set('accent')} /></label>
        <span className="theme-prev dt-swatch" style={{ background: c.bg, borderColor: c.bg2 }} aria-hidden="true"><i style={{ background: c.bg2 }} /><b style={{ background: c.accent }} /></span>
      </div>
      <p className="muted small hint">The CSS is added on top of these colours. They are also what people see in the gallery, and they must keep the text readable.</p>

      <label>CSS</label>
      <textarea className="dt-css" value={f.css} onChange={set('css')} spellCheck={false} rows={18} maxLength={limits.css} aria-label="Theme CSS" />
      <p className="muted small hint">{f.css.length.toLocaleString()} of {limits.css.toLocaleString()} characters.</p>

      {theme ? (
        <>
          <label>PICTURES ({theme.images.length} of {limits.images})</label>
          {theme.images.length > 0 && (
            <ul className="dt-pics">
              {theme.images.map((p) => (
                <li key={p.name}>
                  <code>{p.name}</code> <span className="muted small">{p.width}×{p.height} · {kb(p.bytes)} · <code>url("{p.name}")</code></span>
                  <button type="button" className="gallery-act" disabled={busy} onClick={() => dropPicture(p)} title="Remove this picture" aria-label={'Remove ' + p.name}><Icon name="trash" size={14} /></button>
                </li>
              ))}
            </ul>
          )}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const x = e.target.files?.[0]; e.target.value = ''; if (x) upload(x); }} />
          <button type="button" className="btn small-btn" disabled={busy || theme.images.length >= limits.images} onClick={() => fileRef.current?.click()}>Add a picture</button>
          <p className="muted small hint">PNG, JPEG or WebP, up to {limits.imageSide}px a side and {kb(limits.imageBytes)}. Pictures are checked like every other public picture. A same-named upload replaces the old one.</p>
        </>
      ) : <p className="muted small hint">Save the theme first, then you can add pictures.</p>}

      <Rules />
      {err && <div className="error" role="alert">{err}</div>}
      {note && !err && <p className="muted small" role="status">{note}</p>}
      <div className="dt-actions">
        <button className="btn primary" disabled={busy || !dirty || f.name.trim().length < 2} onClick={save}>{busy ? 'Working…' : theme ? 'Save' : 'Create theme'}</button>
        <button className="btn" disabled={busy || f.name.trim().length < 2} onClick={togglePreview}>{prev ? 'Stop preview' : 'Preview on this page'}</button>
        <button className="btn" disabled={busy || f.name.trim().length < 2} onClick={previewSite}>Preview on the whole site</button>
        {theme && theme.status === 'pending' && <button className="btn" disabled={busy} onClick={withdraw}>Withdraw from review</button>}
        {theme && (theme.status === 'draft') && <button className="btn" disabled={busy || dirty || !theme.css.trim()} title={dirty ? 'Save your changes first' : 'Ask an admin to verify it'} onClick={submit}>Send for review</button>}
        {theme && <button className="btn danger-btn" disabled={busy} onClick={remove}>Delete</button>}
      </div>
    </div>
  );
}

// ---------- the bar shown while the whole site is being previewed ----------
export function SitePreviewBar({ onEdit }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const h = () => tick((n) => n + 1);
    window.addEventListener('aduna:devtheme', h);
    return () => window.removeEventListener('aduna:devtheme', h);
  }, []);
  const held = previewHeld();
  if (!held) return null;
  return (
    <div className="dt-sitebar" role="status">
      <span className="dt-sitebar-text">Previewing <b>{held.name}</b> on the whole site. Nothing is saved.</span>
      <button type="button" className="btn small-btn" onClick={onEdit}>Back to editor</button>
      <button type="button" className="btn small-btn primary" onClick={() => { stopPreview(); restoreLook(); }}>Stop preview</button>
    </div>
  );
}

// ---------- Settings > Developer > Themes ----------
export function DeveloperThemes({ me }) {
  const [state, setState] = useState('loading'); // loading | ready | off | error
  const [list, setList] = useState([]);
  const [limits, setLimits] = useState(null);
  const [editing, setEditing] = useState(null); // null = the list, 'new' or a theme id
  const load = useCallback(() => api('/devthemes/mine').then((r) => { setList(r.themes); setLimits(r.limits); setState('ready'); }).catch((e) => setState(e.status === 403 ? 'off' : 'error')), []);
  useEffect(() => { if (me.developer) load(); else setState('off'); }, [load, me.developer]);
  // the author's drafts change on the server when an admin decides: look again when the list opens
  const upsert = (t) => setList((l) => (l.some((x) => x.id === t.id) ? l.map((x) => (x.id === t.id ? t : x)) : [t, ...l]));

  if (state === 'off') return null;
  if (state === 'loading') return <PanelSkeleton cards={1} label="Loading themes" />;
  if (state === 'error') return <p className="error-text small">Could not load your themes. <button type="button" className="linkish" onClick={load}>Try again</button></p>;
  if (editing) {
    const t = editing === 'new' ? null : list.find((x) => x.id === editing);
    return <Editor key={editing === 'new' ? 'new' : editing} theme={t} limits={limits} onBack={() => { setEditing(null); load(); }}
      onChange={(x) => { upsert(x); if (editing === 'new') setEditing(x.id); }} onDeleted={(id) => { setList((l) => l.filter((x) => x.id !== id)); setEditing(null); }} />;
  }
  const full = list.length >= limits.perDeveloper;
  return (
    <div className="dt-list-wrap">
      <h2 className="dt-title">Themes</h2>
      <p className="muted small hint">Write a whole look as CSS, with your own pictures. It stays yours until an admin has read and verified it; then anyone can use it from the Explorer. You can have up to {limits.perDeveloper} themes.</p>
      {list.length === 0 && <EmptyState icon="plus" title="You have no themes yet" action={<button className="btn primary" onClick={() => setEditing('new')}>New theme</button>}>Start from a small example and change anything you like.</EmptyState>}
      {list.map((t) => {
        const st = STATUS[t.status] || STATUS.draft;
        return (
          <button key={t.id} className="bot-row" onClick={() => setEditing(t.id)}>
            <div className="bot-head"><b className="bot-name">{t.name}</b><span className={'bchip dt-' + (st[1] || 'draft')}>{st[0]}</span></div>
            <div className="muted small">{t.images.length} picture{t.images.length === 1 ? '' : 's'}{t.status === 'approved' ? ` · ${t.uses} use${t.uses === 1 ? '' : 's'}` : ''}{t.description ? ' · ' + t.description : ''}</div>
          </button>
        );
      })}
      {list.length > 0 && <button className="btn primary" disabled={full} onClick={() => setEditing('new')}><Icon name="plus" size={16} className="inline-icon" /> New theme</button>}
      {full && <p className="muted small hint">You have reached the limit. Delete a theme to make a new one.</p>}
    </div>
  );
}

// ---------- Explorer > Themes: the verified developer themes ----------
function Card({ t, active, previewing, onUse, onPreview, onReport, busy }) {
  const c = previewColors({ id: 'dt', ...t.seed });
  const cover = t.coverImage ? `url("/api/images/${t.coverImage}")` : null;
  return (
    <div className={'gallery-card dt-card' + (active ? ' on' : '')}>
      <span className="theme-prev dt-cover" style={{ background: c.bg, borderColor: c.bg2, backgroundImage: cover || undefined }} aria-hidden="true"><i style={{ background: c.bg2, opacity: cover ? 0.7 : 1 }} /><b style={{ background: c.accent }} /></span>
      <div className="dt-body">
        <span className="theme-name dt-name" title={t.name}>{t.name}</span>
        <span className="gallery-by muted small">by {t.mine ? 'you' : t.author.displayName} · {t.uses} {t.uses === 1 ? 'use' : 'uses'}</span>
        {t.description && <p className="dt-desc muted small">{t.description}</p>}
        <div className="dt-card-acts">
          <div className="mode-pick">
            <button type="button" className={active ? 'on' : ''} disabled={busy} aria-pressed={active} onClick={() => onUse(t)}>{active ? 'Applied' : 'Save and apply'}</button>
            <button type="button" disabled={busy} onClick={() => onPreview(t)}>{previewing ? 'Stop trying' : 'Try'}</button>
          </div>
          {!t.mine && <button type="button" className="gallery-act" disabled={busy} onClick={() => onReport(t)} title="Report this theme" aria-label={'Report ' + t.name}><Icon name="flag" size={14} /></button>}
        </div>
      </div>
    </div>
  );
}

export function DevThemeGallery() {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState('');
  const [sort, setSort] = useState('popular');
  const [rows, setRows] = useState([]);
  const [more, setMore] = useState(false);
  const [state, setState] = useState('loading');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [tryId, setTryId] = useState(previewingId());
  const active = useActive();
  const seq = useRef(0);

  const load = useCallback(async (offset) => {
    const mine = ++seq.current;
    if (!offset) setState('loading');
    try {
      const r = await api('/devthemes?' + new URLSearchParams({ sort, ...(mode ? { mode } : {}), ...(q.trim() ? { q: q.trim() } : {}), ...(offset ? { offset } : {}) }));
      if (mine !== seq.current) return;
      setRows((p) => (offset ? [...p, ...r.themes] : r.themes)); setMore(!!r.more); setState('ready');
    } catch { if (mine === seq.current) setState('failed'); }
  }, [q, mode, sort]);
  useEffect(() => { const t = setTimeout(() => load(0), q ? 250 : 0); return () => clearTimeout(t); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  // a "Try" ends when the person leaves this tab
  const tryRef = useRef(tryId);
  tryRef.current = tryId;
  useEffect(() => () => { if ((previewingId() || tryRef.current) && !previewHeld()) { stopPreview(); restoreLook(); } }, []);

  const use = (t) => {
    if (active && active.id === t.id) return;
    if (previewingId()) { stopPreview(); }
    showSeed(t.seed, true); // the theme's colours become the person's custom colours on this device, as with any gallery theme
    applyDevTheme({ id: t.id, v: t.v, name: t.name });
    setTryId(null); setNote(`Using ${t.name}.`);
    api(`/devthemes/${t.id}/use`, { method: 'POST' }).then((r) => setRows((p) => p.map((x) => (x.id === t.id ? { ...x, uses: r.theme.uses } : x)))).catch(() => {});
  };
  // "Try" shows it on this page without saving; it is a stylesheet of its own, so the version in the address is what a verified theme is cached by
  const tryIt = (t) => {
    if (tryId === t.id) { stopPreview(); restoreLook(); setTryId(null); return; }
    setNote('Trying it here. Press Use to keep it, or Stop to go back.');
    showSeed(t.seed, false);
    // a verified theme is public, so its own address is the preview (no key needed): the saved-theme path with this version, but not saved
    applyTrial(t);
    setTryId(t.id);
  };
  const off = () => { clearDevTheme(); setNote('Developer theme turned off. Your colours stay.'); };
  const report = async (t) => {
    if (!(await askConfirm({ title: 'Report theme', body: `Report "${t.name}"? Themes with enough reports are hidden until an admin looks at them.`, confirmLabel: 'Report', danger: true }))) return;
    setBusy(true);
    try { await api(`/devthemes/${t.id}/report`, { method: 'POST' }); setRows((p) => p.filter((x) => x.id !== t.id)); setNote('Thanks, it was reported and is hidden for you.'); }
    catch (e) { setNote(e.message || 'Could not report that.'); } finally { setBusy(false); }
  };

  return (
    <div className="gallery dt-gallery">
      <h3 className="dt-title">Developer themes</h3>
      <p className="muted small hint">Whole looks written as CSS, with their own pictures. Each one was read and verified by an admin; changing a theme takes its verification away until it is checked again.</p>
      {active && <p className="small dt-active">Using <b>{active.name || 'a developer theme'}</b>. <button type="button" className="linkish" onClick={off}>Turn it off</button></p>}
      <div className="gallery-filters">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search themes or authors" maxLength={40} aria-label="Search developer themes" />
        <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Light or dark"><option value="">Light and dark</option><option value="light">Light</option><option value="dark">Dark</option></select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort"><option value="popular">Most used</option><option value="new">Newest</option></select>
      </div>
      {state === 'loading' && <p className="muted small" role="status">Loading themes…</p>}
      {state === 'failed' && <p className="error-text small">Could not load themes. <button type="button" className="linkish" onClick={() => load(0)}>Try again</button></p>}
      {state === 'ready' && !rows.length && <p className="muted small">{q || mode ? 'No themes match.' : 'No developer themes are verified yet. Turn on a developer account in Settings and write the first one!'}</p>}
      {!!rows.length && <div className="gallery-grid dt-grid">{rows.map((t) => <Card key={t.id} t={t} active={!!active && active.id === t.id} previewing={tryId === t.id} onUse={use} onPreview={tryIt} onReport={report} busy={busy} />)}</div>}
      {more && <button type="button" className="btn small-btn gallery-more" onClick={() => load(rows.length)}>Show more</button>}
      {note && <p className="muted small" role="status">{note}</p>}
    </div>
  );
}

// a verified theme tried without saving: the same stylesheet the saved path loads, shown through the preview slot
function applyTrial(t) {
  // previewDevTheme wants a private key; a verified theme needs none, so load it by its public version instead
  const link = document.getElementById('aduna-devtheme-css') || Object.assign(document.createElement('link'), { id: 'aduna-devtheme-css', rel: 'stylesheet' });
  link.setAttribute('href', `/api/devthemes/${encodeURIComponent(t.id)}/css?v=${encodeURIComponent(t.v)}`);
  if (document.head.lastElementChild !== link) document.head.appendChild(link);
  document.documentElement.dataset.devtheme = t.id;
}
