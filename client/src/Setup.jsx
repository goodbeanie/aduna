import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { LANGS, setLang, useLang } from './i18n.js';

// The language choices, shared by the first-time setup and Settings > Language. Picking one switches the whole app straight away.
function LangList({ value, onPick, disabled }) {
  return (
    <div className="lang-list" role="radiogroup" aria-label="Language">
      {LANGS.map(([code, name]) => (
        <button key={code} type="button" role="radio" aria-checked={value === code} lang={code} disabled={disabled}
          className={'lang-opt' + (value === code ? ' on' : '')} onClick={() => onPick(code)}>
          <span className="lang-dot" aria-hidden="true" />{name}
        </button>
      ))}
    </div>
  );
}

// Shown once after sign-up, before the app opens: language, and whether to join the official Aduna server.
export default function Setup({ onDone, onLogout }) {
  const { lang, t } = useLang();
  const [join, setJoin] = useState(true);
  const [hasAduna, setHasAduna] = useState(true); // false when the server has no official Aduna server to offer
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api('/auth-options').then((o) => setHasAduna(o.adunaServer !== false)).catch(() => {}); }, []);

  async function finish(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try { onDone((await api('/me/setup', { method: 'POST', body: { lang, joinAduna: hasAduna && join } })).user); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="auth-bg">
      <form className="auth-card" onSubmit={finish}>
        <img className="wordmark" src="/aduna-wordmark.png" alt="Aduna" width="190" />
        <h1>{t('setupTitle')}</h1>
        <p className="muted center">{t('setupSub')}</p>

        <label>{t('language')}</label>
        <LangList value={lang} onPick={setLang} disabled={busy} />

        {hasAduna && (
          <label className="check-row setup-join">
            <input type="checkbox" checked={join} onChange={(e) => setJoin(e.target.checked)} disabled={busy} />
            <span><strong>{t('joinAduna')}</strong><span className="hint setup-hint">{t('joinAdunaHint')}</span></span>
          </label>
        )}

        {error && <div className="error">{error}</div>}
        <button className="btn primary full" disabled={busy}>{busy ? t('saving') : t('finish')}</button>
        {onLogout && <p className="muted small"><a href="#" onClick={(e) => { e.preventDefault(); onLogout(); }}>{t('logOut')}</a></p>}
      </form>
    </div>
  );
}

// Settings > Language: the same list, saved on the account so it follows you to other devices.
export function LanguageSettings({ me, onSaved }) {
  const { lang, t } = useLang();
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function pick(code) {
    const before = lang;
    setError(''); setSaved(false); setLang(code); // the screen changes at once; the account follows
    try { onSaved((await api('/me', { method: 'PATCH', body: { lang: code } })).user); setSaved(true); }
    catch (err) { setLang(before); setError(err.message); }
  }
  return (
    <div className="lang-settings">
      <p className="muted small hint">{t('langHelp')}</p>
      <LangList value={lang} onPick={pick} />
      {saved && <p className="muted small" role="status">{t('langSaved')}</p>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
