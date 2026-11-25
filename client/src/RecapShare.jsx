import React, { Suspense, lazy, useState } from 'react';
import { DEFAULT_LOOK } from './recap.js';
import { lightness } from './profilethemes.js';
import './recapshare.css';

// A recap shared into a chat (a recap:1: message, see recap.js): a poster with a play button, like a clip. Pressing it opens the video over the chat.
const RecapViewer = lazy(() => import('./RecapViewer.jsx'));

export function RecapShareCard({ share }) {
  const [open, setOpen] = useState(false);
  const look = share.look || DEFAULT_LOOK;
  const light = look.colors.reduce((s, c) => s + lightness(c), 0) / look.colors.length > 0.4;
  const title = share.scenes[0].main.text || String(share.year);
  const style = {
    backgroundImage: `linear-gradient(${look.angle}deg, ${look.colors.join(', ')})`,
    '--rc-ink': light ? '#14110d' : '#fbf8f1',
  };
  return (
    <>
      <button type="button" className="rs-card" onClick={() => setOpen(true)} aria-label={`Play: ${title}`}>
        <span className="rs-thumb" style={style}>
          <span className="rc-logo" aria-hidden="true"><i className="rc-mark" /><i className="rc-word" /></span>
          <span className="rs-title">{title}</span>
          <span className="rs-play" aria-hidden="true">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="#fff" stroke="#fff" strokeWidth="2" strokeLinejoin="round"><path d="M6.5 5.5v13L17.5 12z" /></svg>
          </span>
        </span>
        <span className="rs-meta"><b>Year in review</b><span>30 seconds</span></span>
      </button>
      {open && <Suspense fallback={null}><RecapViewer share={share} onClose={() => setOpen(false)} /></Suspense>}
    </>
  );
}

export default RecapShareCard;
