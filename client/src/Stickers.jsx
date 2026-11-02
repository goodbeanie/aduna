import React, { useEffect, useState } from 'react';
import { Icon } from './ui.jsx';
import { TileSkeleton } from './ShellBits.jsx';
import { Popover } from './Attachments.jsx';
import { api } from './api.js';
import { stickerSrc } from './stickers.js';

// One sticker picture. An animated one sits still on its first frame and plays while the pointer is over it (or it has focus), like every other animated picture.
// `sticker` is optional: without it (a message whose pack is gone, or an old one) the picture is simply loaded, as a still when it turns out to be a GIF.
export function StickerImg({ id, animated = true, name = 'Sticker', className = '', ...rest }) {
  const [play, setPlay] = useState(false);
  const [broken, setBroken] = useState(false);
  if (broken) return <span className={'stk-gone ' + className} title="This sticker is no longer available"><Icon name="sticker" size={28} /></span>;
  return (
    <img className={className} src={stickerSrc(id, animated && !play)} alt={name} draggable={false} loading="lazy"
      onMouseEnter={animated ? () => setPlay(true) : undefined} onMouseLeave={animated ? () => setPlay(false) : undefined}
      onFocus={animated ? () => setPlay(true) : undefined} onBlur={animated ? () => setPlay(false) : undefined}
      onError={() => setBroken(true)} {...rest} />
  );
}

// A message that is one sticker: drawn large, with no text around it.
export function StickerMessage({ id }) {
  return <div className="sticker-msg"><StickerImg id={id} className="sticker-big" /></div>;
}

// The picker: the packs you own (or made), a tab for each, and the stickers of the open pack.
export function StickerPop({ onPick, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);
  const [hover, setHover] = useState('');

  useEffect(() => {
    let dead = false;
    api('/stickers/mine').then((r) => { if (!dead) { setData(r); setOpen(r.packs[0]?.id || null); } }).catch((e) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, []);

  const packs = data?.packs || [];
  const pack = packs.find((p) => p.id === open) || packs[0];
  return (
    <Popover onClose={onClose} className="sticker-pop">
      {!data && !err && <div className="stk-body"><TileSkeleton tiles={8} size={72} label="Loading stickers" /></div>}
      {err && <div className="error-text pad center">{err}</div>}
      {data && packs.length === 0 && (
        <div className="stk-empty">
          <Icon name="sticker" size={30} />
          <b>No stickers yet</b>
          <p className="muted small">Sticker packs are made by artists and sold in the credits shop. A pack you buy shows up here.</p>
        </div>
      )}
      {pack && (
        <>
          <div className="stk-tabs" role="tablist">
            {packs.map((p) => (
              <button key={p.id} type="button" role="tab" aria-selected={p.id === pack.id} className={'stk-tab' + (p.id === pack.id ? ' on' : '')} title={p.name} onClick={() => setOpen(p.id)}>
                {p.stickers[0] ? <img src={stickerSrc(p.stickers[0].id, true)} alt="" draggable={false} /> : <Icon name="sticker" size={20} />}
              </button>
            ))}
          </div>
          <div className="stk-label">{pack.name.toUpperCase()}{pack.mine && <span className="muted small"> · yours</span>}</div>
          <div className="stk-body">
            <div className="stk-grid">
              {pack.stickers.map((s) => (
                <button key={s.id} type="button" className="stk-pick" title={s.name} aria-label={`Send the sticker ${s.name}`} onMouseEnter={() => setHover(s.name)} onFocus={() => setHover(s.name)} onClick={() => onPick(s)}>
                  <StickerImg id={s.id} animated={s.animated} name={s.name} />
                </button>
              ))}
            </div>
          </div>
          <div className="stk-foot muted small">{hover || 'Pick a sticker to send it'}</div>
        </>
      )}
    </Popover>
  );
}
