import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { LANGS, setLang, useLang } from './i18n.js';
import { Avatar } from './ui.jsx';
import { Swatch } from './Appearance.jsx';
import { THEMES, GRADIENT_THEMES, applyTheme, loadTheme } from './themes.js';
import { themeCardStyle, themeGradient } from './profilethemes.js';

// Sign-up in three steps, so the person builds something before they are asked for anything:
//   1  design your profile: username, picture, profile theme and the app theme, with a live card that follows every choice
//   2  email and password
//   3  how to get back in if they forget the password (recovery key and/or email recovery)
// Nothing is sent until step 3. Auth.jsx owns the register call (`onSubmit`), because it also handles the encryption keys and the recovery key screen.
// The design choices (not the email or password) are kept in sessionStorage so a refresh does not throw away what the person made.

const NAME = /^[a-zA-Z0-9_]{3,20}$/; // same rule as the server (POST /api/register)
const HUES = ['#8c6b4f', '#b4553d', '#5f7a55', '#a67c1f', '#4b6a88', '#7a5a7d', '#2a251e']; // the avatar colours the server picks from
const DRAFT = 'aduna-signup-draft';
const LIGHT = THEMES.filter((x) => !x.dark);
const DARK = THEMES.filter((x) => x.dark);
const TABS = [['light', 'suTabLight', LIGHT], ['dark', 'suTabDark', DARK], ['gradient', 'suTabGradient', GRADIENT_THEMES]];
const groupOf = (id) => (id === 'system' ? 'auto' : DARK.some((x) => x.id === id) ? 'dark' : GRADIENT_THEMES.some((x) => x.id === id) ? 'gradient' : 'light');

function readDraft() {
  try { const d = JSON.parse(sessionStorage.getItem(DRAFT) || 'null'); return d && typeof d === 'object' ? d : {}; } catch { return {}; }
}

// True on phone-width screens, so the pinned preview card can use a smaller picture and leave room for the keyboard.
function useNarrow() {
  const q = '(max-width: 779px)';
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const m = matchMedia(q);
    const on = () => setNarrow(m.matches);
    on();
    if (m.addEventListener) m.addEventListener('change', on); else m.addListener(on);
    return () => { if (m.removeEventListener) m.removeEventListener('change', on); else m.removeListener(on); };
  }, []);
  return narrow;
}

const Tick = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8" /></svg>
);

// The profile card as other people will see it. `row` is the small version used on steps 2 and 3.
function Card({ theme, who, name, username, row, compact, t }) {
  const small = row || compact;
  return (
    <div className={'su-card' + (row ? ' row' : '') + (theme ? ' themed' : '')} style={theme ? themeCardStyle(theme) : undefined}>
      <Avatar user={who} size={small ? 44 : 72} />
      <div className="su-card-text">
        <div className={'su-card-name' + (name ? '' : ' empty')}>{name || t('suYourName')}</div>
        <div className="su-card-user">@{username || 'username'}</div>
        {!row && (
          <div className="su-chips">
            <span className="su-chip"><i className="su-live" />{t('st_online')}</span>
            <span className="su-chip">{t('suJustJoined')}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SignupFlow({ mailOk, onSubmit, onLogin }) {
  const { lang, t } = useLang();
  const [draft] = useState(readDraft); // what the person had made before a refresh
  const root = useRef(null);
  const narrow = useNarrow();
  const [step, setStep] = useState(1);

  // step 1
  const [username, setUsername] = useState(typeof draft.username === 'string' ? draft.username.slice(0, 20) : '');
  const [displayName, setDisplayName] = useState(typeof draft.displayName === 'string' ? draft.displayName.slice(0, 32) : '');
  const [avatarLogo, setAvatarLogo] = useState(!!draft.avatarLogo);
  const [avatarColor, setAvatarColor] = useState(() => (HUES.includes(draft.avatarColor) ? draft.avatarColor : HUES[Math.floor(Math.random() * HUES.length)]));
  const [themeId, setThemeId] = useState(typeof draft.themeId === 'string' ? draft.themeId : null);
  const [themes, setThemes] = useState([]);          // the free profile themes, from the server
  const [app, setApp] = useState(loadTheme);         // the app theme settings ({ id, custom, serverThemes }); picking one applies it to this page at once
  const [tab, setTab] = useState(() => groupOf(loadTheme().id));
  const [avail, setAvail] = useState('idle');        // idle | checking | ok | taken | unknown

  // step 2 and 3
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [useKey, setUseKey] = useState(true);
  const [useMail, setUseMail] = useState(false);
  const [err, setErr] = useState(null);              // { step, msg }
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let dead = false;
    api('/signup-themes').then((r) => { if (!dead && Array.isArray(r.themes)) setThemes(r.themes); }).catch(() => { /* the card just stays plain */ });
    return () => { dead = true; };
  }, []);

  useEffect(() => {
    try { sessionStorage.setItem(DRAFT, JSON.stringify({ username, displayName, avatarLogo, avatarColor, themeId })); } catch { /* private mode: nothing is kept */ }
  }, [username, displayName, avatarLogo, avatarColor, themeId]);

  // Ask the server whether the name is free once the person stops typing. The server checks again when the account is made.
  const trimmed = username.trim();
  const valid = NAME.test(trimmed);
  useEffect(() => {
    if (!valid) { setAvail('idle'); return undefined; }
    setAvail('checking');
    let dead = false;
    const timer = setTimeout(() => {
      api('/username-available?u=' + encodeURIComponent(trimmed))
        .then((r) => { if (!dead) setAvail(r.ok ? 'ok' : r.reason === 'format' ? 'idle' : 'taken'); })
        .catch(() => { if (!dead) setAvail('unknown'); });
    }, 350);
    return () => { dead = true; clearTimeout(timer); };
  }, [trimmed, valid]);

  useEffect(() => { root.current?.parentElement?.scrollTo?.(0, 0); }, [step]);

  const theme = themes.find((x) => x.id === themeId) || null;
  const shownName = displayName.trim() || trimmed;
  const who = { username: trimmed || '?', displayName: shownName || '?', avatarColor, avatarLogo };

  function pickApp(id) {
    const next = { ...app, id };
    setApp(next);
    applyTheme(next, { save: true });
  }

  const status = trimmed && !valid ? { c: 'bad', m: t('suUsernameBad') }
    : avail === 'checking' ? { c: '', m: t('suChecking') }
      : avail === 'taken' ? { c: 'bad', m: t('suUsernameTaken') }
        : avail === 'ok' ? { c: 'ok', m: t('suUsernameFree') }
          : { c: '', m: t('suUsernameHint') };
  const canNext = valid && avail !== 'taken' && avail !== 'checking';

  const to1 = (e) => { e.preventDefault(); if (canNext) { setErr(null); setStep(2); } };
  const to2 = (e) => { e.preventDefault(); setErr(null); setStep(3); };

  async function finish(e) {
    e.preventDefault();
    setErr(null);
    if (!useKey && !(useMail && mailOk)) { setErr({ step: 3, msg: 'Pick at least one way to get back into your account.' }); return; }
    setBusy(true);
    try {
      await onSubmit({
        username: trimmed, email: email.trim(), password, useKey, useMail: useMail && mailOk,
        design: { displayName: displayName.trim(), avatarLogo, avatarColor, profileTheme: theme ? theme.id : null },
      });
      try { sessionStorage.removeItem(DRAFT); } catch { /* ignore */ }
    } catch (e2) {
      const msg = e2.message || 'Something went wrong';
      const at = /username/i.test(msg) ? 1 : /email|password/i.test(msg) ? 2 : 3; // take them back to the step the problem belongs to
      setErr({ step: at, msg });
      setStep(at);
    } finally {
      setBusy(false);
    }
  }

  const problem = err && err.step === step ? <div className="error" role="alert">{err.msg}</div> : null;
  const list = (TABS.find(([g]) => g === tab) || TABS[0])[2];

  return (
    <div className="su-wrap" ref={root}>
      <div className="su-top">
        <span className="wordmark" role="img" aria-label="Aduna" />
        <span className="su-pill">{t('suStep', { n: step })}</span>
      </div>
      <div className="su-bars" aria-hidden="true">{[1, 2, 3].map((n) => <i key={n} className={n <= step ? 'on' : ''} />)}</div>

      {step === 1 && (
        <form onSubmit={to1} noValidate>
          <h1 className="su-h">{t('suDesignTitle')}</h1>
          <p className="muted su-sub">{t('suDesignSub')}</p>

          <div className="su-grid">
            <aside className="su-side" aria-label="Preview">
              <Card theme={theme} who={who} name={shownName} username={trimmed} compact={narrow} t={t} />
            </aside>

            <div className="su-main">
              <label htmlFor="su-username">{t('username')}</label>
              <input id="su-username" value={username} onChange={(e) => setUsername(e.target.value.replace(/^@/, ''))} autoFocus required maxLength={20}
                autoComplete="username" autoCapitalize="none" spellCheck={false} aria-describedby="su-username-status" aria-invalid={status.c === 'bad' ? true : undefined} />
              <p id="su-username-status" className={'hint su-status ' + status.c} role="status" aria-live="polite">{status.c === 'ok' && <Tick />}{status.m}</p>

              <label htmlFor="su-display">{t('suDisplayName')}</label>
              <input id="su-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} placeholder={t('suDisplayPh')} autoComplete="off" />

              <label>{t('suAvatar')}</label>
              <div className="mode-pick" role="radiogroup" aria-label={t('suAvatar')}>
                <button type="button" role="radio" aria-checked={!avatarLogo} className={!avatarLogo ? 'on' : ''} onClick={() => setAvatarLogo(false)}>{t('suLetter')}</button>
                <button type="button" role="radio" aria-checked={avatarLogo} className={avatarLogo ? 'on' : ''} onClick={() => setAvatarLogo(true)}>{t('suLogo')}</button>
              </div>
              <div className="su-swatches" role="radiogroup" aria-label={t('suColor')}>
                {HUES.map((c, i) => (
                  <button key={c} type="button" role="radio" aria-checked={avatarColor === c} aria-label={t('suColor') + ' ' + (i + 1)}
                    className={'su-sw dot' + (avatarColor === c ? ' on' : '')} style={{ background: c }} onClick={() => setAvatarColor(c)} />
                ))}
              </div>

              <label>{t('suProfileTheme')}</label>
              <div className="su-swatches" role="radiogroup" aria-label={t('suProfileTheme')}>
                <button type="button" role="radio" aria-checked={!theme} aria-label={t('suPlain')} title={t('suPlain')} className={'su-sw none' + (!theme ? ' on' : '')} onClick={() => setThemeId(null)} />
                {themes.map((x) => (
                  <button key={x.id} type="button" role="radio" aria-checked={themeId === x.id} aria-label={x.name} title={x.name}
                    className={'su-sw' + (themeId === x.id ? ' on' : '')} style={{ backgroundImage: themeGradient(x) }} onClick={() => setThemeId(x.id)} />
                ))}
                <span className="su-cap" aria-hidden="true">{theme ? theme.name : t('suPlain')}</span>
              </div>

              <label>{t('suAppTheme')}</label>
              <div className="mode-pick" role="group" aria-label={t('suAppTheme')}>
                {TABS.map(([g, key]) => (
                  <button key={g} type="button" aria-pressed={tab === g} className={tab === g ? 'on' : ''} onClick={() => setTab(g)}>{t(key)}</button>
                ))}
                <button type="button" aria-pressed={tab === 'auto'} className={tab === 'auto' ? 'on' : ''} onClick={() => { setTab('auto'); pickApp('system'); }}>{t('suTabAuto')}</button>
              </div>
              {tab === 'auto'
                ? <p className="hint">{t('suAutoHint')}</p>
                : <div className="theme-grid su-themes">{list.map((x) => <Swatch key={x.id} theme={x} on={app.id === x.id} onPick={() => pickApp(x.id)} />)}</div>}

              {problem}
              <div className="su-nextbar"><button className="btn primary full su-next" disabled={!canNext}>{t('continue')}</button></div>
              <p className="muted small su-switch">{t('haveAccount')}<a href="#" onClick={(e) => { e.preventDefault(); onLogin(); }}>{t('logInLink')}</a></p>
            </div>
          </div>
        </form>
      )}

      {step === 2 && (
        <form className="su-narrow" onSubmit={to2}>
          <Card row theme={theme} who={who} name={shownName} username={trimmed} t={t} />
          <h1 className="su-h">{t('suAccountTitle')}</h1>
          <p className="muted su-sub">{t('suAccountSub')}</p>

          <label htmlFor="su-email">{t('email')}</label>
          <input id="su-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required autoComplete="email" maxLength={254} placeholder="you@example.com" />
          <p className="hint">{t('emailHint')}</p>

          <label htmlFor="su-password">{t('password')}</label>
          <input id="su-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
          <p className="hint">{t('passwordHint')}</p>

          {problem}
          <div className="su-actions">
            <button type="button" className="btn" onClick={() => { setErr(null); setStep(1); }}>{t('suBack')}</button>
            <button className="btn primary">{t('continue')}</button>
          </div>
        </form>
      )}

      {step === 3 && (
        <form className="su-narrow" onSubmit={finish}>
          <Card row theme={theme} who={who} name={shownName} username={trimmed} t={t} />
          <h1 className="su-h">{t('suSafeTitle')}</h1>
          <p className="muted su-sub">{t('chooseBack')}</p>

          <label className="check-row">
            <input type="checkbox" checked={useKey} onChange={(e) => { if (!e.target.checked && !(useMail && mailOk)) return; setUseKey(e.target.checked); setErr(null); }} />
            <span><strong>{t('keyOptionB')}</strong>{t('keyOptionT')}</span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={useMail && mailOk} disabled={!mailOk} onChange={(e) => { if (!e.target.checked && !useKey) return; setUseMail(e.target.checked); setErr(null); }} />
            <span><strong>{t('mailOptionB')}</strong>{t('mailOptionT')}{!mailOk && t('mailUnavailable')}</span>
          </label>

          {problem}
          <div className="su-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => { setErr(null); setStep(2); }}>{t('suBack')}</button>
            <button className="btn primary" disabled={busy}>{busy ? t('working') : t('suCreate')}</button>
          </div>
        </form>
      )}

      <select className="auth-lang" aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)}>
        {LANGS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
      </select>
    </div>
  );
}
