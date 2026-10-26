import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { BadgeArt } from './Shop.jsx';
import { askConfirm } from './Dialogs.jsx';
import { ACCEPT_ATTR, imageUrl, processBadge, processPiece, uploadImage } from './image.js';

// Settings > Artist. Anyone can apply to sell their own badges in the credits shop: send exactly 4 pieces of your art and an optional note.
// Moderators (creator accounts and the usernames in ADMIN_USERNAMES) review the applications and every item here too. Once approved, an artist
// makes shop items (a picture, a name, a description and a price), which also go through review, and earns a share of each sale.
// The rules live in server/artists.js; this file is only what it draws.
const BADGE_PX = { w: 128, h: 128 };
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const STATUS = { draft: 'Draft', pending: 'In review', approved: 'In the shop', rejected: 'Needs changes' };

export function ArtistSettings() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api('/artists/me').then((x) => { setD(x); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (!d) return <p className="muted">{err || 'Loading…'}</p>;
  const app = d.application;
  return (
    <div className="badge-admin artist-admin">
      {err && <div className="error-text">{err}</div>}
      {d.reviewer && <ReviewQueue waiting={d.waiting} onError={setErr} />}

      {app.status === 'approved' && <Items d={d} onChange={(items) => setD({ ...d, items })} onError={setErr} />}
      {app.status === 'pending' && (
        <div className="badge-card">
          <b>Your application is with the reviewers</b>
          <p className="muted small">You sent it{app.appliedAt ? ' on ' + day(app.appliedAt) : ''}. You will be able to make shop items as soon as it is approved.</p>
          <PieceStrip ids={app.pieces} />
          {app.note && <p className="muted small">Your note: {app.note}</p>}
          <div className="row"><button className="btn" onClick={load}>Check again</button></div>
        </div>
      )}
      {(app.status === 'none' || app.status === 'draft' || app.status === 'rejected') && (
        <Apply d={d} onApp={(application) => setD({ ...d, application })} onError={setErr} />
      )}
    </div>
  );
}

// the pieces of an application, small, each opening full size in a new tab
function PieceStrip({ ids }) {
  return (
    <div className="artist-strip">
      {(ids || []).filter(Boolean).map((id) => <a key={id} href={imageUrl(id)} target="_blank" rel="noopener noreferrer"><img src={imageUrl(id)} alt="A piece of art" /></a>)}
    </div>
  );
}

// ---------- applying ----------
function Apply({ d, onApp, onError }) {
  const app = d.application, L = d.limits;
  const [note, setNote] = useState(app.note || '');
  const [busy, setBusy] = useState(false);
  const files = useRef([]);
  // after a rejection the person starts a fresh application (the server drops the old pieces when the first new one arrives), so the slots show empty
  const slots = Array.from({ length: L.pieces }, (_, i) => (app.status === 'rejected' ? null : (app.pieces || [])[i]) || null);
  const run = async (fn) => { onError(''); setBusy(true); try { await fn(); } catch (e) { onError(e.message); } finally { setBusy(false); } };

  const pick = (i, file) => run(async () => {
    const blob = await processPiece(file, L.maxSide);
    onApp((await uploadImage(String(i), blob, '/api/artists/pieces')).application);
  });
  const remove = (i) => run(async () => onApp((await api('/artists/pieces/' + i, { method: 'DELETE' })).application));
  const send = () => run(async () => onApp((await api('/artists/apply', { method: 'POST', body: { note } })).application));

  const waiting = app.status === 'rejected' && app.retryAt;
  return (
    <div className="badge-card">
      <b>Sell your art in the shop</b>
      <p className="muted small">Artists make badges that people can buy with credits, and earn <b>{L.cutPercent}%</b> of every sale. To apply, send exactly {L.pieces} pieces of your own art. A moderator will have a look.</p>
      {app.status === 'rejected' && (
        <div className="artist-note">
          <b>Your last application was not approved.</b>
          {app.reviewNote && <p>{app.reviewNote}</p>}
          {waiting ? <p className="muted small">You can apply again on {day(app.retryAt)}.</p> : <p className="muted small">You can apply again now. Adding a piece starts a new application.</p>}
        </div>
      )}
      {!waiting && (
        <>
          <div className="artist-pieces">
            {slots.map((id, i) => (
              <div key={i} className={'artist-piece' + (id ? ' has' : '')}>
                {id ? <img src={imageUrl(id)} alt={'Piece ' + (i + 1)} /> : <span className="muted small">Piece {i + 1}</span>}
                <input ref={(el) => { files.current[i] = el; }} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pick(i, f); }} />
                <div className="row">
                  <button className="btn" disabled={busy} onClick={() => files.current[i]?.click()}>{id ? 'Replace' : 'Add'}</button>
                  {id && <button className="btn" disabled={busy} onClick={() => remove(i)}>Remove</button>}
                </div>
              </div>
            ))}
          </div>
          <textarea className="artist-text" rows={3} maxLength={L.note} placeholder="Anything you want the reviewers to know (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row">
            <button className="btn primary" disabled={busy || slots.some((s) => !s)} onClick={send}>Send application</button>
            <span className="muted small">{slots.filter(Boolean).length} of {L.pieces} pieces added</span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- an approved artist's items ----------
function Items({ d, onChange, onError }) {
  const L = d.limits;
  const [draft, setDraft] = useState({ name: '', desc: '', price: '' });
  const [busy, setBusy] = useState(false);
  const replace = (item) => onChange(d.items.map((x) => (x.id === item.id ? item : x)));

  async function create(e) {
    e.preventDefault(); onError(''); setBusy(true);
    try {
      const r = await api('/artists/items', { method: 'POST', body: { name: draft.name, desc: draft.desc, price: Number(draft.price) } });
      onChange([...d.items, r.item]); setDraft({ name: '', desc: '', price: '' });
    } catch (x) { onError(x.message); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="badge-card">
        <b>You are an artist</b>
        <p className="muted small">Make badges for the shop. Add a picture, a name and a price, then send it for review. You earn {L.cutPercent}% of each sale, rounded down. Once an item is approved its picture, name and description are locked (people may already be wearing it); you can still change its price or take it off sale. Your first approved item earns you the Artist badge.</p>
      </div>
      {d.items.length < L.items && (
        <form className="badge-card" onSubmit={create}>
          <b>New item</b>
          <div className="row">
            <input placeholder="Name" maxLength={L.name} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <input placeholder="Description (optional)" maxLength={L.desc} style={{ flex: 1, minWidth: 160 }} value={draft.desc} onChange={(e) => setDraft({ ...draft, desc: e.target.value })} />
            <input type="number" min={L.minPrice} step="1" placeholder={'Price (min ' + L.minPrice + ')'} style={{ width: 140 }} value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
            <button className="btn primary" disabled={busy || !draft.name.trim() || !draft.price}>Create</button>
          </div>
        </form>
      )}
      {d.items.length === 0 && <p className="muted">No items yet.</p>}
      {d.items.map((it) => <ItemCard key={it.id} item={it} limits={L} onChange={replace} onDeleted={() => onChange(d.items.filter((x) => x.id !== it.id))} onError={onError} />)}
    </>
  );
}

function ItemCard({ item, limits, onChange, onDeleted, onError }) {
  const fresh = { name: item.name, desc: item.desc, price: item.price ?? '' };
  const [f, setF] = useState(fresh);
  useEffect(() => { setF({ name: item.name, desc: item.desc, price: item.price ?? '' }); }, [item.name, item.desc, item.price]); // eslint-disable-line react-hooks/exhaustive-deps
  const file = useRef(null);
  const locked = item.status === 'approved';
  const dirty = f.name !== item.name || f.desc !== item.desc || String(f.price) !== String(item.price ?? '');
  const run = async (fn) => { onError(''); try { await fn(); } catch (e) { onError(e.message); } };
  const label = item.status === 'approved' && !item.price ? 'Off sale' : STATUS[item.status] || item.status;

  const save = () => run(async () => {
    const body = locked ? { price: f.price === '' ? null : Number(f.price) } : { name: f.name, desc: f.desc, price: Number(f.price) };
    onChange((await api('/artists/items/' + item.id, { method: 'PATCH', body })).item);
  });

  return (
    <div className="badge-card">
      <div className="badge-head">
        <BadgeArt item={{ ...item, color: '#8c6b4f' }} size={48} />
        <input value={f.name} maxLength={limits.name} disabled={locked} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Item name" />
        <input value={f.desc} maxLength={limits.desc} disabled={locked} placeholder="Description" style={{ flex: 1, minWidth: 140 }} onChange={(e) => setF({ ...f, desc: e.target.value })} aria-label="Description" />
        <input type="number" min={limits.minPrice} step="1" value={f.price} placeholder={locked ? 'Off sale' : 'Price'} style={{ width: 110 }} onChange={(e) => setF({ ...f, price: e.target.value })} aria-label="Price in credits" />
        {dirty && <button className="btn primary" onClick={save}>Save</button>}
      </div>
      <div className="row">
        <span className={'artist-chip ' + item.status}>{label}</span>
        {item.status === 'approved' && <span className="muted small">{item.sold} {item.sold === 1 ? 'person owns' : 'people own'} this</span>}
        {item.status === 'approved' && item.price && <button className="btn" onClick={() => run(async () => onChange((await api('/artists/items/' + item.id, { method: 'PATCH', body: { price: null } })).item))}>Take off sale</button>}
      </div>
      {item.status === 'rejected' && item.reviewNote && <div className="artist-note"><b>Not approved:</b> {item.reviewNote}</div>}
      {!locked && (
        <div className="row">
          <input ref={file} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => {
            const picked = e.target.files?.[0]; e.target.value = '';
            if (picked) run(async () => { const blob = await processBadge(picked, BADGE_PX); onChange((await uploadImage('image', blob, '/api/artists/items/' + item.id)).item); });
          }} />
          <button className="btn" onClick={() => file.current?.click()}>{item.image ? 'Change picture' : 'Add picture'}</button>
          {(item.status === 'draft') && <button className="btn primary" disabled={!item.image || dirty} title={!item.image ? 'Add a picture first' : dirty ? 'Save your changes first' : 'Send to the reviewers'} onClick={() => run(async () => onChange((await api('/artists/items/' + item.id + '/submit', { method: 'POST' })).item))}>Send for review</button>}
          {item.status === 'pending' && <span className="muted small">Waiting for a reviewer. Changing anything takes it back to a draft.</span>}
        </div>
      )}
      {item.sold === 0 && (
        <div className="row">
          <button className="btn danger" onClick={async () => { if (await askConfirm({ title: 'Delete item', body: 'Delete "' + item.name + '"?', confirmLabel: 'Delete', danger: true })) run(async () => { await api('/artists/items/' + item.id, { method: 'DELETE' }); onDeleted(); }); }}>Delete</button>
        </div>
      )}
    </div>
  );
}

// ---------- moderators ----------
function ReviewQueue({ waiting, onError }) {
  const [q, setQ] = useState(null);
  const load = () => api('/artists/review').then(setQ).catch((e) => onError(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!q) return null;
  const decide = async (url, action, note, drop) => {
    onError('');
    try { await api(url, { method: 'POST', body: { action, note } }); setQ(drop(q)); } catch (e) { onError(e.message); }
  };
  const empty = q.applications.length === 0 && q.items.length === 0;
  return (
    <div className="badge-card">
      <b>Review{waiting && waiting.applications + waiting.items > 0 ? ` (${waiting.applications + waiting.items} waiting)` : ''}</b>
      {empty && <p className="muted small">Nothing is waiting for review.</p>}
      {q.applications.map((a) => (
        <div key={'a' + a.userId} className="artist-review">
          <div><b>{a.displayName || a.username}</b> <span className="muted small">@{a.username} wants to sell art{a.appliedAt ? ' · ' + day(a.appliedAt) : ''}</span></div>
          <PieceStrip ids={a.pieces} />
          {a.note && <p className="muted small">Note: {a.note}</p>}
          <Decision own={a.own} onDecide={(action, note) => decide('/artists/review/applications/' + a.userId, action, note, (s) => ({ ...s, applications: s.applications.filter((x) => x.userId !== a.userId) }))} />
        </div>
      ))}
      {q.items.map((it) => (
        <div key={'i' + it.id} className="artist-review">
          <div className="row">
            <BadgeArt item={{ ...it, color: '#8c6b4f' }} size={72} />
            <div><b>{it.name}</b> <span className="muted small">{it.price} credits · by @{it.artist.username}</span>{it.desc && <div className="muted small">{it.desc}</div>}</div>
          </div>
          <Decision own={it.own} onDecide={(action, note) => decide('/artists/review/items/' + it.id, action, note, (s) => ({ ...s, items: s.items.filter((x) => x.id !== it.id) }))} />
        </div>
      ))}
    </div>
  );
}

// Approve, or reject with a note (the note is what the person sees, so a rejection needs one)
function Decision({ own, onDecide }) {
  const [note, setNote] = useState('');
  if (own) return <p className="muted small">This one is yours, so someone else has to review it.</p>;
  return (
    <div className="row">
      <input placeholder="Note (needed to reject)" maxLength={200} style={{ flex: 1, minWidth: 160 }} value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn primary" onClick={() => onDecide('approve', note)}>Approve</button>
      <button className="btn danger" disabled={!note.trim()} onClick={() => onDecide('reject', note)}>Reject</button>
    </div>
  );
}
