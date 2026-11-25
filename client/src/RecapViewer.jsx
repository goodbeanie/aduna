import React, { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './ui.jsx';
import { useLang } from './i18n.js';
import { DEFAULT_LOOK } from './recap.js';
import { Player } from './Recap.jsx';
import './recapshare.css';

// The video of a recap that was shared into a chat, over the whole app.
export default function RecapViewer({ share, onClose }) {
  const { lang } = useLang();
  const back = useRef(null);
  const scenes = useMemo(() => share.scenes.map((s) => (typeof s.main.count === 'number' ? { ...s, main: { ...s.main, lang } } : s)), [share, lang]);

  useEffect(() => {
    const was = document.activeElement;
    back.current?.focus();
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', esc); document.body.style.overflow = overflow; if (was && was.focus) was.focus(); };
  }, [onClose]);

  return createPortal(
    <div className="rs-back" role="dialog" aria-modal="true" aria-label="Year in review" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rs-panel">
        <button ref={back} type="button" className="btn ghost rs-exit" onClick={onClose}><Icon name="back" size={16} /> Back to chat</button>
        <Player scenes={scenes} year={share.year} kind={share.kind} look={share.look || DEFAULT_LOOK} song={share.song} received autoPlay />
      </div>
    </div>,
    document.body,
  );
}
