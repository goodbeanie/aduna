import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Avatar } from './ui.jsx';
import { DialogHost } from './Dialogs.jsx';
import ClipActions, { exact } from './ClipActions.jsx';
import { VideoPlayer } from './Clips.jsx';
import './dash.css';

// A single clip on its own page: /clips/<clip id>. The same link works for sharing. You have to be signed in to Aduna to watch (like the feed).
const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' minutes ago';
  if (s < 86400) return Math.round(s / 3600) + ' hours ago';
  return Math.round(s / 86400) + ' days ago';
};
const left = (t) => {
  const s = (t - Date.now()) / 1000;
  if (s <= 0) return 'ending now';
  return s < 86400 ? 'removed in ' + Math.max(1, Math.round(s / 3600)) + 'h' : 'removed in ' + Math.round(s / 86400) + ' days';
};

export default function ClipPage({ id }) {
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'gone' | 'signedout' | 'off' | 'error'
  const [clip, setClip] = useState(null);
  const counted = useRef(false);

  const load = async () => {
    setState('loading');
    try {
      const r = await api('/clips/' + encodeURIComponent(id));
      setClip(r.clip);
      setState('ready');
    } catch (e) {
      setState(e.status === 401 ? 'signedout' : e.status === 404 ? 'gone' : e.status === 503 ? 'off' : 'error');
    }
  };
  useEffect(() => { document.title = 'Clip · Aduna'; load(); }, [id]);
  useEffect(() => { if (clip) document.title = (clip.caption ? clip.caption.slice(0, 60) : 'Clip by ' + (clip.owner.username || 'someone')) + ' · Aduna'; }, [clip]);

  const play = () => {
    if (counted.current) return;
    counted.current = true;
    api(`/clips/${id}/view`, { method: 'POST' }).then((r) => setClip((c) => (c ? { ...c, views: r.views } : c))).catch(() => {});
  };

  const ratio = clip && clip.width && clip.height ? clip.width / clip.height : 9 / 16;
  return (
    <div className="yt-dash">
      <header className="yt-top">
        <a className="yt-logo" href="/app"><i aria-hidden="true" />Aduna<small>Clips</small></a>
        <div className="yt-search" />
        <a className="yt-back" href="/app">Back to Aduna</a>
      </header>

      <main className="watch">
        {state === 'loading' && <p className="muted">Loading…</p>}
        {state === 'signedout' && <div className="dash-card"><h2>Sign in to watch</h2><p className="muted">Open Aduna, sign in, then open this link again.</p><div><a className="btn primary" href="/app">Open Aduna</a></div></div>}
        {state === 'off' && <div className="dash-card"><h2>Clips are not switched on yet</h2><p className="muted">Check back soon.</p></div>}
        {state === 'gone' && <div className="dash-card"><h2>This clip is gone</h2><p className="muted">Clips are removed after a few days, or the poster took it down.</p><div><a className="btn primary" href="/app">Back to Aduna</a></div></div>}
        {state === 'error' && <div className="dash-card"><h2>Something went wrong</h2><div><button className="btn" onClick={load}>Try again</button></div></div>}

        {state === 'ready' && clip && (
          <>
            <div className="watch-player">
              <VideoPlayer inline className="watch-video" style={{ aspectRatio: String(ratio) }} src={clip.url} poster={clip.poster} autoPlay onPlay={play} />
            </div>
            <div className="watch-info">
              {clip.caption && <h1 className="watch-title">{clip.caption}</h1>}
              <div className="watch-meta muted">{exact(clip.views)} views · {ago(clip.createdAt)} · {left(clip.expiresAt)}</div>
              <div className="watch-who">
                <Avatar user={{ ...clip.owner, id: clip.owner.id }} size={40} />
                <b>{clip.owner.username || 'Someone'}</b>
              </div>
              <ClipActions clip={clip} onChange={setClip} onGone={() => setState('gone')} />
            </div>
          </>
        )}
        <DialogHost />
      </main>
    </div>
  );
}
