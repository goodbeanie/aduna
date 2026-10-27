import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { Uploader, Mine } from './Clips.jsx';
import { DialogHost, toast } from './Dialogs.jsx';

// What a creator agrees to. Shown on /dashboard before anyone can post. The version goes up if the text changes.
function CreatorTerms() {
  return (
    <div className="dash-terms" tabIndex={0}>
      <h3>1. Your clips</h3>
      <p>You are responsible for every clip you post. You confirm that you made it, or have permission to use everything in it, including the video, the sound and any music.</p>
      <h3>2. No copyrighted material</h3>
      <p>Do not post other people's videos, films, shows, games, or music you do not have the rights to. If a rights holder reports a clip, we remove it, and repeated reports can end your creator access.</p>
      <h3>3. What is not allowed</h3>
      <ul>
        <li>Sexual content, nudity, or anything involving minors in an unsafe or sexual way</li>
        <li>Graphic violence, gore, or dangerous acts people could copy</li>
        <li>Hate, harassment, threats, or bullying</li>
        <li>Illegal activity, scams, spam, or links and advertising in captions</li>
        <li>Impersonating a person or organisation, or sharing someone's private information</li>
      </ul>
      <h3>4. Format</h3>
      <p>Clips are portrait, up to 30 seconds, and are reduced to 720p and a small file size before they upload.</p>
      <h3>5. How long clips stay</h3>
      <p>Clips are deleted automatically after 7 days. Only the numbers (views, likes, reports) are kept. You can remove a clip yourself at any time.</p>
      <h3>6. Our right to act</h3>
      <p>Other people can report clips. Clips with enough reports are hidden until a moderator checks them. We can remove any clip and suspend creator access if these terms are broken.</p>
      <h3>7. Permission to show your clip</h3>
      <p>By posting, you let Aduna store your clip and show it to other people in Clips while it is up. You keep ownership of it.</p>
    </div>
  );
}

export default function Dashboard() {
  const [state, setState] = useState('loading'); // 'loading' | 'signedout' | 'off' | 'error' | 'apply' | 'ready'
  const [limits, setLimits] = useState(null);
  const [agree, setAgree] = useState(false);
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
    if (!agree || busy) return;
    setBusy(true);
    try { await api('/clips/creator/join', { method: 'POST', body: { accept: true } }); toast('You are now a creator'); await load(); }
    catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  const refreshLimits = () => { setRev((n) => n + 1); api('/clips?limit=1').then((f) => setLimits(f.limits)).catch(() => {}); };

  return (
    <main className="dash">
      <header className="dash-head">
        <h1>Creator dashboard</h1>
        <a href="/app">Back to Aduna</a>
      </header>

      {state === 'loading' && <p className="muted">Loading…</p>}
      {state === 'signedout' && <div className="dash-card"><h2>Sign in first</h2><p className="muted">Open Aduna, sign in, then come back to this page.</p><a className="btn primary" href="/app">Open Aduna</a></div>}
      {state === 'off' && <div className="dash-card"><h2>Clips are not switched on yet</h2><p className="muted">Check back soon.</p></div>}
      {state === 'error' && <div className="dash-card"><h2>Something went wrong</h2><button className="btn" onClick={load}>Try again</button></div>}

      {state === 'apply' && (
        <div className="dash-card">
          <h2>Become a creator</h2>
          <p className="muted">Anyone can watch clips. To post them, read and accept the creator terms.</p>
          <CreatorTerms />
          <label className="dash-check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>I have read and accept the creator terms.</span>
          </label>
          <button className="btn primary" disabled={!agree || busy} onClick={join}>{busy ? 'Saving…' : 'Become a creator'}</button>
        </div>
      )}

      {state === 'ready' && limits && (
        <>
          <div className="dash-card">
            <h2>Upload a clip</h2>
            <ul className="dash-rules">
              <li>Portrait video (taller than wide), at most {limits.maxSeconds} seconds</li>
              <li>Squeezed to 720p and under {limits.maxMb} MB on your device, then uploaded</li>
              <li>You must own it or have permission, including any music</li>
              <li>Removed after {limits.keepDays} days; your numbers stay</li>
            </ul>
            <Uploader limits={limits} onDone={refreshLimits} />
          </div>
          <div className="dash-card">
            <h2>Your clips</h2>
            <Mine rev={rev} />
          </div>
        </>
      )}
      <DialogHost />
    </main>
  );
}
