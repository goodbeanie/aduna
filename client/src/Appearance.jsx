import React, { useState } from 'react';
import { Modal } from './ui.jsx';
import { THEMES, GRADIENT_THEMES, DEFAULT_CUSTOM, MAX_STOPS, customStops, applyTheme, loadTheme, previewColors } from './themes.js';
import { ThemeGallery, PublishTheme } from './ThemeGallery.jsx';
import { useLang } from './i18n.js';
import { seasonalNow } from './seasonal.js';

export function Swatch({ theme, on, onPick }) {
  const c = previewColors(theme);
  return (
    <button type="button" className={'theme-card' + (on ? ' on' : '')} onClick={onPick} aria-pressed={on}>
      <span className="theme-prev" style={{ background: c.bg, backgroundImage: c.image || undefined, borderColor: c.bg2 }}>
        <i style={{ background: c.bg2 }} />
        <b style={{ background: c.accent }} />
      </span>
      {theme.icon && <span className="theme-ico" aria-hidden="true">{theme.icon}</span>}
      <span className="theme-name">{theme.name}</span>
    </button>
  );
}

export function AppearancePicker() {
  const { t: tr } = useLang();
  const [s, setS] = useState(loadTheme);
  const [publishing, setPublishing] = useState(false);
  const choose = (next) => { setS(next); applyTheme(next, { save: true }); };
  const pick = (id) => choose({ ...s, id });
  const setCustom = (patch) => choose({ ...s, id: 'custom', custom: { ...s.custom, ...patch } });
  const c = s.custom;
  const stops = customStops(c); // the custom theme's gradient colours, or null for a plain background
  const angle = Number.isFinite(c.angle) ? c.angle : 135;
  const setStops = (next) => setCustom({ grad: null, stops: next });
  const light = THEMES.filter((t) => !t.dark);
  const dark = THEMES.filter((t) => t.dark);
  const limited = seasonalNow();
  const [density, setDensityState] = useState(() => document.documentElement.dataset.density === 'compact' ? 'compact' : 'cozy');
  const setDensity = (d) => {
    setDensityState(d);
    document.documentElement.dataset.density = d;
    try { localStorage.setItem('aduna-density', d); } catch { /* storage blocked: applies until reload */ }
  };

  return (
    <div className="appearance">
      <label>Chat density</label>
      <div className="mode-pick" role="radiogroup" aria-label="Chat density">
        {[['cozy', 'Cozy'], ['compact', 'Compact']].map(([id, label]) => (
          <button type="button" role="radio" key={id} aria-checked={density === id} className={density === id ? 'on' : ''} onClick={() => setDensity(id)}>{label}</button>
        ))}
      </div>

      <label>{tr('automatic')}</label>
      <div className="mode-pick" role="radiogroup" aria-label={tr('themeMode')}>
        <button type="button" role="radio" aria-checked={s.id === 'system'} className={s.id === 'system' ? 'on' : ''} onClick={() => pick('system')}>{tr('matchDevice')}</button>
      </div>

      <label>{tr('lightLbl')}</label>
      <div className="theme-grid">{light.map((t) => <Swatch key={t.id} theme={t} on={s.id === t.id} onPick={() => pick(t.id)} />)}</div>

      <label>{tr('darkLbl')}</label>
      <div className="theme-grid">{dark.map((t) => <Swatch key={t.id} theme={t} on={s.id === t.id} onPick={() => pick(t.id)} />)}</div>

      <label>GRADIENT</label>
      <div className="theme-grid">{GRADIENT_THEMES.map((t) => <Swatch key={t.id} theme={t} on={s.id === t.id} onPick={() => pick(t.id)} />)}</div>

      {limited && (
        <>
          <label>{tr('limitedLbl')} &middot; {limited.until ? tr('limitedUntil', { date: limited.until.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }) : 'Test mode'}</label>
          <div className="theme-grid">{limited.themes.map((t) => <Swatch key={t.id} theme={t} on={s.id === t.id} onPick={() => pick(t.id)} />)}</div>
        </>
      )}

      <label>{tr('customLbl')}</label>
      <div className={'custom-theme' + (s.id === 'custom' ? ' on' : '')}>
        <div className="mode-pick" role="radiogroup" aria-label={tr('customBase')}>
          {[[false, tr('lightBase')], [true, tr('darkBase')]].map(([d, label]) => (
            <button type="button" role="radio" key={String(d)} aria-checked={c.dark === d} className={s.id === 'custom' && c.dark === d ? 'on' : ''}
              onClick={() => setCustom({ dark: d })}>{label}</button>
          ))}
        </div>
        <div className="custom-row">
          <span>{tr('background')}</span>
          <input type="color" value={c.bg} onChange={(e) => setCustom({ bg: e.target.value })} aria-label={tr('customBgAria')} />
          <code>{c.bg}</code>
        </div>
        <div className="custom-row">
          <span>{tr('accent')}</span>
          <input type="color" value={c.accent} onChange={(e) => setCustom({ accent: e.target.value })} aria-label={tr('customAccentAria')} />
          <code>{c.accent}</code>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={!!stops} onChange={(e) => setCustom({ grad: null, stops: e.target.checked ? [c.bg, c.dark ? '#5b2a86' : '#ffd9e4'] : null })} />
          <span>Gradient background</span>
        </label>
        {stops && (
          <>
            <div className="custom-row cg-stops">
              <span>Gradient</span>
              {stops.map((col, i) => (
                <span className="cg-stop" key={i}>
                  <input type="color" value={col} onChange={(e) => setStops(stops.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Gradient colour ${i + 1}`} />
                  {stops.length > 2 && <button type="button" className="icon-btn" title="Remove this colour" aria-label={`Remove gradient colour ${i + 1}`} onClick={() => setStops(stops.filter((_, j) => j !== i))}>×</button>}
                </span>
              ))}
              {stops.length < MAX_STOPS && <button type="button" className="btn small-btn" onClick={() => setStops([...stops, stops[stops.length - 1]])}>+ Colour</button>}
            </div>
            <label className="custom-row cg-angle">
              <span>Angle {angle}°</span>
              <input type="range" min="0" max="360" step="5" value={angle} onChange={(e) => setCustom({ angle: Number(e.target.value) })} aria-label="Gradient angle" />
            </label>
          </>
        )}
        <div className="mode-pick">
          <button type="button" onClick={() => setCustom({ ...DEFAULT_CUSTOM })}>{tr('resetCustom')}</button>
          <button type="button" onClick={() => setPublishing(true)}>{tr('publishTheme')}</button>
        </div>
        <p className="muted small hint">{tr('customHint')}</p>
      </div>

      <label>{tr('communityThemes')}</label>
      <p className="muted small hint">{tr('communityHint')}</p>
      <ThemeGallery current={s.id === 'custom' ? c : null} onPick={(seed) => choose({ ...s, id: 'custom', custom: { dark: seed.dark, bg: seed.bg, accent: seed.accent } })} />
      {publishing && <PublishTheme seed={{ dark: !!c.dark, bg: c.bg, accent: c.accent }} onClose={() => setPublishing(false)} />}

      <label>{tr('serverThemes')}</label>
      <label className="check-row">
        <input type="checkbox" checked={s.serverThemes !== false} onChange={(e) => choose({ ...s, serverThemes: e.target.checked })} />
        <span>{tr('serverThemesCheck')}</span>
      </label>
      <p className="muted small hint">{tr('serverThemesHint')}</p>

      <p className="muted small hint">{tr('themeApplied')}</p>
    </div>
  );
}

export function AppearanceModal({ onClose }) {
  const { t: tr } = useLang();
  return (
    <Modal title={tr('tabAppearance')} onClose={onClose}>
      <AppearancePicker />
      <div className="modal-foot"><button className="btn primary" onClick={onClose}>{tr('done')}</button></div>
    </Modal>
  );
}
