import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './ui.jsx';

// The profile song on a card. Two kinds:
//  - an uploaded clip ({ id, title } from the server, or { url, title } for a file just picked in the profile editor): it starts out MUTED and loops while
//    the card is open, and nobody hears anything until they press the speaker. (Muted playback is allowed everywhere; the unmuting press is the user gesture
//    that lets the sound start.) Closing the card unmounts this, which stops it.
//  - a song from the search ({ kind: 'track', title, artist, art, url, link }): cover, title, artist and a play button for its 30 second preview. It never plays
//    by itself, and the card also links to the same song on Spotify and YouTube Music (a search link: neither service gives an app a keyless way to play a song).
// The route behind /api/songs/:id supports Range requests, which Safari needs before it will play an audio file. Rules and limits: server/profile.js and server/music.js.
export const songUrl = (song) => (song && (song.url || (song.id ? `/api/songs/${song.id}` : ''))) || '';

export default function ProfileSong({ song }) {
  return song && song.kind === 'track' ? <TrackSong song={song} /> : <ClipSong song={song} />;
}

function TrackSong({ song }) {
  const audio = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState(0);
  const src = song.url;
  // The part of the preview the person picked (song.start / song.end, seconds). Without one the whole preview plays.
  const start = Number.isFinite(song.start) && song.start >= 0 ? song.start : 0;
  const end = Number.isFinite(song.end) && song.end > start ? song.end : Infinity;

  useEffect(() => {
    setPlaying(false); setFailed(false); setProgress(0);
    const a = audio.current;
    return () => { if (a) a.pause(); }; // closing the card (or switching song) stops it
  }, [src]);

  if (!src) return null;
  const title = (song.title || 'Profile song').slice(0, 60);
  const q = encodeURIComponent(`${song.title || ''} ${song.artist || ''}`.trim());
  const secs = Number.isFinite(end) ? Math.round(end - start) : 30;

  function toggle() {
    const a = audio.current;
    if (!a) return;
    if (a.paused) {
      // Setting the time before the file is loaded is fine: the browser starts from there once it has it.
      if (a.currentTime < start || a.currentTime >= end - 0.05) a.currentTime = start;
      a.play().then(() => setPlaying(true)).catch(() => setFailed(true));
    } else { a.pause(); setPlaying(false); }
  }
  function onTime(e) {
    const a = e.currentTarget;
    if (a.currentTime >= end) { a.pause(); a.currentTime = start; setPlaying(false); setProgress(0); return; } // the end of the picked part
    const len = (Number.isFinite(end) ? end : a.duration) - start;
    setProgress(len > 0 ? Math.max(0, Math.min(1, (a.currentTime - start) / len)) : 0);
  }

  return (
    <>
      <h4>PROFILE SONG</h4>
      <div className={'psong track' + (playing ? ' on' : '')}>
        <span className="sp-cover">{song.art ? <img src={song.art} alt="" draggable={false} /> : <Icon name="music" size={18} />}</span>
        <span className="psong-meta grow">
          <span className="psong-title">{title}</span>
          <span className="muted small psong-artist" role="status">{failed ? 'This song could not be played' : song.artist || ''}</span>
          <span className="psong-bar" style={{ '--p': progress }}><i /></span>
        </span>
        <button type="button" className="psong-btn" onClick={toggle} disabled={failed} aria-pressed={playing}
          aria-label={(playing ? 'Pause ' : 'Play ') + title} title={playing ? 'Pause' : `Play a ${secs} second preview`}>
          <Icon name={playing ? 'pause' : 'play'} size={18} />
        </button>
      </div>
      <div className="plinks psong-links">
        <a className="plink" href={`https://open.spotify.com/search/${q}`} target="_blank" rel="noopener noreferrer"><Icon name="link" size={14} /><span>Spotify</span></a>
        <a className="plink" href={`https://music.youtube.com/search?q=${q}`} target="_blank" rel="noopener noreferrer"><Icon name="link" size={14} /><span>YouTube Music</span></a>
      </div>
      <audio ref={audio} src={src} preload="none" onTimeUpdate={onTime}
        onEnded={() => { setPlaying(false); setProgress(0); const a = audio.current; if (a) a.currentTime = start; }} onError={() => setFailed(true)} />
    </>
  );
}

function ClipSong({ song }) {
  const audio = useRef(null);
  const [muted, setMuted] = useState(true);
  const [failed, setFailed] = useState(false);
  const src = songUrl(song);

  useEffect(() => {
    const a = audio.current;
    if (!a || !src) return undefined;
    setMuted(true); setFailed(false);
    a.muted = true; a.loop = true; // set on the element itself: React does not keep the muted attribute in sync
    a.play().catch(() => { /* the browser said no: the speaker button starts it */ });
    return () => { a.pause(); };
  }, [src]);

  if (!src) return null;
  const title = (song.title || 'Profile song').slice(0, 60);

  function toggle() {
    const a = audio.current;
    if (!a) return;
    const next = !a.muted; // the new muted state
    a.muted = next;
    setMuted(next);
    if (!next) a.play().catch(() => setFailed(true));
  }

  return (
    <>
      <h4>PROFILE SONG</h4>
      <div className={'psong' + (muted ? '' : ' on')}>
        <button type="button" className="psong-btn" onClick={toggle} disabled={failed} aria-pressed={!muted}
          aria-label={(muted ? 'Unmute ' : 'Mute ') + title} title={muted ? 'Muted. Press to listen' : 'Press to mute'}>
          <Icon name={muted ? 'speakeroff' : 'speaker'} size={18} />
        </button>
        <span className="psong-meta">
          <span className="psong-title"><Icon name="music" size={14} className="inline-icon" /> {title}</span>
          <span className="muted small" role="status">{failed ? 'This song could not be played' : muted ? 'Muted' : 'Playing'}</span>
        </span>
      </div>
      <audio ref={audio} src={src} preload="auto" onError={() => setFailed(true)} />
    </>
  );
}
