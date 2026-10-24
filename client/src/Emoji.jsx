import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Icon, Modal } from './ui.jsx';
import { api } from './api.js';
import { EveryoneMention, Mention } from './Mentions.jsx';
import { renderMarkdown } from './Markdown.jsx';

// ---------- links + custom emoji inside message text ----------
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)"'\]])/g;
export function Linkified({ text }) {
  return text.split(URL_RE).map((part, i) => (i % 2
    ? <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow">{part}</a>
    : part));
}

const TOKEN = /<:([a-z0-9_]{2,32}):([0-9a-f]{16})>/g;
const ONLY_EMOJI = /^(\s*<:[a-z0-9_]{2,32}:[0-9a-f]{16}>\s*){1,5}$/;

// emoji token | <@userId> mention | a plain @everyone
const RICH = /<:([a-z0-9_]{2,32}):([0-9a-f]{16})>|<@([0-9a-f]{16})>|(?<![\w<@])@everyone(?![\w])/g;

// mention: { users, meId, onUser, everyone } - everyone is true only when the server accepted this message's @everyone
// Message text is Discord-style Markdown (see Markdown.jsx); emoji, mentions and @everyone are drawn here and handed in as atoms.
export function Rich({ text: raw, mention }) {
  const text = String(raw ?? '');
  const big = ONLY_EMOJI.test(text);
  return renderMarkdown(text, {
    atomRe: RICH,
    atom: (m) => {
      if (m[2]) return <CustomEmoji id={m[2]} name={m[1]} big={big} />;
      if (m[3]) return <Mention id={m[3]} ctx={mention} />;
      return mention?.everyone ? <EveryoneMention /> : m[0];
    },
  });
}

export function CustomEmoji({ id, name, big }) {
  const { openMenu } = useEmoji();
  const [bad, setBad] = useState(false);
  if (bad) return <span className="cemoji-missing" title="This emoji is no longer available">:{name}:</span>;
  return <img className={'cemoji' + (big ? ' big' : '')} src={`/api/emoji/${id}/image`} alt={`:${name}:`} title={`:${name}:`} draggable={false}
    onError={() => setBad(true)} onClick={(e) => openMenu(id, name, e.clientX, e.clientY)} />;
}

// ---------- client-side checks (the server repeats every one of them) ----------
export const EMOJI_RULES = { bytes: 256 * 1024, min: 16, max: 512, ratio: 2, target: 128 };
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const kb = (n) => Math.max(1, Math.round(n / 1024)) + ' KB';
const toBlob = (c, type, q) => new Promise((r) => c.toBlob(r, type, q));

export async function prepareEmoji(file) {
  const checks = [];
  const typeOk = TYPES.includes(file.type);
  checks.push({ ok: typeOk, label: 'PNG, JPEG, WebP or GIF' });
  if (!typeOk) return { checks };
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { checks.push({ ok: false, label: 'Readable image' }); return { checks }; }
  const { width: w, height: h } = bmp;
  let blob = file, cw = w, ch = h, note = '';
  if (file.type !== 'image/gif' && Math.min(w, h) >= EMOJI_RULES.min) {
    // re-encode small: drops metadata (EXIF, GPS) and keeps transparency
    const s = Math.min(1, EMOJI_RULES.target / Math.max(w, h));
    cw = Math.max(1, Math.round(w * s)); ch = Math.max(1, Math.round(h * s));
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, cw, ch);
    blob = await toBlob(c, 'image/webp', 0.9);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(c, 'image/png');
    note = 'Resized and re-encoded; photo metadata is removed. Use a GIF for animation.';
  }
  bmp.close?.();
  const dimOk = Math.min(w, h) >= EMOJI_RULES.min && (file.type !== 'image/gif' || Math.max(w, h) <= EMOJI_RULES.max);
  checks.push({ ok: dimOk, label: `At least ${EMOJI_RULES.min} px, GIFs up to ${EMOJI_RULES.max} px (yours: ${w}×${h})` });
  const ratioOk = Math.max(w, h) / Math.min(w, h) <= EMOJI_RULES.ratio;
  checks.push({ ok: ratioOk, label: 'Roughly square (no wider than 2:1)' });
  const sizeOk = !!blob && blob.size <= EMOJI_RULES.bytes;
  checks.push({ ok: sizeOk, label: `Under 256 KB (yours: ${blob ? kb(blob.size) : '?'})` });
  return { checks, blob, w: cw, h: ch, note, ok: checks.every((c) => c.ok) };
}

export const cleanName = (s) => s.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
export const NAME_OK = /^[a-z0-9_]{2,32}$/;

// ---------- library + shared UI ----------
const Ctx = createContext(null);
export const useEmoji = () => useContext(Ctx);

export function EmojiProvider({ children }) {
  const [lib, setLib] = useState([]);
  const [limits, setLimits] = useState({ owned: 50, library: 100 });
  const [menu, setMenu] = useState(null); // { id, name, x, y, note }
  const [manager, setManager] = useState(false);

  const refresh = useCallback(() => api('/emoji/mine').then((r) => { setLib(r.emoji); setLimits(r.limits); }).catch(() => {}), []);
  useEffect(() => { refresh(); }, [refresh]);

  const actions = useMemo(() => ({
    save: (id) => api(`/emoji/${id}/save`, { method: 'POST' }).then(refresh),
    remove: (id) => api(`/emoji/${id}`, { method: 'DELETE' }).then(refresh),
    report: (id) => api(`/emoji/${id}/report`, { method: 'POST' }).then((r) => { refresh(); return r; }),
  }), [refresh]);

  // typed :name: -> <:name:id> on send, and back again when editing
  const toTokens = useCallback((text) => text.replace(/(?<!<):([a-z0-9_]{2,32}):(?![0-9a-f]{16}>)/gi, (m, n) => {
    const e = lib.find((x) => x.name === n.toLowerCase());
    return e ? `<:${e.name}:${e.id}>` : m;
  }), [lib]);
  const fromTokens = useCallback((text) => text.replace(TOKEN, (m, _n, id) => {
    const e = lib.find((x) => x.id === id);
    return e ? `:${e.name}:` : m;
  }), [lib]);

  const value = useMemo(() => ({
    lib, limits, refresh, ...actions, toTokens, fromTokens,
    openMenu: (id, name, x, y) => setMenu({ id, name, x, y, note: '' }),
    openManager: () => setManager(true),
  }), [lib, limits, refresh, actions, toTokens, fromTokens]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {menu && <EmojiMenu menu={menu} setMenu={setMenu} ctx={value} />}
      {manager && <EmojiManager ctx={value} onClose={() => setManager(false)} />}
    </Ctx.Provider>
  );
}

function EmojiMenu({ menu, setMenu, ctx }) {
  const ref = useRef(null);
  const mine = ctx.lib.find((x) => x.id === menu.id);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const close = (e) => { if (!ref.current || !ref.current.contains(e.target)) setMenu(null); };
    const key = (e) => e.key === 'Escape' && setMenu(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', () => setMenu(null));
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [setMenu]);
  async function run(fn, done) {
    setBusy(true);
    try { await fn(); setMenu((m) => ({ ...m, note: done })); } catch (e) { setMenu((m) => ({ ...m, note: e.message })); }
    setBusy(false);
  }
  const left = Math.min(menu.x, window.innerWidth - 230), top = Math.min(menu.y + 10, window.innerHeight - 190);
  return (
    <div className="emenu" ref={ref} style={{ left, top }}>
      <div className="emenu-head"><img src={`/api/emoji/${menu.id}/image`} alt="" /><b>:{mine?.name || menu.name}:</b></div>
      {mine
        ? <div className="emenu-item muted"><Icon name="check" size={15} /> In your emoji</div>
        : <button className="emenu-item" disabled={busy} onClick={() => run(() => ctx.save(menu.id), 'Saved to your emoji')}><Icon name="plus" size={15} /> Save to my emoji</button>}
      {!mine?.mine && <button className="emenu-item danger-text" disabled={busy} onClick={() => confirm('Report this emoji as inappropriate? Enough reports remove it for everyone.') && run(() => ctx.report(menu.id), 'Reported. Thank you.')}><Icon name="flag" size={15} /> Report emoji</button>}
      {menu.note && <div className="emenu-note">{menu.note}</div>}
    </div>
  );
}

function EmojiManager({ ctx, onClose }) {
  const { lib, limits } = ctx;
  const [prep, setPrep] = useState(null);
  const [preview, setPreview] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [dup, setDup] = useState(null);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const nameEdited = useRef(false);

  useEffect(() => () => preview && URL.revokeObjectURL(preview), [preview]);

  async function choose(file) {
    if (!file) return;
    setErr(''); setDup(null); setPrep(null);
    const p = await prepareEmoji(file);
    setPrep(p);
    setPreview(p.blob ? URL.createObjectURL(p.blob) : '');
    if (!nameEdited.current) setName(cleanName(file.name)); // keep a name the user typed, otherwise follow the file
  }

  const nameOk = NAME_OK.test(name);
  const takenByYou = lib.some((x) => x.name === name);
  async function upload() {
    setBusy(true); setErr(''); setDup(null);
    try {
      const res = await fetch('/api/emoji?name=' + encodeURIComponent(name), { method: 'PUT', headers: { 'Content-Type': prep.blob.type }, body: prep.blob });
      const d = await res.json().catch(() => ({}));
      if (res.status === 409 && d.existing) setDup(d);
      else if (!res.ok) throw new Error(d.error || 'Upload failed');
      else { await ctx.refresh(); setPrep(null); setPreview(''); setName(''); nameEdited.current = false; }
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <Modal title="Custom emoji" onClose={onClose} wide>
      <div className="em-layout">
        <div>
          <h4 className="em-h">ADD AN EMOJI</h4>
          <p className="muted small">Use it anywhere by typing <code>:name:</code>. Everyone who sees it can save it or report it.</p>
          <div className="upload-row" style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => input.current?.click()}>Choose image</button>
            <input ref={input} type="file" hidden accept={TYPES.join(',')} onChange={(e) => { choose(e.target.files[0]); e.target.value = ''; }} />
            {preview && <img className="em-preview" src={preview} alt="" />}
          </div>
          {prep && (
            <>
              <ul className="em-checks">
                {prep.checks.map((c) => <li key={c.label} className={c.ok ? 'ok' : 'bad'}><Icon name={c.ok ? 'check' : 'close'} size={15} />{c.label}</li>)}
              </ul>
              {prep.note && prep.ok && <p className="muted small">{prep.note}</p>}
              {prep.ok && (
                <>
                  <label>NAME</label>
                  <input value={name} onChange={(e) => { nameEdited.current = true; setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_')); }} maxLength={32} placeholder="party_cat" />
                  <ul className="em-checks">
                    <li className={nameOk ? 'ok' : 'bad'}><Icon name={nameOk ? 'check' : 'close'} size={15} />2 to 32 letters, numbers or underscores</li>
                    {takenByYou && <li className="bad"><Icon name="close" size={15} />You already have :{name}:</li>}
                  </ul>
                </>
              )}
            </>
          )}
          {err && <div className="error">{err}</div>}
          {dup && (
            <div className="em-dup">
              <img src={`/api/emoji/${dup.existing.id}/image`} alt="" />
              <div className="grow-text">{dup.error}. {dup.alreadySaved ? <>It is already in your list as <b>:{lib.find((x) => x.id === dup.existing.id)?.name}:</b>.</> : <>You can save the existing one instead.</>}
                {!dup.alreadySaved && <div><button className="btn small-btn" onClick={async () => { await ctx.save(dup.existing.id); setDup(null); setPrep(null); setPreview(''); }}>Save :{dup.existing.name}:</button></div>}
              </div>
            </div>
          )}
          <button className="btn primary full" disabled={!prep?.ok || !nameOk || takenByYou || busy} onClick={upload}>{busy ? 'Checking…' : 'Add emoji'}</button>
        </div>
        <div>
          <h4 className="em-h">YOUR EMOJI ({lib.length}/{limits.library})</h4>
          {lib.length === 0 && <p className="muted pad">Nothing yet. Add one, or click an emoji in a message to save it.</p>}
          <div className="em-grid">
            {lib.map((e) => (
              <div className="em-card" key={e.id}>
                <img src={`/api/emoji/${e.id}/image`} alt={e.name} />
                <div className="em-name" title={':' + e.name + ':'}>:{e.name}:</div>
                <div className="muted small">{e.mine ? 'Yours' : 'Saved'}{e.animated ? ' · GIF' : ''}</div>
                <button className="icon-btn em-del" title={e.mine ? 'Delete for everyone' : 'Remove from my list'}
                  onClick={() => confirm(e.mine ? `Delete :${e.name}: for everyone? Messages that use it will show :${e.name}: instead.` : `Remove :${e.name}: from your list?`) && ctx.remove(e.id).catch((x) => alert(x.message))}><Icon name="trash" size={15} /></button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
