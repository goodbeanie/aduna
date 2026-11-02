import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './ui.jsx';

// The profile song on a card. It starts out MUTED and loops while the card is open: nobody hears anything until they press the speaker.
// (Muted playback is allowed everywhere; the unmuting press is the user gesture that lets the sound start.) Closing the card unmounts this, which stops it.
// `song` is { id, title } from the server, or { url, title } for a file the person just picked in the profile editor (a preview before saving).
// The route behind /api/songs/:id supports Range requests, which Safari needs before it will play an audio file. Rules and limits: server/profile.js.
export const songUrl = (song) => (song && (song.url || (song.id ? `/api/songs/${song.id}` : ''))) || '';

export default function ProfileSong({ song }) {
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
