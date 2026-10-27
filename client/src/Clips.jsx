import React, { useCallback, useEffect, useRef, useState } from 'react';
import './clips.css';
import { api } from './api.js';
import { Avatar, Icon } from './ui.jsx';
import { compressVideo, canCompress } from './compress.js';
import { toast, askConfirm } from './Dialogs.jsx';

const MB = 1024 * 1024;
const MAX_POSTER = 200 * 1024; // the server's limit for the cover picture
const REASONS = [['inappropriate', 'Inappropriate'], ['spam', 'Spam'], ['illegal', 'Illegal'], ['impersonation', 'Impersonation']];
const STATE_LABEL = { live: 'Live', hidden: 'Hidden (reported)', pending: 'Uploading', expired: 'Expired', removed: 'Removed', rejected: 'Not posted' };

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};
const left = (t) => {
  const s = (t - Date.now()) / 1000;
  if (s <= 0) return 'ending';
  return s < 86400 ? Math.max(1, Math.round(s / 3600)) + 'h left' : Math.round(s / 86400) + 'd left';
};

// what the original video looks like (the compressed copy can report a strange length, so numbers come from here)
function probe(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'auto'; v.muted = true; v.playsInline = true; v.src = url;
    v.onloadedmetadata = () => resolve({ video: v, url, duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This video could not be read')); };
  });
}

// a cover picture: one frame, small enough for the server (200 KB)
async function makeCover(p, longSide = 480) {
  const v = p.video;
  const at = Math.min(1, (p.duration || 1) / 2);
  await new Promise((resolve) => { v.onseeked = resolve; v.currentTime = at; setTimeout(resolve, 3000); });
  for (const side of [longSide, 360, 240]) {
    const k = Math.min(1, side / Math.max(p.width, p.height));
    const c = document.createElement('canvas');
    c.width = even(p.width * k); c.height = even(p.height * k);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    for (const q of [0.75, 0.55, 0.4]) {
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= MAX_POSTER) return blob;
    }
  }
  throw new Error('Could not make a cover picture');
}

async function put(target, body) {
  const r = await fetch(target.url, { method: target.method || 'PUT', headers: target.headers || {}, body });
  if (!r.ok) throw new Error('The upload did not go through (' + r.status + ')');
}

function Uploader({ limits, onDone }) {
  const [file, setFile] = useState(null);
  const [caption, setCaption] = useState('');
  const [step, setStep] = useState(''); // '' | 'Making the clip' | 'Uploading' | 'Checking'
  const [progress, setProgress] = useState(0);
  const ctl = useRef(null);
  const busy = !!step;

  const cancel = () => { ctl.current?.abort(); };
  const go = async () => {
    if (!file || busy) return;
    ctl.current = new AbortController();
    let p = null;
    try {
      setStep('Making the clip'); setProgress(0);
      p = await probe(file);
      if (!Number.isFinite(p.duration) || !p.width) throw new Error('This video could not be read');
      const seconds = Math.floor(Math.min(p.duration, limits.maxSeconds) * 10) / 10;
      const out = await compressVideo(file, {
        onProgress: setProgress, signal: ctl.current.signal,
        target: Math.max(1, limits.maxMb - 1) * MB, limit: limits.maxMb * MB, maxSide: 1280, maxSeconds: limits.maxSeconds, mp4Only: true,
      });
      const cover = await makeCover(p);
      const k = Math.min(1, 1280 / Math.max(p.width, p.height));
      setStep('Uploading'); setProgress(0);
      const up = await api('/clips/upload-url', { method: 'POST', body: {
        size: out.size, posterSize: cover.size, posterType: 'image/jpeg', seconds,
        width: even(p.width * k), height: even(p.height * k), caption,
      } });
      await Promise.all([put(up.video, out), put(up.poster, cover)]);
      setStep('Checking');
      let done = null;
      for (let i = 0; i < 5 && !done; i++) {
        try { done = await api(`/clips/${up.id}/complete`, { method: 'POST' }); }
        catch (e) { if (e.code !== 'not_uploaded' && e.status !== 409) throw e; await new Promise((r) => setTimeout(r, 1500)); }
      }
      if (!done) throw new Error('The upload did not arrive. Try again.');
      toast('Clip posted');
      setFile(null); setCaption('');
      onDone();
    } catch (e) {
      if (!e.cancelled) toast(e.message || 'Could not post the clip', 'error');
    } finally {
      if (p) { try { p.video.removeAttribute('src'); p.video.load(); URL.revokeObjectURL(p.url); } catch { /* gone already */ } }
      setStep('');
    }
  };

  if (!canCompress()) return <p className="muted clip-note">This device cannot make clips yet. Try the desktop app or Chrome.</p>;
  return (
    <div className="clip-up">
      <div className="clip-up-row">
        <label className={'btn' + (busy ? ' disabled' : '')}>
          <Icon name="video" size={16} /> {file ? 'Change video' : 'Choose a video'}
          <input type="file" accept="video/*" hidden disabled={busy} onChange={(e) => { setFile(e.target.files?.[0] || null); e.target.value = ''; }} />
        </label>
        {file && <span className="muted clip-file">{file.name}</span>}
      </div>
      {file && (
        <>
          <input className="clip-caption" value={caption} maxLength={150} placeholder="Add a caption (optional)" disabled={busy} onChange={(e) => setCaption(e.target.value)} />
          <div className="clip-up-row">
            <button className="btn primary" disabled={busy || limits.left <= 0} onClick={go}>{busy ? step + '…' : 'Post clip'}</button>
            {step === 'Making the clip' && <button className="btn" onClick={cancel}>Cancel</button>}
            {step === 'Making the clip' && <span className="muted">{Math.round(progress * 100)}%</span>}
          </div>
        </>
      )}
      <p className="muted clip-note">
        Up to {limits.maxSeconds} seconds and {limits.maxMb} MB, 720p. Longer videos are cut off, then squeezed on this device before they upload.
        Clips are removed after {limits.keepDays} days. {limits.left} of {limits.dailyLimit} posts left today{limits.credits ? ` (${limits.credits} credits each)` : ''}.
      </p>
    </div>
  );
}

function ClipCard({ clip, onChange, onGone }) {
  const [reporting, setReporting] = useState(false);
  const counted = useRef(false);
  const like = async () => {
    try { const r = await api(`/clips/${clip.id}/like`, { method: 'POST' }); onChange({ ...clip, liked: r.liked, likes: r.likes }); }
    catch (e) { toast(e.message, 'error'); }
  };
  const play = (e) => {
    document.querySelectorAll('.clip video').forEach((v) => { if (v !== e.currentTarget) v.pause(); });
    if (!counted.current) { counted.current = true; api(`/clips/${clip.id}/view`, { method: 'POST' }).catch(() => {}); }
  };
  const report = async (reason) => {
    setReporting(false);
    try { await api(`/clips/${clip.id}/report`, { method: 'POST', body: { reason } }); toast('Thanks, we will take a look'); }
    catch (e) { toast(e.message, 'error'); }
  };
  const remove = async () => {
    if (!(await askConfirm({ title: 'Remove this clip?', body: 'The video is deleted. Its numbers stay.', confirm: 'Remove' }))) return;
    try { await api(`/clips/${clip.id}`, { method: 'DELETE' }); onGone(clip.id); } catch (e) { toast(e.message, 'error'); }
  };
  const ratio = clip.width && clip.height ? clip.width / clip.height : 9 / 16;
  return (
    <article className="clip">
      <div className="clip-who">
        <Avatar user={{ ...clip.owner, id: clip.owner.id }} size={32} />
        <b>{clip.owner.username || 'Someone'}</b>
        <span className="muted">{ago(clip.createdAt)} · {left(clip.expiresAt)}</span>
      </div>
      <video className="clip-video" style={{ aspectRatio: String(ratio) }} src={clip.url} poster={clip.poster} controls loop playsInline preload="none" onPlay={play} />
      {clip.caption && <p className="clip-text">{clip.caption}</p>}
      <div className="clip-bar">
        <button className={'clip-like' + (clip.liked ? ' on' : '')} onClick={like} aria-pressed={clip.liked}>{clip.liked ? '♥' : '♡'} {clip.likes}</button>
        <span className="muted">{clip.views} views</span>
        <span className="grow" />
        {clip.mine
          ? <button className="icon-btn" title="Remove" aria-label="Remove clip" onClick={remove}><Icon name="trash" size={18} /></button>
          : <button className="icon-btn" title="Report" aria-label="Report clip" onClick={() => setReporting((v) => !v)}><Icon name="flag" size={18} /></button>}
      </div>
      {reporting && (
        <div className="clip-report">
          <span className="muted">Why are you reporting this?</span>
          {REASONS.map(([id, label]) => <button key={id} className="btn" onClick={() => report(id)}>{label}</button>)}
        </div>
      )}
    </article>
  );
}

function Mine({ rev }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api('/clips/mine').then((r) => setRows(r.clips)).catch(() => setRows([])); }, [rev]);
  if (!rows) return <p className="muted clip-note">Loading…</p>;
  if (!rows.length) return <p className="muted clip-note">You have not posted any clips yet.</p>;
  return (
    <div className="clip-mine">
      {rows.map((c) => (
        <div key={c.id} className="clip-row">
          <div className="clip-row-main"><b>{c.caption || 'No caption'}</b><span className="muted">{STATE_LABEL[c.state] || c.state}{c.why ? ' · ' + c.why : ''}</span></div>
          <div className="clip-row-nums muted">{c.views} views · {c.likes} likes{c.reports ? ` · ${c.reports} reports` : ''}</div>
        </div>
      ))}
    </div>
  );
}

export default function Clips({ onBack }) {
  const [tab, setTab] = useState('feed'); // 'feed' | 'top' | 'mine'
  const [clips, setClips] = useState([]);
  const [limits, setLimits] = useState(null);
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'off' | 'error'
  const [more, setMore] = useState(false);
  const [rev, setRev] = useState(0);

  const load = useCallback(async (append, list) => {
    const sort = tab === 'top' ? 'top' : 'new';
    const q = new URLSearchParams({ sort, limit: '10' });
    if (append && list.length) { if (sort === 'top') q.set('offset', String(list.length)); else q.set('before', String(list[list.length - 1].createdAt)); }
    try {
      const r = await api('/clips?' + q);
      setLimits(r.limits);
      setClips(append ? [...list, ...r.clips] : r.clips);
      setMore(r.clips.length >= 10);
      setState('ready');
    } catch (e) {
      setState(e.status === 503 || e.status === 403 ? 'off' : 'error');
    }
  }, [tab]);

  useEffect(() => { if (tab !== 'mine') load(false, []); }, [load, tab, rev]);

  const swap = (c) => setClips((p) => p.map((x) => (x.id === c.id ? c : x)));
  const gone = (id) => { setClips((p) => p.filter((x) => x.id !== id)); setRev((n) => n + 1); };

  return (
    <section className="chat clips">
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title="Back" aria-label="Back to list" onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash"><Icon name="video" size={20} /></span>
        <h3>Clips</h3>
        <span className="muted clip-test">Testing</span>
        <div className="explore-tabs" role="tablist">
          {[['feed', 'New'], ['top', 'Top'], ['mine', 'Mine']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={'explore-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>{label}</button>)}
        </div>
      </header>
      <div className="clips-body">
        {state === 'off' && <p className="muted clip-note">Clips are not switched on for this account yet.</p>}
        {state === 'error' && <p className="muted clip-note">Could not load clips. <button className="btn" onClick={() => load(false, [])}>Try again</button></p>}
        {state === 'loading' && tab !== 'mine' && <p className="muted clip-note">Loading…</p>}
        {state === 'ready' && limits && <Uploader limits={limits} onDone={() => { setRev((n) => n + 1); }} />}
        {tab === 'mine' ? <Mine rev={rev} /> : state === 'ready' && (
          <>
            {clips.length === 0 && <p className="muted clip-note">No clips yet. Be the first to post one.</p>}
            <div className="clip-list">{clips.map((c) => <ClipCard key={c.id} clip={c} onChange={swap} onGone={gone} />)}</div>
            {more && <button className="btn clip-more" onClick={() => load(true, clips)}>Load more</button>}
          </>
        )}
      </div>
    </section>
  );
}
