import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, Icon } from './ui.jsx';
import { api, emitAck } from './api.js';
import { encryptFor, decryptFrom } from './crypto.js';

// ---------- ringtones (generated, no audio files) ----------
let audioCtx = null, ringTimer = null;
function ctx() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
function beep(freq, dur) {
  try {
    const c = ctx(), o = c.createOscillator(), g = c.createGain();
    o.frequency.value = freq; g.gain.value = 0.04;
    o.connect(g); g.connect(c.destination);
    o.start(); o.stop(c.currentTime + dur);
  } catch { /* sound is best effort */ }
}
// Browsers keep sound blocked until the page has had a click or key press, which made incoming calls
// ring silently. Unlock audio on the first interaction, and ask once to show desktop notifications.
if (typeof window !== 'undefined') {
  const unlock = () => {
    try { ctx(); } catch { /* no audio support */ }
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* not supported */ }
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}
// While a call is ringing the tab title flashes, and a desktop notification shows if the tab is hidden.
let titleTimer = null, titleBase = '', notif = null;
function alertIncoming(name, video) {
  clearAlert();
  titleBase = document.title;
  let on = false;
  titleTimer = setInterval(() => { on = !on; document.title = on ? `\u{1F4DE} ${name} is calling…` : titleBase; }, 900);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      notif = new Notification(`${name} is calling`, { body: `Incoming ${video ? 'video' : 'voice'} call`, tag: 'aduna-call', requireInteraction: true, icon: '/aduna-icon.png' });
      notif.onclick = () => { window.focus(); notif?.close(); };
    } catch { /* notifications are best effort */ }
  }
}
function clearAlert() {
  clearInterval(titleTimer); titleTimer = null;
  if (titleBase) document.title = titleBase;
  titleBase = '';
  try { notif?.close(); } catch { /* already closed */ }
  notif = null;
}
function startRing(kind) {
  stopRing();
  const play = kind === 'in' ? () => { beep(440, 0.35); setTimeout(() => beep(520, 0.35), 420); } : () => beep(425, 0.8);
  play();
  ringTimer = setInterval(play, kind === 'in' ? 2200 : 3000);
}
function stopRing() { clearInterval(ringTimer); ringTimer = null; clearAlert(); }

const IDLE = { phase: 'idle', callId: null, peerId: null, video: false, startedAt: 0, muted: false, camOn: false, sharing: false, preview: null, remote: null, peerState: {}, rev: 0, notice: '' };

async function getMedia(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Calls need a secure page (https or localhost) and a modern browser');
  const audio = { echoCancellation: true, noiseSuppression: true };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false });
  } catch (e) {
    if (video && (e.name === 'NotFoundError' || e.name === 'NotReadableError' || e.name === 'OverconstrainedError')) {
      try { return await navigator.mediaDevices.getUserMedia({ audio, video: false }); } catch (e2) { e = e2; }
    }
    throw new Error(e.name === 'NotAllowedError' ? 'Microphone or camera permission was denied'
      : e.name === 'NotFoundError' ? 'No microphone found' : 'Could not access your microphone or camera');
  }
}

// One-to-one calls. Media goes straight between the browsers (WebRTC). The server only rings and relays
// signalling, and the signalling is encrypted with the conversation key, so it cannot read or alter it.
// Offers use the "perfect negotiation" pattern so either side can add video or share a screen mid-call.
export function useCall({ socketRef, privKey, getUser }) {
  const [call, setCall] = useState(IDLE);
  const cRef = useRef(IDLE);
  const rt = useRef({ pc: null, local: null, remote: null, cam: null, screen: null, vsender: null, polite: false, makingOffer: false, ignoreOffer: false, cands: [], tracksAdded: false, chain: Promise.resolve() });

  const set = (patch) => { cRef.current = { ...cRef.current, ...patch }; setCall(cRef.current); };
  const bump = () => set({ rev: cRef.current.rev + 1 });

  function teardown() {
    const r = rt.current;
    stopRing();
    r.local?.getTracks().forEach((t) => t.stop());
    r.screen?.stop();
    r.cam?.stop();
    try { r.pc?.close(); } catch { /* already closed */ }
    Object.assign(r, { pc: null, local: null, remote: null, cam: null, screen: null, vsender: null, cands: [], tracksAdded: false, makingOffer: false, ignoreOffer: false, chain: Promise.resolve() });
  }
  const finish = (notice = '') => { teardown(); cRef.current = { ...IDLE, notice }; setCall(cRef.current); };
  const nameOf = (id) => getUser(id)?.displayName || 'Someone';

  async function send(data) {
    const c = cRef.current, peer = getUser(c.peerId);
    if (!c.callId || !peer) return;
    const enc = await encryptFor(privKey, peer.publicKey, JSON.stringify(data));
    socketRef.current?.emit('call:signal', { callId: c.callId, data: enc });
  }

  const outgoingTrack = () => {
    const r = rt.current;
    if (r.screen && r.screen.readyState === 'live') return r.screen;
    return r.cam && r.cam.enabled && r.cam.readyState === 'live' ? r.cam : null;
  };
  function announce() {
    const t = outgoingTrack();
    set({ preview: t ? new MediaStream([t]) : null, camOn: !!t });
    send({ state: { cam: !!t, mic: !cRef.current.muted, sharing: !!rt.current.screen } }).catch(() => {});
  }

  function addLocalTracks() {
    const r = rt.current;
    r.tracksAdded = true;
    for (const t of r.local.getTracks()) {
      const s = r.pc.addTrack(t, r.local);
      if (t.kind === 'video') { r.vsender = s; r.cam = t; }
    }
  }

  async function beginPeer() {
    const r = rt.current;
    let ice = [{ urls: 'stun:stun.l.google.com:19302' }]; // without any STUN server, calls only work on the same network
    try { ice = (await api('/call/config')).iceServers; } catch { /* keep the fallback above */ }
    const pc = new RTCPeerConnection({ iceServers: ice });
    r.pc = pc; r.remote = new MediaStream();
    pc.onicecandidate = (e) => { if (e.candidate) send({ candidate: e.candidate }).catch(() => {}); };
    pc.ontrack = (e) => {
      if (!r.remote.getTracks().includes(e.track)) r.remote.addTrack(e.track);
      e.track.onmute = e.track.onunmute = bump;
      set({ remote: r.remote }); bump();
    };
    pc.onnegotiationneeded = async () => {
      try { r.makingOffer = true; await pc.setLocalDescription(); await send({ description: pc.localDescription }); }
      catch (e) { console.warn('negotiation failed', e); } finally { r.makingOffer = false; }
    };
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === 'connected' || st === 'completed') { if (cRef.current.phase !== 'active') set({ phase: 'active', startedAt: Date.now() }); }
      else if (st === 'failed') hangup('Connection failed. A firewall may be blocking the call.');
      else if (st === 'disconnected') setTimeout(() => { if (rt.current.pc === pc && pc.iceConnectionState === 'disconnected') hangup('Connection lost'); }, 8000);
    };
    set({ remote: r.remote });
  }

  async function onSignal({ callId, data }) {
    const c = cRef.current, r = rt.current;
    if (!c.callId || callId !== c.callId || !r.pc) return;
    const pc = r.pc;
    let d;
    try { d = JSON.parse(await decryptFrom(privKey, getUser(c.peerId).publicKey, data.ciphertext, data.iv)); } catch { return; }
    if (d.state) set({ peerState: d.state });
    if (d.description) {
      const collision = d.description.type === 'offer' && (r.makingOffer || pc.signalingState !== 'stable');
      r.ignoreOffer = !r.polite && collision;
      if (r.ignoreOffer) return;
      await pc.setRemoteDescription(d.description);
      for (const cand of r.cands.splice(0)) await pc.addIceCandidate(cand).catch(() => {});
      if (d.description.type === 'offer') {
        if (!r.tracksAdded) addLocalTracks(); // reuses the transceivers from the offer, so no extra round trip
        await pc.setLocalDescription();
        await send({ description: pc.localDescription });
        announce();
      }
    } else if (d.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(d.candidate).catch(() => {});
      else r.cands.push(d.candidate);
    }
  }

  // ----- actions -----
  async function startCall(peerId, video) {
    if (cRef.current.phase !== 'idle') return;
    cRef.current = { ...IDLE, phase: 'starting', peerId, video };
    setCall(cRef.current);
    try {
      rt.current.local = await getMedia(video);
      const hasCam = rt.current.local.getVideoTracks().length > 0;
      const r = await emitAck(socketRef.current, 'call:invite', { to: peerId, video: hasCam });
      set({ phase: 'outgoing', callId: r.callId, video: hasCam, camOn: hasCam, preview: hasCam ? new MediaStream(rt.current.local.getVideoTracks()) : null });
      startRing('out');
    } catch (e) { finish(e.message); }
  }

  async function accept() {
    const c = cRef.current;
    if (c.phase !== 'incoming') return;
    stopRing();
    set({ phase: 'connecting' });
    try {
      rt.current.local = await getMedia(c.video);
      rt.current.polite = true;
      await beginPeer();
      await emitAck(socketRef.current, 'call:accept', { callId: c.callId });
      const cam = rt.current.local.getVideoTracks();
      set({ camOn: cam.length > 0, preview: cam.length ? new MediaStream(cam) : null });
    } catch (e) {
      socketRef.current?.emit('call:decline', { callId: c.callId });
      finish(e.message);
    }
  }

  function hangup(notice = '') {
    const c = cRef.current;
    if (c.callId) socketRef.current?.emit(c.phase === 'incoming' ? 'call:decline' : 'call:hangup', { callId: c.callId });
    finish(notice);
  }

  function toggleMute() {
    const muted = !cRef.current.muted;
    rt.current.local?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    set({ muted });
    announce();
  }

  async function toggleCamera() {
    const r = rt.current;
    try {
      if (r.cam && r.cam.readyState === 'live') { r.cam.enabled = !r.cam.enabled; }
      else {
        const t = (await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0];
        r.cam = t; r.local.addTrack(t);
        if (r.vsender) await r.vsender.replaceTrack(r.screen || t); else r.vsender = r.pc.addTrack(t, r.local);
      }
      announce();
    } catch (e) { set({ notice: e.name === 'NotAllowedError' ? 'Camera permission was denied' : 'Could not start the camera' }); }
  }

  async function stopShare() {
    const r = rt.current, t = r.screen;
    if (!t) return;
    r.screen = null; t.stop();
    const back = r.cam && r.cam.readyState === 'live' ? r.cam : null;
    if (r.vsender) await r.vsender.replaceTrack(back).catch(() => {});
    set({ sharing: false });
    announce();
  }

  async function toggleShare() {
    const r = rt.current;
    if (r.screen) return stopShare();
    if (!navigator.mediaDevices?.getDisplayMedia) return set({ notice: 'Screen sharing is not supported in this browser' });
    try {
      const t = (await navigator.mediaDevices.getDisplayMedia({ video: true })).getVideoTracks()[0];
      r.screen = t; t.onended = () => stopShare();
      if (r.vsender) await r.vsender.replaceTrack(t); else r.vsender = r.pc.addTrack(t, r.local);
      set({ sharing: true });
      announce();
    } catch { /* the picker was cancelled */ }
  }

  // ----- socket events -----
  const handleRef = useRef(null);
  handleRef.current = (ev, p) => {
    const c = cRef.current;
    if (ev === 'call:incoming') {
      if (c.phase !== 'idle') return;
      cRef.current = { ...IDLE, phase: 'incoming', callId: p.callId, peerId: p.from, video: p.video };
      setCall(cRef.current);
      startRing('in');
      alertIncoming(nameOf(p.from), p.video);
    } else if (ev === 'call:accepted') {
      if (p.callId !== c.callId || c.phase !== 'outgoing') return;
      stopRing();
      set({ phase: 'connecting' });
      rt.current.polite = false;
      beginPeer().then(addLocalTracks).catch((e) => hangup(e.message));
    } else if (ev === 'call:signal') {
      rt.current.chain = rt.current.chain.then(() => onSignal(p)).catch((e) => console.warn('signal failed', e));
    } else if (ev === 'call:handled') {
      if (c.phase === 'incoming' && c.callId === p.callId) finish();
    } else if (ev === 'call:ended') {
      if (!c.callId || p.callId !== c.callId) return;
      const who = nameOf(c.peerId);
      const incoming = c.phase === 'incoming';
      const secs = c.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) : 0;
      finish({
        declined: `${who} declined the call`,
        missed: incoming ? `Missed call from ${who}` : `${who} did not answer`,
        cancelled: incoming ? `Missed call from ${who}` : '',
        hangup: secs ? `Call ended (${fmt(secs)})` : 'Call ended',
        dropped: 'The call was disconnected',
      }[p.reason] || 'Call ended');
    } else if (ev === 'disconnect') {
      if (c.phase !== 'idle') finish('Connection lost');
    }
  };
  const handle = useCallback((ev, p) => handleRef.current(ev, p), []);
  useEffect(() => () => { teardown(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { call, handle, actions: { startCall, accept, hangup: () => hangup(), toggleMute, toggleCamera, toggleShare, clearNotice: () => set({ notice: '' }) } };
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function VideoEl({ stream, muted, className }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream || null; }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

const callName = (u) => u?.displayName || 'Someone';

// A bar docked on the right edge of the window (like Discord's side panel). Incoming calls ring inside
// it with Accept / Decline, and it turns into the call view once you pick up.
export function CallUI({ call, actions, users, me }) {
  const [big, setBig] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!call.notice) return undefined;
    const t = setTimeout(actions.clearNotice, 5000);
    return () => clearTimeout(t);
  }, [call.notice]); // eslint-disable-line react-hooks/exhaustive-deps

  // phones: video calls open full screen, voice calls become a slim strip you can expand
  useEffect(() => {
    if (call.phase === 'idle') setBig(false);
    else if (call.phase === 'outgoing' || call.phase === 'connecting') setBig(!!window.matchMedia?.('(max-width: 720px)').matches && !!call.video);
  }, [call.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const peer = users[call.peerId];
  const toast = call.notice && <div className="call-toast" role="status">{call.notice}</div>;
  if (call.phase === 'idle') return toast || null;

  const kind = call.video ? 'video' : 'voice';

  if (call.phase === 'incoming') {
    return (
      <>
        {toast}
        <aside className="call-bar ringing" role="alertdialog" aria-label="Incoming call">
          <div className="call-bar-head"><span className="call-dot ring" /><b>Incoming {kind} call</b></div>
          <div className="call-ring">
            <div className="call-pulse"><Avatar user={peer} size={96} /></div>
            <div className="call-ring-name">{callName(peer)}</div>
            <span className="muted">is calling you…</span>
            <div className="call-ring-actions">
              <button className="call-pill decline" onClick={actions.hangup}><Icon name="phone" size={18} style={{ transform: 'rotate(135deg)' }} />Decline</button>
              <button className="call-pill accept" onClick={actions.accept}><Icon name={call.video ? 'video' : 'phone'} size={18} />Accept</button>
            </div>
          </div>
        </aside>
      </>
    );
  }

  const remoteVideo = call.remote && call.remote.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted) && call.peerState.cam !== false;
  const live = call.phase === 'active';
  const status = live ? fmt(Math.max(0, Math.floor((Date.now() - call.startedAt) / 1000)))
    : call.phase === 'outgoing' ? 'Calling…' : call.phase === 'starting' ? 'Starting…' : 'Connecting…';

  return (
    <>
      {toast}
      <aside className={'call-bar' + (big ? ' big' : '')} aria-label="Call">
        <div className="call-bar-head">
          <span className={'call-dot' + (live ? ' live' : ' ring')} />
          <b>{live ? (remoteVideo || call.camOn ? 'Video connected' : 'Voice connected') : status}</b>
          <span className="call-peer">{callName(peer)}</span>
          {live && <span className="muted small">{status}</span>}
          <span className="call-lock" title="End-to-end encrypted signalling; media is encrypted peer to peer"><Icon name="lock" size={13} /></span>
          <div className="spacer" />
          <button className="icon-btn" title={big ? 'Shrink' : 'Expand'} onClick={() => setBig(!big)}><Icon name={big ? 'shrink' : 'expand'} size={16} /></button>
        </div>

        <div className="call-tiles">
          <div className={'call-tile' + (!live ? ' waiting' : '')}>
            {/* the remote element always exists so audio keeps playing when there is no picture */}
            <VideoEl stream={call.remote} className={'tile-video' + (remoteVideo ? '' : ' hidden')} />
            {!remoteVideo && <div className="tile-avatar"><Avatar user={peer} size={big ? 120 : 76} /></div>}
            <span className="tile-name">{callName(peer)}{live && call.peerState.mic === false && <Icon name="micoff" size={13} />}</span>
          </div>
          <div className="call-tile self">
            {call.preview ? <VideoEl stream={call.preview} muted className="tile-video mirror" /> : <div className="tile-avatar"><Avatar user={me} size={big ? 96 : 56} /></div>}
            <span className="tile-name">You{call.muted && <Icon name="micoff" size={13} />}</span>
          </div>
        </div>

        <div className="call-bar-controls">
          <button className={'call-btn' + (call.muted ? ' off' : '')} title={call.muted ? 'Unmute' : 'Mute'} onClick={actions.toggleMute} disabled={!live && call.phase !== 'outgoing'}><Icon name={call.muted ? 'micoff' : 'mic'} size={20} /></button>
          <button className={'call-btn' + (call.camOn ? '' : ' off')} title={call.camOn ? 'Turn camera off' : 'Turn camera on'} onClick={actions.toggleCamera} disabled={!live}><Icon name={call.camOn ? 'video' : 'videooff'} size={20} /></button>
          <button className={'call-btn' + (call.sharing ? ' on' : '')} title={call.sharing ? 'Stop sharing' : 'Share screen'} onClick={actions.toggleShare} disabled={!live}><Icon name="screen" size={20} /></button>
          <button className="call-btn decline" title="Hang up" onClick={actions.hangup}><Icon name="phone" size={20} style={{ transform: 'rotate(135deg)' }} /></button>
        </div>
      </aside>
    </>
  );
}
