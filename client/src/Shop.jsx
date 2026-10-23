import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon, Modal } from './ui.jsx';
import { ACCEPT_ATTR, imageUrl, processBadge, uploadImage } from './image.js';

// The shop's pieces: badge tiles, the "are you sure" window, the celebration after buying, and the creator's "add a badge" form.
// Credits.jsx owns the data and the buying; this file is only what it draws.
const BADGE_PX = { w: 128, h: 128 };
const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// A badge picture: the creator's uploaded image, or an emoji (or first letter) on a colour. `src` overrides the stored image (a local preview).
export function BadgeArt({ item, size = 64, src }) {
  const url = src || imageUrl(item?.image);
  return (
    <span className={'badge-art' + (url ? ' img' : '')} style={{ width: size, height: size, fontSize: size * 0.5, background: url ? 'transparent' : item?.color }} aria-hidden="true">
      {url ? <img src={url} alt="" draggable={false} /> : item?.emoji || Array.from(item?.name || '?')[0]}
    </span>
  );
}

// A number that rolls up or down to its new value, so spending and earning credits is something you can watch. The first value just appears.
export function useCountUp(value, ms = 700) {
  const [shown, setShown] = useState(value ?? 0);
  const cur = useRef(null);
  useEffect(() => {
    if (value == null) return undefined;
    if (cur.current == null || reduced()) { cur.current = value; setShown(value); return undefined; }
    const start = cur.current, delta = value - start;
    if (!delta) return undefined;
    let raf = 0;
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      cur.current = Math.round(start + delta * (1 - Math.pow(1 - p, 3))); // ease out
      setShown(cur.current);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

const fmtEnds = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// One badge for sale. Affordable ones lift on hover and open the buy window; the rest show how close you are.
// A creator also gets a pin button, a Daily shop checkbox, Edit and Take off sale. `item.state` (creator only): live, resting (daily, not picked today) or ended.
export function ShopTile({ item, balance, busy, creator, onOpen, onOffSale, onPin, onDaily, onEdit }) {
  const away = !!item.state && item.state !== 'live'; // not on show to players right now, so it cannot be bought
  const short = !item.owned && balance < item.price;
  const pct = Math.max(0, Math.min(100, Math.round((balance / item.price) * 100)));
  return (
    <div className={'shop-tile ' + (item.owned ? 'owned' : short ? 'short' : 'can') + (away ? ' away' : '')}>
      {(item.pinned || item.ends || away) && (
        <div className="shop-chips">
          {item.pinned && <span className="shop-chip pinned"><Icon name="pin" size={12} /> Pinned</span>}
          {item.state === 'ended' && <span className="shop-chip off">Ended</span>}
          {item.state === 'resting' && <span className="shop-chip off">Resting today</span>}
          {item.ends && item.state !== 'ended' && <span className="shop-chip" title={fmtEnds(item.ends)}><Icon name="clock" size={12} /> Ends {fmtEnds(item.ends)}</span>}
        </div>
      )}
      <button type="button" className="shop-tile-main" disabled={item.owned || short || away || busy === item.id} onClick={() => onOpen(item)}
        title={item.owned ? 'You own this' : away ? 'Players cannot see this right now' : short ? `You need ${(item.price - balance).toLocaleString()} more credits` : `Get ${item.name}`}>
        <BadgeArt item={item} size={72} />
        <b>{item.name}</b>
        <span className="muted small shop-desc">{item.desc}</span>
      </button>
      {item.owned
        ? <span className="quest-done"><Icon name="check" size={16} /> Owned</span>
        : <span className="shop-price"><Icon name="coin" size={14} />{item.price.toLocaleString()}</span>}
      {short && !away && (
        <div className="shop-progress" title={`${balance.toLocaleString()} of ${item.price.toLocaleString()}`}>
          <div className="quest-bar"><i style={{ width: pct + '%' }} /></div>
          <span className="muted small">{(item.price - balance).toLocaleString()} to go</span>
        </div>
      )}
      {creator && (
        <div className="shop-admin">
          <div className="shop-admin-row">
            <button type="button" className={'icon-btn pin-btn' + (item.pinned ? ' on' : '')} aria-pressed={item.pinned} title={item.pinned ? 'Unpin' : 'Pin to the top of the shop'} aria-label={item.pinned ? 'Unpin ' + item.name : 'Pin ' + item.name} onClick={() => onPin(item)}><Icon name="pin" size={16} /></button>
            <label className="daily-check" title="Daily shop: shown on some days only. Up to 5 daily badges are picked at random each day."><input type="checkbox" checked={item.daily} onChange={() => onDaily(item)} /> Daily shop</label>
          </div>
          <div className="shop-admin-row">
            <button type="button" className="link-btn small" onClick={() => onEdit(item)}>Edit</button>
            <button type="button" className="link-btn small" onClick={() => onOffSale(item)}>Take off sale</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Shown before any credits are spent: what you get, and what your balance does.
export function BuyConfirm({ item, balance, busy, onConfirm, onClose }) {
  return (
    <Modal title="Get this badge?" onClose={onClose}>
      <div className="buy-confirm">
        <BadgeArt item={item} size={96} />
        <h3>{item.name}</h3>
        {item.desc && <p className="muted">{item.desc}</p>}
        <div className="buy-math">
          <span>Your credits</span><b>{balance.toLocaleString()}</b>
          <span>Price</span><b className="minus">−{item.price.toLocaleString()}</b>
          <span className="sum">After</span><b className="sum">{(balance - item.price).toLocaleString()}</b>
        </div>
        <p className="muted small">It shows next to your name everywhere in Aduna, and it is yours to keep.</p>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Not now</button>
        <button className="btn primary" disabled={busy} onClick={onConfirm}><Icon name="coin" size={14} /> {busy ? 'Buying…' : `Buy for ${item.price.toLocaleString()}`}</button>
      </div>
    </Modal>
  );
}

// The reward moment: the badge bounces in over a burst of confetti.
const COLORS = ['#ff8a1f', '#ffd43b', '#51cf66', '#4dabf7', '#9775fa', '#f06595'];
export function Celebration({ item, onClose }) {
  const bits = useMemo(() => (reduced() ? [] : Array.from({ length: 36 }, (_, i) => ({
    left: Math.random() * 100, delay: Math.random() * 0.35, dur: 1.3 + Math.random() * 1.1,
    x: Math.round((Math.random() - 0.5) * 160) + 'px', r: Math.round(360 + Math.random() * 540) + 'deg', color: COLORS[i % COLORS.length],
  }))), []);
  useEffect(() => {
    const h = (e) => (e.key === 'Escape' || e.key === 'Enter') && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay celebrate" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="confetti" aria-hidden="true">
        {bits.map((b, i) => <i key={i} style={{ left: b.left + '%', background: b.color, '--delay': b.delay + 's', '--d': b.dur + 's', '--x': b.x, '--r': b.r }} />)}
      </div>
      <div className="celebrate-card" role="dialog" aria-label="Badge bought">
        <div className="celebrate-art"><BadgeArt item={item} size={112} /></div>
        <h3>It’s yours!</h3>
        <p>The <b>{item.name}</b> badge now shows next to your name.</p>
        <button className="btn primary" autoFocus onClick={onClose}>Nice</button>
      </div>
    </div>
  );
}

const pad2 = (n) => String(n).padStart(2, '0');
const toLocalInput = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

// Creator accounts only: change a badge that is in the shop (name, description, price, picture), say when it leaves the shop, pin it, or make it a daily one.
// Only what was changed is sent, so a badge whose end date has passed can still have its other details edited.
export function EditBadgeModal({ item, onClose, onSaved }) {
  const [f, setF] = useState({ name: item.name, desc: item.desc || '', price: String(item.price), ends: toLocalInput(item.ends), pinned: !!item.pinned, daily: !!item.daily });
  const [blob, setBlob] = useState(null);
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));

  const pick = async (e) => {
    const picked = e.target.files?.[0]; e.target.value = '';
    if (!picked) return;
    setErr('');
    try { const out = await processBadge(picked, BADGE_PX); setBlob(out); setPreview(URL.createObjectURL(out)); }
    catch (x) { setErr(x.message); }
  };

  const price = Number(f.price);
  const endsChanged = f.ends !== toLocalInput(item.ends);
  const endMs = f.ends ? new Date(f.ends).getTime() : null;
  const ended = item.state === 'ended';

  async function save(e) {
    e.preventDefault(); setErr('');
    if (!f.name.trim()) return setErr('A badge needs a name');
    if (!Number.isInteger(price) || price < 1) return setErr('The price is a whole number of credits, 1 or more');
    if (endsChanged && endMs !== null && (!Number.isFinite(endMs) || endMs <= Date.now())) return setErr('Pick an end date that is still to come');
    const body = {};
    if (f.name.trim() !== item.name) body.name = f.name.trim();
    if (f.desc.trim() !== (item.desc || '')) body.desc = f.desc.trim();
    if (price !== item.price) body.price = price;
    if (endsChanged) body.shopEnds = endMs;
    if (f.pinned !== !!item.pinned) body.pinned = f.pinned;
    if (f.daily !== !!item.daily) body.daily = f.daily;
    setBusy(true);
    try {
      if (Object.keys(body).length) await api('/badges/' + item.id, { method: 'PATCH', body });
      if (blob) await uploadImage('image', blob, '/api/badges/' + item.id);
      onSaved(f.name.trim());
    } catch (x) { setErr(x.message); setBusy(false); }
  }

  return (
    <Modal title="Edit shop badge" onClose={onClose}>
      <form className="addbadge" onSubmit={save}>
        <input ref={input} type="file" accept={ACCEPT_ATTR} hidden onChange={pick} />
        <button type="button" className="badge-pick has" onClick={() => input.current?.click()} aria-label="Change picture">
          <BadgeArt item={item} size={88} src={preview || undefined} />
        </button>
        <p className="muted small">Tap the picture to change it. People who already own this badge see the new picture too.</p>
        <label>Name</label>
        <input value={f.name} maxLength={24} onChange={(e) => set('name')(e.target.value)} />
        <label>Description <span className="muted small">(optional)</span></label>
        <input value={f.desc} maxLength={80} placeholder="One short line" onChange={(e) => set('desc')(e.target.value)} />
        <label>Price in credits</label>
        <input type="number" min="1" step="1" inputMode="numeric" value={f.price} onChange={(e) => set('price')(e.target.value)} />
        <label>Leaves the shop on <span className="muted small">(optional)</span></label>
        <div className="row">
          <input type="datetime-local" value={f.ends} onChange={(e) => set('ends')(e.target.value)} />
          {f.ends && <button type="button" className="btn" onClick={() => set('ends')('')}>No end date</button>}
        </div>
        <p className="muted small hint">{ended ? 'This badge’s end date has passed, so it is off the shop. Clear the date or pick a later one to put it back.' : 'After this time the badge is taken off the shop. People who own it keep it.'}</p>
        <label className="check-row"><input type="checkbox" checked={f.pinned} onChange={(e) => set('pinned')(e.target.checked)} /> Pin to the top of the shop <span className="muted small">(always shown)</span></label>
        <label className="check-row"><input type="checkbox" checked={f.daily} onChange={(e) => set('daily')(e.target.checked)} /> Daily shop <span className="muted small">(up to 5 daily badges are picked at random each day)</span></label>
        {err && <div className="error-text">{err}</div>}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Creator accounts only: make a badge from a picture, give it a price, and it goes on sale. Nothing is created unless the picture is usable.
export function AddBadgeModal({ onClose, onAdded }) {
  const [f, setF] = useState({ name: '', desc: '', price: '', ends: '', pinned: false, daily: false });
  const [blob, setBlob] = useState(null); // the picture after the crop and the background removal, ready to upload
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  // The picture is processed as soon as it is chosen, so the preview shows exactly what will be uploaded (background already cut out).
  const pick = async (e) => {
    const picked = e.target.files?.[0]; e.target.value = '';
    if (!picked) return;
    setErr('');
    try { const out = await processBadge(picked, BADGE_PX); setBlob(out); setPreview(URL.createObjectURL(out)); }
    catch (x) { setErr(x.message); }
  };
  const price = Number(f.price);
  const endMs = f.ends ? new Date(f.ends).getTime() : null;
  const ready = !!blob && f.name.trim() && Number.isInteger(price) && price >= 1 && !busy;

  async function save(e) {
    e.preventDefault(); setErr('');
    if (endMs !== null && (!Number.isFinite(endMs) || endMs <= Date.now())) return setErr('Pick an end date that is still to come');
    setBusy(true);
    let id = null;
    try {
      const { badge } = await api('/badges', { method: 'POST', body: { name: f.name, desc: f.desc } }); // not for sale yet
      id = badge.id;
      await uploadImage('image', blob, '/api/badges/' + id);
      await api('/badges/' + id, { method: 'PATCH', body: { price, shopEnds: endMs, pinned: f.pinned, daily: f.daily } }); // on sale only once the picture is in
      onAdded(badge.name);
    } catch (x) {
      if (id) api('/badges/' + id, { method: 'DELETE' }).catch(() => {}); // do not leave a half-made badge behind
      setErr(x.message); setBusy(false);
    }
  }

  return (
    <Modal title="Add a badge to the shop" onClose={onClose}>
      <form className="addbadge" onSubmit={save}>
        <input ref={input} type="file" accept={ACCEPT_ATTR} hidden onChange={pick} />
        <button type="button" className={'badge-pick' + (preview ? ' has' : '')} onClick={() => input.current?.click()} aria-label={preview ? 'Change picture' : 'Upload a picture'}>
          {preview ? <BadgeArt item={{ name: f.name }} size={88} src={preview} /> : <><Icon name="plus" size={26} /><span>Upload a picture</span></>}
        </button>
        <p className="muted small">PNG, JPEG, WebP or GIF. A plain background (like white) is removed for you, and the picture is cropped square and shown small, so keep it simple.</p>
        <label>Name</label>
        <input value={f.name} maxLength={24} placeholder="Badge name" onChange={(e) => setF({ ...f, name: e.target.value })} />
        <label>Description <span className="muted small">(optional)</span></label>
        <input value={f.desc} maxLength={80} placeholder="One short line" onChange={(e) => setF({ ...f, desc: e.target.value })} />
        <label>Price in credits</label>
        <input type="number" min="1" step="1" inputMode="numeric" value={f.price} placeholder="250" onChange={(e) => setF({ ...f, price: e.target.value })} />
        <label>Leaves the shop on <span className="muted small">(optional)</span></label>
        <div className="row">
          <input type="datetime-local" value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value })} />
          {f.ends && <button type="button" className="btn" onClick={() => setF({ ...f, ends: '' })}>No end date</button>}
        </div>
        <p className="muted small hint">After this time the badge is taken off the shop. People who own it keep it.</p>
        <label className="check-row"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> Pin to the top of the shop <span className="muted small">(always shown)</span></label>
        <label className="check-row"><input type="checkbox" checked={f.daily} onChange={(e) => setF({ ...f, daily: e.target.checked })} /> Daily shop <span className="muted small">(up to 5 daily badges are picked at random each day)</span></label>
        {err && <div className="error-text">{err}</div>}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ready}>{busy ? 'Adding…' : 'Add to shop'}</button>
        </div>
      </form>
    </Modal>
  );
}
