import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Avatar } from './ui.jsx';
import { DialogHost, toast } from './Dialogs.jsx';
import { ClipCard } from './Clips.jsx';
import ClipSearch, { SearchIcon } from './ClipSearch.jsx';
import './dash.css';
import './clipssite.css';

// The Clips website: /clips is the feed, /clips/user/<id> is one person's page. It is its own page (the Clips button in Aduna opens it),
// dark like the creator dashboard. Your picture sits bottom right; it opens a small menu: back to Aduna, your dashboard, your page.
//
// The feed is one clip per screen and snaps to it. A swipe, one turn of the mouse wheel, or the arrow keys / Page Up / Page Down move
// exactly one clip (CSS scroll-snap does the touch part; the wheel and keys are handled here so a fast scroll never skips a clip).
const TABS = [['feed', 'New'], ['top', 'Top'], ['following', 'Following']];
const NONE = 'No content has been posted';
const GO_MS = 600; // a move takes about this long; further wheel / key input is ignored until it is over

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

const Chevron = ({ up }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
  </svg>
);

export default function ClipsSite({ userId = null }) {
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState('feed'); // 'feed' | 'top' | 'following' (a person's page always shows their newest)
  const [clips, setClips] = useState([]);
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'off' | 'error' | 'signedout' | 'notfound'
  const [more, setMore] = useState(false);
  const [profile, setProfile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [idx, setIdx] = useState(0); // which clip is on screen
  const [searching, setSearching] = useState(false);

  const feedRef = useRef(null);
  const lockUntil = useRef(0);
  const target = useRef(0);
  const loadingMore = useRef(false);

  useEffect(() => { document.title = 'Clips · Aduna'; api('/me').then((r) => setMe(r.user)).catch(() => {}); }, []);

  useEffect(() => {
    setProfile(null);
    if (!userId) return;
    api('/clips/creator/' + encodeURIComponent(userId)).then((r) => {
      setProfile(r.user);
      document.title = (r.user.username || 'Creator') + ' · Clips · Aduna';
    }).catch((e) => { if (e.status === 404) setState('notfound'); });
  }, [userId]);

  const reqId = useRef(0); // only the newest request may change the screen (switching tabs quickly must not show the wrong tab's clips)
  const load = useCallback(async (append, list) => {
    const my = ++reqId.current;
    const sort = userId ? 'new' : tab === 'top' ? 'top' : tab === 'following' ? 'following' : 'new';
    const q = new URLSearchParams({ sort, limit: '10' });
    if (userId) q.set('owner', userId);
    if (append && list.length) { if (sort === 'top') q.set('offset', String(list.length)); else q.set('before', String(list[list.length - 1].createdAt)); }
    try {
      const r = await api('/clips?' + q);
      if (my !== reqId.current) return;
      setClips(append ? [...list, ...r.clips.filter((c) => !list.some((x) => x.id === c.id))] : r.clips);
      setMore(r.clips.length >= 10);
      setState('ready');
    } catch (e) {
      if (my !== reqId.current) return;
      if (append) { setMore(false); return; } // a failed "next page" never throws away the clips already on screen
      setState(e.status === 401 ? 'signedout' : e.status === 503 ? 'off' : 'error');
    }
  }, [tab, userId]);

  useEffect(() => {
    setState((s) => (s === 'notfound' ? s : 'loading'));
    setIdx(0); target.current = 0; lockUntil.current = 0;
    if (feedRef.current) feedRef.current.scrollTop = 0;
    load(false, []);
  }, [load]);

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
  const feeding = ready && clips.length > 0;

  // the newest data for the handlers below, which are set up once
  const latest = useRef({});
  latest.current = { clips, more, load };
  const loadMore = useCallback(() => {
    const s = latest.current;
    if (!s.more || loadingMore.current) return;
    loadingMore.current = true;
    Promise.resolve(s.load(true, s.clips)).finally(() => { loadingMore.current = false; });
  }, []);

  // move `dir` clips (1 = next, -1 = previous), one at a time
  const go = useCallback((dir) => {
    const el = feedRef.current;
    if (!el || !el.children.length) return;
    const now = Date.now();
    const base = now < lockUntil.current ? target.current : Math.round(el.scrollTop / Math.max(1, el.clientHeight));
    const next = Math.min(el.children.length - 1, Math.max(0, base + dir));
    target.current = next;
    lockUntil.current = now + GO_MS;
    el.scrollTo({ top: next * el.clientHeight, behavior: 'smooth' });
    if (next >= el.children.length - 3) loadMore();
  }, [loadMore]);

  // mouse wheel and keyboard: one clip per gesture
  useEffect(() => {
    const el = feedRef.current;
    if (!feeding || !el) return undefined;
    let last = 0;
    const onWheel = (e) => {
      if (e.ctrlKey || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return; // pinch-zoom and sideways scrolling are left alone
      if (e.target.closest && e.target.closest('.ss-back')) return;
      e.preventDefault();
      const now = Date.now();
      const gap = now - last;
      last = now;
      if (Math.abs(e.deltaY) < 4 || now < lockUntil.current) return;
      if (gap < 80) return; // the tail of a trackpad swipe that already moved one clip
      go(e.deltaY > 0 ? 1 : -1);
    };
    const onKey = (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target;
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('.ss-back, .sp')) return; // the comments, share or search popup is open
      const dir = e.key === 'ArrowDown' || e.key === 'PageDown' ? 1 : e.key === 'ArrowUp' || e.key === 'PageUp' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      if (e.repeat && Date.now() < lockUntil.current) return; // holding a key moves one clip at a time, pressing again queues the next one
      go(dir);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => { el.removeEventListener('wheel', onWheel); window.removeEventListener('keydown', onKey); };
  }, [feeding, go]);

  // keep `idx` in step with what is on screen (touch swipes too), and load the next page when near the end
  const onScroll = (e) => {
    const el = e.currentTarget;
    if (!feeding) return;
    const i = Math.round(el.scrollTop / Math.max(1, el.clientHeight));
    setIdx((p) => (p === i ? p : i));
    if (i >= el.children.length - 3) loadMore();
  };

  // The address follows the clip on screen, like YouTube Shorts: /clips/<clip id>. It replaces the current history entry (no new one per swipe,
  // so Back still leaves Clips), and the link can be copied and opened as that clip's own page. On someone's page and while nothing is showing it stays put.
  const shownId = feeding && !userId ? clips[idx]?.id : null;
  useEffect(() => {
    if (userId) return;
    const want = shownId ? '/clips/' + shownId : '/clips';
    try { if (location.pathname !== want) history.replaceState(history.state, '', want); } catch { /* the address just stays as it was */ }
  }, [shownId, userId]);
  useEffect(() => {
    const c = shownId ? clips[idx] : null;
    if (c) document.title = (c.caption ? c.caption.slice(0, 60) : 'Clip by ' + (c.owner.username || 'someone')) + ' · Clips · Aduna';
    else if (!userId) document.title = 'Clips · Aduna';
  }, [shownId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={'yt-dash cs' + (!userId ? ' cs-over' : '')}>
      <header className="yt-top">
        <a className="yt-logo" href="/clips"><i aria-hidden="true" /><span className="yt-logo-name">Aduna</span><small>Clips</small></a>
        {!userId
          ? <div className="cs-tabs" role="tablist" aria-label="Clips">{TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={'cs-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>{label}</button>)}</div>
          : <div className="yt-search" />}
        <button type="button" className="cs-search-btn" aria-label="Search creators and clips" title="Search" onClick={() => { document.querySelectorAll('.cs video').forEach((v) => v.pause()); setSearching(true); }}><SearchIcon /></button>
      </header>

      {userId && profile && (
        <div className="cs-profile">
          <Avatar user={profile} size={48} />
          <div className="cs-profile-info">
            <h1>{profile.username || 'Someone'}</h1>
            <span className="muted">{Number(profile.followers || 0).toLocaleString()} {profile.followers === 1 ? 'follower' : 'followers'}</span>
          </div>
          {!profile.mine && profile.creator && <button className={'btn' + (profile.following ? '' : ' primary')} disabled={busy} onClick={follow} aria-pressed={!!profile.following}>{profile.following ? 'Following' : 'Follow'}</button>}
        </div>
      )}

      <main ref={feedRef} className={'cs-main' + (feeding ? ' cs-feeding' : '')} onScroll={onScroll}>
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
        {feeding && clips.map((c) => (
          <section key={c.id} className="cs-slide">
            <ClipCard reel clip={c} onChange={swap} onGone={gone} />
          </section>
        ))}
      </main>

      {feeding && (
        <div className="cs-nav">
          <button type="button" className="cs-nav-btn" aria-label="Previous clip" title="Previous clip" disabled={idx <= 0} onClick={() => go(-1)}><Chevron up /></button>
          <button type="button" className="cs-nav-btn" aria-label="Next clip" title="Next clip" disabled={idx >= clips.length - 1} onClick={() => go(1)}><Chevron /></button>
        </div>
      )}

      {me && <MeMenu me={me} />}
      {searching && <ClipSearch onClose={() => setSearching(false)} />}
      <DialogHost />
    </div>
  );
}
