import React, { useState } from 'react';
import { Modal } from './ui.jsx';
import { THEMES, DEFAULT_CUSTOM, applyTheme, loadTheme, previewColors } from './themes.js';
import { ThemeGallery, PublishTheme } from './ThemeGallery.jsx';

export function Swatch({ theme, on, onPick }) {
  const c = previewColors(theme);
  return (
    <button type="button" className={'theme-card' + (on ? ' on' : '')} onClick={onPick} aria-pressed={on}>
      <span className="theme-prev" style={{ background: c.bg, borderColor: c.bg2 }}>
        <i style={{ background: c.bg2 }} />
        <b style={{ background: c.accent }} />
      </span>
      <span className="theme-name">{theme.name}</span>
    </button>
  );
}

export function AppearancePicker() {
  const [s, setS] = useState(loadTheme);
  const [publishing, setPublishing] = useState(false);
  const choose = (next) => { setS(next); applyTheme(next, { save: true }); };
  const pick = (id) => choose({ ...s, id });
  const setCustom = (patch) => choose({ ...s, id: 'custom', custom: { ...s.custom, ...patch } });
  const c = s.custom;
  const light = THEMES.filter((t) => !t.dark);
  const dark = THEMES.filter((t) => t.dark);

  return (
    <div className="appearance">
      <label>AUTOMATIC</label>
      <div className="mode-pick" role="radiogroup" aria-label="Theme mode">
        <button type="button" role="radio" aria-checked={s.id === 'system'} className={s.id === 'system' ? 'on' : ''} onClick={() => pick('system')}>Match my device (light / dark)</button>
      </div>

      <label>LIGHT</label>
      <div className="theme-grid">{light.map((t) => <Swatch key={t.id} theme={t} on={s.id === t.id} onPick={() => pick(t.id)} />)}</div>

      <label>DARK</label>
      <div className="theme-grid">{dark.map((t) => <Swatch key={t.id} theme={t} on={s.id === t.id} onPick={() => pick(t.id)} />)}</div>

      <label>CUSTOM</label>
      <div className={'custom-theme' + (s.id === 'custom' ? ' on' : '')}>
        <div className="mode-pick" role="radiogroup" aria-label="Custom theme base">
          {[[false, 'Light base'], [true, 'Dark base']].map(([d, label]) => (
            <button type="button" role="radio" key={label} aria-checked={c.dark === d} className={s.id === 'custom' && c.dark === d ? 'on' : ''}
              onClick={() => setCustom({ dark: d })}>{label}</button>
          ))}
        </div>
        <div className="custom-row">
          <span>Background</span>
          <input type="color" value={c.bg} onChange={(e) => setCustom({ bg: e.target.value })} aria-label="Custom background colour" />
          <code>{c.bg}</code>
        </div>
        <div className="custom-row">
          <span>Accent (buttons, highlights)</span>
          <input type="color" value={c.accent} onChange={(e) => setCustom({ accent: e.target.value })} aria-label="Custom accent colour" />
          <code>{c.accent}</code>
        </div>
        <div className="mode-pick">
          <button type="button" onClick={() => setCustom({ ...DEFAULT_CUSTOM })}>Reset custom colours</button>
          <button type="button" onClick={() => setPublishing(true)}>Publish this theme…</button>
        </div>
        <p className="muted small hint">Sidebars, borders, hover and text colours are generated from these two colours. Light and dark bases keep text readable.</p>
      </div>

      <label>COMMUNITY THEMES</label>
      <p className="muted small hint">Themes other people published. Picking one makes it your custom theme on this device (your current custom colours are replaced).</p>
      <ThemeGallery current={s.id === 'custom' ? c : null} onPick={(seed) => choose({ ...s, id: 'custom', custom: { dark: seed.dark, bg: seed.bg, accent: seed.accent } })} />
      {publishing && <PublishTheme seed={{ dark: !!c.dark, bg: c.bg, accent: c.accent }} onClose={() => setPublishing(false)} />}

      <label>SERVER THEMES</label>
      <label className="check-row">
        <input type="checkbox" checked={s.serverThemes !== false} onChange={(e) => choose({ ...s, serverThemes: e.target.checked })} />
        <span>Let servers fade the app to their own theme while I'm there</span>
      </label>
      <p className="muted small hint">Server owners can pick a theme for their server. Turn this off to always keep your own theme.</p>

      <p className="muted small hint">Theme changes apply instantly and are saved on this device.</p>
    </div>
  );
}

export function AppearanceModal({ onClose }) {
  return (
    <Modal title="Appearance" onClose={onClose}>
      <AppearancePicker />
      <div className="modal-foot"><button className="btn primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}
