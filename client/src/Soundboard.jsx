import React, { useRef, useState } from 'react';
import { api } from './api.js';
import { Icon } from './ui.jsx';
import { askConfirm } from './Dialogs.jsx';
import { can, isOwner as ownerOrCo } from './perms.js';
import { checkSoundFile, inspectSoundFile, soundNameOf, uploadSound } from './image.js';
import { SOUND, settingsOf, soundUrl, whyNotPlay, playClip } from './soundboard.js';
import { SoundTrim } from './SoundTrim.jsx';
import { canTrim } from './soundtrim.js';

// The buttons under a voice channel's tiles. Pressing one asks the server to play it for everyone in the channel (the server checks that you are in
// the channel, that the soundboard is on and that you may use it); every browser then plays the clip when the server announces it (Voice.jsx).
// Nothing at all is shown while the owner has the soundboard turned off.
export function SoundBar({ server, me, play }) {
  const [err, setErr] = useState('');
  const cfg = settingsOf(server);
  if (!cfg.enabled) return null;
  const sounds = server.sounds || [];
  const why = whyNotPlay(server, me.id);
  const canAdd = can(server, me.id, 'manageServer');
  if (!sounds.length && !canAdd) return null;

  // No resting between presses: every click plays (the server only turns away a flood, and says so here).
  function go(s) {
    play(s.id).then(() => setErr(''), (e) => setErr(e.message));
  }

  return (
    <div className="sb-bar">
      <div className="sb-head muted"><Icon name="music" size={16} /> Soundboard</div>
      {why ? <p className="muted small sb-note">{why}.</p>
        : !sounds.length ? <p className="muted small sb-note">No sounds yet. Add some in Server settings, under Soundboard.</p>
          : (
            <div className="sb-grid">
              {sounds.map((s) => (
                <button key={s.id} type="button" className="sb-btn" title={s.name} onClick={() => go(s)}>
                  <span className="sb-emoji" aria-hidden="true">{s.emoji || <Icon name="play" size={14} />}</span>
                  <span className="sb-name">{s.name}</span>
                </button>
              ))}
            </div>
          )}
      {err && <div className="error sb-err" role="alert">{err}</div>}
    </div>
  );
}

// Server settings > Soundboard. People with Manage server add and remove sounds; only the owner turns the soundboard on or off and chooses who may play.
// Like the Channels tab, everything here applies at once (there is no Save button).
export function SoundboardTab({ server, me, onChange }) {
  const isOwner = ownerOrCo(server, me.id); // the owner or a co-owner
  const cfg = settingsOf(server);
  const sounds = server.sounds || [];
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState(null);
  const [trimming, setTrimming] = useState(null); // a chosen file that is too long or heavy, while the person picks the part to use
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const input = useRef(null);
  const base = `/servers/${server.id}`;

  const run = async (fn) => {
    setErr(''); setBusy(true);
    try { const { server: sv } = await fn(); onChange(sv); return true; }
    catch (e) { setErr(e.message); return false; }
    finally { setBusy(false); }
  };
  const patch = (body) => run(() => api(`${base}/soundboard`, { method: 'PATCH', body }));
  const toggleRole = (id) => patch({ roles: cfg.roles.includes(id) ? cfg.roles.filter((x) => x !== id) : [...cfg.roles, id] });

  async function pick(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setErr(''); setTrimming(null);
    try {
      const { trim } = await inspectSoundFile(f);
      if (!trim) { await checkSoundFile(f); setFile(f); setName((n) => n || soundNameOf(f)); return; }
      if (!canTrim()) { await checkSoundFile(f); return; } // this browser cannot cut audio: say why the file does not fit
      setFile(null); setTrimming(f); // longer or heavier than a sound can be: the person picks the part to use
    }
    catch (ex) { setFile(null); setErr(ex.message); }
  }
  const trimmed = (cut) => { setName((n) => n || soundNameOf(trimming)); setFile(cut); setTrimming(null); }
  async function add(e) {
    e.preventDefault();
    if (!file || !name.trim()) return;
    if (await run(() => uploadSound(server.id, file, name.trim(), emoji.trim()))) { setFile(null); setName(''); setEmoji(''); }
  }
  async function remove(s) {
    const yes = await askConfirm({ title: `Delete "${s.name}"?`, body: 'It disappears from the soundboard for everyone.', confirmLabel: 'Delete', cancelLabel: 'Cancel', danger: true });
    if (yes) run(() => api(`${base}/sounds/${s.id}`, { method: 'DELETE' }));
  }
  const preview = (s) => playClip(soundUrl(server.id, s.id)); // only you hear this

  return (
    <>
      <h1>Soundboard</h1>
      <p className="muted">Short sounds, up to {SOUND.secs} seconds, that people can play in voice chat. Everyone in the voice channel hears them (unless they are deafened).</p>

      <label>WHO CAN USE IT</label>
      {isOwner ? (
        <>
          <label className="sb-check"><input type="checkbox" checked={cfg.enabled} disabled={busy} onChange={(e) => patch({ enabled: e.target.checked })} /> Soundboard is on</label>
          <div className="mode-pick" role="radiogroup" aria-label="Who can play sounds">
            <button type="button" role="radio" aria-checked={cfg.who === 'everyone'} className={cfg.who === 'everyone' ? 'on' : ''} disabled={busy || !cfg.enabled} onClick={() => patch({ who: 'everyone' })}>Everyone</button>
            <button type="button" role="radio" aria-checked={cfg.who === 'roles'} className={cfg.who === 'roles' ? 'on' : ''} disabled={busy || !cfg.enabled} onClick={() => patch({ who: 'roles' })}>Only some roles</button>
          </div>
          {cfg.enabled && cfg.who === 'roles' && (
            <div className="sb-roles">
              {(server.roles || []).length === 0 && <p className="muted small">This server has no roles yet. Make some in the Roles tab.</p>}
              {(server.roles || []).map((r) => (
                <label key={r.id} className="sb-check"><input type="checkbox" checked={cfg.roles.includes(r.id)} disabled={busy} onChange={() => toggleRole(r.id)} /> <span style={r.color ? { color: r.color } : undefined}>{r.name}</span></label>
              ))}
              <p className="muted small hint">The owner and administrators can always play sounds while the soundboard is on.</p>
            </div>
          )}
          {!cfg.enabled && <p className="muted small hint">While it is off, nobody can play a sound, you included. The sounds below are kept.</p>}
        </>
      ) : (
        <p className="muted">{!cfg.enabled ? 'The owner has turned the soundboard off.' : cfg.who === 'everyone' ? 'Everyone in the server can play sounds.' : 'Only some roles can play sounds.'} Only the server owner can change this.</p>
      )}

      <label>SOUNDS ({sounds.length}/{SOUND.sounds})</label>
      <input ref={input} type="file" accept="audio/*,.mp3,.m4a,.ogg,.oga,.wav,.webm" hidden onChange={pick} />
      <form className="sb-add" onSubmit={add}>
        <button type="button" className="btn" disabled={busy || sounds.length >= SOUND.sounds} onClick={() => input.current.click()}>{file || trimming ? 'Change file' : 'Choose audio file'}</button>
        {file && (
          <>
            <input className="sb-emoji-in" value={emoji} maxLength={SOUND.emoji} placeholder="🔊" aria-label="Icon (an emoji, optional)" onChange={(e) => setEmoji(e.target.value)} />
            <input className="sb-name-in" value={name} maxLength={SOUND.name} placeholder="Name" aria-label="Sound name" onChange={(e) => setName(e.target.value)} />
            <button className="btn primary" disabled={busy || !name.trim()}>{busy ? 'Adding…' : 'Add sound'}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => { setFile(null); setName(''); setEmoji(''); }}>Cancel</button>
          </>
        )}
      </form>
      {trimming && <SoundTrim file={trimming} onUse={trimmed} onCancel={() => setTrimming(null)} />}
      <p className="muted small hint">MP3, M4A, OGG, WAV or WebM. A sound is up to {SOUND.secs} seconds: if your file is longer, you choose which part to use. The icon is optional.</p>
      {err && <div className="error" role="alert">{err}</div>}

      {sounds.length === 0 ? <p className="muted">No sounds yet.</p> : (
        <ul className="sb-list">
          {sounds.map((s) => (
            <li key={s.id} className="sb-row">
              <span className="sb-emoji" aria-hidden="true">{s.emoji || <Icon name="music" size={16} />}</span>
              <span className="sb-name">{s.name}</span>
              <span className="spacer" />
              <button type="button" className="icon-btn" title="Listen (only you hear it)" aria-label={`Listen to ${s.name}`} onClick={() => preview(s)}><Icon name="play" size={18} /></button>
              <button type="button" className="icon-btn" title="Delete" aria-label={`Delete ${s.name}`} disabled={busy} onClick={() => remove(s)}><Icon name="trash" size={18} /></button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
