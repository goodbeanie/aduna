import React, { useState, useEffect } from 'react';
import { api, markSignedIn, endSession } from './api.js';
import { newDeviceRequest, openSealedIdentity, saveKey } from './crypto.js';
import { useLang } from './i18n.js';

// "Log in with another device" (the new device's side; server/devicelogin.js explains the idea). This device shows a short code. On a
// device that is already signed in, the person types it under Settings > Security > "Approve a sign-in" and confirms with their
// password. That device locks the encryption key to the throwaway key made here, so only this screen can open it.
export function DeviceSignIn({ onAuthed, onBack }) {
  const { t } = useLang();
  const [phase, setPhase] = useState('starting'); // starting | waiting | denied | expired | error
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [round, setRound] = useState(0); // goes up to ask for a fresh code

  useEffect(() => {
    let stop = false, timer = 0;
    setPhase('starting'); setError(''); setCode('');
    (async () => {
      try {
        const k = await newDeviceRequest();
        const r = await api('/device-login/start', { method: 'POST', body: { publicKey: k.publicKey } });
        if (stop) return;
        setCode(r.code); setPhase('waiting');
        const tick = async () => {
          if (stop) return;
          try {
            const p = await api('/device-login/poll', { method: 'POST', body: { id: r.id } });
            if (stop) return;
            if (p.status === 'approved') {
              markSignedIn(true);
              try {
                const privateKey = await openSealedIdentity(p.sealed, k.privateKey, p.user.publicKey);
                await saveKey(p.user.id, privateKey);
                onAuthed(p.user, privateKey);
              } catch {
                endSession(); // the session was made, but the key did not open: do not leave it behind
                setError('The other device answered, but the encryption key could not be opened here. Try again.'); setPhase('error');
              }
              return;
            }
            if (p.status === 'denied') { setPhase('denied'); return; }
            if (p.status === 'expired') { setPhase('expired'); return; }
          } catch (e) {
            if (stop) return;
            if (e.status && e.status !== 429) { setError(e.message || 'Something went wrong.'); setPhase('error'); return; }
            // no answer (offline for a moment) or "slow down": just ask again
          }
          timer = setTimeout(tick, 2500);
        };
        timer = setTimeout(tick, 2500);
      } catch (e) {
        if (!stop) { setError(e.message || 'Something went wrong.'); setPhase('error'); }
      }
    })();
    return () => { stop = true; clearTimeout(timer); };
  }, [round]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <span className="wordmark" role="img" aria-label="Aduna" />
      <h1>{t('deviceTitle')}</h1>
      <p className="muted center">{t('deviceHelp')}</p>
      {phase === 'starting' && <p className="muted center" role="status">{t('working')}</p>}
      {phase === 'waiting' && (
        <>
          <div className="device-code" role="status" aria-label={'Your code is ' + code}>{code}</div>
          <p className="hint center">{t('deviceWaiting')}</p>
        </>
      )}
      {phase === 'denied' && <div className="error">The other device said no. If that was a mistake, ask for a new code.</div>}
      {phase === 'expired' && <div className="error">That code expired. Ask for a new one.</div>}
      {phase === 'error' && <div className="error">{error}</div>}
      {(phase === 'denied' || phase === 'expired' || phase === 'error') && <button type="button" className="btn primary full" onClick={() => setRound((n) => n + 1)}>{t('deviceNew')}</button>}
      <button type="button" className="btn full" onClick={onBack}>{t('backToLogin')}</button>
    </>
  );
}
