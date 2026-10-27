import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Avatar } from './ui.jsx';
import { DialogHost, toast } from './Dialogs.jsx';
import { ClipCard } from './Clips.jsx';
import './dash.css';
import './clipssite.css';

// The Clips website: /clips is the feed, /clips/user/<id> is one person's page. It is its own page (the Clips button in Aduna opens it),
// dark like the creator dashboard. Your picture sits bottom right; it opens a small menu: back to Aduna, your dashboard, your page.
const TABS = [['feed', 'New'], ['top', 'Top'], ['following', 'Following']];
const NONE = 'No content has been posted';

// the picture bottom right and the menu it opens
function MeMenu({ me }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className="cs-me" ref={box}>
      {open && (
        <div className="cs-me-menu" role="menu" aria-label="Your account">
          <div className="cs-me-who">{me.username || 'You'}</div>
          <a role="menuitem" className="cs-me-item" href="/app">Return to Aduna</a>
          <a role="menuitem" className="cs-me-item" href="/dashboard">Go to dashboard</a>
          <a role="menuitem" className="cs-me-item" href={`/clips/user/${me.id}`}>View my page</a>
        </div>
      )}
      <button className="cs-me-btn" aria-haspopup="menu" aria-expanded={open} aria-label="Your account menu" title={me.username || 'Your account'} onClick={() => setOpen((v) => !v)}>
        <Avatar user={me} size={48} />
      </button>
    </div>
  );
}

export default function ClipsSite({ userId = null }) {
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState('feed'); // 'feed' | 'top' | 'following' (a person's page always shows their newest)
  const [clips, setClips] = useState([]);
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'off' | 'error' | 'signedout' | 'notfound'
  const [more, setMore] = useState(false);
  const [profile, setProfile] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { document.title = 'Clips · Aduna'; api('/me').then((r) => setMe(r.user)).catch(() => {}); }, []);

  useEffect(() => {
    setProfile(null);
    if (!userId) return;
    api('/clips/creator/' + encodeURIComponent(userId)).then((r) => {
      setProfile(r.user);
      document.title = (r.user.username || 'Creator') + ' · Clips · Aduna';
    }).catch((e) => { if (e.status === 404) setState('notfound'); });
  }, [userId]);

  const load = useCallback(async (append, list) => {
    const sort = userId ? 'new' : tab === 'top' ? 'top' : tab === 'following' ? 'following' : 'new';
    const q = new URLSearchParams({ sort, limit: '10' });
    if (userId) q.set('owner', userId);
    if (append && list.length) { if (sort === 'top') q.set('offset', String(list.length)); else q.set('before', String(list[list.length - 1].createdAt)); }
    try {
      const r = await api('/clips?' + q);
      setClips(append ? [...list, ...r.clips] : r.clips);
      setMore(r.clips.length >= 10);
      setState('ready');
    } catch (e) {
      setState(e.status === 401 ? 'signedout' : e.status === 503 ? 'off' : 'error');
    }
  }, [tab, userId]);

  useEffect(() => { setState((s) => (s === 'notfound' ? s : 'loading')); load(false, []); }, [load]);

  // a like or a follow on one clip is kept; following a creator also updates their other clips and their page
  const swap = (c) => {
    setClips((p) => p.map((x) => (x.id === c.id ? c : x.owner.id === c.owner.id ? { ...x, following: c.following, owner: { ...x.owner, followers: c.owner.followers } } : x)));
    setProfile((p) => (p && p.id === c.owner.id ? { ...p, following: c.following, followers: c.owner.followers } : p));
  };
  const gone = (id) => setClips((p) => p.filter((x) => x.id !== id));

  const follow = async () => {
    if (!profile || busy) return;
    setBusy(true);
    try {
      const r = await api(`/clips/follow/${profile.id}`, { method: 'POST' });
      setProfile({ ...profile, following: r.following, followers: r.followers });
      setClips((p) => p.map((x) => (x.owner.id === profile.id ? { ...x, following: r.following, owner: { ...x.owner, followers: r.followers } } : x)));
      toast(r.following ? 'Following ' + (profile.username || 'this creator') : 'Unfollowed');
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  const ready = state === 'ready';
  return (
    <div className="yt-dash cs">
      <header className="yt-top">
        <a className="yt-logo" href="/clips"><i aria-hidden="true" />Aduna<small>Clips</small></a>
        {!userId
          ? <div className="cs-tabs" role="tablist" aria-label="Clips">{TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={'cs-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>{label}</button>)}</div>
          : <div className="yt-search" />}
      </header>

      <main className="cs-main">
        {userId && profile && (
          <div className="cs-profile">
            <Avatar user={profile} size={72} />
            <div className="cs-profile-info">
              <h1>{profile.username || 'Someone'}</h1>
              <span className="muted">{Number(profile.followers || 0).toLocaleString()} {profile.followers === 1 ? 'follower' : 'followers'}</span>
            </div>
            {!profile.mine && profile.creator && <button className={'btn' + (profile.following ? '' : ' primary')} disabled={busy} onClick={follow} aria-pressed={!!profile.following}>{profile.following ? 'Following' : 'Follow'}</button>}
          </div>
        )}

        {state === 'loading' && <p className="muted cs-note">Loading…</p>}
        {state === 'signedout' && <div className="dash-card"><h2>Sign in to watch</h2><p className="muted">Open Aduna, sign in, then come back to Clips.</p><div><a className="btn primary" href="/app">Open Aduna</a></div></div>}
        {state === 'off' && <div className="dash-card"><h2>Clips are not switched on yet</h2><p className="muted">Check back soon.</p></div>}
        {state === 'notfound' && <div className="dash-card"><h2>This page was not found</h2><div><a className="btn primary" href="/clips">Back to Clips</a></div></div>}
        {state === 'error' && <div className="dash-card"><h2>Something went wrong</h2><div><button className="btn" onClick={() => load(false, [])}>Try again</button></div></div>}

        {ready && clips.length === 0 && (
          <div className="cs-empty">
            <p>{NONE}</p>
            {userId && profile && profile.mine && !profile.creator && <a className="dash-link" href="/dashboard">Become a Clips creator on your dashboard</a>}
          </div>
        )}
        {ready && clips.length > 0 && (
          <>
            <div className="clip-list">{clips.map((c) => <ClipCard key={c.id} clip={c} onChange={swap} onGone={gone} />)}</div>
            {more && <button className="btn clip-more" onClick={() => load(true, clips)}>Load more</button>}
          </>
        )}
      </main>

      {me && <MeMenu me={me} />}
      <DialogHost />
    </div>
  );
}
