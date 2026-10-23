import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, Icon } from './ui.jsx';
import { emitAck } from './api.js';
import { encryptFor, decryptFrom } from './crypto.js';
import * as notify from './notify.js';
import { getIce, restartPath, failureText } from './rtc.js';
import * as snd from './callsound.js';
import { levelOf, SpeakingGate } from './speaking.js';
import { ringtoneFor } from './ringtones.js';

// While a call is ringing the tab title flashes, and a desktop notification shows if the tab is hidden.
let titleTimer = null, titleBase = '';
function alertIncoming(name, video, peerId) {
  clearInterval(titleTimer); if (titleBase) document.title = titleBase; // (not clearAlert: that would also close the notification shown below)
  titleBase = document.title;
  let on = false;
  titleTimer = setInterval(() => { on = !on; document.title = on ? `\u{1F4DE} ${name} is calling…` : titleBase; }, 900);
  if (notify.away()) notify.show({ title: `${name} is calling`, body: `Incoming ${video ? 'video' : 'voice'} call`, tag: 'call', target: 'd:' + peerId, kind: 'call', sticky: true });
}
function clearAlert() {
  clearInterval(titleTimer); titleTimer = null;
  if (titleBase) document.title = titleBase;
  titleBase = '';
  notify.dismiss('call');
}
function startRing(kind) { stopRing(); snd.startRing(kind); }
function stopRing() { snd.stopRing(); clearAlert(); }

// Phases in which the person is "in" a call (as opposed to idle or only being rung).
export const IN_CALL = ['starting', 'outgoing', 'connecting', 'active'];
export const inCall = (call) => IN_CALL.includes(call.phase);

const IDLE = { phase: 'idle', callId: null, peerId: null, video: false, startedAt: 0, muted: false, deafened: false, camOn: false, sharing: false, preview: null, local: null, remote: null, peerState: {}, rev: 0, notice: '' };

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
    clearTimeout(r.dropTimer);
    Object.assign(r, { pc: null, local: null, remote: null, cam: null, screen: null, vsender: null, cands: [], tracksAdded: false, makingOffer: false, ignoreOffer: false, chain: Promise.resolve(), restarts: 0, dropTimer: 0 });
  }
  const finish = (notice = '') => {
    const was = cRef.current.phase;
    teardown();
    cRef.current = { ...IDLE, notice }; setCall(cRef.current);
    if (IN_CALL.includes(was) && was !== 'starting') snd.cue.disconnect();
  };
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
    send({ state: { cam: !!t, mic: !cRef.current.muted, deaf: !!cRef.current.deafened, sharing: !!rt.current.screen } }).catch(() => {});
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
    const { servers, relay } = await getIce(); // STUN + TURN; falls back to public STUN if the server cannot be reached
    r.relay = relay; r.restarts = 0; clearTimeout(r.dropTimer);
    const pc = new RTCPeerConnection({ iceServers: servers });
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
    // A dropped path (Wi-Fi to mobile, a brief outage) is retried with fresh credentials before the call is given up on.
    const retry = async () => {
      const cur = rt.current;
      if (cur.pc !== pc) return false;
      if ((cur.restarts || 0) >= 3 || !(await restartPath(pc))) return false;
      cur.restarts = (cur.restarts || 0) + 1;
      return true;
    };
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState, cur = rt.current;
      if (st === 'connected' || st === 'completed') {
        clearTimeout(cur.dropTimer);
        if (cur.restarts) cur.restarts = 0;
        if (cRef.current.phase !== 'active') { set({ phase: 'active', startedAt: Date.now() }); snd.cue.connect(); }
      } else if (st === 'failed') {
        clearTimeout(cur.dropTimer);
        retry().then((ok) => { if (!ok && cur.pc === pc) hangup(failureText(cur.relay)); });
      } else if (st === 'disconnected') {
        clearTimeout(cur.dropTimer);
        // it often heals by itself within a few seconds; if not, look for a new path, and give up if that does not work either
        cur.dropTimer = setTimeout(async () => {
          if (rt.current.pc !== pc || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return;
          const ok = await retry();
          if (!ok) { if (rt.current.pc === pc) hangup('Connection lost'); return; }
          cur.dropTimer = setTimeout(() => { if (rt.current.pc === pc && !['connected', 'completed'].includes(pc.iceConnectionState)) hangup('Connection lost'); }, 10000);
        }, 3000);
      }
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
      set({ phase: 'outgoing', callId: r.callId, video: hasCam, camOn: hasCam, local: rt.current.local, preview: hasCam ? new MediaStream(rt.current.local.getVideoTracks()) : null });
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
      set({ camOn: cam.length > 0, local: rt.current.local, preview: cam.length ? new MediaStream(cam) : null });
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

  function applyMute(muted) {
    rt.current.local?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    set({ muted });
  }
  function toggleMute() {
    const c = cRef.current;
    if (c.deafened) { // like Discord: unmuting while deafened also lets you hear again
      set({ deafened: false }); applyMute(false); snd.cue.undeafen(); announce(); return;
    }
    const muted = !c.muted;
    applyMute(muted);
    (muted ? snd.cue.mute : snd.cue.unmute)();
    announce();
  }
  // Deafen: you stop hearing them and (like Discord) your microphone is muted too. Undeafening puts the microphone back how it was.
  function toggleDeafen() {
    const c = cRef.current, r = rt.current;
    if (c.deafened) { set({ deafened: false }); applyMute(!!r.mutedBeforeDeafen); snd.cue.undeafen(); }
    else { r.mutedBeforeDeafen = c.muted; set({ deafened: true }); applyMute(true); snd.cue.deafen(); }
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
      alertIncoming(nameOf(p.from), p.video, p.from);
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
  useEffect(() => { snd.preloadRingtone(); return () => { teardown(); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { call, handle, actions: { startCall, accept, hangup: () => hangup(), toggleMute, toggleDeafen, toggleCamera, toggleShare, clearNotice: () => set({ notice: '' }) } };
}

// =====================================================================================================
// Interface. Discord-style: the call lives in the conversation (CallStage), a "Voice Connected" panel in the
// sidebar follows you around (CallDock), and an incoming call drops in at the top (inside CallUI).
// =====================================================================================================
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const callName = (u) => u?.displayName || 'Someone';
const statusOf = (call) => (call.phase === 'outgoing' ? 'Calling…' : call.phase === 'starting' ? 'Starting…' : 'Connecting…');

function usePhone() {
  const q = '(max-width: 720px)';
  const [m, setM] = useState(() => !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(q);
    if (!mq) return undefined;
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

// Counts up by itself, so the rest of the call UI does not redraw every second.
function CallTimer({ since }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return <>{fmt(Math.max(0, Math.floor((Date.now() - since) / 1000)))}</>;
}

// true while this audio is loud enough to count as talking (the green ring). Reads the stream through a Web Audio analyser.
function useSpeaking(stream, on) {
  const [speaking, setSpeaking] = useState(false);
  const hasAudio = !!stream && stream.getAudioTracks().length > 0;
  useEffect(() => {
    if (!on || !hasAudio) { setSpeaking(false); return undefined; }
    let src, timer;
    try {
      const c = snd.ctx(), node = c.createAnalyser();
      node.fftSize = 512;
      src = c.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      src.connect(node); // not connected to the speakers: it only listens
      const bytes = new Uint8Array(node.fftSize), gate = new SpeakingGate();
      timer = setInterval(() => { node.getByteTimeDomainData(bytes); setSpeaking(gate.update(levelOf(bytes), performance.now())); }, 90);
    } catch { /* no Web Audio: no ring */ }
    return () => { clearInterval(timer); try { src?.disconnect(); } catch { /* gone */ } setSpeaking(false); };
  }, [stream, on, hasAudio]);
  return speaking;
}

function VideoEl({ stream, muted, className }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream || null; }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

// Plays the other person's voice. Always mounted (even while you are looking at another chat), so the call
// keeps going when the stage is not on screen; deafening just mutes this element.
function CallAudio({ call }) {
  const ref = useRef(null);
  useEffect(() => { const el = ref.current, s = call.remote || null; if (el && el.srcObject !== s) el.srcObject = s; }, [call.remote]);
  return <audio ref={ref} autoPlay muted={!!call.deafened} />;
}

function StageBtn({ icon, title, onClick, off, on, disabled, hangup, size = 22 }) {
  return (
    <button className={'stage-btn' + (off ? ' off' : '') + (on ? ' on' : '') + (hangup ? ' hangup' : '')} title={title} aria-label={title} aria-pressed={off || on ? true : undefined} onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={size} style={hangup ? { transform: 'rotate(135deg)' } : undefined} />
    </button>
  );
}

function Tile({ user, label, size, speaking, waiting, muted, deaf, stream, mirror, contain, showVideo, silent = true, small, onPick, pinned, live }) {
  const off = deaf || muted;
  return (
    <div className={'call-tile' + (speaking ? ' speaking' : '') + (waiting ? ' waiting' : '') + (small ? ' small' : '') + (pinned ? ' pinned' : '')}
      onClick={onPick} role={onPick ? 'button' : undefined} tabIndex={onPick ? 0 : undefined}
      onKeyDown={onPick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } } : undefined}
      title={onPick ? (pinned ? 'Click to unfocus' : 'Click to focus') : undefined}>
      {/* the video element always exists for the other person, so a camera that turns on appears at once */}
      <VideoEl stream={stream} muted={silent} className={'tile-video' + (mirror ? ' mirror' : '') + (contain ? ' contain' : '') + (showVideo ? '' : ' hidden')} />
      {!showVideo && (
        <div className="tile-avatar">
          <span className="tile-halo" aria-hidden="true" />
          <Avatar user={user} size={size} />
        </div>
      )}
      <span className="tile-name">
        {speaking && <span className="tile-wave" aria-hidden="true"><i /><i /><i /></span>}
        {label}
      </span>
      {live && off && (
        <span className="tile-badge" title={deaf ? 'Deafened' : 'Muted'}>
          <Icon name={deaf ? 'headphonesoff' : 'micoff'} size={14} />
        </span>
      )}
    </div>
  );
}

// The call itself, shown at the top of the conversation with the person you are calling.
export function CallStage({ call, actions, users, me }) {
  const phone = usePhone();
  const [big, setBig] = useState(false);
  const [pin, setPin] = useState(null); // 'peer' | 'me' | null: the tile the person clicked to focus
  useEffect(() => { if (phone && call.video) setBig(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- phones open a video call full size
  const peer = users[call.peerId];
  const live = call.phase === 'active';
  const peerSharing = !!call.peerState.sharing;
  const remoteVideo = !!call.remote && call.remote.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted) && call.peerState.cam !== false;
  const peerTalking = useSpeaking(call.remote, live && call.peerState.mic !== false);
  const meTalking = useSpeaking(call.local, live && !call.muted);
  // Like Discord: a screen share takes the big spot on its own, and you can click either tile to focus it.
  const focus = pin || (peerSharing ? 'peer' : call.sharing ? 'me' : null);
  const av = focus ? (phone ? 64 : 84) : big ? (phone ? 88 : 120) : (phone ? 52 : 68);
  const pick = (who) => () => setPin(pin === who ? null : who);
  const label = live ? (call.video || call.camOn || remoteVideo ? 'Video Connected' : 'Voice Connected') : statusOf(call);

  return (
    <section className={'call-stage' + (big ? ' big' : '') + (live ? ' live' : '')} aria-label="Call">
      <div className="stage-top">
        <span className={'call-dot' + (live ? ' live' : ' ring')} />
        <span className="stage-status" aria-live="polite">
          <b>{label}</b>
          <span className="stage-with">{callName(peer)}{live && <> &middot; <CallTimer since={call.startedAt} /></>}</span>
        </span>
        <span className="call-lock" title="End-to-end encrypted signalling; media is encrypted peer to peer"><Icon name="lock" size={13} /></span>
        <div className="spacer" />
        <button className="stage-icon" title={big ? 'Show chat' : 'Expand call'} aria-label={big ? 'Show chat' : 'Expand call'} onClick={() => setBig(!big)}><Icon name={big ? 'shrink' : 'expand'} size={16} /></button>
      </div>

      <div className={'stage-tiles' + (focus ? ' spot' : '')}>
        <Tile user={peer} label={callName(peer)} size={av} stream={call.remote} showVideo={remoteVideo} contain={peerSharing}
          speaking={peerTalking} waiting={!live} muted={live && call.peerState.mic === false} deaf={live && !!call.peerState.deaf}
          live={live} small={!!focus && focus !== 'peer'} pinned={pin === 'peer'} onPick={live ? pick('peer') : undefined} />
        <Tile user={me} label="You" size={av} stream={call.preview} showVideo={!!call.preview} mirror={!call.sharing} contain={call.sharing}
          speaking={meTalking} muted={call.muted} deaf={call.deafened}
          live={live || call.phase === 'outgoing'} small={!!focus && focus !== 'me'} pinned={pin === 'me'} onPick={live ? pick('me') : undefined} />
      </div>

      <div className="stage-controls">
        <div className="stage-pill">
          <StageBtn icon={call.camOn ? 'video' : 'videooff'} title={call.camOn ? 'Turn camera off' : 'Turn camera on'} off={!call.camOn} onClick={actions.toggleCamera} disabled={!live} />
          <StageBtn icon="screen" title={call.sharing ? 'Stop sharing' : 'Share screen'} on={call.sharing} onClick={actions.toggleShare} disabled={!live} />
          <StageBtn icon={call.muted ? 'micoff' : 'mic'} title={call.muted ? 'Unmute' : 'Mute'} off={call.muted} onClick={actions.toggleMute} disabled={!live && call.phase !== 'outgoing'} />
          <StageBtn icon={call.deafened ? 'headphonesoff' : 'headphones'} title={call.deafened ? 'Undeafen' : 'Deafen'} off={call.deafened} onClick={actions.toggleDeafen} disabled={!live} />
        </div>
        <StageBtn icon="phone" title="Hang up" hangup onClick={actions.hangup} />
      </div>
    </section>
  );
}

// "Voice Connected" panel above your name in the sidebar. Stays while you read other chats; clicking it takes you back to the call.
export function CallDock({ call, actions, users, onOpen }) {
  if (!inCall(call)) return null;
  const peer = users[call.peerId], live = call.phase === 'active';
  return (
    <div className="call-dock" role="region" aria-label="Call controls">
      <div className="cd-row">
        <span className={'signal' + (live ? ' live' : ' wait')}><Icon name="signal" size={18} /></span>
        <button className="cd-who" title="Go to the call" onClick={() => onOpen?.(call.peerId)}>
          <b className={live ? '' : 'wait'}>{live ? (call.video || call.camOn ? 'Video Connected' : 'Voice Connected') : statusOf(call)}</b>
          <span>{callName(peer)}{live && <> · <CallTimer since={call.startedAt} /></>}</span>
        </button>
        <button className="cd-btn hang" title="Hang up" aria-label="Hang up" onClick={actions.hangup}><Icon name="phone" size={18} style={{ transform: 'rotate(135deg)' }} /></button>
      </div>
      <div className="cd-tools">
        <button className={'cd-btn' + (call.muted ? ' off' : '')} title={call.muted ? 'Unmute' : 'Mute'} aria-label={call.muted ? 'Unmute' : 'Mute'} onClick={actions.toggleMute} disabled={!live && call.phase !== 'outgoing'}><Icon name={call.muted ? 'micoff' : 'mic'} size={17} /></button>
        <button className={'cd-btn' + (call.deafened ? ' off' : '')} title={call.deafened ? 'Undeafen' : 'Deafen'} aria-label={call.deafened ? 'Undeafen' : 'Deafen'} onClick={actions.toggleDeafen} disabled={!live}><Icon name={call.deafened ? 'headphonesoff' : 'headphones'} size={17} /></button>
        <button className={'cd-btn' + (call.camOn ? ' on' : '')} title={call.camOn ? 'Turn camera off' : 'Turn camera on'} aria-label={call.camOn ? 'Turn camera off' : 'Turn camera on'} onClick={actions.toggleCamera} disabled={!live}><Icon name={call.camOn ? 'video' : 'videooff'} size={17} /></button>
        <button className={'cd-btn' + (call.sharing ? ' on' : '')} title={call.sharing ? 'Stop sharing' : 'Share screen'} aria-label={call.sharing ? 'Stop sharing' : 'Share screen'} onClick={actions.toggleShare} disabled={!live}><Icon name="screen" size={17} /></button>
      </div>
    </div>
  );
}

// Phones only (CSS hides it elsewhere): a slim strip under the top bar while you are in a chat other than the call.
function CallStrip({ call, actions, users, onOpen }) {
  const peer = users[call.peerId], live = call.phase === 'active';
  return (
    <div className="call-strip" role="region" aria-label="Call">
      <button className="cs-who" onClick={() => onOpen?.(call.peerId)} title="Go to the call">
        <span className={'call-dot' + (live ? ' live' : ' ring')} />
        <Avatar user={peer} size={28} />
        <span className="cs-name">{callName(peer)}</span>
        <span className="muted small">{live ? <CallTimer since={call.startedAt} /> : statusOf(call)}</span>
      </button>
      <button className={'cd-btn' + (call.muted ? ' off' : '')} title={call.muted ? 'Unmute' : 'Mute'} aria-label={call.muted ? 'Unmute' : 'Mute'} onClick={actions.toggleMute}><Icon name={call.muted ? 'micoff' : 'mic'} size={18} /></button>
      <button className="cd-btn hang" title="Hang up" aria-label="Hang up" onClick={actions.hangup}><Icon name="phone" size={18} style={{ transform: 'rotate(135deg)' }} /></button>
    </div>
  );
}

// Someone is calling you: a card drops in at the top of the window (full screen on a phone) with the ringtone playing.
function Incoming({ call, actions, users }) {
  const phone = usePhone();
  const peer = users[call.peerId], kind = call.video ? 'video' : 'voice';
  const tone = ringtoneFor(); // Halloween / Christmas get a matching glow while their ringtone is the one playing
  const accept = useRef(actions.accept);
  accept.current = actions.accept;
  useEffect(() => {
    const h = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); accept.current(); } }; // Ctrl+Enter answers, as in Discord
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  return (
    <aside className="call-incoming" data-season={tone.id} role="alertdialog" aria-label={`Incoming ${kind} call from ${callName(peer)}`}>
      <div className="call-pulse"><Avatar user={peer} size={phone ? 120 : 60} /></div>
      <div className="ci-text">
        <div className="ci-name">{callName(peer)}</div>
        <div className="ci-sub">Incoming {kind} call…{tone.id !== 'default' && <span className="ci-season">{tone.id === 'halloween' ? '\u{1F383}' : '\u{1F384}'} {tone.label}</span>}</div>
      </div>
      <div className="ci-actions">
        <button className="ci-btn decline" title="Decline" aria-label="Decline" onClick={actions.hangup}><Icon name="phone" size={phone ? 26 : 22} style={{ transform: 'rotate(135deg)' }} /><span>Decline</span></button>
        <button className="ci-btn accept" title="Accept (Ctrl+Enter)" aria-label="Accept" onClick={actions.accept}><Icon name={call.video ? 'video' : 'phone'} size={phone ? 26 : 22} /><span>Accept</span></button>
      </div>
    </aside>
  );
}

// The parts of a call that are not tied to one place on screen: the voice itself, the ring card, the notice toast and
// the phone strip. (The stage and the dock are placed by App.jsx.) `showStrip` is false while the stage is on screen.
export function CallUI({ call, actions, users, onOpen, showStrip }) {
  useEffect(() => {
    if (!call.notice) return undefined;
    const t = setTimeout(actions.clearNotice, 5000);
    return () => clearTimeout(t);
  }, [call.notice]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <CallAudio call={call} />
      {call.notice && <div className="call-toast" role="status">{call.notice}</div>}
      {call.phase === 'incoming' && <Incoming call={call} actions={actions} users={users} />}
      {showStrip && inCall(call) && <CallStrip call={call} actions={actions} users={users} onOpen={onOpen} />}
    </>
  );
}
