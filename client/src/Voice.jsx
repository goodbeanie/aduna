import React, { useCallback, useEffect, useRef, useState } from 'react';
import { micConstraint, applyOutput, EVENT as DEVICES_EVENT } from './devices.js';
import { Avatar, Icon } from './ui.jsx';
import { emitAck } from './api.js';
import { getIce } from './rtc.js';

// Voice channels. Everyone in a channel connects directly to everyone else (WebRTC mesh, audio only),
// so it suits small groups (the server allows 8). The server keeps the list of who is in a channel and
// relays signalling; it never touches the audio. The person who joins starts a connection to each
// person already there, so two sides never offer at the same time.
const IDLE = { channelId: null, connecting: false, muted: false, deafened: false, error: '' };

export function useVoice({ socketRef, ready }) {
  const [state, setState] = useState(IDLE);
  const [members, setMembers] = useState({}); // channelId -> [userId], for the whole server list
  const [remote, setRemote] = useState({});   // userId -> MediaStream (rendered by <VoiceAudio>)
  const sRef = useRef(IDLE);
  const rt = useRef({ local: null, peers: new Map() });
  const set = (patch) => { sRef.current = { ...sRef.current, ...patch }; setState(sRef.current); };

  const closePeer = (id) => {
    const p = rt.current.peers.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    try { p.pc.close(); } catch { /* already closed */ }
    rt.current.peers.delete(id);
    setRemote((r) => { if (!(id in r)) return r; const n = { ...r }; delete n[id]; return n; });
  };
  const teardown = () => {
    const r = rt.current;
    [...r.peers.keys()].forEach(closePeer);
    r.local?.getTracks().forEach((t) => t.stop());
    r.local = null;
  };
  const reset = (error = '') => { teardown(); sRef.current = { ...IDLE, error }; setState(sRef.current); };

  async function makePeer(id, initiator) {
    const r = rt.current;
    if (r.peers.has(id)) closePeer(id);
    const { servers } = await getIce(); // STUN + TURN from the server (public STUN if it cannot be reached)
    const channelId = sRef.current.channelId;
    const pc = new RTCPeerConnection({ iceServers: servers });
    const peer = { pc, queued: [], haveRemote: false, initiator, restarts: 0, timer: 0 };
    r.peers.set(id, peer);
    const send = (data) => socketRef.current?.emit('voice:signal', { channelId, to: id, data });
    const alive = () => r.peers.get(id) === peer;
    // The side that made the first offer looks for a new path (fresh credentials, ICE restart); the other side waits for it.
    const restart = async () => {
      if (!initiator || !alive() || peer.restarts >= 3) return false;
      peer.restarts += 1;
      const { servers: fresh } = await getIce({ fresh: true });
      try { pc.setConfiguration({ ...pc.getConfiguration(), iceServers: fresh }); } catch { /* keep the old list */ }
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
      send({ description: pc.localDescription, restart: true });
      return true;
    };
    // Give up on this peer if it has not come back after a while (the other side's restart offer would replace the timer).
    const giveUpSoon = (ms) => { clearTimeout(peer.timer); peer.timer = setTimeout(() => { if (alive() && pc.connectionState !== 'connected') closePeer(id); }, ms); };
    const recover = () => {
      if (!initiator) { giveUpSoon(20000); return; }       // wait for the other side's restart offer
      restart().then((ok) => { if (ok) giveUpSoon(20000); else closePeer(id); }).catch(() => closePeer(id));
    };
    pc.onicecandidate = (e) => { if (e.candidate) send({ candidate: e.candidate }); };
    pc.ontrack = (e) => setRemote((m) => ({ ...m, [id]: e.streams[0] || new MediaStream([e.track]) }));
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') { peer.restarts = 0; clearTimeout(peer.timer); }
      else if (st === 'disconnected') {
        // often heals on its own within a few seconds
        clearTimeout(peer.timer);
        peer.timer = setTimeout(() => { if (alive() && pc.connectionState === 'disconnected') recover(); }, 3000);
      } else if (st === 'failed') { clearTimeout(peer.timer); recover(); }
    };
    r.local?.getTracks().forEach((t) => pc.addTrack(t, r.local));
    if (initiator) {
      await pc.setLocalDescription(await pc.createOffer());
      send({ description: pc.localDescription });
    }
    return peer;
  }

  async function onSignal({ channelId, from, data }) {
    if (channelId !== sRef.current.channelId) return;
    try {
      let peer = rt.current.peers.get(from);
      if (data.description?.type === 'offer' && data.restart && peer && peer.pc.signalingState === 'stable') {
        // the other side is looking for a new network path: answer on the same connection (keeps the audio and its encryption keys)
        await peer.pc.setRemoteDescription(data.description);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        socketRef.current?.emit('voice:signal', { channelId, to: from, data: { description: peer.pc.localDescription } });
      } else if (data.description?.type === 'offer') {
        peer = await makePeer(from, false);
        await peer.pc.setRemoteDescription(data.description);
        peer.haveRemote = true;
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        socketRef.current?.emit('voice:signal', { channelId, to: from, data: { description: peer.pc.localDescription } });
        for (const c of peer.queued.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
      } else if (data.description?.type === 'answer' && peer) {
        await peer.pc.setRemoteDescription(data.description);
        peer.haveRemote = true;
        for (const c of peer.queued.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
      } else if (data.candidate && peer) {
        if (peer.haveRemote) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.queued.push(data.candidate);
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
    s.on('voice:state', onState); s.on('voice:left', onLeft); s.on('voice:kicked', onKicked);
    s.on('voice:signal', onSignal); s.on('disconnect', onDisconnect);
    return () => { s.off('voice:state', onState); s.off('voice:left', onLeft); s.off('voice:kicked', onKicked); s.off('voice:signal', onSignal); s.off('disconnect', onDisconnect); };
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { teardown(); socketRef.current?.emit('voice:leave'); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const actions = {
    async join(channelId) {
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
        sRef.current = { ...sRef.current, channelId };
        const { peers } = await emitAck(socketRef.current, 'voice:join', { channelId });
        set({ channelId, connecting: false });
        await Promise.all(peers.map((id) => makePeer(id, true)));
      } catch (e) {
        socketRef.current?.emit('voice:leave');
        reset(e.message);
      }
    },
    leave() { socketRef.current?.emit('voice:leave'); reset(); },
    toggleMute() {
      const muted = !sRef.current.muted;
      rt.current.local?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
      set({ muted });
    },
    toggleDeafen() { set({ deafened: !sRef.current.deafened }); },
  };
  return { state, members, remote, actions };
}

function RemoteAudio({ stream, deafened }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  useEffect(() => { const go = () => applyOutput(ref.current); go(); window.addEventListener(DEVICES_EVENT, go); return () => window.removeEventListener(DEVICES_EVENT, go); }, []);
  return <audio ref={ref} autoPlay muted={deafened} />;
}
// Hidden elements that play everyone else's audio while you are in a channel.
export function VoiceAudio({ voice }) {
  return <>{Object.entries(voice.remote).map(([id, stream]) => <RemoteAudio key={id} stream={stream} deafened={voice.state.deafened} />)}</>;
}

export function VoicePanel({ channel, voice, users, me, presence, onBack, headerExtra }) {
  const { state, members, actions } = voice;
  const here = state.channelId === channel.id;
  const ids = members[channel.id] || [];
  const full = ids.length >= 8 && !ids.includes(me.id);
  return (
    <section className="chat voice-panel">
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title="Back" aria-label="Back to list" onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash"><Icon name="speaker" size={20} /></span>
        <h3>{channel.name}</h3>
        <div className="spacer" />
        {headerExtra}
      </header>
      <div className="voice-body">
        {ids.length === 0 ? <div className="empty">Nobody is in this voice channel yet.</div> : (
          <div className="voice-grid">
            {ids.map((id) => {
              const u = users[id];
              return u && (
                <div key={id} className="voice-tile">
                  <Avatar user={u} size={72} presence={presence[id] || 'offline'} />
                  <div className="voice-name" data-nc style={{ '--nc': u.accentColor }}>{u.displayName}{id === me.id ? ' (you)' : ''}</div>
                  {id === me.id && here && state.muted && <Icon name="micoff" size={16} className="voice-muted" />}
                </div>
              );
            })}
          </div>
        )}
        {state.error && <div className="error voice-error">{state.error}</div>}
        <div className="voice-controls">
          {here ? (
            <>
              <button className={'btn' + (state.muted ? ' on' : '')} onClick={actions.toggleMute}><Icon name={state.muted ? 'micoff' : 'mic'} size={18} className="inline-icon" /> {state.muted ? 'Unmute' : 'Mute'}</button>
              <button className={'btn' + (state.deafened ? ' on' : '')} onClick={actions.toggleDeafen}><Icon name="speaker" size={18} className="inline-icon" /> {state.deafened ? 'Undeafen' : 'Deafen'}</button>
              <button className="btn primary danger-fill" onClick={actions.leave}><Icon name="phone" size={18} className="inline-icon" /> Leave</button>
            </>
          ) : (
            <button className="btn primary" disabled={state.connecting || full} onClick={() => actions.join(channel.id)}>
              {state.connecting ? 'Connecting…' : full ? 'Channel is full' : 'Join voice'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
