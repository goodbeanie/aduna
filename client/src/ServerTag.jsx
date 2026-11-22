import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ColorInput } from './Controls.jsx';
import { InviteBox } from './Invite.jsx';
import { api } from './api.js';

// Server tags: a short badge (up to 4 characters) a server designs and its members can choose to wear beside their name.
// The rules live on the server (server/servertag.js); this file draws the tag and holds the two screens that use it:
// Server settings > Server tag (the design) and Settings > Profile > Server tag (which one you wear).

export const TAG_MAX = 4;
const DEFAULT_BG = '#5865f2';
const DEFAULT_FRAME = '#ffffff';
const QUICK = ['#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#f0883e', '#2b2d31', '#ffffff'];

// Black or white, whichever reads better on the colour (same rule as the server, so a live preview matches what is saved).
export function textOn(bg) {
  if (!/^#[0-9a-f]{6}$/i.test(bg)) return '#ffffff';
  const c = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.35 ? '#111111' : '#ffffff';
}

// tag: { text, bg, frame, fg, name? }. Draws nothing when there is no tag.
// With `card` set, clicking the tag opens a small invite card for its server under it (the tag has to carry a serverId).
export function ServerTagChip({ tag, className = '', card = false }) {
  const [anchor, setAnchor] = useState(null);
  const chipRef = useRef(null);
  const close = useCallback(() => setAnchor(null), []);
  if (!tag || !tag.text) return null;
  const clickable = card && !!tag.serverId;
  const toggle = (e) => {
    e.stopPropagation();
    if (anchor) return setAnchor(null);
    const r = chipRef.current.getBoundingClientRect();
    setAnchor({ left: r.left, top: r.top, bottom: r.bottom });
  };
  return (
    <>
      <span ref={chipRef} className={'stag ' + className + (clickable ? ' clickable' : '')} style={{ background: tag.bg, color: tag.fg || textOn(tag.bg), borderColor: tag.frame || 'transparent' }}
        title={tag.name ? `${tag.name} server tag` : 'Server tag'}
        {...(clickable ? { role: 'button', tabIndex: 0, onClick: toggle, onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } } } : {})}>{tag.text}</span>
      {anchor && createPortal(<TagCard serverId={tag.serverId} anchor={anchor} chipEl={chipRef.current} onClose={close} />, document.body)}
    </>
  );
}

const cardCache = new Map(); // serverId -> { at, info }; info is null when the server can't be shown
const CARD_TTL = 60_000;
const CLOSE_DELAY = 140;

// The small invite card under a tag. It closes when the pointer has left both the tag and the card, when you tap or press
// outside, on Escape, and when the page scrolls or resizes.
function TagCard({ serverId, anchor, chipEl, onClose }) {
  const [info, setInfo] = useState(() => { const c = cardCache.get(serverId); return c && Date.now() - c.at < CARD_TTL ? c.info : undefined; });
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 6 });
  const box = useRef(null);

  useEffect(() => {
    if (info !== undefined) return undefined;
    let live = true;
    api(`/servers/${encodeURIComponent(serverId)}/tag-card`)
      .then((r) => { cardCache.set(serverId, { at: Date.now(), info: r.invite }); if (live) setInfo(r.invite); })
      .catch(() => { cardCache.set(serverId, { at: Date.now(), info: null }); if (live) setInfo(null); });
    return () => { live = false; };
  }, [serverId, info]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - w - 8));
    let top = anchor.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - h - 6);
    setPos({ left, top });
  }, [info, anchor]);

  useEffect(() => {
    let timer = 0;
    const inside = (t) => !!t && (box.current?.contains(t) || chipEl?.contains(t));
    const move = (e) => {
      if (inside(e.target)) { clearTimeout(timer); timer = 0; } else if (!timer) timer = setTimeout(onClose, CLOSE_DELAY);
    };
    const down = (e) => { if (!inside(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [chipEl, onClose]);

  let body;
  if (info === undefined) body = <div className="invite-card mini loading" aria-busy="true"><div className="ic-banner" /><div className="ic-body"><div className="ic-meta">Loading…</div></div></div>;
  else if (info === null) body = <div className="invite-card mini dead"><div className="ic-body"><div className="ic-name">Server not available</div><div className="ic-meta">It may be private or gone.</div></div></div>;
  else body = <InviteBox info={info} compact />;

  const stop = (e) => e.stopPropagation(); // the card sits in a portal, but React events still travel up to the message or member row
  return <div ref={box} className="tag-card" style={{ left: pos.left, top: pos.top }} onClick={stop} onDoubleClick={stop} onContextMenu={stop}>{body}</div>;
}

// Server settings > Server tag. Applies with its own button (like Channels and Roles) rather than the Overview "Save changes".
export function ServerTagTab({ server, onChange }) {
  const saved = server.serverTag;
  const [text, setText] = useState(saved ? saved.text : '');
  const [bg, setBg] = useState(saved ? saved.bg : DEFAULT_BG);
  const [frameOn, setFrameOn] = useState(!!(saved && saved.frame));
  const [frame, setFrame] = useState(saved && saved.frame ? saved.frame : DEFAULT_FRAME);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  const clean = text.trim();
  const draft = clean ? { text: clean, bg, frame: frameOn ? frame : null, fg: textOn(bg), name: server.name } : null;
  const dirty = saved
    ? !draft || draft.text !== saved.text || draft.bg !== saved.bg || (draft.frame || null) !== (saved.frame || null)
    : !!draft;

  async function run(fn) {
    setErr(''); setDone(''); setBusy(true);
    try { const { server: sv } = await fn(); onChange(sv); return true; }
    catch (e) { setErr(e.message); return false; }
    finally { setBusy(false); }
  }
  const save = async () => {
    if (!draft) return setErr('Type up to 4 letters or numbers for the tag');
    if (await run(() => api(`/servers/${server.id}/tag`, { method: 'PUT', body: { text: draft.text, bg: draft.bg, frame: draft.frame } }))) setDone('Saved. Members who wear this tag see the change right away.');
  };
  const remove = async () => {
    if (await run(() => api(`/servers/${server.id}/tag`, { method: 'DELETE' }))) { setText(''); setFrameOn(false); setDone('The tag was removed. People who wore it no longer show one.'); }
  };

  if (server.visibility !== 'public') {
    return (
      <>
        <h1>Server tag</h1>
        <p className="muted">Server tags are only for public servers. The owner can make {server.name} public in Server settings, under Publish, and then design a tag here.</p>
        {saved && <p className="muted small hint">The tag you made is kept, but nobody wears it while the server is not public.</p>}
        {err && <div className="error">{err}</div>}
        {saved && <div className="settings-foot"><button className="btn" disabled={busy} onClick={remove}>Remove tag</button></div>}
      </>
    );
  }

  return (
    <>
      <h1>Server tag</h1>
      <p className="muted">Give {server.name} a tag of up to {TAG_MAX} characters. Members choose whether to wear it, and it shows beside their name in chat, the member list and their profile.</p>

      <div className="stag-preview" aria-label="Tag preview">
        <span className="stag-sample-name">YourName</span>
        {draft ? <ServerTagChip tag={draft} /> : <span className="muted small">Type a tag to see it here</span>}
      </div>

      <label htmlFor="stag-text">TAG (UP TO {TAG_MAX} LETTERS OR NUMBERS)</label>
      <input id="stag-text" className="stag-input" value={text} maxLength={TAG_MAX} spellCheck={false} autoCapitalize="characters" autoCorrect="off" autoComplete="off" placeholder="ADUN"
        onChange={(e) => { setDone(''); setText(e.target.value.replace(/[^\p{L}\p{N}]/gu, '').slice(0, TAG_MAX)); }} />

      <label>TAG BACKGROUND COLOUR</label>
      <div className="stag-colors">
        {QUICK.map((c) => <button type="button" key={c} className={'swatch' + (c === bg ? ' on' : '')} style={{ background: c }} aria-label={`Background ${c}`} onClick={() => { setBg(c); setDone(''); }} />)}
        <ColorInput value={bg} onChange={(e) => { setBg(e.target.value); setDone(''); }} aria-label="Tag background colour" />
        <code>{bg}</code>
      </div>

      <label>FRAME</label>
      <div className="mode-pick" role="radiogroup" aria-label="Tag frame">
        <button type="button" role="radio" aria-checked={!frameOn} className={!frameOn ? 'on' : ''} onClick={() => { setFrameOn(false); setDone(''); }}>No frame</button>
        <button type="button" role="radio" aria-checked={frameOn} className={frameOn ? 'on' : ''} onClick={() => { setFrameOn(true); setDone(''); }}>Add a frame</button>
      </div>
      {frameOn && (
        <div className="stag-colors">
          {QUICK.map((c) => <button type="button" key={c} className={'swatch' + (c === frame ? ' on' : '')} style={{ background: c }} aria-label={`Frame ${c}`} onClick={() => { setFrame(c); setDone(''); }} />)}
          <ColorInput value={frame} onChange={(e) => { setFrame(e.target.value); setDone(''); }} aria-label="Tag frame colour" />
          <code>{frame}</code>
        </div>
      )}
      <p className="muted small hint">The text turns black or white on its own so it stays readable on any background.</p>

      {err && <div className="error">{err}</div>}
      {done && <div className="notice" role="status">{done}</div>}
      <div className="settings-foot">
        {saved && <button className="btn" disabled={busy} onClick={remove}>Remove tag</button>}{' '}
        <button className="btn primary" disabled={busy || !dirty || !draft} onClick={save}>{busy ? 'Saving…' : saved ? 'Update tag' : 'Create tag'}</button>
      </div>
    </>
  );
}

// Settings > Profile > Server tag: pick which one tag you wear. choices = me.tagChoices; value = a server id or ''.
export function ServerTagPicker({ choices, value, onChange }) {
  if (!choices.length) return <p className="muted small hint">None of your servers have a tag yet. When a public server you are in creates one, you can wear it here.</p>;
  return (
    <div className="stag-picker" role="radiogroup" aria-label="Server tag">
      <button type="button" role="radio" aria-checked={!value} className={'stag-opt' + (!value ? ' on' : '')} onClick={() => onChange('')}>
        <span className="stag-opt-name">No server tag</span>
      </button>
      {choices.map((c) => (
        <button type="button" role="radio" aria-checked={value === c.serverId} key={c.serverId} className={'stag-opt' + (value === c.serverId ? ' on' : '')} onClick={() => onChange(c.serverId)}>
          <ServerTagChip tag={c} /><span className="stag-opt-name">{c.name}</span>
        </button>
      ))}
    </div>
  );
}
