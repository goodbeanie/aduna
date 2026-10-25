import React, { useEffect, useState } from 'react';
import { Icon, Modal } from './ui.jsx';

// The "Share your screen" sheet. One look on every platform, three behaviours:
//  - Aduna desktop (window.adunaDesktop.screen exists): Electron has no picker of its own, so this sheet IS the picker:
//    live thumbnails of every screen and window, and the choice goes back to the app before getDisplayMedia() runs.
//  - Website on a computer: a quality choice, then the browser's own screen / window / tab chooser opens.
//  - Phones and anything without getDisplayMedia (Android WebView and phone browsers cannot capture the screen):
//    a short, honest message instead of a button that silently does nothing. Watching someone else's share still works.

export const QUALITY = {
  text:     { label: 'Sharp text', hint: 'Documents and code',    fps: 15, w: 1920, h: 1080, content: 'detail' },
  balanced: { label: 'Balanced',   hint: 'Good for most things',  fps: 30, w: 1920, h: 1080, content: 'detail' },
  motion:   { label: 'Smooth',     hint: 'Games and video',       fps: 60, w: 1280, h: 720,  content: 'motion' },
};
const KEY = 'aduna-share-quality';
const loadQuality = () => { try { const v = localStorage.getItem(KEY); return QUALITY[v] ? v : 'balanced'; } catch { return 'balanced'; } };
const saveQuality = (v) => { try { localStorage.setItem(KEY, v); } catch { /* storage blocked: it just will not be remembered */ } };

export const desktopScreen = () => (typeof window !== 'undefined' && window.adunaDesktop && window.adunaDesktop.screen) || null;
export const canShareScreen = () => !!desktopScreen() || !!navigator.mediaDevices?.getDisplayMedia;

function Quality({ value, onChange }) {
  return (
    <div className="ss-quality" role="radiogroup" aria-label="Quality">
      {Object.entries(QUALITY).map(([id, q]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={'ss-q' + (value === id ? ' on' : '')} onClick={() => onChange(id)}>
          <b>{q.label}</b>
          <span>{q.hint}</span>
        </button>
      ))}
    </div>
  );
}

function SourceCard({ s, on, onPick, onStart }) {
  return (
    <button type="button" className={'ss-src' + (on ? ' on' : '')} onClick={onPick} onDoubleClick={onStart} aria-pressed={on} title={s.name}>
      <span className="ss-thumb">{s.thumb ? <img src={s.thumb} alt="" draggable="false" /> : <Icon name="screen" size={28} />}</span>
      <span className="ss-name">
        {s.icon && <img className="ss-app" src={s.icon} alt="" draggable="false" />}
        <span>{s.name}</span>
      </span>
    </button>
  );
}

export function ScreenSharePicker({ onStart, onClose }) {
  const desk = desktopScreen();
  const [quality, setQuality] = useState(loadQuality);
  const [sources, setSources] = useState(null); // null while loading (desktop only)
  const [tab, setTab] = useState('screen');
  const [sel, setSel] = useState('');

  useEffect(() => {
    if (!desk) return undefined;
    let dead = false;
    const load = async () => {
      try { const s = await desk.sources(); if (!dead) setSources(Array.isArray(s) ? s : []); }
      catch { if (!dead) setSources((old) => old || []); }
    };
    load();
    const t = setInterval(load, 4000); // thumbnails stay live while the sheet is open
    return () => { dead = true; clearInterval(t); };
  }, [desk]);

  // pre-select the first screen once the list arrives
  useEffect(() => { if (sources && !sel) { const first = sources.find((s) => s.kind === 'screen') || sources[0]; if (first) setSel(first.id); } }, [sources]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (sourceId) => { saveQuality(quality); onStart({ sourceId, quality }); };
  const shown = (sources || []).filter((s) => s.kind === tab);
  const chosen = (sources || []).find((s) => s.id === sel);

  // ----- this device cannot capture its screen -----
  if (!canShareScreen()) {
    return (
      <Modal title="Share your screen" onClose={onClose}>
        <div className="ss-body ss-center">
          <span className="ss-badge"><Icon name="screen" size={30} /></span>
          <h3>Sharing isn't available on this device</h3>
          <p>Phones can't share their screen in Aduna yet. You can still watch when your friend shares theirs, and you can share from the Aduna desktop app or a computer's browser.</p>
          <div className="ss-actions"><button className="btn primary" onClick={onClose}>Got it</button></div>
        </div>
      </Modal>
    );
  }

  // ----- Aduna desktop: our own picker -----
  if (desk) {
    return (
      <Modal title="Share your screen" onClose={onClose} wide>
        <div className="ss-body">
          <div className="ss-tabs" role="tablist">
            {[['screen', 'Screens'], ['window', 'Windows']].map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={'ss-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          {sources === null
            ? <div className="ss-empty">Looking for screens…</div>
            : shown.length === 0
              ? <div className="ss-empty">{tab === 'screen' ? 'No screens found.' : 'No windows to share right now.'}</div>
              : (
                <div className="ss-grid">
                  {shown.map((s) => <SourceCard key={s.id} s={s} on={sel === s.id} onPick={() => setSel(s.id)} onStart={() => go(s.id)} />)}
                </div>
              )}
          <Quality value={quality} onChange={setQuality} />
          <div className="ss-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!chosen} onClick={() => go(chosen.id)}>Share {chosen ? (chosen.kind === 'screen' ? 'screen' : 'window') : ''}</button>
          </div>
        </div>
      </Modal>
    );
  }

  // ----- website: our sheet first, then the browser's own chooser -----
  return (
    <Modal title="Share your screen" onClose={onClose}>
      <div className="ss-body">
        <p className="ss-lead">Pick how it should look. Next, your browser asks what to share: a whole screen, one window or a single tab. Only that is shown.</p>
        <Quality value={quality} onChange={setQuality} />
        <div className="ss-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => go(undefined)}>Choose what to share</button>
        </div>
      </div>
    </Modal>
  );
}

// A strip at the top of the call while you are sharing, with a clear way to stop.
export function ShareBar({ onStop }) {
  return (
    <div className="ss-bar" role="status">
      <span className="ss-live" aria-hidden="true" />
      <span className="ss-bar-text">You're sharing your screen</span>
      <button className="ss-stop" onClick={onStop}>Stop sharing</button>
    </div>
  );
}
