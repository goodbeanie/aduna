import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { BadgeIcons } from './ui.jsx';
import { ACCEPT_ATTR, processBadge, uploadImage } from './image.js';

// Settings > Badges (creator accounts only): make badges, give them to people by username, take them back, delete them.
const BADGE_PX = { w: 128, h: 128 };
const asUser = (b) => ({ badges: [{ id: b.id, name: b.name || '?', image: b.image, emoji: b.emoji, color: b.color }] });

export function BadgeSettings() {
  const [badges, setBadges] = useState(null);
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState({ name: '', emoji: '', color: '#8c6b4f' });
  const [busy, setBusy] = useState(false);

  const load = () => api('/badges').then((d) => setBadges(d.badges)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const replace = (b) => setBadges((l) => l.map((x) => (x.id === b.id ? b : x)));

  async function create(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try { const d = await api('/badges', { method: 'POST', body: draft }); setBadges((l) => [...l, d.badge]); setDraft({ name: '', emoji: '', color: draft.color }); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  }

  if (!badges) return <p className="muted">{err || 'Loading…'}</p>;
  return (
    <div className="badge-admin">
      <p className="muted">The <b>Creator</b> badge is added to your account automatically. Make your own badges here, then give them to people by username. A badge is a picture, or an emoji on a colour.</p>
      {err && <div className="error-text">{err}</div>}
      <form className="badge-card" onSubmit={create}>
        <b>New badge</b>
        <div className="row">
          <input placeholder="Name" maxLength={24} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input placeholder="Emoji (optional)" maxLength={8} style={{ width: 130 }} value={draft.emoji} onChange={(e) => setDraft({ ...draft, emoji: e.target.value })} />
          <input type="color" aria-label="Colour" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
          <BadgeIcons user={asUser({ id: 'new', ...draft })} size={28} />
          <button className="btn primary" disabled={busy || !draft.name.trim()}>Create</button>
        </div>
      </form>
      {badges.length === 0 && <p className="muted">No badges yet.</p>}
      {badges.map((b) => <BadgeCard key={b.id} badge={b} onChange={replace} onDeleted={() => setBadges((l) => l.filter((x) => x.id !== b.id))} onError={setErr} />)}
    </div>
  );
}

function BadgeCard({ badge, onChange, onDeleted, onError }) {
  const [f, setF] = useState({ name: badge.name, emoji: badge.emoji, color: badge.color });
  const [who, setWho] = useState('');
  const file = useRef(null);
  const dirty = f.name !== badge.name || f.emoji !== badge.emoji || f.color !== badge.color;
  const run = async (fn) => { onError(''); try { await fn(); } catch (e) { onError(e.message); } };

  return (
    <div className="badge-card">
      <div className="badge-head">
        <BadgeIcons user={asUser({ ...badge, ...f })} size={32} />
        <input value={f.name} maxLength={24} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Badge name" />
        <input value={f.emoji} maxLength={8} style={{ width: 90 }} placeholder="Emoji" onChange={(e) => setF({ ...f, emoji: e.target.value })} aria-label="Emoji" />
        <input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} aria-label="Colour" />
        {dirty && <button className="btn primary" onClick={() => run(async () => onChange((await api('/badges/' + badge.id, { method: 'PATCH', body: f })).badge))}>Save</button>}
      </div>
      <div className="row">
        <input ref={file} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => {
          const picked = e.target.files?.[0]; e.target.value = '';
          if (picked) run(async () => { const blob = await processBadge(picked, BADGE_PX); onChange((await uploadImage('image', blob, '/api/badges/' + badge.id)).badge); });
        }} />
        <button className="btn" onClick={() => file.current?.click()}>{badge.image ? 'Change picture' : 'Add picture'}</button>
        {badge.image && <button className="btn" onClick={() => run(async () => onChange((await api('/badges/' + badge.id + '/image', { method: 'DELETE' })).badge))}>Remove picture</button>}
        <button className="btn danger" onClick={() => { if (window.confirm('Delete the "' + badge.name + '" badge? It disappears from everyone who has it.')) run(async () => { await api('/badges/' + badge.id, { method: 'DELETE' }); onDeleted(); }); }}>Delete</button>
      </div>
      <div className="holders">
        {badge.holders.length === 0 && <span className="muted small">Nobody has this badge yet.</span>}
        {badge.holders.map((h) => (
          <span key={h.id} className="holder">@{h.username}
            <button title="Take the badge back" aria-label={'Take the badge back from ' + h.username} onClick={() => run(async () => onChange((await api('/badges/' + badge.id + '/give/' + encodeURIComponent(h.username), { method: 'DELETE' })).badge))}>×</button>
          </span>
        ))}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (!who.trim()) return; run(async () => { onChange((await api('/badges/' + badge.id + '/give', { method: 'POST', body: { username: who } })).badge); setWho(''); }); }}>
        <input placeholder="Give to username" value={who} onChange={(e) => setWho(e.target.value)} />
        <button className="btn primary" disabled={!who.trim()}>Give</button>
      </form>
    </div>
  );
}
