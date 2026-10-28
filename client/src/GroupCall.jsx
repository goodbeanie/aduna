import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, Icon } from './ui.jsx';
import { emitAck } from './api.js';
import { encryptFor, decryptFrom } from './crypto.js';
import { getIce, restartPath } from './rtc.js';
import * as snd from './callsound.js';
import { ringtoneFor } from './ringtones.js';
import { applyOutput, camConstraint, EVENT as DEVICES_EVENT } from './devices.js';
import { getMedia, alertCall, startRing, stopRing, Tile, StageBtn, CallTimer, useSpeaking, usePhone } from './Call.jsx';

// Group calls: a mesh. Everybody on the call has a direct WebRTC connection to everybody else (the server allows 8 people).
// The server only rings, keeps the roster and relays signalling; the signalling between two people is encrypted with the same
// pairwise key their DMs use, so the server cannot read or alter it.
//   - The person who joins sends the offer to each person already on the call (the server tells them who that is).
//   - Every pair then runs "perfect negotiation" on its own, so anyone can add a camera later.
//   - A pair is polite when this person's id is the larger one; both sides compute the same answer.

const IDLE = { phase: 'idle', groupId: null, callId: null, video: false, startedAt: 0, muted: false, deafened: false, camOn: false, preview: null, local: null, peers: {}, notice: '', incoming: null };

export const IN_GROUP_CALL = ['starting', 'active'];
export const inGroupCall = (g) => IN_GROUP_CALL.includes(g.phase);

const RING_SECONDS = 30;
const ENDED_NOTICE = {
  removed: 'You were removed from this group',
  deleted: 'This group was deleted',
  'other-window': 'You joined this call in another window',
};

export function useGroupCall({ socketRef, privKey, me, getUser, isBusy }) {
  const [gcall, setG] = useState(IDLE);
  const cRef = useRef(IDLE);
  // links: userId -> { pc, polite, makingOffer, ignoreOffer, cands, tracksAdded, stream, restarts, dropTimer, vsender, link }
  const rt = useRef({ local: null, cam: null, links: new Map(), opening: new Map(), chain: Promise.resolve(), ringTimer: 0, mutedBeforeDeafen: false });

  const set = (patch) => { cRef.current = { ...cRef.current, ...patch }; setG(cRef.current); };
  const setPeer = (uid, patch) => {
    const prev = cRef.current.peers[uid] || {};
    set({ peers: { ...cRef.current.peers, [uid]: { ...prev, ...patch, rev: (prev.rev || 0) + 1 } } });
  };
  const nameOf = (id) => getUser(id)?.displayName || 'Someone';

  function closeLink(uid) {
    const L = rt.current.links.get(uid);
    if (!L) return;
    clearTimeout(L.dropTimer);
    rt.current.links.delete(uid);
    try { L.pc.close(); } catch { /* already closed */ }
  }
  function teardown() {
    const r = rt.current;
    stopRing();
    clearTimeout(r.ringTimer);
    for (const uid of [...r.links.keys()]) closeLink(uid);
    r.opening.clear();
    r.local?.getTracks().forEach((t) => t.stop());
    r.cam?.stop();
    Object.assign(r, { local: null, cam: null, chain: Promise.resolve(), mutedBeforeDeafen: false });
  }
  const finish = (notice = '') => {
    const was = cRef.current.phase;
    teardown();
    cRef.current = { ...IDLE, notice }; setG(cRef.current);
    if (was === 'active') snd.cue.disconnect();
  };

  const camLive = () => { const t = rt.current.cam; return !!t && t.enabled && t.readyState === 'live'; };
  const stateNow = () => ({ cam: camLive(), mic: !cRef.current.muted, deaf: !!cRef.current.deafened });

  async function send(uid, data) {
    const c = cRef.current, peer = getUser(uid);
    if (!c.callId || !peer?.publicKey) return;
    const enc = await encryptFor(privKey, peer.publicKey, JSON.stringify(data));
    socketRef.current?.emit('gcall:signal', { groupId: c.groupId, to: uid, data: enc });
  }
  function announce() {
    const on = camLive();
    set({ preview: on ? new MediaStream([rt.current.cam]) : null, camOn: on });
    const state = stateNow();
    for (const uid of rt.current.links.keys()) send(uid, { state }).catch(() => {});
  }

  function addLocalTracks(L) {
    const local = rt.current.local;
    if (!local || L.tracksAdded) return;
    L.tracksAdded = true;
    for (const t of local.getTracks()) {
      const s = L.pc.addTrack(t, local);
      if (t.kind === 'video') L.vsender = s;
    }
  }

  async function openLink(uid) {
    const r = rt.current;
    closeLink(uid); // a new connection from someone who dropped and came back
    const { servers, relay } = await getIce();
    if (cRef.current.phase === 'idle') throw new Error('call ended');
    const pc = new RTCPeerConnection({ iceServers: servers });
    const L = { pc, polite: String(me.id) > String(uid), makingOffer: false, ignoreOffer: false, cands: [], tracksAdded: false, stream: new MediaStream(), restarts: 0, dropTimer: 0, vsender: null, link: 'connecting', relay };
    r.links.set(uid, L);
    setPeer(uid, { link: 'connecting', stream: L.stream });

    pc.onicecandidate = (e) => { if (e.candidate) send(uid, { candidate: e.candidate }).catch(() => {}); };
    pc.ontrack = (e) => {
      if (!L.stream.getTracks().includes(e.track)) L.stream.addTrack(e.track);
      e.track.onmute = e.track.onunmute = () => setPeer(uid, { stream: L.stream });
      setPeer(uid, { stream: L.stream });
    };
    pc.onnegotiationneeded = async () => {
      try { L.makingOffer = true; await pc.setLocalDescription(); await send(uid, { description: pc.localDescription }); }
      catch (e) { console.warn('group negotiation failed', e); } finally { L.makingOffer = false; }
    };

    const current = () => r.links.get(uid)?.pc === pc;
    const lose = () => {
      if (!current()) return;
      closeLink(uid);
      setPeer(uid, { link: 'failed' });
      set({ notice: `Lost connection with ${nameOf(uid)}` });
    };
    const retry = async () => {
      if (!current() || L.restarts >= 3 || !(await restartPath(pc))) return false;
      L.restarts += 1;
      return true;
    };
    pc.oniceconnectionstatechange = () => {
      if (!current()) return;
      const st = pc.iceConnectionState;
      if (st === 'connected' || st === 'completed') {
        clearTimeout(L.dropTimer);
        L.restarts = 0;
        if (L.link !== 'connected') {
          L.link = 'connected';
          setPeer(uid, { link: 'connected' });
          send(uid, { state: stateNow() }).catch(() => {}); // tell them whether we are muted or have a camera on
        }
      } else if (st === 'failed') {
        clearTimeout(L.dropTimer);
        retry().then((ok) => { if (!ok) lose(); });
      } else if (st === 'disconnected') {
        clearTimeout(L.dropTimer);
        L.dropTimer = setTimeout(async () => {
          if (!current() || ['connected', 'completed'].includes(pc.iceConnectionState)) return;
          if (!(await retry())) { lose(); return; }
          L.dropTimer = setTimeout(() => { if (current() && !['connected', 'completed'].includes(pc.iceConnectionState)) lose(); }, 10000);
        }, 3000);
      }
    };
    return L;
  }
  // one connection per person, even when two signals for a new person arrive together
  const linkFor = (uid) => {
    const r = rt.current, have = r.links.get(uid);
    if (have) return Promise.resolve(have);
    if (!r.opening.has(uid)) r.opening.set(uid, openLink(uid).finally(() => r.opening.delete(uid)));
    return r.opening.get(uid);
  };

  async function onSignal({ groupId, callId, from, data }) {
    const c = cRef.current;
    if (c.phase === 'idle' || groupId !== c.groupId || callId !== c.callId) return;
    const who = getUser(from);
    if (!who?.publicKey || !data) return;
    let d;
    try { d = JSON.parse(await decryptFrom(privKey, who.publicKey, data.ciphertext, data.iv)); } catch { return; }
    if (d.state) setPeer(from, { state: d.state });
    if (!d.description && !d.candidate) return;
    const L = await linkFor(from);
    const pc = L.pc;
    if (d.description) {
      const collision = d.description.type === 'offer' && (L.makingOffer || pc.signalingState !== 'stable');
      L.ignoreOffer = !L.polite && collision;
      if (L.ignoreOffer) return;
      await pc.setRemoteDescription(d.description);
      for (const cand of L.cands.splice(0)) await pc.addIceCandidate(cand).catch(() => {});
      if (d.description.type === 'offer') {
        addLocalTracks(L); // reuses the transceivers from the offer, so no extra round trip
        await pc.setLocalDescription();
        await send(from, { description: pc.localDescription });
      }
    } else if (d.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(d.candidate).catch(() => { /* a candidate for an ignored offer */ });
      else L.cands.push(d.candidate);
    }
  }

  // ----- actions -----
  async function join(groupId, video = false) {
    if (cRef.current.phase !== 'idle') return;
    if (isBusy?.()) { set({ notice: 'You are already on a call' }); return; }
    stopRing(); clearTimeout(rt.current.ringTimer);
    cRef.current = { ...IDLE, phase: 'starting', groupId, video: !!video }; setG(cRef.current);
    let media = null;
    try {
      media = await getMedia(!!video, true);
      if (cRef.current.phase !== 'starting' || cRef.current.groupId !== groupId) { media.getTracks().forEach((t) => t.stop()); return; } // hung up while the permission box was open
      const hasCam = media.getVideoTracks().length > 0;
      const r = await emitAck(socketRef.current, 'gcall:join', { groupId, video: hasCam });
      if (cRef.current.phase !== 'starting' || cRef.current.groupId !== groupId) { // hung up while the server answered
        media.getTracks().forEach((t) => t.stop());
        socketRef.current?.emit('gcall:leave', { groupId });
        return;
      }
      rt.current.local = media;
      rt.current.cam = media.getVideoTracks()[0] || null;
      set({ phase: 'active', callId: r.callId, video: !!r.video, startedAt: Date.now(), camOn: hasCam, local: media, preview: hasCam ? new MediaStream(media.getVideoTracks()) : null });
      snd.cue.connect();
      for (const uid of r.peers || []) linkFor(uid).then(addLocalTracks).catch((e) => console.warn('group link failed', e)); // the joiner makes the offers
    } catch (e) {
      media?.getTracks().forEach((t) => t.stop());
      if (cRef.current.phase === 'starting') finish(e.message);
    }
  }

  const accept = () => {
    const inc = cRef.current.incoming;
    if (inc) join(inc.groupId, inc.video);
  };
  function decline() {
    if (!cRef.current.incoming) return;
    stopRing(); clearTimeout(rt.current.ringTimer);
    set({ incoming: null });
  }

  function hangup(notice = '') {
    const c = cRef.current;
    if (c.groupId && inGroupCall(c)) socketRef.current?.emit('gcall:leave', { groupId: c.groupId });
    finish(notice);
  }

  function applyMute(muted) {
    rt.current.local?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    set({ muted });
  }
  function toggleMute() {
    const c = cRef.current;
    if (c.deafened) { set({ deafened: false }); applyMute(false); snd.cue.undeafen(); announce(); return; } // unmuting while deafened lets you hear again
    const muted = !c.muted;
    applyMute(muted);
    (muted ? snd.cue.mute : snd.cue.unmute)();
    announce();
  }
  function toggleDeafen() {
    const c = cRef.current, r = rt.current;
    if (c.deafened) { set({ deafened: false }); applyMute(!!r.mutedBeforeDeafen); snd.cue.undeafen(); }
    else { r.mutedBeforeDeafen = c.muted; set({ deafened: true }); applyMute(true); snd.cue.deafen(); }
    announce();
  }

  async function toggleCamera() {
    const r = rt.current;
    if (cRef.current.phase !== 'active' || !r.local) return;
    try {
      if (r.cam && r.cam.readyState === 'live') r.cam.enabled = !r.cam.enabled;
      else {
        // a smaller picture than in a 1:1 call: it is sent to every other person
        const t = (await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 }, ...camConstraint() } })).getVideoTracks()[0];
        r.cam = t; r.local.addTrack(t);
        for (const L of r.links.values()) {
          if (L.vsender) await L.vsender.replaceTrack(t).catch(() => {});
          else L.vsender = L.pc.addTrack(t, r.local); // adding a track makes the pair negotiate again
        }
      }
      announce();
    } catch (e) { set({ notice: e.name === 'NotAllowedError' ? 'Camera permission was denied' : 'Could not start the camera' }); }
  }

  // ----- socket events -----
  const handleRef = useRef(null);
  handleRef.current = (ev, p) => {
    const c = cRef.current;
    if (ev === 'gcall:incoming') {
      if (c.phase !== 'idle' || isBusy?.() || c.incoming?.callId === p.callId) return;
      set({ incoming: { groupId: p.groupId, callId: p.callId, from: p.from, video: !!p.video } });
      startRing('in');
      alertCall(`${nameOf(p.from)} started a group call`, p.video, 'g:' + p.groupId);
      clearTimeout(rt.current.ringTimer);
      rt.current.ringTimer = setTimeout(() => { if (cRef.current.incoming?.callId === p.callId) { stopRing(); set({ incoming: null }); } }, RING_SECONDS * 1000);
    } else if (ev === 'gcall:signal') {
      rt.current.chain = rt.current.chain.then(() => onSignal(p)).catch((e) => console.warn('group signal failed', e));
    } else if (ev === 'gcall:left') {
      if (p.callId !== c.callId || c.phase === 'idle') return;
      closeLink(p.userId);
      const { [p.userId]: gone, ...rest } = c.peers; // eslint-disable-line no-unused-vars
      set({ peers: rest });
    } else if (ev === 'gcall:ended') {
      if (c.incoming && c.incoming.groupId === p.groupId) { stopRing(); clearTimeout(rt.current.ringTimer); set({ incoming: null }); }
      if (c.callId && p.callId === c.callId && inGroupCall(c)) finish(ENDED_NOTICE[p.reason] || '');
    } else if (ev === 'disconnect') {
      if (inGroupCall(c)) finish('Connection lost');
      else if (c.incoming) { stopRing(); clearTimeout(rt.current.ringTimer); set({ incoming: null }); }
    }
  };
  const handle = useCallback((ev, p) => handleRef.current(ev, p), []);
  useEffect(() => () => {
    const c = cRef.current;
    if (c.groupId && inGroupCall(c)) socketRef.current?.emit('gcall:leave', { groupId: c.groupId });
    teardown();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { gcall, handle, actions: { join, accept, decline, hangup: () => hangup(), toggleMute, toggleDeafen, toggleCamera, clearNotice: () => set({ notice: '' }) } };
}

// =====================================================================================================
// Interface. Same look as one-to-one calls (Call.jsx): the stage sits at the top of the group chat, a panel in the sidebar
// follows you around, an incoming call drops in at the top, and a banner in the chat lets you join a call that is running.
// =====================================================================================================
const nameOfUser = (u) => u?.displayName || 'Someone';
const hasVideo = (s) => !!s && s.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);
const statusLabel = (g, peerCount) => (g.phase === 'starting' ? 'Starting\u2026' : peerCount === 0 ? 'Waiting for others\u2026' : g.video || g.camOn ? 'Video Connected' : 'Voice Connected');

function PeerAudio({ stream, deaf }) {
  const ref = useRef(null);
  useEffect(() => { const el = ref.current; if (el && el.srcObject !== stream) el.srcObject = stream || null; }, [stream]);
  useEffect(() => {
    const go = () => applyOutput(ref.current); // the speakers chosen in Settings > Voice & Video, also when changed during the call
    go(); window.addEventListener(DEVICES_EVENT, go);
    return () => window.removeEventListener(DEVICES_EVENT, go);
  }, []);
  return <audio ref={ref} autoPlay muted={deaf} />;
}
// Always mounted (even while you read another chat) so the call keeps going.
function GroupAudio({ gcall }) {
  return <>{Object.entries(gcall.peers).map(([id, p]) => p.stream && <PeerAudio key={id} stream={p.stream} deaf={!!gcall.deafened} />)}</>;
}

function PeerTile({ id, p, users, live, size, small, pinned, onPick }) {
  const talking = useSpeaking(p.stream, live && p.state?.mic !== false && p.link === 'connected');
  return (
    <Tile user={users[id]} label={nameOfUser(users[id])} size={size} stream={p.stream} showVideo={hasVideo(p.stream) && p.state?.cam !== false}
      speaking={talking} waiting={p.link !== 'connected'} muted={p.state?.mic === false} deaf={!!p.state?.deaf} live={p.link === 'connected'}
      small={small} pinned={pinned} onPick={onPick} />
  );
}

export function GroupCallStage({ gcall, actions, users, me, titleFor }) {
  const phone = usePhone();
  const [big, setBig] = useState(false);
  const [pin, setPin] = useState(null); // a user id, 'me' or null: the tile the person clicked to focus
  useEffect(() => { if (phone && gcall.video) setBig(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- phones open a video call full size
  const live = gcall.phase === 'active';
  const ids = Object.keys(gcall.peers);
  const total = ids.length + 1;
  const meTalking = useSpeaking(gcall.local, live && !gcall.muted);
  const focus = pin && (pin === 'me' || gcall.peers[pin]) ? pin : null;
  const av = focus ? (phone ? 56 : 72) : total <= 2 ? (phone ? 64 : 84) : total <= 4 ? (phone ? 48 : 64) : 44;
  const pick = (who) => () => setPin(pin === who ? null : who);
  const title = titleFor(gcall.groupId);

  return (
    <section className={'call-stage gcall' + (big ? ' big' : '') + (live ? ' live' : '')} aria-label="Group call">
      <div className="stage-top">
        <span className={'call-dot' + (live && ids.length ? ' live' : ' ring')} />
        <span className="stage-status" aria-live="polite">
          <b>{statusLabel(gcall, ids.length)}</b>
          <span className="stage-with">{title}{live && <> &middot; <CallTimer since={gcall.startedAt} /></>} &middot; {total} {total === 1 ? 'person' : 'people'}</span>
        </span>
        <span className="call-lock" title="End-to-end encrypted signalling; media is encrypted peer to peer"><Icon name="lock" size={13} /></span>
        <div className="spacer" />
        <button className="stage-icon" title={big ? 'Show chat' : 'Expand call'} aria-label={big ? 'Show chat' : 'Expand call'} onClick={() => setBig(!big)}><Icon name={big ? 'shrink' : 'expand'} size={16} /></button>
      </div>

      <div className={'stage-tiles gcall-grid' + (focus ? ' spot' : '')} data-n={Math.min(total, 8)}>
        {ids.map((id) => (
          <PeerTile key={id} id={id} p={gcall.peers[id]} users={users} live={live} size={av} small={!!focus && focus !== id} pinned={pin === id} onPick={live ? pick(id) : undefined} />
        ))}
        <Tile user={me} label="You" size={av} stream={gcall.preview} showVideo={!!gcall.preview} mirror
          speaking={meTalking} muted={gcall.muted} deaf={gcall.deafened} live={live}
          small={!!focus && focus !== 'me'} pinned={pin === 'me'} onPick={live ? pick('me') : undefined} />
      </div>

      <div className="stage-controls">
        <div className="stage-pill">
          <StageBtn icon={gcall.camOn ? 'video' : 'videooff'} title={gcall.camOn ? 'Turn camera off' : 'Turn camera on'} off={!gcall.camOn} onClick={actions.toggleCamera} disabled={!live} />
          <StageBtn icon={gcall.muted ? 'micoff' : 'mic'} title={gcall.muted ? 'Unmute' : 'Mute'} off={gcall.muted} onClick={actions.toggleMute} disabled={!live} />
          <StageBtn icon={gcall.deafened ? 'headphonesoff' : 'headphones'} title={gcall.deafened ? 'Undeafen' : 'Deafen'} off={gcall.deafened} onClick={actions.toggleDeafen} disabled={!live} />
        </div>
        <StageBtn icon="phone" title="Leave call" hangup onClick={actions.hangup} />
      </div>
    </section>
  );
}

// "Voice Connected" panel in the sidebar. Stays while you read other chats; clicking it takes you back to the call.
export function GroupCallDock({ gcall, actions, titleFor, onOpen }) {
  if (!inGroupCall(gcall)) return null;
  const live = gcall.phase === 'active', n = Object.keys(gcall.peers).length;
  return (
    <div className="call-dock" role="region" aria-label="Group call controls">
      <div className="cd-row">
        <span className={'signal' + (live && n ? ' live' : ' wait')}><Icon name="signal" size={18} /></span>
        <button className="cd-who" title="Go to the call" onClick={() => onOpen?.(gcall.groupId)}>
          <b className={live && n ? '' : 'wait'}>{statusLabel(gcall, n)}</b>
          <span>{titleFor(gcall.groupId)}{live && <> &middot; <CallTimer since={gcall.startedAt} /></>}</span>
        </button>
        <button className="cd-btn hang" title="Leave call" aria-label="Leave call" onClick={actions.hangup}><Icon name="phone" size={18} style={{ transform: 'rotate(135deg)' }} /></button>
      </div>
      <div className="cd-tools">
        <button className={'cd-btn' + (gcall.muted ? ' off' : '')} title={gcall.muted ? 'Unmute' : 'Mute'} aria-label={gcall.muted ? 'Unmute' : 'Mute'} onClick={actions.toggleMute} disabled={!live}><Icon name={gcall.muted ? 'micoff' : 'mic'} size={17} /></button>
        <button className={'cd-btn' + (gcall.deafened ? ' off' : '')} title={gcall.deafened ? 'Undeafen' : 'Deafen'} aria-label={gcall.deafened ? 'Undeafen' : 'Deafen'} onClick={actions.toggleDeafen} disabled={!live}><Icon name={gcall.deafened ? 'headphonesoff' : 'headphones'} size={17} /></button>
        <button className={'cd-btn' + (gcall.camOn ? ' on' : '')} title={gcall.camOn ? 'Turn camera off' : 'Turn camera on'} aria-label={gcall.camOn ? 'Turn camera off' : 'Turn camera on'} onClick={actions.toggleCamera} disabled={!live}><Icon name={gcall.camOn ? 'video' : 'videooff'} size={17} /></button>
      </div>
    </div>
  );
}

// Phones only (CSS hides it elsewhere): a slim strip under the top bar while you are in a chat other than the call.
function GroupCallStrip({ gcall, actions, titleFor, onOpen }) {
  const live = gcall.phase === 'active';
  return (
    <div className="call-strip" role="region" aria-label="Group call">
      <button className="cs-who" onClick={() => onOpen?.(gcall.groupId)} title="Go to the call">
        <span className={'call-dot' + (live ? ' live' : ' ring')} />
        <span className="cs-name">{titleFor(gcall.groupId)}</span>
        <span className="muted small">{live ? <CallTimer since={gcall.startedAt} /> : 'Starting\u2026'}</span>
      </button>
      <button className={'cd-btn' + (gcall.muted ? ' off' : '')} title={gcall.muted ? 'Unmute' : 'Mute'} aria-label={gcall.muted ? 'Unmute' : 'Mute'} onClick={actions.toggleMute}><Icon name={gcall.muted ? 'micoff' : 'mic'} size={18} /></button>
      <button className="cd-btn hang" title="Leave call" aria-label="Leave call" onClick={actions.hangup}><Icon name="phone" size={18} style={{ transform: 'rotate(135deg)' }} /></button>
    </div>
  );
}

function GroupIncoming({ gcall, actions, users, titleFor }) {
  const phone = usePhone();
  const inc = gcall.incoming, from = users[inc.from], kind = inc.video ? 'video' : 'voice', tone = ringtoneFor();
  const accept = useRef(actions.accept);
  accept.current = actions.accept;
  useEffect(() => {
    const h = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); accept.current(); } }; // Ctrl+Enter answers, as in 1:1 calls
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  return (
    <aside className="call-incoming" data-season={tone.id} role="alertdialog" aria-label={`Incoming group ${kind} call in ${titleFor(inc.groupId)}`}>
      <div className="call-pulse"><Avatar user={from} size={phone ? 120 : 60} /></div>
      <div className="ci-text">
        <div className="ci-name">{titleFor(inc.groupId)}</div>
        <div className="ci-sub">{nameOfUser(from)} started a group {kind} call{'\u2026'}{tone.id !== 'default' && <span className="ci-season">{tone.id === 'halloween' ? '\u{1F383}' : '\u{1F384}'} {tone.label}</span>}</div>
      </div>
      <div className="ci-actions">
        <button className="ci-btn decline" title="Dismiss" aria-label="Dismiss" onClick={actions.decline}><Icon name="phone" size={phone ? 26 : 22} style={{ transform: 'rotate(135deg)' }} /><span>Dismiss</span></button>
        <button className="ci-btn accept" title="Join (Ctrl+Enter)" aria-label="Join" onClick={actions.accept}><Icon name={inc.video ? 'video' : 'phone'} size={phone ? 26 : 22} /><span>Join</span></button>
      </div>
    </aside>
  );
}

// The parts of a group call that are not tied to one place on screen: the voices, the ring card, the notice toast and the phone strip.
// (The stage and the dock are placed by App.jsx.) `showStrip` is false while the stage is on screen.
export function GroupCallUI({ gcall, actions, users, titleFor, onOpen, showStrip }) {
  useEffect(() => {
    if (!gcall.notice) return undefined;
    const t = setTimeout(actions.clearNotice, 5000);
    return () => clearTimeout(t);
  }, [gcall.notice]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <GroupAudio gcall={gcall} />
      {gcall.notice && <div className="call-toast" role="status">{gcall.notice}</div>}
      {gcall.incoming && gcall.phase === 'idle' && <GroupIncoming gcall={gcall} actions={actions} users={users} titleFor={titleFor} />}
      {showStrip && inGroupCall(gcall) && <GroupCallStrip gcall={gcall} actions={actions} titleFor={titleFor} onOpen={onOpen} />}
    </>
  );
}

// At the top of a group chat while a call is running and you are not in it.
export function GroupCallBanner({ group, gcall, actions, users }) {
  const info = group?.call;
  if (!info || (gcall.groupId === group.id && inGroupCall(gcall))) return null;
  const busy = inGroupCall(gcall); // already in another call
  const names = info.users.map((id) => users[id]).filter(Boolean);
  return (
    <div className="gcall-banner" role="region" aria-label="A call is running">
      <span className="call-dot live" />
      <span className="gb-faces">{names.slice(0, 4).map((u) => <Avatar key={u.id} user={u} size={24} />)}</span>
      <span className="gb-text"><b>{info.video ? 'Video call' : 'Voice call'}</b> &middot; {info.users.length} in the call</span>
      <div className="spacer" />
      <button className="gb-btn" onClick={() => actions.join(group.id, false)} disabled={busy} title={busy ? 'Leave your current call first' : 'Join with your microphone'}><Icon name="phone" size={16} /> Join</button>
      <button className="gb-btn icon" onClick={() => actions.join(group.id, true)} disabled={busy} title="Join with your camera" aria-label="Join with video"><Icon name="video" size={16} /></button>
    </div>
  );
}
