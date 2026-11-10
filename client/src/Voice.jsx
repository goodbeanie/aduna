import React, { useEffect, useRef, useState } from 'react';
import { micConstraint, applyOutput, EVENT as DEVICES_EVENT } from './devices.js';
import { Avatar, Icon } from './ui.jsx';
import { nameProps } from './namestyle.js';
import { emitAck } from './api.js';
import { getIce, restartPath, tuneSender } from './rtc.js';
import { SoundBar } from './Soundboard.jsx';
import { soundUrl, playClip, stopAllClips } from './soundboard.js';
import { useContextMenu } from './ContextMenu.jsx';
import { VOL, prefsOf, setPrefs, soundVolume, useUserPrefs, useAllUserPrefs } from './voiceprefs.js';
import { Tile, StageBtn, CallTimer, useSpeaking, usePhone } from './Call.jsx';
import { ScreenSharePicker, ShareBar, shareSpec, desktopScreen } from './ScreenShare.jsx';
import { shareZoom } from './sharezoom.js';
import { hasFeature } from './features.js';

// Screen sharing in voice channels is gated (server/features.js): until a published release lists 'vc-screenshare' only creator accounts have it.
// Without it a person neither sees the Share button nor a share someone else started.
export const SHARE_FEATURE = 'vc-screenshare';

// Voice channels. Everyone in a channel connects directly to everyone else (WebRTC mesh: audio, plus a screen share while someone shares),
// so it suits small groups (the server allows 8). The server keeps the list of who is in a channel and
// relays signalling; it never touches the audio or the picture.
// Every pair runs "perfect negotiation" (like group calls), so anyone can start or stop a screen share at any time. The side that joins
// still makes the first offer. Mic / deafen / sharing state is announced to the others through the same signalling channel.
// Soundboard sounds do not travel over these connections: the server announces `soundboard:play` to the channel and each browser plays the clip itself,
// so a person who deafens themselves simply does not hear it (rules: server/soundboard.js, buttons: Soundboard.jsx).
const IDLE = { channelId: null, serverId: null, connecting: false, muted: false, deafened: false, error: '', notice: '', sharing: false, picker: false, preview: null, local: null, startedAt: 0 };

export function useVoice({ socketRef, ready, isPlus = () => false, canShare = () => true, canZoom = () => false }) {
  const [state, setState] = useState(IDLE);
  const [members, setMembers] = useState({}); // channelId -> [userId], for the whole server list
  const [remote, setRemote] = useState({});   // userId -> MediaStream with their voice (rendered by <VoiceAudio>)
  const [shots, setShots] = useState({});     // userId -> MediaStream with their screen share (shown in their tile)
  const [peerState, setPeerState] = useState({}); // userId -> { mic, deaf, sharing } as they announced it
  const [linked, setLinked] = useState({});   // userId -> true once the connection to them is up
  const [flash, setFlash] = useState({});     // userId -> soundId, for the second or two after they played a soundboard sound
  const sRef = useRef(IDLE);
  const rt = useRef({ local: null, peers: new Map(), opening: new Map(), chain: Promise.resolve(), screen: null, screenStream: null, shareQ: null, zoom: null, outTrack: null, mutedBeforeDeafen: false });
  const set = (patch) => { sRef.current = { ...sRef.current, ...patch }; setState(sRef.current); };
  const without = (m, id) => { if (!(id in m)) return m; const n = { ...m }; delete n[id]; return n; };

  const sendTo = (id, data) => socketRef.current?.emit('voice:signal', { channelId: sRef.current.channelId, to: id, data });
  const stateNow = () => ({ mic: !sRef.current.muted, deaf: !!sRef.current.deafened, sharing: !!rt.current.screen });
  const announce = () => { const st = stateNow(); for (const id of rt.current.peers.keys()) sendTo(id, { state: st }); };

  const closePeer = (id) => {
    const p = rt.current.peers.get(id);
    if (p) {
      clearTimeout(p.timer);
      try { p.pc.close(); } catch { /* already closed */ }
      rt.current.peers.delete(id);
    }
    setRemote((m) => without(m, id));
    setShots((m) => without(m, id));
    setPeerState((m) => without(m, id));
    setLinked((m) => without(m, id));
  };
  const teardown = () => {
    const r = rt.current;
    [...r.peers.keys()].forEach(closePeer);
    r.opening.clear();
    r.chain = Promise.resolve();
    r.local?.getTracks().forEach((t) => t.stop());
    if (r.zoom) { r.zoom.stop(); r.zoom = null; } // before the screen track stops: it draws from it
    r.screen?.stop();
    r.local = null; r.screen = null; r.screenStream = null; r.shareQ = null; r.outTrack = null; r.mutedBeforeDeafen = false;
    stopAllClips(); // leaving the channel cuts off any sound still playing
    setFlash({});
  };
  const reset = (error = '') => { teardown(); sRef.current = { ...IDLE, error }; setState(sRef.current); };

  // Your microphone, and the screen if you are sharing, go to this person. Used for the first offer and when answering one.
  function addLocalTracks(peer) {
    const r = rt.current;
    if (peer.tracksAdded || !r.local) return;
    peer.tracksAdded = true;
    r.local.getTracks().forEach((t) => peer.pc.addTrack(t, r.local));
    if (r.screen && r.screen.readyState === 'live') attachScreen(peer);
  }
  function attachScreen(peer) {
    const r = rt.current, q = r.shareQ, track = r.outTrack || r.screen; // outTrack: the zoomed picture while the share is zoomed in
    if (peer.vsender) peer.vsender.replaceTrack(track).catch(() => {});
    else peer.vsender = peer.pc.addTrack(track, r.screenStream); // a new picture line: the pair negotiates again by itself
    if (q) tuneSender(peer.vsender, q.kbps, q.content);
  }

  async function makePeer(id, initiator) {
    const r = rt.current;
    const { servers } = await getIce(); // STUN + TURN from the server (public STUN if it cannot be reached)
    const channelId = sRef.current.channelId;
    if (!channelId) throw new Error('left the channel');
    const pc = new RTCPeerConnection({ iceServers: servers });
    const peer = { pc, polite: String(ready) > String(id), makingOffer: false, cands: [], tracksAdded: false, vsender: null, initiator, restarts: 0, timer: 0, up: false };
    r.peers.set(id, peer);
    const alive = () => r.peers.get(id) === peer;
    // The side that made the first offer looks for a new path (fresh credentials, ICE restart); the other side waits for it.
    const restart = async () => {
      if (!initiator || !alive() || peer.restarts >= 3) return false;
      peer.restarts += 1;
      return restartPath(pc);
    };
    // Give up on this peer if it has not come back after a while.
    const giveUpSoon = (ms) => { clearTimeout(peer.timer); peer.timer = setTimeout(() => { if (alive() && pc.connectionState !== 'connected') closePeer(id); }, ms); };
    const recover = () => {
      if (!initiator) { giveUpSoon(20000); return; }       // wait for the other side's restart offer
      restart().then((ok) => { if (ok) giveUpSoon(20000); else closePeer(id); }).catch(() => closePeer(id));
    };
    pc.onicecandidate = (e) => { if (e.candidate) sendTo(id, { candidate: e.candidate }); };
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') setRemote((m) => ({ ...m, [id]: e.streams[0] || new MediaStream([e.track]) }));
      else {
        const s = e.streams[0] || new MediaStream([e.track]);
        setShots((m) => ({ ...m, [id]: s }));
        e.track.onmute = e.track.onunmute = () => setShots((m) => ({ ...m })); // redraw: the picture starts or stops flowing
      }
    };
    pc.onnegotiationneeded = async () => {
      try { peer.makingOffer = true; await pc.setLocalDescription(); sendTo(id, { description: pc.localDescription }); }
      catch (e) { console.warn('voice negotiation failed', e); } finally { peer.makingOffer = false; }
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') {
        peer.restarts = 0; clearTimeout(peer.timer);
        if (!peer.up) { peer.up = true; setLinked((m) => ({ ...m, [id]: true })); sendTo(id, { state: stateNow() }); } // tell them whether we are muted or sharing
      } else if (st === 'disconnected') {
        // often heals on its own within a few seconds
        clearTimeout(peer.timer);
        peer.timer = setTimeout(() => { if (alive() && pc.connectionState === 'disconnected') recover(); }, 3000);
      } else if (st === 'failed') { clearTimeout(peer.timer); recover(); }
    };
    return peer;
  }
  // One connection per person, even when a signal and our own offer for the same person overlap.
  const peerFor = (id, initiator = false) => {
    const r = rt.current, have = r.peers.get(id);
    if (have) return Promise.resolve(have);
    if (!r.opening.has(id)) r.opening.set(id, makePeer(id, initiator).finally(() => r.opening.delete(id)));
    return r.opening.get(id);
  };

  async function onSignal({ channelId, from, data }) {
    if (channelId !== sRef.current.channelId || !data || typeof data !== 'object') return;
    try {
      if (data.state && typeof data.state === 'object') {
        const { mic, deaf, sharing } = data.state;
        setPeerState((m) => ({ ...m, [from]: { mic: mic !== false, deaf: !!deaf, sharing: !!sharing } }));
      }
      if (!data.description && !data.candidate) return;
      const peer = await peerFor(from);
      const pc = peer.pc;
      if (data.description) {
        const collision = data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        if (collision && !peer.polite) return; // both offered at once: the polite side backs down, this side keeps its offer
        await pc.setRemoteDescription(data.description);
        for (const c of peer.cands.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (data.description.type === 'offer') {
          addLocalTracks(peer); // reuses the transceivers from the offer, so no extra round trip
          await pc.setLocalDescription();
          sendTo(from, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => { /* a candidate for an ignored offer */ });
        else peer.cands.push(data.candidate);
      }
    } catch (e) { console.warn('voice signalling failed', e); }
  }

  useEffect(() => {
    const s = socketRef.current;
    if (!s) return undefined;
    const onState = ({ channelId, users }) => setMembers((m) => {
      const n = { ...m };
      if (users.length) n[channelId] = users; else delete n[channelId];
      return n;
    });
    const onLeft = ({ channelId, userId }) => { if (channelId === sRef.current.channelId) closePeer(userId); };
    const onKicked = ({ channelId }) => { if (channelId === sRef.current.channelId) reset('You joined voice from another window'); };
    // a dropped connection removes you from the channel on the server, so leave here too
    const onDisconnect = () => { setMembers({}); if (sRef.current.channelId) reset('Connection lost'); };
    const onVoiceSignal = (p) => { rt.current.chain = rt.current.chain.then(() => onSignal(p)).catch((e) => console.warn('voice signal failed', e)); }; // one at a time, in order
    // someone in this channel played a soundboard sound: light up their tile and play it (the server already checked they may)
    const onSound = ({ channelId, soundId, userId }) => {
      const st = sRef.current;
      if (channelId !== st.channelId || !st.serverId || typeof soundId !== 'string') return;
      setFlash((f) => ({ ...f, [userId]: soundId }));
      setTimeout(() => setFlash((f) => { if (f[userId] !== soundId) return f; const n = { ...f }; delete n[userId]; return n; }), 1800);
      // deafened: you hear nothing, like everyone else's voice. Your own settings for that person apply too (their sounds muted, or turned down).
      const mine = prefsOf(userId);
      if (!st.deafened && !mine.sbMute && mine.vol > 0) playClip(soundUrl(st.serverId, soundId), soundVolume(mine));
    };
    s.on('voice:state', onState); s.on('voice:left', onLeft); s.on('voice:kicked', onKicked);
    s.on('voice:signal', onVoiceSignal); s.on('disconnect', onDisconnect); s.on('soundboard:play', onSound);
    return () => { s.off('voice:state', onState); s.off('voice:left', onLeft); s.off('voice:kicked', onKicked); s.off('voice:signal', onVoiceSignal); s.off('disconnect', onDisconnect); s.off('soundboard:play', onSound); };
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { teardown(); socketRef.current?.emit('voice:leave'); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- screen sharing (the sheet is in ScreenShare.jsx; it calls startShare() with what the person chose) -----
  async function stopShare() {
    const r = rt.current, t = r.screen;
    if (!t) return;
    if (r.zoom) { r.zoom.stop(); r.zoom = null; }
    r.screen = null; r.screenStream = null; r.shareQ = null; r.outTrack = null; t.stop();
    for (const p of r.peers.values()) {
      if (p.vsender) { await p.vsender.replaceTrack(null).catch(() => {}); tuneSender(p.vsender, 0, ''); }
    }
    set({ sharing: false, preview: null });
    announce();
  }
  function toggleShare() {
    if (rt.current.screen) return stopShare();
    const s = sRef.current;
    if (!s.channelId || s.connecting || !canShare()) return undefined;
    set({ picker: !s.picker });
    return undefined;
  }
  async function startShare({ sourceId, quality } = {}) {
    const r = rt.current;
    set({ picker: false });
    if (!sRef.current.channelId || sRef.current.connecting || r.screen || !canShare()) return;
    const q = shareSpec(quality, isPlus()); // what this person's plan allows: 720p / 30 fps for everyone, up to 1080p / 60 fps with Aduna Plus
    try {
      // Aduna desktop: tell the app which screen or window was picked, so its handler can answer the request below.
      if (sourceId && desktopScreen()) {
        if (!(await desktopScreen().choose(sourceId))) throw Object.assign(new Error('bad source'), { name: 'SourceError' });
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: q.fps, max: q.fps }, width: { max: q.w }, height: { max: q.h } },
        audio: false,
      });
      const t = stream.getVideoTracks()[0];
      if (!t) throw Object.assign(new Error('no video'), { name: 'SourceError' });
      try { t.contentHint = q.content; } catch { /* older browsers: the default is fine */ }
      if (!sRef.current.channelId) { t.stop(); return; } // you left while the picker was open
      r.screen = t; r.screenStream = new MediaStream([t]); r.shareQ = q;
      t.onended = () => stopShare(); // the browser's own "Stop sharing" button ends it too
      for (const p of r.peers.values()) if (p.tracksAdded) attachScreen(p); // peers still being set up pick it up in addLocalTracks
      // Aduna desktop, whole-screen share: a hotkey zooms the picture in on the cursor (sharezoom.js). `swap` puts the zoomed or the plain track on every sender.
      r.zoom = !canZoom() ? null : shareZoom({
        track: t, fps: q.fps, notice: (n) => set({ notice: n }),
        swap: (x) => { r.outTrack = x === t ? null : x; return Promise.all([...r.peers.values()].filter((p) => p.vsender).map((p) => p.vsender.replaceTrack(x).catch(() => {}))); },
      });
      set({ sharing: true, preview: r.screenStream });
      announce();
    } catch (e) {
      // Cancelling the browser's chooser is a normal "no thanks"; on desktop a refusal means the chosen source could not be captured.
      if (e.name === 'NotAllowedError' && !desktopScreen()) return;
      if (e.name === 'AbortError') return;
      set({ notice: e.name === 'NotAllowedError' ? 'Aduna is not allowed to capture the screen. Check your system privacy settings.' : 'Could not start screen sharing' });
    }
  }

  const actions = {
    async join(channelId, serverId = null) {
      if (sRef.current.connecting || sRef.current.channelId === channelId) return;
      if (sRef.current.channelId) actions.leave();
      set({ ...IDLE, connecting: true });
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Voice needs a secure page (https or localhost) and a modern browser');
        try {
          rt.current.local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, ...micConstraint() }, video: false });
        } catch (e) {
          throw new Error(e.name === 'NotAllowedError' ? 'Microphone permission was denied' : e.name === 'NotFoundError' ? 'No microphone found' : 'Could not access your microphone');
        }
        sRef.current = { ...sRef.current, channelId, serverId };
        const { peers } = await emitAck(socketRef.current, 'voice:join', { channelId });
        set({ channelId, serverId, connecting: false, local: rt.current.local, startedAt: Date.now() });
        await Promise.all(peers.map((id) => peerFor(id, true).then(addLocalTracks))); // the joiner makes the offers
      } catch (e) {
        socketRef.current?.emit('voice:leave');
        reset(e.message);
      }
    },
    leave() { socketRef.current?.emit('voice:leave'); reset(); },
    // Ask the server to play a soundboard sound for everyone in the channel. Rejects with a sentence the person can read (off, not allowed, too fast).
    playSound(soundId) {
      const channelId = sRef.current.channelId;
      if (!channelId) return Promise.reject(new Error('Join the voice channel first'));
      return emitAck(socketRef.current, 'soundboard:play', { channelId, soundId });
    },
    toggleMute() {
      const s = sRef.current;
      if (s.deafened) { // like in calls: unmuting while deafened lets you hear again too
        rt.current.local?.getAudioTracks().forEach((t) => { t.enabled = true; });
        set({ deafened: false, muted: false });
        announce();
        return;
      }
      const muted = !s.muted;
      rt.current.local?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
      set({ muted });
      announce();
    },
    // Deafening also mutes your microphone (nobody should hear you while you cannot hear them); undeafening puts the mic back as it was.
    toggleDeafen() {
      const s = sRef.current;
      const tracks = rt.current.local?.getAudioTracks() || [];
      if (s.deafened) {
        const muted = !!rt.current.mutedBeforeDeafen;
        tracks.forEach((t) => { t.enabled = !muted; });
        set({ deafened: false, muted });
      } else {
        rt.current.mutedBeforeDeafen = s.muted;
        tracks.forEach((t) => { t.enabled = false; });
        set({ deafened: true, muted: true });
      }
      announce();
    },
    toggleShare, startShare, stopShare, isPlus,
    closePicker: () => set({ picker: false }),
    clearNotice: () => set({ notice: '' }),
  };
  return { state, members, remote, shots, peerState, linked, flash, actions };
}

// One shared Web Audio context for the per-person volume (a plain <audio> element cannot go above 100%).
let audioCtx = null;
function getAudioCtx() {
  try {
    if (!audioCtx || audioCtx.state === 'closed') { const AC = window.AudioContext || window.webkitAudioContext; audioCtx = AC ? new AC() : null; }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch { return null; }
}

// Plays one person's voice at the level you chose for them (right-click their tile: volume 0 to 150%, or mute).
// Path: stream -> volume (gain) -> a second stream -> a hidden <audio> that follows your speaker choice. The first <audio> holds the incoming stream
// silently, because browsers only feed a call's audio into Web Audio while a media element has it. If Web Audio is missing, that first element plays
// the voice itself (volume up to 100% only).
function RemoteAudio({ stream, deafened, userId }) {
  const rawRef = useRef(null);
  const outRef = useRef(null);
  const gainRef = useRef(null);
  const [mode, setMode] = useState('pending'); // 'pending' (silent until decided) | 'graph' | 'direct'
  const p = useUserPrefs(userId);
  const level = p.mute ? 0 : p.vol / VOL.normal;
  const levelRef = useRef(level);
  levelRef.current = level;

  useEffect(() => {
    const raw = rawRef.current, out = outRef.current;
    if (raw) raw.srcObject = stream;
    const ctx = getAudioCtx();
    if (!ctx || !raw || !out) { setMode('direct'); return undefined; }
    let src = null, gain = null;
    try {
      src = ctx.createMediaStreamSource(stream);
      gain = ctx.createGain();
      gain.gain.value = levelRef.current;
      const dest = ctx.createMediaStreamDestination();
      src.connect(gain); gain.connect(dest);
      out.srcObject = dest.stream;
      out.play().catch(() => {});
      gainRef.current = gain;
      setMode('graph');
    } catch { gainRef.current = null; setMode('direct'); }
    return () => {
      gainRef.current = null;
      try { src?.disconnect(); gain?.disconnect(); } catch { /* already gone */ }
      out.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    if (mode === 'graph' && gainRef.current) gainRef.current.gain.setTargetAtTime(level, gainRef.current.context.currentTime, 0.015);
    else if (rawRef.current) rawRef.current.volume = Math.min(1, level);
  }, [level, mode]);
  useEffect(() => {
    const go = () => { applyOutput(outRef.current); applyOutput(rawRef.current); };
    go(); window.addEventListener(DEVICES_EVENT, go);
    return () => window.removeEventListener(DEVICES_EVENT, go);
  }, [mode]);
  return <><audio ref={rawRef} autoPlay muted={mode !== 'direct' || deafened} /><audio ref={outRef} autoPlay muted={deafened} /></>;
}
// Hidden elements that play everyone else's audio while you are in a channel.
export function VoiceAudio({ voice }) {
  return <>{Object.entries(voice.remote).map(([id, stream]) => <RemoteAudio key={id} stream={stream} userId={id} deafened={voice.state.deafened} />)}</>;
}

// Everything about a voice session that is not tied to one place on screen (App.jsx mounts it once): the voices, the "Share your screen" sheet
// and the notice toast. Always mounted, so the channel keeps going while you read another chat.
export function VoiceUI({ voice }) {
  const { state, actions } = voice;
  useEffect(() => {
    if (!state.notice) return undefined;
    const t = setTimeout(actions.clearNotice, 5000);
    return () => clearTimeout(t);
  }, [state.notice]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <VoiceAudio voice={voice} />
      {state.notice && <div className="call-toast" role="status">{state.notice}</div>}
      {state.picker && state.channelId && <ScreenSharePicker onStart={actions.startShare} onClose={actions.closePicker} plus={actions.isPlus()} />}
    </>
  );
}

const hasVideo = (s) => !!s && s.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);

// Somebody else in the channel. Its own component because each tile listens to that person's voice (the green ring).
function PeerTile({ id, u, voice, here, mine, snd, size, small, pinned, onPick, onMenu, canShare }) {
  const st = voice.peerState[id] || {};
  const up = here && !!voice.linked[id];
  const showing = canShare && !!st.sharing && hasVideo(voice.shots[id]); // without the feature a share is not shown, only the person
  const talking = useSpeaking(voice.remote[id], up && st.mic !== false);
  const heard = mine?.mute ? { title: 'You muted this person', icon: 'micoff' } : mine?.sbMute ? { title: "You muted this person's soundboard", icon: 'music' } : null;
  return (
    <Tile user={u} label={<span {...nameProps(u)}>{u.displayName}</span>} size={size} stream={voice.shots[id]} showVideo={showing} contain={showing}
      sharing={canShare && !!st.sharing} speaking={talking} waiting={here && !up} muted={up && st.mic === false} deaf={up && !!st.deaf} live={up}
      sound={snd} heard={heard} small={small} pinned={pinned} onPick={onPick} onMenu={onMenu} />
  );
}

// The voice channel page. Same look as a call (Call.jsx): a stage with one tile per person, a screen share takes the big spot on its own
// (click any tile to focus it), and the controls are the same round buttons in a pill.
export function VoicePanel({ channel, server, voice, users, me, onBack, headerExtra }) {
  const { state, members, flash, actions } = voice;
  const phone = usePhone();
  const canShare = hasFeature(me, SHARE_FEATURE);
  const here = state.channelId === channel.id;
  const ids = (members[channel.id] || []).filter((id) => users[id]);
  const full = (members[channel.id] || []).length >= 8 && !ids.includes(me.id);
  const [pin, setPin] = useState(null); // a user id or null: the tile the person clicked to focus
  const soundOf = (id) => (flash[id] && server ? (server.sounds || []).find((s) => s.id === flash[id]) : null); // the sound this person just played, if it still exists
  const ctxMenu = useContextMenu();
  const mine = useAllUserPrefs(); // your own volume / mute choices per person (voiceprefs.js), so a tile shows when you muted someone
  const meTalking = useSpeaking(state.local, here && !state.muted);
  // Right-click (or long-press) a person's tile: how loud they are for you, mute them, or mute only their soundboard sounds. Only you are affected.
  const tileMenu = (e, id, u) => {
    if (id === me.id) return;
    const p = prefsOf(id);
    ctxMenu.open(e, {
      header: <><Avatar user={u} size={32} /><div className="cmenu-who"><b>{u.displayName}</b><span className="small muted">Only you hear the change</span></div></>,
      items: [
        { slider: { label: 'Volume', min: VOL.min, max: VOL.max, value: p.vol, normal: VOL.normal, onChange: (v) => setPrefs(id, { vol: v }) } },
        'sep',
        { label: p.mute ? 'Unmute' : 'Mute', icon: p.mute ? 'mic' : 'micoff', onClick: () => setPrefs(id, { mute: !p.mute }) },
        { label: p.sbMute ? 'Unmute soundboard' : 'Mute soundboard', icon: 'music', onClick: () => setPrefs(id, { sbMute: !p.sbMute }) },
      ],
    });
  };

  const total = ids.length;
  const isSharing = (id) => here && canShare && (id === me.id ? state.sharing : !!voice.peerState[id]?.sharing);
  // Like a call: a screen share takes the big spot on its own, and you can click a tile to focus it.
  const focus = here ? ((pin && ids.includes(pin) ? pin : null) || ids.find(isSharing) || null) : null;
  const size = focus ? (phone ? 56 : 72) : total <= 2 ? (phone ? 64 : 84) : total <= 4 ? (phone ? 48 : 64) : 44;
  const pick = (id) => () => setPin(pin === id ? null : id);

  const renderTile = (id, small) => {
    const u = users[id];
    const px = small ? 36 : size;
    const common = { size: px, small, pinned: pin === id, onPick: here ? pick(id) : undefined, snd: soundOf(id) };
    if (id === me.id) {
      const showing = state.sharing && !!state.preview;
      return (
        <Tile key={id} user={u} label={<span {...nameProps(u)}>You</span>} size={px} stream={state.preview} showVideo={showing} contain={showing} sharing={state.sharing}
          speaking={meTalking} muted={state.muted} deaf={state.deafened} live={here} sound={common.snd} small={small} pinned={common.pinned} onPick={common.onPick} />
      );
    }
    return <PeerTile key={id} id={id} u={u} voice={voice} here={here} mine={mine[id]} canShare={canShare} onMenu={(e) => tileMenu(e, id, u)} {...common} />;
  };

  const others = ids.filter((id) => id !== me.id).length;
  const status = !here ? 'Voice channel' : state.connecting ? 'Connecting…' : others === 0 ? 'Waiting for others…' : 'Voice Connected';
  const liveDot = here && others > 0;

  return (
    <section className="chat voice-panel">
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title="Back" aria-label="Back to list" onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash"><Icon name="speaker" size={20} /></span>
        <h3>{channel.name}</h3>
        {ids.length > 0 && <span className="voice-count muted" title="People in this channel">{ids.length}/8</span>}
        <div className="spacer" />
        {headerExtra}
      </header>
      {state.error && <div className="error voice-error">{state.error}</div>}
      <section className={'call-stage gcall big vc-stage' + (here ? ' live' : '')} aria-label="Voice channel">
        <div className="stage-top">
          <span className={'call-dot' + (liveDot ? ' live' : here ? ' ring' : '')} />
          <span className="stage-status" aria-live="polite">
            <b>{status}</b>
            <span className="stage-with">
              {channel.name}{here && !state.connecting && <> &middot; <CallTimer since={state.startedAt} /></>} &middot; {total === 0 ? 'nobody here yet' : `${total} ${total === 1 ? 'person' : 'people'}`}
            </span>
          </span>
        </div>

        {state.sharing && <ShareBar onStop={actions.stopShare} />}

        {total === 0 ? (
          <div className="stage-tiles"><div className="vc-empty">Nobody is in this voice channel yet.</div></div>
        ) : (
          <div className={'stage-tiles gcall-grid' + (focus ? ' spot' : '')} data-n={Math.min(total, 8)}>
            {focus ? (
              <>
                {renderTile(focus, false)}
                <div className="vc-strip">{ids.filter((id) => id !== focus).map((id) => renderTile(id, true))}</div>
              </>
            ) : ids.map((id) => renderTile(id, false))}
          </div>
        )}

        <div className="stage-controls">
          {here ? (
            <>
              <div className="stage-pill">
                {canShare && <StageBtn icon="screen" title={state.sharing ? 'Stop sharing' : 'Share screen'} on={state.sharing} onClick={actions.toggleShare} disabled={state.connecting} />}
                <StageBtn icon={state.muted ? 'micoff' : 'mic'} title={state.muted ? 'Unmute' : 'Mute'} off={state.muted} onClick={actions.toggleMute} />
                <StageBtn icon={state.deafened ? 'headphonesoff' : 'headphones'} title={state.deafened ? 'Undeafen' : 'Deafen'} off={state.deafened} onClick={actions.toggleDeafen} />
              </div>
              <StageBtn icon="phone" title="Leave voice channel" hangup onClick={actions.leave} />
            </>
          ) : (
            <button className="btn primary vc-join" disabled={state.connecting || full} onClick={() => actions.join(channel.id, server?.id)}>
              <Icon name="phone" size={18} className="inline-icon" /> {state.connecting ? 'Connecting…' : full ? 'Channel is full' : 'Join voice'}
            </button>
          )}
        </div>
      </section>
      {here && server && <div className="vc-sound"><SoundBar server={server} me={me} play={actions.playSound} /></div>}
    </section>
  );
}
