import React, { useState } from 'react';
import { ColorInput } from './Controls.jsx';
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
export function ServerTagChip({ tag, className = '' }) {
  if (!tag || !tag.text) return null;
  return (
    <span className={'stag ' + className} style={{ background: tag.bg, color: tag.fg || textOn(tag.bg), borderColor: tag.frame || 'transparent' }}
      title={tag.name ? `${tag.name} server tag` : 'Server tag'}>{tag.text}</span>
  );
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
  if (!choices.length) return <p className="muted small hint">None of your servers have a tag yet. When a server you are in creates one, you can wear it here.</p>;
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
