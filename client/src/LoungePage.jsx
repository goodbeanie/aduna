import React, { useRef, useState } from 'react';
import './lounge.css';
import { Avatar, Icon, ServerIcon } from './ui.jsx';
import { imageUrl } from './image.js';
import { api } from './api.js';
import { askConfirm, toast } from './Dialogs.jsx';
import {
  LIMITS, SECTION_TYPES, ACCENTS, LOOK_OPTIONS, LOOK_LABELS, TEMPLATES,
  draftOf, fromTemplate, newSection, accentOf, onColor, fixUrl, forSave,
} from './lounge.js';

// The Lounge tab: a server's info page. Everyone who may see it reads it here; people with Manage server get a Customize button that opens the
// editor beside the page (Templates / Look / Sections), and the page above redraws live from the draft. Nothing is stored until Save.
// Data and templates: client/src/lounge.js. Validation and storage: server/lounge.js.

export const LOUNGE_ICON = 'star';
const BANNER_H = { tall: 230, normal: 160, short: 96 };
const fontAttr = (look) => (look.font && look.font !== 'default' ? { 'data-nf': look.font } : {}); // the bundled name fonts (namestyle.css)
const chanIcon = (c) => ({ voice: 'speaker', rules: 'rules', announcements: 'megaphone' }[c.type] || 'hash');
// a link from the draft that is safe to draw as a real link (the server only stores https)
const safe = (u) => { const f = fixUrl(u); return /^https:\/\/[^\s<>"']+$/i.test(f) ? f : null; };

function Stack({ ids, users, max = 4 }) {
  const shown = ids.slice(0, max), more = ids.length - shown.length;
  return (
    <span className="lg-stack">
      {shown.map((id) => <Avatar key={id} user={users[id]} size={26} />)}
      {more > 0 && <span className="lg-more">+{more}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- the widgets
function Widget({ s, ctx }) {
  const { server, users, presence, voiceMembers, onChannel, editing, look } = ctx;
  const meta = SECTION_TYPES[s.type];
  const channels = server.channels || [];
  const open = (c) => { if (onChannel) onChannel(c); };
  const head = (def) => { const t = s.heading || def; return t ? <h2 className="lg-h" {...fontAttr(look)}>{t}</h2> : null; };
  const hint = (t) => (editing ? <p className="lg-empty">{t}</p> : null);

  switch (s.type) {
    case 'buttons': {
      const items = (s.items || []).filter((i) => i.label && (i.channelId || safe(i.url)));
      if (!items.length) return hint('Buttons: add a label and where it goes.');
      return (
        <div className="lg-buttons">
          {items.map((i, n) => {
            if (i.channelId) {
              const c = channels.find((x) => x.id === i.channelId);
              return c ? <button key={n} className="lg-btn" onClick={() => open(c)}>{i.label}</button> : null;
            }
            return <a key={n} className="lg-btn" href={safe(i.url)} target="_blank" rel="noopener noreferrer">{i.label}</a>;
          })}
        </div>
      );
    }
    case 'about': case 'text':
      if (!s.text && !editing) return null;
      return (
        <div className="lg-card">
          {head(s.type === 'about' ? meta.label : '')}
          <p className="lg-text">{s.text || <span className="lg-empty">Nothing written yet.</span>}</p>
        </div>
      );
    case 'announcement':
      if (!s.text && !editing) return null;
      return (
        <div className="lg-card lg-announce">
          <Icon name="megaphone" size={20} />
          <div>{head(meta.label)}<p className="lg-text">{s.text || <span className="lg-empty">Nothing written yet.</span>}</p></div>
        </div>
      );
    case 'live': {
      const rooms = channels.filter((c) => c.type === 'voice').map((c) => ({ c, ids: (voiceMembers[c.id] || []).filter((id) => users[id]) })).filter((r) => r.ids.length);
      return (
        <div className="lg-card">
          <h2 className="lg-h" {...fontAttr(look)}><i className="lg-live-dot" />{s.heading || meta.label}</h2>
          {rooms.length ? (
            <div className="lg-tiles">
              {rooms.map(({ c, ids }) => (
                <button key={c.id} className="lg-tile" onClick={() => open(c)}>
                  <span className="lg-tile-ico"><Icon name="speaker" size={18} /></span>
                  <span className="lg-tile-text"><b>{c.name}</b><small className="lg-green">{ids.length} in voice</small></span>
                  <Stack ids={ids} users={users} />
                </button>
              ))}
            </div>
          ) : <p className="lg-empty">Nobody is in voice right now.</p>}
        </div>
      );
    }
    case 'channels': {
      const list = (s.channelIds || []).map((id) => channels.find((c) => c.id === id)).filter(Boolean);
      if (!list.length) return editing ? <div className="lg-card">{head(meta.label)}<p className="lg-empty">Pick some channels in the editor.</p></div> : null;
      return (
        <div className="lg-card">
          {head(meta.label)}
          <div className="lg-tiles">
            {list.map((c) => (
              <button key={c.id} className="lg-tile" onClick={() => open(c)}>
                <span className="lg-tile-ico"><Icon name={chanIcon(c)} size={18} /></span>
                <span className="lg-tile-text"><b>{c.name}</b></span>
              </button>
            ))}
          </div>
        </div>
      );
    }
    case 'members': {
      const rank = { online: 0, idle: 1, dnd: 2 };
      const on = (server.members || []).filter((m) => (presence[m.id] || 'offline') !== 'offline').sort((a, b) => (rank[presence[a.id]] ?? 3) - (rank[presence[b.id]] ?? 3));
      const shown = on.slice(0, 14);
      return (
        <div className="lg-card">
          {head(meta.label)}
          {shown.length ? (
            <div className="lg-people">
              {shown.map((m) => (
                <span key={m.id} className="lg-person"><Avatar user={users[m.id] || m} size={26} presence={presence[m.id]} /><span>{(users[m.id] || m).displayName}</span></span>
              ))}
              {on.length > shown.length && <span className="lg-person lg-more-chip">+{on.length - shown.length} more</span>}
            </div>
          ) : <p className="lg-empty">Nobody is online right now.</p>}
        </div>
      );
    }
    case 'links': {
      const items = (s.items || []).map((i) => ({ label: i.label, url: safe(i.url) })).filter((i) => i.label && i.url);
      if (!items.length) return editing ? <div className="lg-card">{head(meta.label)}<p className="lg-empty">Add a label and a link in the editor.</p></div> : null;
      return (
        <div className="lg-card">
          {head(meta.label)}
          <div className="lg-people">
            {items.map((i, n) => <a key={n} className="lg-person lg-link" href={i.url} target="_blank" rel="noopener noreferrer"><Icon name="globe" size={16} />{i.label}</a>)}
          </div>
        </div>
      );
    }
    default: return null;
  }
}

// The whole page for a draft: background, banner, the title block (logo, name, tagline, counts) and the widgets in order.
function LoungeBody({ draft, ctx }) {
  const { server, presence } = ctx;
  const look = ctx.look;
  const accent = accentOf(look, server);
  const banner = imageUrl(server.bannerImage);
  const online = (server.members || []).filter((m) => (presence[m.id] || 'offline') !== 'offline').length;
  const vars = { '--lg-accent': accent, '--lg-on': onColor(accent), '--lg-banner-h': BANNER_H[look.banner] + 'px' };
  return (
    <div className={`lounge bg-${look.background} cards-${look.cards} title-${look.title}${banner ? '' : ' no-banner'}`} style={vars}>
      {look.background === 'banner' && banner && <div className="lounge-bgblur" style={{ backgroundImage: `url("${banner}")` }} />}
      <div className="lounge-banner" style={banner ? { backgroundImage: `url("${banner}")` } : undefined} />
      <div className="lounge-title">
        <span className="lounge-logo"><ServerIcon server={server} size={88} /></span>
        <h1 {...fontAttr(look)}>{server.name}</h1>
        {draft.tagline && <p className="lounge-tagline">{draft.tagline}</p>}
        <div className="lounge-stats"><b>{(server.members || []).length.toLocaleString()}</b> members<i className="lg-sep" /><i className="lg-online-dot" /><b>{online.toLocaleString()}</b> online</div>
      </div>
      <div className="lounge-sections">
        {draft.sections.filter((s) => s.enabled !== false).map((s) => <Widget key={s.id} s={s} ctx={ctx} />)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the editor
function ItemsForm({ s, chans, patch }) {
  const isBtn = s.type === 'buttons';
  const max = isBtn ? LIMITS.buttons : LIMITS.links;
  const items = s.items || [];
  const setItems = (next) => patch(s.id, { items: next });
  const edit = (n, p) => setItems(items.map((it, i) => (i === n ? { ...it, ...p } : it)));
  return (
    <div className="lg-field">
      <span>{isBtn ? 'Buttons' : 'Links'} ({items.length}/{max})</span>
      {items.map((it, n) => (
        <div key={n} className="lg-item">
          <input className="lg-input" placeholder="Label" maxLength={LIMITS.label} value={it.label || ''} onChange={(e) => edit(n, { label: e.target.value })} aria-label="Label" />
          {isBtn && (
            <select className="lg-input" value={it.channelId ? 'c:' + it.channelId : 'link'} aria-label="Where it goes"
              onChange={(e) => { const v = e.target.value; edit(n, v === 'link' ? { channelId: undefined, url: it.url || '' } : { channelId: v.slice(2), url: undefined }); }}>
              <option value="link">A link</option>
              {chans.map((c) => <option key={c.id} value={'c:' + c.id}>#{c.name}</option>)}
            </select>
          )}
          {!(isBtn && it.channelId) && <input className="lg-input" placeholder="example.com" maxLength={LIMITS.url} value={it.url || ''} onChange={(e) => edit(n, { url: e.target.value })} aria-label="Link" />}
          <button type="button" className="icon-btn" title="Remove" aria-label="Remove" onClick={() => setItems(items.filter((_, i) => i !== n))}><Icon name="close" size={14} /></button>
        </div>
      ))}
      {items.length < max && <button type="button" className="btn small-btn lg-add-item" onClick={() => setItems([...items, { label: '', url: '' }])}><Icon name="plus" size={14} /> Add {isBtn ? 'a button' : 'a link'}</button>}
    </div>
  );
}

function SectionForm({ s, server, patch }) {
  const chans = server.channels || [];
  const set = (p) => patch(s.id, p);
  const picked = s.channelIds || [];
  return (
    <div className="lg-form">
      {s.type !== 'buttons' && (
        <label className="lg-field"><span>Heading</span>
          <input className="lg-input" value={s.heading || ''} maxLength={LIMITS.heading} placeholder={s.type === 'text' ? 'No heading' : SECTION_TYPES[s.type].label} onChange={(e) => set({ heading: e.target.value })} />
        </label>
      )}
      {(s.type === 'about' || s.type === 'text' || s.type === 'announcement') && (
        <label className="lg-field"><span>Text</span>
          <textarea className="lg-input" rows={4} value={s.text || ''} maxLength={s.type === 'announcement' ? LIMITS.announcement : LIMITS.body} onChange={(e) => set({ text: e.target.value })} />
        </label>
      )}
      {s.type === 'channels' && (
        <div className="lg-field"><span>Channels ({picked.length}/{LIMITS.channels})</span>
          <div className="lg-checks">
            {chans.map((c) => {
              const on = picked.includes(c.id), full = !on && picked.length >= LIMITS.channels;
              return (
                <label key={c.id} className={'lg-check' + (full ? ' dis' : '')}>
                  <input type="checkbox" checked={on} disabled={full} onChange={() => set({ channelIds: on ? picked.filter((x) => x !== c.id) : [...picked, c.id] })} />
                  <span>{c.name}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
      {(s.type === 'buttons' || s.type === 'links') && <ItemsForm s={s} chans={chans} patch={patch} />}
      {(s.type === 'live' || s.type === 'members') && <p className="lg-hint">Nothing to set here. It shows what is happening in your server right now.</p>}
    </div>
  );
}

function Chips({ options, value, onPick, label }) {
  return (
    <div className="lg-chips" role="radiogroup" aria-label={label}>
      {options.map(([id, text]) => <button key={id} type="button" role="radio" aria-checked={value === id} className={'lg-chip' + (value === id ? ' on' : '')} onClick={() => onPick(id)}>{text}</button>)}
    </div>
  );
}

function Editor({ server, draft, setDraft, dirty, changed, saved, saving, err, device, setDevice, onPreview, onCancel, onSave }) {
  const [tab, setTab] = useState(saved ? 'sections' : 'templates');
  const [openId, setOpenId] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null); // { i, before }
  const secs = draft.sections;
  const look = draft.look;

  const upd = (p) => setDraft((d) => ({ ...d, ...p }));
  const updLook = (p) => setDraft((d) => ({ ...d, look: { ...d.look, ...p } }));
  const mv = (from, to) => setDraft((d) => { const a = d.sections.slice(); const [x] = a.splice(from, 1); a.splice(to, 0, x); return { ...d, sections: a }; });
  const patch = (id, p) => setDraft((d) => ({ ...d, sections: d.sections.map((s) => (s.id === id ? { ...s, ...p } : s)) }));
  const remove = (id) => setDraft((d) => ({ ...d, sections: d.sections.filter((s) => s.id !== id) }));
  const add = (type) => { const s = newSection(type, server); setDraft((d) => ({ ...d, sections: [...d.sections, s] })); setOpenId(s.id); setAddOpen(false); };

  const used = new Set(secs.map((s) => s.type));
  const textCount = secs.filter((s) => s.type === 'text').length;
  const canAdd = (type) => secs.length < LIMITS.sections && (type === 'text' ? textCount < LIMITS.text : !used.has(type));
  const addable = Object.keys(SECTION_TYPES).filter(canAdd);

  const pickTemplate = async (id) => {
    if (id === draft.template) return;
    const t = TEMPLATES.find((x) => x.id === id);
    if (secs.length && !(await askConfirm({ title: 'Replace your current layout?', body: `${t.label} sets the look and the widgets again. Your tagline and the show/hide switch stay as they are.`, confirmLabel: 'Replace' }))) return;
    setDraft((d) => fromTemplate(id, server, { enabled: d.enabled, tagline: d.tagline }));
  };

  const endDrag = () => { setDragId(null); setOver(null); };
  const onDrop = (e) => {
    e.preventDefault();
    if (dragId && over) {
      const from = secs.findIndex((s) => s.id === dragId);
      let to = over.before ? over.i : over.i + 1;
      if (from < to) to -= 1; // the row itself leaves its old place first
      if (from >= 0 && to !== from) mv(from, to);
    }
    endDrag();
  };

  return (
    <aside className="lg-editor" aria-label="Customize lounge">
      <div className="lg-ed-head">
        <h3>Customize lounge</h3>
        <div className="lg-seg" role="group" aria-label="Preview size">
          <button type="button" className={device === 'desktop' ? 'on' : ''} aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')}>Desktop</button>
          <button type="button" className={device === 'phone' ? 'on' : ''} aria-pressed={device === 'phone'} onClick={() => setDevice('phone')}>Phone</button>
        </div>
        <button type="button" className="btn small-btn" onClick={onPreview}>Preview</button>
        <button type="button" className="icon-btn" title="Close" aria-label="Close" onClick={onCancel}><Icon name="close" size={18} /></button>
      </div>

      <div className="lg-toggle-row">
        <div><b>Show the lounge to members</b><small>{draft.enabled ? 'On. Everyone in the server can see it.' : 'Off. Only you and your managers can see it for now.'}</small></div>
        <button type="button" role="switch" aria-checked={draft.enabled} aria-label="Show the lounge to members" className={'lg-switch' + (draft.enabled ? ' on' : '')} onClick={() => upd({ enabled: !draft.enabled })}><i /></button>
      </div>

      <div className="lg-tabs" role="tablist">
        {[['templates', 'Templates'], ['look', 'Look'], ['sections', 'Sections']].map(([id, text]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{text}</button>
        ))}
      </div>

      <div className="lg-ed-body">
        {tab === 'templates' && (
          <div className="lg-tpl-grid">
            {TEMPLATES.map((t) => (
              <button key={t.id} type="button" className={'lg-tpl' + (draft.template === t.id ? ' on' : '')} onClick={() => pickTemplate(t.id)}>
                <span className="lg-tpl-pic">{t.rows.map((r, i) => <span key={i} className="lg-tpl-row" style={{ height: r.h }}>{Array.from({ length: r.n }, (_, j) => <i key={j} />)}</span>)}</span>
                <b>{t.label}</b><small>{t.blurb}</small>
              </button>
            ))}
          </div>
        )}

        {tab === 'look' && (
          <div className="lg-look">
            <div className="lg-group"><div className="lg-label">{LOOK_LABELS.title}</div><Chips label="Title" options={LOOK_OPTIONS.title} value={look.title} onPick={(v) => updLook({ title: v })} /></div>
            <div className="lg-group">
              <div className="lg-label">Accent</div>
              <div className="lg-swatches">
                <button type="button" className={'lg-swatch auto' + (look.accent === 'auto' ? ' on' : '')} onClick={() => updLook({ accent: 'auto' })} aria-label="Automatic accent" aria-pressed={look.accent === 'auto'}>Auto</button>
                {ACCENTS.map((c) => <button key={c} type="button" className={'lg-swatch' + (look.accent === c ? ' on' : '')} style={{ background: c }} onClick={() => updLook({ accent: c })} aria-label={'Accent ' + c} aria-pressed={look.accent === c} />)}
                <label className={'lg-swatch custom' + (look.accent !== 'auto' && !ACCENTS.includes(look.accent) ? ' on' : '')} title="Pick any colour">
                  <input type="color" value={look.accent !== 'auto' ? look.accent : '#e8743b'} onChange={(e) => updLook({ accent: e.target.value })} aria-label="Custom accent colour" />
                </label>
              </div>
            </div>
            {['background', 'cards', 'font', 'banner'].map((k) => (
              <div key={k} className="lg-group"><div className="lg-label">{LOOK_LABELS[k]}</div><Chips label={LOOK_LABELS[k]} options={LOOK_OPTIONS[k]} value={look[k]} onPick={(v) => updLook({ [k]: v })} /></div>
            ))}
          </div>
        )}

        {tab === 'sections' && (
          <div className="lg-sections-tab">
            <div className="lg-row lg-fixed">
              <div className="lg-row-main">
                <span className="lg-grip off" aria-hidden="true">{'\u22EE\u22EE'}</span>
                <span className="lg-row-ico"><Icon name="crown" size={16} /></span>
                <span className="lg-row-name"><b>Title</b><small>Logo, name and tagline. Always first.</small></span>
              </div>
              <label className="lg-field lg-row-form"><span>Tagline</span>
                <input className="lg-input" value={draft.tagline} maxLength={LIMITS.tagline} placeholder="A short line under the name" onChange={(e) => upd({ tagline: e.target.value })} />
              </label>
            </div>

            {secs.map((s, i) => {
              const meta = SECTION_TYPES[s.type];
              const isOpen = openId === s.id;
              const cls = 'lg-row' + (dragId === s.id ? ' dragging' : '') + (dragId && over?.i === i ? (over.before ? ' over-before' : ' over-after') : '') + (s.enabled === false ? ' is-off' : '');
              return (
                <div key={s.id} className={cls}
                  onDragOver={(e) => { if (!dragId) return; e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setOver({ i, before: e.clientY < r.top + r.height / 2 }); }}
                  onDrop={onDrop}>
                  <div className="lg-row-main">
                    <span className="lg-grip" draggable title="Drag to reorder" aria-hidden="true"
                      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); const row = e.currentTarget.closest('.lg-row'); if (row) e.dataTransfer.setDragImage(row, 16, 16); setDragId(s.id); }}
                      onDragEnd={endDrag}>{'\u22EE\u22EE'}</span>
                    <button type="button" className="lg-row-open" aria-expanded={isOpen} onClick={() => setOpenId(isOpen ? null : s.id)}>
                      <span className="lg-row-ico"><Icon name={meta.icon} size={16} /></span>
                      <span className="lg-row-name"><b>{s.heading || meta.label}</b><small>{meta.blurb}</small></span>
                    </button>
                    <span className="lg-row-tools">
                      <button type="button" className="icon-btn" title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => mv(i, i - 1)}>{'\u2191'}</button>
                      <button type="button" className="icon-btn" title="Move down" aria-label="Move down" disabled={i === secs.length - 1} onClick={() => mv(i, i + 1)}>{'\u2193'}</button>
                      <button type="button" role="switch" aria-checked={s.enabled !== false} aria-label={`Show ${meta.label}`} title={s.enabled === false ? 'Hidden' : 'Shown'} className={'lg-switch small' + (s.enabled !== false ? ' on' : '')} onClick={() => patch(s.id, { enabled: s.enabled === false })}><i /></button>
                      <button type="button" className="icon-btn" title="Remove" aria-label={`Remove ${meta.label}`} onClick={() => { remove(s.id); if (openId === s.id) setOpenId(null); }}><Icon name="trash" size={15} /></button>
                    </span>
                  </div>
                  {isOpen && <div className="lg-row-form"><SectionForm s={s} server={server} patch={patch} /></div>}
                </div>
              );
            })}

            {secs.length === 0 && <p className="lg-hint">No widgets yet. Add one below, or pick a template.</p>}

            <div className="lg-add">
              <button type="button" className="btn" disabled={!addable.length} aria-expanded={addOpen} onClick={() => setAddOpen((o) => !o)}><Icon name="plus" size={16} /> Add a widget</button>
              {!addable.length && <small className="lg-hint">{secs.length >= LIMITS.sections ? `Up to ${LIMITS.sections} widgets.` : 'Every widget is already on the page.'}</small>}
              {addOpen && (
                <div className="lg-add-list">
                  {addable.map((t) => (
                    <button key={t} type="button" onClick={() => add(t)}>
                      <span className="lg-row-ico"><Icon name={SECTION_TYPES[t].icon} size={16} /></span>
                      <span className="lg-row-name"><b>{SECTION_TYPES[t].label}</b><small>{SECTION_TYPES[t].blurb}</small></span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {err && <div className="error lg-err">{err}</div>}
      <div className="lg-ed-foot">
        <span className="lg-unsaved">{dirty ? (saved ? 'Unsaved changes' : 'Not saved yet') : ''}</span>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn primary" disabled={saving || !dirty} onClick={onSave}>{saving ? 'Saving\u2026' : 'Save'}</button>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- the tab
export default function LoungePage({ server, users, presence, voiceMembers, canManage, onBack, headerExtra, onChannel, onChange }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [device, setDevice] = useState('desktop');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const baseRef = useRef('');
  const saved = server.lounge;

  const startEdit = () => { const d = draftOf(server); baseRef.current = JSON.stringify(d); setDraft(d); setErr(''); setPreview(false); setEditing(true); };
  const stopEdit = () => { setEditing(false); setDraft(null); setPreview(false); setErr(''); };
  const changed = !!draft && JSON.stringify(draft) !== baseRef.current;
  const dirty = !!draft && (!saved || changed);

  const cancel = async () => {
    if (changed && !(await askConfirm({ title: 'Discard your changes?', body: 'Your edits to the lounge have not been saved.', confirmLabel: 'Discard', danger: true }))) return;
    stopEdit();
  };
  const put = async (body) => {
    const { server: sv } = await api(`/servers/${server.id}/lounge`, { method: 'PUT', body });
    onChange(sv);
  };
  const save = async () => {
    setSaving(true); setErr('');
    try { await put(forSave(draft)); toast('Lounge saved'); stopEdit(); }
    catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };
  const publish = async () => { // the "Show to members" button on the hidden notice: turns the saved page on without opening the editor
    try { await put({ ...forSave(draftOf(server)), enabled: true }); toast('The lounge is now visible to members'); }
    catch (e) { toast(e.message, 'error'); }
  };

  const page = editing && draft ? draft : saved ? draftOf(server) : null;
  const look = page?.look;
  const ctx = page && { server, users, presence, voiceMembers: voiceMembers || {}, onChannel, editing: editing && !preview, look };

  return (
    <section className="chat lounge-panel">
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title="Back" aria-label="Back to list" onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash"><Icon name={LOUNGE_ICON} size={20} /></span>
        <h3>Lounge</h3>
        <div className="spacer" />
        {canManage && !editing && saved && <button className="btn small-btn" onClick={startEdit}><Icon name="palette" size={16} className="inline-icon" /> Customize</button>}
        {headerExtra}
      </header>

      {canManage && saved && !saved.enabled && !editing && (
        <div className="lg-notice">
          <Icon name="lock" size={16} />
          <span>Only you and people who manage the server can see the lounge right now.</span>
          <button type="button" className="btn small-btn" onClick={publish}>Show to members</button>
        </div>
      )}

      <div className="lounge-stage">
        <div className="lounge-scroll">
          {page ? (
            <div className={'lounge-frame ' + (editing ? device : 'desktop')}>
              <LoungeBody draft={page} ctx={ctx} />
            </div>
          ) : (
            <div className="lg-setup">
              <Icon name={LOUNGE_ICON} size={36} />
              <h2>Set up your lounge</h2>
              <p>An info page for your server, right above the channels. Pick a template, choose a look, and arrange the widgets. Nobody else sees it until you turn it on.</p>
              {canManage && <button type="button" className="btn primary" onClick={startEdit}>Get started</button>}
            </div>
          )}
        </div>
        {editing && draft && !preview && (
          <Editor server={server} draft={draft} setDraft={setDraft} dirty={dirty} changed={changed} saved={!!saved} saving={saving} err={err}
            device={device} setDevice={setDevice} onPreview={() => setPreview(true)} onCancel={cancel} onSave={save} />
        )}
        {editing && preview && <button type="button" className="btn primary lg-exit-preview" onClick={() => setPreview(false)}>Back to editing</button>}
      </div>
    </section>
  );
}
