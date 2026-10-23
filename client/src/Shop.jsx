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

// One badge for sale. Affordable ones lift on hover and open the buy window; the rest show how close you are.
export function ShopTile({ item, balance, busy, creator, onOpen, onOffSale }) {
  const short = !item.owned && balance < item.price;
  const pct = Math.max(0, Math.min(100, Math.round((balance / item.price) * 100)));
  return (
    <div className={'shop-tile ' + (item.owned ? 'owned' : short ? 'short' : 'can')}>
      <button type="button" className="shop-tile-main" disabled={item.owned || short || busy === item.id} onClick={() => onOpen(item)}
        title={item.owned ? 'You own this' : short ? `You need ${(item.price - balance).toLocaleString()} more credits` : `Get ${item.name}`}>
        <BadgeArt item={item} size={72} />
        <b>{item.name}</b>
        <span className="muted small shop-desc">{item.desc}</span>
      </button>
      {item.owned
        ? <span className="quest-done"><Icon name="check" size={16} /> Owned</span>
        : <span className="shop-price"><Icon name="coin" size={14} />{item.price.toLocaleString()}</span>}
      {short && (
        <div className="shop-progress" title={`${balance.toLocaleString()} of ${item.price.toLocaleString()}`}>
          <div className="quest-bar"><i style={{ width: pct + '%' }} /></div>
          <span className="muted small">{(item.price - balance).toLocaleString()} to go</span>
        </div>
      )}
      {creator && <button type="button" className="link-btn small shop-offsale" onClick={() => onOffSale(item)}>Take off sale</button>}
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

// Creator accounts only: make a badge from a picture, give it a price, and it goes on sale. Nothing is created unless the picture is usable.
export function AddBadgeModal({ onClose, onAdded }) {
  const [f, setF] = useState({ name: '', desc: '', price: '' });
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
  const ready = !!blob && f.name.trim() && Number.isInteger(price) && price >= 1 && !busy;

  async function save(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    let id = null;
    try {
      const { badge } = await api('/badges', { method: 'POST', body: { name: f.name, desc: f.desc } }); // not for sale yet
      id = badge.id;
      await uploadImage('image', blob, '/api/badges/' + id);
      await api('/badges/' + id, { method: 'PATCH', body: { price } }); // on sale only once the picture is in
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
        {err && <div className="error-text">{err}</div>}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ready}>{busy ? 'Adding…' : 'Add to shop'}</button>
        </div>
      </form>
    </Modal>
  );
}
