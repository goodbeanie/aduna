import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { useLang } from './i18n.js';

// "Playing ..." on a profile. The server (server/activity.js) decides who may see a game: nothing arrives here when the person turned it
// off, is offline or is Invisible, so showing `user.activity` whenever it is there is enough.

// "25m" / "2h" / "2h 5m"; empty for under a minute.
export function playingFor(since, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - since) / 60000));
  if (m < 1) return '';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
}

// Desktop app only: the app finds a known game running (desktop/games.js) and this passes it on to Aduna, like Discord's "Playing ...".
// It sends the game when it starts, again every minute while it runs (the server drops an auto game that goes quiet for 4 minutes),
// and clears it when the game closes. Nothing is sent when the person turned "Show what I'm playing" off. A name the server refuses is not retried.
export function useGameDetection(userId, enabled) {
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.adunaDesktop?.game : undefined;
    if (!bridge || !userId || !enabled) return undefined;
    let current = null, timer = 0, stopped = false, reported = false;
    const refused = new Set();
    const send = async () => {
      if (stopped) return;
      try {
        if (current) {
          if (refused.has(current)) return;
          await api('/me/activity', { method: 'PUT', body: { name: current, source: 'auto' } });
          reported = true;
        } else if (reported) {
          await api('/me/activity', { method: 'PUT', body: { name: null, source: 'auto' } });
          reported = false;
        }
      } catch (e) {
        if (current && e && e.status === 400) refused.add(current); // not an allowed name: stop trying it (429 and network errors retry next minute)
      }
    };
    const off = bridge.onChange((name) => {
      if (name === current) return;
      current = name;
      clearInterval(timer);
      timer = name ? setInterval(send, 60000) : 0;
      send();
    });
    return () => {
      stopped = true; clearInterval(timer); off();
      if (reported) api('/me/activity', { method: 'PUT', body: { name: null, source: 'auto' } }).catch(() => {}); // logged out or turned off: do not leave the game showing
    };
  }, [userId, enabled]);
}

// The block on the profile card. `activity` is { name, since, source } or null.
export function PlayingLine({ activity }) {
  const { t } = useLang();
  const [, tick] = useState(0);
  useEffect(() => { // keep the "for 25m" fresh while the card stays open
    if (!activity) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, [activity]);
  if (!activity || !activity.name) return null;
  const dur = playingFor(activity.since);
  return (
    <>
      <h4>{t('playingLbl')}</h4>
      <p className="playing-line"><b>{activity.name}</b>{dur && <span className="muted"> · {t('playingFor', { time: dur })}</span>}</p>
    </>
  );
}

// Settings > Activity: the switch that hides it, and a way to type a game by hand (the desktop app can also report one).
export function ActivitySettings({ me, onSaved }) {
  const { t } = useLang();
  const on = me.showActivity !== false;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const current = on && me.activity && me.activity.name ? me.activity : null;

  async function toggle(next) {
    setBusy(true); setErr('');
    try {
      const { user } = await api('/me', { method: 'PATCH', body: { showActivity: next } });
      onSaved(user); // turning it off also removes the game on the server straight away
    } catch (e) { setErr(e.message || t('actCantSave')); } finally { setBusy(false); }
  }

  async function setGame(e) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true); setErr('');
    try {
      const r = await api('/me/activity', { method: 'PUT', body: { name: n, source: 'manual' } });
      if (r.off) { setErr(t('actIsOff')); return; }
      onSaved({ ...me, activity: r.activity });
      setName('');
    } catch (ex) { setErr(ex.message || t('actCantSave')); } finally { setBusy(false); }
  }

  async function clearGame() {
    setBusy(true); setErr('');
    try {
      const r = await api('/me/activity', { method: 'PUT', body: { name: null, source: 'manual' } });
      onSaved({ ...me, activity: r.activity });
    } catch (ex) { setErr(ex.message || t('actCantSave')); } finally { setBusy(false); }
  }

  return (
    <div className="activity-settings">
      <label className="check-row">
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => toggle(e.target.checked)} />
        <span>{t('actToggle')}</span>
      </label>
      <p className="muted small hint">{t('actHint')}</p>
      {typeof window !== 'undefined' && window.adunaDesktop?.game && <p className="muted small hint">{t('actAutoHint')}</p>}

      {on && (
        <>
          <label htmlFor="act-name">{t('actNow')}</label>
          {current
            ? <p>{current.name}{playingFor(current.since) && <span className="muted"> · {t('playingFor', { time: playingFor(current.since) })}</span>}{current.source === 'auto' && <span className="muted"> · {t('actDetected')}</span>}{' '}{current.source !== 'auto' && <button type="button" className="btn" disabled={busy} onClick={clearGame}>{t('actClear')}</button>}</p>
            : <p className="muted small">{t('actNone')}</p>}
          <form onSubmit={setGame} className="link-row">
            <input id="act-name" value={name} maxLength={64} placeholder={t('actPlaceholder')} onChange={(e) => { setName(e.target.value); setErr(''); }} />
            <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{t('actSet')}</button>
          </form>
          <p className="muted small hint">{t('actManualHint')}</p>
        </>
      )}
      {err && <p className="error-text" role="alert">{err}</p>}
    </div>
  );
}
