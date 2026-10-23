import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './ui.jsx';
import { useLang } from './i18n.js';
import { levelOf } from './speaking.js';
import * as snd from './callsound.js';
import { loadDevices, saveDevices, listDevices, onDeviceChange, canPickOutput, micConstraint, camConstraint, applyOutput } from './devices.js';

// Settings > Voice & Video: pick the microphone, camera and speakers, and try each one.
// What is chosen here is used by the next call or voice-channel join (the speakers also change in a call that is already running).
export function VoiceSettings() {
  const { t } = useLang();
  const [sel, setSel] = useState(loadDevices);
  const [list, setList] = useState({ mics: [], cams: [], outs: [], labelled: true });
  const [note, setNote] = useState('');
  const [micTest, setMicTest] = useState(false);
  const [camTest, setCamTest] = useState(false);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const videoRef = useRef(null);
  const micRef = useRef(null), camRef = useRef(null);

  const refresh = useCallback(() => listDevices().then(setList).catch(() => {}), []);
  useEffect(() => { refresh(); return onDeviceChange(refresh); }, [refresh]);

  const choose = (key, id) => { setSel(saveDevices({ [key]: id })); setNote(''); };

  // Browsers hide device names until the microphone has been allowed once.
  const allow = async () => {
    setNote('');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((x) => x.stop());
      refresh();
    } catch (e) { setNote(e.name === 'NotAllowedError' ? 'Permission was denied. Allow the microphone for this site in your browser settings.' : 'No microphone found.'); }
  };

  // ----- microphone test: a level bar that follows your voice (nothing is played back or sent anywhere) -----
  const stopMic = () => { const m = micRef.current; micRef.current = null; if (m) { clearInterval(m.timer); try { m.src.disconnect(); } catch { /* gone */ } m.stream.getTracks().forEach((x) => x.stop()); } setLevel(0); };
  useEffect(() => {
    if (!micTest) return undefined;
    let dead = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, ...micConstraint(sel) } });
        if (dead) { stream.getTracks().forEach((x) => x.stop()); return; }
        const c = snd.ctx(), node = c.createAnalyser(); node.fftSize = 512;
        const src = c.createMediaStreamSource(stream); src.connect(node);
        const bytes = new Uint8Array(node.fftSize);
        const timer = setInterval(() => { node.getByteTimeDomainData(bytes); setLevel(Math.min(1, levelOf(bytes) * 5)); }, 70);
        micRef.current = { stream, src, timer };
        refresh();
      } catch (e) { setMicTest(false); setNote(e.name === 'NotAllowedError' ? 'Microphone permission was denied.' : 'Could not open that microphone.'); }
    })();
    return () => { dead = true; stopMic(); };
  }, [micTest, sel.mic]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- camera test: a live preview -----
  useEffect(() => {
    if (!camTest) return undefined;
    let dead = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...camConstraint(sel) } });
        if (dead) { stream.getTracks().forEach((x) => x.stop()); return; }
        camRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        refresh();
      } catch (e) { setCamTest(false); setNote(e.name === 'NotAllowedError' ? 'Camera permission was denied.' : e.name === 'NotFoundError' ? 'No camera found.' : 'Could not open that camera.'); }
    })();
    return () => { dead = true; camRef.current?.getTracks().forEach((x) => x.stop()); camRef.current = null; if (videoRef.current) videoRef.current.srcObject = null; };
  }, [camTest, sel.cam]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- speaker test: today's ringtone once, through the chosen speakers -----
  const toggleTest = () => {
    setNote('');
    if (testing) { snd.stopTest(); return; }
    setTesting(true);
    snd.testSpeakers((why) => {
      setTesting(false);
      if (why === 'error') setNote('This device could not play the test sound. If Aduna was just updated, reload it.');
      if (why === 'blocked') setNote('The browser blocked the sound. Press the button again.');
    });
  };
  useEffect(() => () => { snd.stopTest(); }, []);
  useEffect(() => { if (testing) snd.stopTest(); }, [sel.out]); // eslint-disable-line react-hooks/exhaustive-deps -- a new speaker choice restarts the test on the next press

  const pick = (key, items, value, none) => (
    <select className="dev-select" value={items.some((d) => d.id === value) ? value : ''} onChange={(e) => choose(key, e.target.value)}>
      <option value="">{none}</option>
      {items.filter((d) => d.id !== 'default' && d.id !== '').map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
    </select>
  );

  return (
    <div className="voice-settings">
      {!list.labelled && (
        <p className="muted small hint">Your browser hides device names until you allow the microphone once. <button type="button" className="link-btn" onClick={allow}>Allow microphone</button></p>
      )}
      {note && <p className="small" role="alert" style={{ color: 'var(--err-fg)' }}>{note}</p>}

      <label>{t('vvMic')}</label>
      {pick('mic', list.mics, sel.mic, t('vvDefault'))}
      <div className="dev-row">
        <button type="button" className="btn" onClick={() => setMicTest(!micTest)} aria-pressed={micTest}><Icon name="mic" size={16} /> {micTest ? t('vvStop') : t('vvTestMic')}</button>
        <div className="dev-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}><i style={{ width: Math.round(level * 100) + '%' }} /></div>
      </div>
      <p className="muted small hint">{micTest ? t('vvMicOn') : t('vvMicHint')}</p>

      <label>{t('vvOut')}</label>
      {canPickOutput()
        ? pick('out', list.outs, sel.out, t('vvDefault'))
        : <p className="muted small hint">{t('vvNoOut')}</p>}
      <div className="dev-row">
        <button type="button" className="btn" onClick={toggleTest} aria-pressed={testing}><Icon name="speaker" size={16} /> {testing ? t('vvStop') : t('vvTestSpk')}</button>
      </div>
      <p className="muted small hint">{t('vvSpkHint')}</p>

      <label>{t('vvCam')}</label>
      {pick('cam', list.cams, sel.cam, t('vvDefault'))}
      <div className="dev-row">
        <button type="button" className="btn" onClick={() => setCamTest(!camTest)} aria-pressed={camTest}><Icon name="video" size={16} /> {camTest ? t('vvStop') : t('vvTestCam')}</button>
      </div>
      {camTest && <video ref={videoRef} className="dev-preview" autoPlay playsInline muted />}
      <p className="muted small hint">{t('vvApply')}</p>
    </div>
  );
}
