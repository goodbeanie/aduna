import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon, ServerIcon } from './ui.jsx';
import { processImage, uploadImage, imageUrl, ACCEPT_ATTR, SERVER_ICON_SIZE, SERVER_BANNER_SIZE } from './image.js';
import { THEMES, DEFAULT_CUSTOM, setServerTheme } from './themes.js';
import { Swatch } from './Appearance.jsx';

const TABS = [['overview', 'Overview', 'users'], ['theme', 'Server theme', 'palette']];
const seedOf = (t) => ({ dark: t.dark, bg: t.bg, accent: t.accent });
const sameSeed = (a, b) => a.dark === b.dark && a.bg.toLowerCase() === b.bg.toLowerCase() && a.accent.toLowerCase() === b.accent.toLowerCase();

// Owner-only full-screen settings for a server: name, icon, banner and a theme the app fades to while you are on the server.
// Picture changes are staged until Save (undefined = unchanged, null = remove, { blob, url } = new image).
// While this screen is open the draft theme is previewed live on the whole app.
export function ServerSettings({ server, onClose, onSaved }) {
  const [tab, setTab] = useState('overview');
  const [name, setName] = useState(server.name);
  const [code, setCode] = useState(server.inviteCode);
  const [codeState, setCodeState] = useState({ status: 'current', reason: '' }); // current | checking | free | taken | invalid
  const [themeOn, setThemeOn] = useState(!!server.theme);
  const [theme, setTheme] = useState(server.theme || seedOf(DEFAULT_CUSTOM));
  const [staged, setStaged] = useState({ icon: undefined, banner: undefined });
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const iconInput = useRef(null);
  const bannerInput = useRef(null);

  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  // Ask the server whether the typed invite code is free (debounced while typing)
  useEffect(() => {
    const c = code.trim().toLowerCase();
    if (c === server.inviteCode) { setCodeState({ status: 'current', reason: '' }); return undefined; }
    if (!/^[a-z0-9_-]{3,32}$/.test(c)) { setCodeState({ status: 'invalid', reason: 'Use 3 to 32 letters, numbers, - or _' }); return undefined; }
    setCodeState({ status: 'checking', reason: '' });
    let live = true;
    const t = setTimeout(() => {
      api(`/servers/${server.id}/invite-check?code=${encodeURIComponent(c)}`)
        .then((r) => live && setCodeState(r.available ? { status: 'free', reason: '' } : { status: 'taken', reason: r.reason || 'That code is already taken' }))
        .catch((e) => live && setCodeState({ status: 'invalid', reason: e.message }));
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [code, server.id, server.inviteCode]);
  useEffect(() => () => { for (const s of Object.values(stagedRef.current)) if (s) URL.revokeObjectURL(s.url); }, []);

  // live preview: the whole app fades to the draft theme (App puts the saved one back when this screen closes)
  useEffect(() => { setServerTheme(themeOn ? theme : null, { force: true }); }, [themeOn, theme]);

  function stage(kind, value) {
    setStaged((s) => { if (s[kind]) URL.revokeObjectURL(s[kind].url); return { ...s, [kind]: value }; });
  }
  async function pick(kind, e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setErr('');
    try {
      const blob = await processImage(file, kind === 'icon' ? SERVER_ICON_SIZE : SERVER_BANNER_SIZE);
      stage(kind, { blob, url: URL.createObjectURL(blob) });
    } catch (ex) { setErr(ex.message); }
  }
  const has = (kind) => (staged[kind] === undefined ? !!server[kind === 'icon' ? 'iconImage' : 'bannerImage'] : staged[kind] !== null);
  const remove = (kind) => stage(kind, server[kind === 'icon' ? 'iconImage' : 'bannerImage'] ? null : undefined);

  const iconSrc = staged.icon === undefined ? imageUrl(server.iconImage) : staged.icon?.url || null;
  const bannerSrc = staged.banner === undefined ? imageUrl(server.bannerImage) : staged.banner?.url || null;
  const shownName = name.trim() || server.name;

  const pickTheme = (seed) => { setTheme(seed); setThemeOn(true); };
  const setSeed = (patch) => pickTheme({ ...theme, ...patch });

  async function save() {
    if (!name.trim()) { setTab('overview'); return setErr('Give the server a name'); }
    if (codeState.status === 'taken' || codeState.status === 'invalid') { setTab('overview'); return setErr(codeState.reason || 'Fix the invite code first'); }
    if (codeState.status === 'checking') return setErr('Still checking the invite code, try again in a moment');
    setSaving(true);
    setErr('');
    try {
      let { server: sv } = await api(`/servers/${server.id}`, { method: 'PATCH', body: { name, theme: themeOn ? theme : null, inviteCode: code.trim().toLowerCase() } });
      for (const kind of ['icon', 'banner']) {
        const s = staged[kind];
        if (s === undefined) continue;
        ({ server: sv } = s === null ? await api(`/servers/${server.id}/${kind}`, { method: 'DELETE' }) : await uploadImage(kind, s.blob, `/api/servers/${server.id}`));
      }
      onSaved(sv);
      onClose();
    } catch (ex) { setErr(ex.message); setSaving(false); }
  }

  return (
    <div className="settings-screen" role="dialog" aria-label="Server settings">
      <nav className="settings-nav">
        <button className="icon-btn settings-navclose" onClick={onClose} aria-label="Close server settings"><Icon name="close" size={20} /></button>
        <h2>{server.name}</h2>
        {TABS.map(([id, label, icon]) => (
          <button key={id} className={'settings-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
            <Icon name={icon} size={18} /><span>{label}</span>
          </button>
        ))}
      </nav>
      <main className="settings-main">
        <button className="icon-btn settings-close" onClick={onClose} aria-label="Close server settings" title="Close (Esc)"><Icon name="close" size={20} /></button>
        <div className="settings-content">
          <input ref={iconInput} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => pick('icon', e)} />
          <input ref={bannerInput} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => pick('banner', e)} />

          {tab === 'overview' && (
            <>
              <h1>Overview</h1>
              <div className="server-prev">
                <div className="sp-banner" style={bannerSrc ? { backgroundImage: `url("${bannerSrc}")` } : undefined}>
                  <button type="button" className="img-overlay banner-ov" onClick={() => bannerInput.current.click()} aria-label="Change server banner">
                    <Icon name="camera" size={20} /><span>Change banner</span>
                  </button>
                </div>
                <div className="sp-icon">
                  <ServerIcon server={{ name: shownName }} fill preview={iconSrc} />
                  <button type="button" className="img-overlay" onClick={() => iconInput.current.click()} aria-label="Change server icon"><Icon name="camera" size={22} /></button>
                </div>
                <div className="sp-body"><div className="sp-name">{shownName}</div><div className="muted small">{server.channels.length} channel{server.channels.length === 1 ? '' : 's'} · {server.members.length} member{server.members.length === 1 ? '' : 's'}</div></div>
              </div>
              <p className="muted small hint">Tip: hover the banner or icon in the preview and click it to upload an image. Icons are cropped square, banners are cropped to 3:1.</p>

              <label>SERVER NAME</label>
              <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />

              <label>CUSTOM INVITE CODE</label>
              <input className={'code-input ' + codeState.status} value={code} maxLength={32} spellCheck={false} autoCapitalize="none" autoCorrect="off" onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))} aria-describedby="code-hint" />
              <p id="code-hint" className={'code-hint ' + codeState.status} role="status">
                {codeState.status === 'current' && 'This is your current invite code.'}
                {codeState.status === 'checking' && 'Checking…'}
                {codeState.status === 'free' && 'Available. It becomes your invite code when you save.'}
                {(codeState.status === 'taken' || codeState.status === 'invalid') && codeState.reason}
              </p>
              <p className="muted small hint">Changing the code stops the old one from working, including invite cards already sent.</p>

              <label>ICON AND BANNER</label>
              <div className="upload-row">
                <button type="button" className="btn" onClick={() => iconInput.current.click()}>{has('icon') ? 'Change icon' : 'Upload icon'}</button>
                {has('icon') && <button type="button" className="btn" onClick={() => remove('icon')}>Remove icon</button>}
                <button type="button" className="btn" onClick={() => bannerInput.current.click()}>{has('banner') ? 'Change banner' : 'Upload banner'}</button>
                {has('banner') && <button type="button" className="btn" onClick={() => remove('banner')}>Remove banner</button>}
              </div>
            </>
          )}

          {tab === 'theme' && (
            <>
              <h1>Server theme</h1>
              <p className="muted">When someone opens your server, the app fades from their own theme to this one, and fades back when they leave.</p>
              <div className="appearance">
                <label>THEME</label>
                <div className="mode-pick" role="radiogroup" aria-label="Server theme">
                  <button type="button" role="radio" aria-checked={!themeOn} className={!themeOn ? 'on' : ''} onClick={() => setThemeOn(false)}>No server theme</button>
                  <button type="button" role="radio" aria-checked={themeOn} className={themeOn ? 'on' : ''} onClick={() => setThemeOn(true)}>Use a server theme</button>
                </div>

                <label>START FROM A PRESET</label>
                <div className="theme-grid">
                  {THEMES.map((t) => <Swatch key={t.id} theme={t} on={themeOn && sameSeed(theme, seedOf(t))} onPick={() => pickTheme(seedOf(t))} />)}
                </div>

                <label>OR CHOOSE YOUR OWN</label>
                <div className={'custom-theme' + (themeOn ? ' on' : '')}>
                  <div className="mode-pick" role="radiogroup" aria-label="Theme base">
                    {[[false, 'Light base'], [true, 'Dark base']].map(([d, label]) => (
                      <button type="button" role="radio" key={label} aria-checked={theme.dark === d} className={themeOn && theme.dark === d ? 'on' : ''} onClick={() => setSeed({ dark: d })}>{label}</button>
                    ))}
                  </div>
                  <div className="custom-row">
                    <span>Background</span>
                    <input type="color" value={theme.bg} onChange={(e) => setSeed({ bg: e.target.value })} aria-label="Server background colour" />
                    <code>{theme.bg}</code>
                  </div>
                  <div className="custom-row">
                    <span>Accent (buttons, highlights)</span>
                    <input type="color" value={theme.accent} onChange={(e) => setSeed({ accent: e.target.value })} aria-label="Server accent colour" />
                    <code>{theme.accent}</code>
                  </div>
                  <p className="muted small hint">Sidebars, borders, hover and text colours are generated from these two colours, so text stays readable.</p>
                </div>
                <p className="muted small hint">You are previewing this live. It only changes for everyone after you save. People can turn server themes off in their own Appearance settings.</p>
              </div>
            </>
          )}

          {err && <div className="error">{err}</div>}
          <div className="settings-foot">
            <button className="btn" onClick={onClose}>Cancel</button> <button className="btn primary" onClick={save} disabled={saving}>Save changes</button>
          </div>
        </div>
      </main>
    </div>
  );
}
