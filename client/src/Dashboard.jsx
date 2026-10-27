import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Uploader, Mine } from './Clips.jsx';
import { DialogHost, toast } from './Dialogs.jsx';
import './dash.css';

// What a creator agrees to. Shown in a pop-up on /dashboard before anyone can post. The numbers here (30 seconds, 720p, 7 days) match the server's limits.
function CreatorTerms({ limits }) {
  const secs = limits ? limits.maxSeconds : 30;
  const days = limits ? limits.keepDays : 7;
  return (
    <>
      <p className="dash-terms-lead">These are the rules for posting clips on Aduna. Anyone can watch clips and follow creators. Posting is for creators who have agreed to the terms below.</p>

      <h3>1. Your clips are your responsibility</h3>
      <p>You are responsible for every clip you post. You confirm that you made it, or that you have permission to use everything in it, including the video, the sound and any music.</p>

      <h3>2. No copyrighted material</h3>
      <p>Do not post other people's videos, films, shows, games, or music that you do not have the rights to. If a rights holder reports a clip, we remove it. Repeated reports can end your creator access.</p>

      <h3>3. What is not allowed</h3>
      <ul>
        <li>Sexual content, nudity, or anything involving minors in an unsafe or sexual way</li>
        <li>Graphic violence, gore, or dangerous acts that people could copy</li>
        <li>Hate, harassment, threats, or bullying</li>
        <li>Illegal activity, scams, spam, or links and advertising in captions</li>
        <li>Pretending to be a person or an organisation, or sharing someone's private information</li>
      </ul>

      <h3>4. Format</h3>
      <p>Clips are portrait (taller than wide) and up to {secs} seconds. They are reduced to 720p and a small file size on your device before they upload.</p>

      <h3>5. How long clips stay up</h3>
      <p>Clips are deleted automatically after {days} days. Only the numbers (views, likes, reports) are kept. You can remove a clip yourself at any time.</p>

      <h3>6. Followers</h3>
      <p>People can follow you to see your new clips in their Following tab. Followers see your clips; other people only see how many followers you have, not who they are.</p>

      <h3>7. Reports and moderation</h3>
      <p>Anyone can report a clip. Clips with enough reports are hidden until a moderator checks them. We can remove any clip, and suspend or end creator access, if these terms are broken.</p>

      <h3>8. Permission to show your clip</h3>
      <p>By posting, you let Aduna store your clip and show it to other people in Clips while it is up. You keep ownership of it, and that permission ends when the clip is removed.</p>

      <h3>9. Changes</h3>
      <p>We may update these terms. If we make a big change, we will tell creators before it applies to new clips.</p>
    </>
  );
}

// The pop-up menu with the terms. The accept box stays off until the terms have been scrolled to the end.
function TermsMenu({ limits, busy, onAccept, onClose }) {
  const [agree, setAgree] = useState(false);
  const [end, setEnd] = useState(false);
  const body = useRef(null);

  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy, onClose]);

  // a tall screen may show all the terms at once: nothing to scroll then
  useEffect(() => {
    const el = body.current;
    if (el && el.scrollHeight - el.clientHeight < 8) setEnd(true);
  }, [limits]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 12) setEnd(true);
  };

  return (
    <div className="dash-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dash-menu" role="dialog" aria-modal="true" aria-labelledby="dash-menu-title">
        <header className="dash-menu-head">
          <h2 id="dash-menu-title">Creator terms and conditions</h2>
          <button className="dash-menu-x" aria-label="Close" disabled={busy} onClick={onClose}>✕</button>
        </header>
        <div className="dash-menu-body" ref={body} onScroll={onScroll} tabIndex={0}>
          <CreatorTerms limits={limits} />
        </div>
        <footer className="dash-menu-foot">
          <label className={'dash-check' + (end ? '' : ' off')}>
            <input type="checkbox" checked={agree} disabled={!end || busy} onChange={(e) => setAgree(e.target.checked)} />
            <span>I have read and accept the creator terms.</span>
          </label>
          {!end && <p className="muted dash-menu-hint">Scroll to the end of the terms to accept them.</p>}
          <div className="dash-menu-actions">
            <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!agree || busy} onClick={onAccept}>{busy ? 'Saving…' : 'Accept and become a Clips creator'}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ---------- the pages of the dashboard ----------
const PAGES = [
  ['dashboard', 'Dashboard', '▦'],
  ['upload', 'Upload', '⬆'],
  ['content', 'Content', '▶'],
  ['analytics', 'Analytics', '▮'],
];
const pageFromHash = () => { const h = (typeof location !== 'undefined' ? location.hash : '').replace('#', ''); return PAGES.some((p) => p[0] === h) ? h : 'dashboard'; };
const n0 = (n) => Number(n || 0).toLocaleString();
const pct = (x) => (x * 100 >= 10 ? Math.round(x * 100) : Math.round(x * 1000) / 10) + '%';
const STATE = { live: 'Live', hidden: 'Hidden (reported)', pending: 'Uploading', expired: 'Expired', removed: 'Removed', rejected: 'Not posted' };

function Stat({ value, label }) {
  return <div className="dash-stat"><b>{n0(value)}</b><span>{label}</span></div>;
}

function totalsOf(rows) {
  const t = { clips: rows.length, live: 0, views: 0, likes: 0, comments: 0, shares: 0, reports: 0 };
  for (const c of rows) {
    if (c.state === 'live') t.live += 1;
    t.views += c.views || 0; t.likes += c.likes || 0; t.comments += c.comments || 0; t.shares += c.shares || 0; t.reports += c.reports || 0;
  }
  t.reactions = t.likes + t.comments + t.shares;
  t.rate = t.views ? t.reactions / t.views : 0;
  return t;
}

// The front page: the numbers that matter and the latest clips.
function Overview({ rows, followers, go }) {
  const t = totalsOf(rows || []);
  const latest = (rows || []).slice(0, 3);
  return (
    <>
      <div className="dash-card">
        <h2>Your channel</h2>
        <div className="dash-stats">
          <Stat value={followers} label="Followers" />
          <Stat value={t.views} label="Views" />
          <Stat value={t.likes} label="Likes" />
          <Stat value={t.comments} label="Comments" />
        </div>
        <div className="dash-actions">
          <button className="btn primary" onClick={() => go('upload')}>⬆ Upload a clip</button>
          <button className="btn" onClick={() => go('analytics')}>▮ See analytics</button>
        </div>
      </div>
      <div className="dash-card">
        <h2>Latest clips</h2>
        {!rows ? <p className="muted clip-note">Loading…</p>
          : !latest.length ? <p className="muted clip-note">You have not posted any clips yet. Use Upload to post your first one.</p>
          : (
            <div className="clip-mine">
              {latest.map((c) => (
                <div key={c.id} className="clip-row dash-row2">
                  <div className="clip-row-main"><b>{c.caption || 'No caption'}</b><span className="muted">{STATE[c.state] || c.state}</span></div>
                  <div className="clip-row-nums muted">{n0(c.views)} views · {n0(c.likes)} likes</div>
                </div>
              ))}
            </div>
          )}
        {!!latest.length && <div><button className="btn" onClick={() => go('content')}>All your content</button></div>}
      </div>
    </>
  );
}

// Analytics: totals, views per clip as bars, and a table. Clips are deleted after a few days but their numbers stay, so the totals keep counting them.
function Analytics({ rows, followers }) {
  if (!rows) return <div className="dash-card"><h2>Analytics</h2><p className="muted clip-note">Loading…</p></div>;
  if (!rows.length) return <div className="dash-card"><h2>Analytics</h2><p className="muted clip-note">Nothing to show yet. Once you post a clip, its views, likes, comments and shares show up here.</p></div>;
  const t = totalsOf(rows);
  const recent = rows.slice(0, 10).reverse(); // oldest to newest, left to right
  const max = Math.max(1, ...recent.map((c) => c.views || 0));
  const best = rows.reduce((a, c) => ((c.views || 0) > ((a && a.views) || 0) ? c : a), null);
  return (
    <>
      <div className="dash-card">
        <h2>Analytics</h2>
        <div className="dash-stats">
          <Stat value={followers} label="Followers" />
          <Stat value={t.views} label="Views" />
          <Stat value={t.likes} label="Likes" />
          <Stat value={t.comments} label="Comments" />
          <Stat value={t.shares} label="Shares" />
          <Stat value={t.live} label={t.live === 1 ? 'Clip live now' : 'Clips live now'} />
        </div>
        <p className="muted clip-note">
          Engagement: {t.views ? pct(t.rate) : '0%'} of views led to a like, comment or share. Totals cover your latest {rows.length} {rows.length === 1 ? 'clip' : 'clips'}, including ones that have expired.
          {best && best.views > 0 ? ` Most viewed: “${best.caption || 'No caption'}” with ${n0(best.views)} views.` : ''}
        </p>
      </div>

      <div className="dash-card">
        <h2>Views per clip</h2>
        <div className="dash-bars" role="img" aria-label="Views for your latest clips, oldest to newest">
          {recent.map((c) => (
            <div key={c.id} className="dash-bar" title={`${c.caption || 'No caption'}: ${n0(c.views)} views`}>
              <span className="dash-bar-n">{n0(c.views)}</span>
              <i style={{ height: Math.max(3, Math.round(((c.views || 0) / max) * 100)) + '%' }} />
              <span className="dash-bar-l">{(c.caption || 'No caption').slice(0, 12)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="dash-card">
        <h2>Every clip</h2>
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead><tr><th>Clip</th><th>Status</th><th>Views</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Engagement</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="dash-cap">{c.caption || 'No caption'}</td>
                  <td>{STATE[c.state] || c.state}</td>
                  <td>{n0(c.views)}</td><td>{n0(c.likes)}</td><td>{n0(c.comments)}</td><td>{n0(c.shares)}</td>
                  <td>{c.views ? pct(((c.likes || 0) + (c.comments || 0) + (c.shares || 0)) / c.views) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export default function Dashboard() {
  const [state, setState] = useState('loading'); // 'loading' | 'signedout' | 'off' | 'error' | 'apply' | 'ready'
  const [limits, setLimits] = useState(null);
  const [terms, setTerms] = useState(false); // the terms pop-up is open
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(pageFromHash);
  const [rows, setRows] = useState(null); // your clips with their numbers (null while loading)
  const [followers, setFollowers] = useState(0);
  const [q, setQ] = useState('');

  const loadRows = () => api('/clips/mine').then((r) => setRows(r.clips)).catch(() => setRows([]));
  const load = async () => {
    try {
      const c = await api('/clips/creator');
      const f = await api('/clips?limit=1');
      setLimits(f.limits);
      setFollowers(c.followers || 0);
      setState(c.creator ? 'ready' : 'apply');
      if (c.creator) loadRows();
    } catch (e) {
      setState(e.status === 401 ? 'signedout' : e.status === 503 ? 'off' : 'error');
    }
  };
  useEffect(() => { document.title = 'Clips dashboard · Aduna'; load(); }, []);
  useEffect(() => {
    const h = () => setPage(pageFromHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  // sidebar and tabs: show that page, keep it in the address (#upload...) so reload and back/forward work, and scroll to the top
  const go = (id) => {
    setPage(id);
    try { history.pushState(null, '', id === 'dashboard' ? location.pathname : '#' + id); } catch { /* the page still switched */ }
    window.scrollTo(0, 0);
  };

  const join = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api('/clips/creator/join', { method: 'POST', body: { accept: true } });
      setTerms(false);
      toast('You are now a Clips creator');
      await load();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  const refreshLimits = () => api('/clips?limit=1').then((f) => setLimits(f.limits)).catch(() => {});
  // after a post or a delete: the posts left today, the list and the numbers all change
  const changed = () => { refreshLimits(); loadRows(); };

  const search = (e) => {
    setQ(e.target.value);
    if (e.target.value && page !== 'content') go('content');
  };

  const nav = (p) => (
    <button key={p[0]} className={'yt-nav' + (page === p[0] ? ' on' : '')} aria-current={page === p[0] ? 'page' : undefined} onClick={() => go(p[0])}><span>{p[2]}</span>{p[1]}</button>
  );

  return (
    <div className="yt-dash">
      <header className="yt-top">
        <a className="yt-logo" href="/dashboard" onClick={(e) => { e.preventDefault(); go('dashboard'); }}><i aria-hidden="true" />Aduna<small>Studio</small></a>
        <div className="yt-search"><input type="search" placeholder="Search your clips" aria-label="Search your clips" value={q} onChange={search} /></div>
        <a className="yt-back" href="/app">Back to Aduna</a>
      </header>

      <nav className="yt-tabs" aria-label="Clips dashboard pages">{PAGES.map(nav)}</nav>

      <div className="yt-body">
        <nav className="yt-side" aria-label="Clips dashboard">
          {PAGES.map(nav)}
          <a className="yt-nav" href="/app"><span>←</span>Back to Aduna</a>
        </nav>

        <main className="yt-main" id="top">
          <h1 className="yt-title">{state === 'ready' ? (PAGES.find((p) => p[0] === page) || PAGES[0])[1] : 'Clips dashboard'}</h1>

          {state === 'loading' && <p className="muted">Loading…</p>}
          {state === 'signedout' && <div className="dash-card"><h2>Sign in first</h2><p className="muted">Open Aduna, sign in, then come back to this page.</p><div><a className="btn primary" href="/app">Open Aduna</a></div></div>}
          {state === 'off' && <div className="dash-card"><h2>Clips are not switched on yet</h2><p className="muted">Check back soon.</p></div>}
          {state === 'error' && <div className="dash-card"><h2>Something went wrong</h2><div><button className="btn" onClick={load}>Try again</button></div></div>}

          {state === 'apply' && (
            <div className="dash-card">
              <h2>Become a Clips creator</h2>
              <p className="muted">Anyone can watch clips and follow creators. To post your own clips and get followers, read and accept the creator terms and conditions.</p>
              <div><button className="btn primary" onClick={() => setTerms(true)}>Read the terms and become a Clips creator</button></div>
            </div>
          )}

          {state === 'ready' && limits && page === 'dashboard' && <Overview rows={rows} followers={followers} go={go} />}

          {state === 'ready' && limits && page === 'upload' && (
            <div className="dash-card" id="upload">
              <h2>Upload a clip</h2>
              <ul className="dash-rules">
                <li>Portrait video (taller than wide), at most {limits.maxSeconds} seconds</li>
                <li>Squeezed to 720p and under {limits.maxMb} MB on your device, then uploaded</li>
                <li>You must own it or have permission, including any music</li>
                <li>Removed after {limits.keepDays} days; your numbers stay</li>
              </ul>
              <Uploader limits={limits} onDone={() => { changed(); go('content'); }} />
            </div>
          )}

          {state === 'ready' && limits && page === 'content' && (
            <div className="dash-card" id="content">
              <h2>Channel content</h2>
              {q.trim() && <p className="muted clip-note">Showing clips that match “{q.trim()}”. <button className="dash-link" onClick={() => setQ('')}>Clear search</button></p>}
              <Mine query={q} onChange={changed} />
            </div>
          )}

          {state === 'ready' && limits && page === 'analytics' && <Analytics rows={rows} followers={followers} />}

          <DialogHost />
        </main>
      </div>

      {terms && <TermsMenu limits={limits} busy={busy} onAccept={join} onClose={() => setTerms(false)} />}
    </div>
  );
}
