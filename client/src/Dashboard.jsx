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
            <button className="btn primary" disabled={!agree || busy} onClick={onAccept}>{busy ? 'Saving…' : 'Accept and become a creator'}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [state, setState] = useState('loading'); // 'loading' | 'signedout' | 'off' | 'error' | 'apply' | 'ready'
  const [limits, setLimits] = useState(null);
  const [terms, setTerms] = useState(false); // the terms pop-up is open
  const [busy, setBusy] = useState(false);
  const [rev, setRev] = useState(0);

  const load = async () => {
    try {
      const c = await api('/clips/creator');
      const f = await api('/clips?limit=1');
      setLimits(f.limits);
      setState(c.creator ? 'ready' : 'apply');
    } catch (e) {
      setState(e.status === 401 ? 'signedout' : e.status === 503 ? 'off' : 'error');
    }
  };
  useEffect(() => { document.title = 'Creator dashboard · Aduna'; load(); }, []);

  const join = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api('/clips/creator/join', { method: 'POST', body: { accept: true } });
      setTerms(false);
      toast('You are now a creator');
      await load();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  const refreshLimits = () => { setRev((n) => n + 1); api('/clips?limit=1').then((f) => setLimits(f.limits)).catch(() => {}); };

  return (
    <div className="yt-dash">
      <header className="yt-top">
        <a className="yt-logo" href="/dashboard"><i aria-hidden="true" />Aduna<small>Studio</small></a>
        <div className="yt-search"><input type="search" placeholder="Search your clips" aria-label="Search your clips" /></div>
        <a className="yt-back" href="/app">Back to Aduna</a>
      </header>

      <div className="yt-body">
        <nav className="yt-side" aria-label="Creator dashboard">
          <a className="on" href="#top"><span>▦</span>Dashboard</a>
          <a href="#upload"><span>⬆</span>Upload</a>
          <a href="#content"><span>▶</span>Content</a>
          <a href="/app"><span>←</span>Back to Aduna</a>
        </nav>

        <main className="yt-main" id="top">
          <h1 className="yt-title">Creator dashboard</h1>

          {state === 'loading' && <p className="muted">Loading…</p>}
          {state === 'signedout' && <div className="dash-card"><h2>Sign in first</h2><p className="muted">Open Aduna, sign in, then come back to this page.</p><div><a className="btn primary" href="/app">Open Aduna</a></div></div>}
          {state === 'off' && <div className="dash-card"><h2>Clips are not switched on yet</h2><p className="muted">Check back soon.</p></div>}
          {state === 'error' && <div className="dash-card"><h2>Something went wrong</h2><div><button className="btn" onClick={load}>Try again</button></div></div>}

          {state === 'apply' && (
            <div className="dash-card">
              <h2>Become a creator</h2>
              <p className="muted">Anyone can watch clips and follow creators. To post your own clips and get followers, read and accept the creator terms and conditions.</p>
              <div><button className="btn primary" onClick={() => setTerms(true)}>Read the terms and become a creator</button></div>
            </div>
          )}

          {state === 'ready' && limits && (
            <>
              <div className="dash-card" id="upload">
                <h2>Upload a clip</h2>
                <ul className="dash-rules">
                  <li>Portrait video (taller than wide), at most {limits.maxSeconds} seconds</li>
                  <li>Squeezed to 720p and under {limits.maxMb} MB on your device, then uploaded</li>
                  <li>You must own it or have permission, including any music</li>
                  <li>Removed after {limits.keepDays} days; your numbers stay</li>
                </ul>
                <Uploader limits={limits} onDone={refreshLimits} />
              </div>
              <div className="dash-card" id="content">
                <h2>Channel content</h2>
                <Mine rev={rev} />
              </div>
            </>
          )}
          <DialogHost />
        </main>
      </div>

      {terms && <TermsMenu limits={limits} busy={busy} onAccept={join} onClose={() => setTerms(false)} />}
    </div>
  );
}
