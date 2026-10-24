import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './ui.jsx';
import { voiceName } from './files.js';

// Recording a voice message with the browser's MediaRecorder. The result is an ordinary audio file (see isVoice in files.js) that the chat
// uploads and sends like any attachment, so DMs stay end-to-end encrypted: the audio is encrypted in the browser before it is uploaded.
export const MAX_VOICE_SECS = 300; // 5 minutes; at this length it stops and sends
const MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
const PLAYABLE = ['audio/webm', 'audio/ogg', 'audio/mp4']; // the audio types the chat plays inline (the server allows the same list)

export const voiceSupported = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
const pickMime = () => MIMES.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

// Starts recording as soon as it appears. onSend(file, onProgress) uploads and sends it (and closes this bar when it works, by the parent
// hiding it); onCancel() closes it. A send that fails keeps the recording here so it can be retried.
export default function VoiceRecorder({ onSend, onCancel }) {
  const [phase, setPhase] = useState('starting'); // starting (waiting for the microphone) | recording | sending | failed
  const [secs, setSecs] = useState(0);
  const [prog, setProg] = useState(0);
  const [err, setErr] = useState('');
  const [retry, setRetry] = useState(null); // the recorded file, kept so a failed send can be tried again
  const s = useRef({ rec: null, stream: null, chunks: [], t0: 0, timer: null, dead: false });
  const props = useRef({});
  props.current = { onSend, onCancel };

  const fail = (msg) => { if (!s.current.dead) { setErr(msg); setRetry(null); setPhase('failed'); } };
  const send = async (file) => {
    setPhase('sending'); setProg(0); setErr(''); setRetry(file);
    try { await props.current.onSend(file, setProg); }
    catch (e) { if (!s.current.dead) { setErr(e?.message || 'Could not send the voice message'); setPhase('failed'); } }
  };
  const release = () => { const c = s.current; clearInterval(c.timer); c.stream?.getTracks().forEach((t) => t.stop()); };
  const stop = () => { const c = s.current; if (c.rec && c.rec.state === 'recording') c.rec.stop(); };
  const finish = () => {
    const c = s.current;
    const type = String(c.rec?.mimeType || '').split(';')[0] || 'audio/webm'; // 'audio/webm;codecs=opus' -> 'audio/webm' (the server matches the plain type)
    const dur = (Date.now() - c.t0) / 1000;
    if (!PLAYABLE.includes(type)) return fail('This browser records in a format that cannot be played in chat yet.');
    if (dur < 1 || !c.chunks.length) return fail('That was too short. Hold on a little longer.');
    send(new File([new Blob(c.chunks, { type })], voiceName(dur, type), { type }));
  };

  useEffect(() => {
    const c = s.current;
    c.dead = false;
    (async () => {
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch (e) { fail(e?.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it in your browser settings to record.' : 'Could not use the microphone.'); return; }
      if (c.dead) { stream.getTracks().forEach((t) => t.stop()); return; }
      c.stream = stream;
      const mime = pickMime();
      let rec;
      try { rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 }); } catch { rec = new MediaRecorder(stream); }
      c.rec = rec; c.chunks = [];
      rec.ondataavailable = (e) => { if (e.data?.size) c.chunks.push(e.data); };
      rec.onstop = () => { release(); if (!c.dead) finish(); };
      rec.start(1000);
      c.t0 = Date.now();
      c.timer = setInterval(() => { const n = (Date.now() - c.t0) / 1000; setSecs(n); if (n >= MAX_VOICE_SECS) stop(); }, 200);
      setPhase('recording');
    })();
    return () => { // closed (cancelled, sent, or you switched chats): stop recording and let go of the microphone
      c.dead = true;
      clearInterval(c.timer);
      try { if (c.rec && c.rec.state !== 'inactive') c.rec.stop(); } catch { /* already stopped */ }
      c.stream?.getTracks().forEach((t) => t.stop());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' && phase !== 'sending') props.current.onCancel(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [phase]);

  return (
    <div className={'voice-rec ' + phase} role="group" aria-label="Voice message">
      <button className="icon-btn" title="Discard" aria-label="Discard voice message" onClick={onCancel} disabled={phase === 'sending'}><Icon name="trash" size={19} /></button>
      {phase === 'failed'
        ? <span className="voice-err error-text" role="alert">{err}</span>
        : <>
          <span className={'rec-dot' + (phase === 'recording' ? ' live' : '')} />
          <span className="rec-time">{clock(secs)}</span>
          <span className="muted small" aria-live="polite">{phase === 'starting' ? 'Allow the microphone…' : phase === 'sending' ? `Sending ${Math.round(prog * 100)}%` : 'Recording'}</span>
          <span style={{ flex: 1 }} />
        </>}
      {phase === 'failed'
        ? (retry && <button className="btn small-btn" onClick={() => send(retry)}>Retry</button>)
        : <button className="icon-btn rec-send" title="Send voice message" aria-label="Send voice message" onClick={stop} disabled={phase !== 'recording'}><Icon name="send" size={19} /></button>}
    </div>
  );
}
