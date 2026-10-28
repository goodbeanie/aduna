import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Avatar, Icon } from './ui.jsx';
import { compressVideo, canCompress } from './compress.js';
import { toast, askConfirm } from './Dialogs.jsx';
import ClipActions, { FollowButton, useDoubleLike, compact } from './ClipActions.jsx';
import { VideoPlayer } from './VideoPlayer.jsx';

const MB = 1024 * 1024;
const MAX_POSTER = 200 * 1024; // the server's limit for the cover picture
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

// a cover picture: one frame (or a picture the creator chose), cropped to the video's shape, small enough for the server (200 KB)
async function makeCover(p, longSide = 480, pick = {}) {
  let src = p.video, sw = p.width, sh = p.height;
  if (pick.image) {
    try { src = await createImageBitmap(pick.image); sw = src.width; sh = src.height; }
    catch { throw new Error('That picture could not be read'); }
  } else {
    const dur = p.duration || 1;
    const at = Number.isFinite(pick.at) ? Math.min(Math.max(0, pick.at), Math.max(0, dur - 0.1)) : Math.min(1, dur / 2);
    const v = p.video;
    await new Promise((resolve) => { v.onseeked = resolve; v.currentTime = at; setTimeout(resolve, 3000); });
  }
  const ratio = p.width / p.height;
  let cw = sw, ch = sh;
  if (cw / ch > ratio) cw = ch * ratio; else ch = cw / ratio;
  const cx = (sw - cw) / 2, cy = (sh - ch) / 2;
  for (const side of [longSide, 360, 240]) {
    const k = Math.min(1, side / Math.max(p.width, p.height));
    const c = document.createElement('canvas');
    c.width = even(p.width * k); c.height = even(p.height * k);
    c.getContext('2d').drawImage(src, cx, cy, cw, ch, 0, 0, c.width, c.height);
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

// The upload form. It lives on the /dashboard page (see Dashboard.jsx). Every check that can be made on the device is made here
// before anything is sent; the server checks the same things again on what arrives.
export function Uploader({ limits, onDone }) {
  const [file, setFile] = useState(null);
  const [caption, setCaption] = useState('');
  const [rights, setRights] = useState(false);
  const [step, setStep] = useState(''); // '' | 'Making the clip' | 'Uploading' | 'Checking'
  const [progress, setProgress] = useState(0);
  const ctl = useRef(null);
  const busy = !!step;
  const [prevUrl, setPrevUrl] = useState('');
  const [dur, setDur] = useState(0);
  const [coverAt, setCoverAt] = useState(null); // seconds into the video, or null for the automatic frame
  const [coverImg, setCoverImg] = useState(null); // a picture the creator chose instead of a frame
  const [coverImgUrl, setCoverImgUrl] = useState('');
  const pv = useRef(null);
  useEffect(() => {
    if (!file) { setPrevUrl(''); return undefined; }
    const u = URL.createObjectURL(file);
    setPrevUrl(u); setDur(0); setCoverAt(null); setCoverImg(null);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  useEffect(() => {
    if (!coverImg) { setCoverImgUrl(''); return undefined; }
    const u = URL.createObjectURL(coverImg);
    setCoverImgUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [coverImg]);

  const cancel = () => { ctl.current?.abort(); };
  const go = async () => {
    if (!file || busy) return;
    ctl.current = new AbortController();
    let p = null;
    try {
      if (!/^video\//.test(file.type || '')) throw new Error('That is not a video file');
      setStep('Checking the video'); setProgress(0);
      p = await probe(file);
      if (!Number.isFinite(p.duration) || !p.width) throw new Error('This video could not be read');
      if (p.height <= p.width) throw new Error('Clips must be portrait (taller than wide). Turn the video or pick another one.');
      if (p.duration > limits.maxSeconds + 0.3) throw new Error(`Clips can be at most ${limits.maxSeconds} seconds. This one is ${Math.round(p.duration)} seconds. Trim it first.`);
      const seconds = Math.floor(Math.min(p.duration, limits.maxSeconds) * 10) / 10;
      setStep('Making the clip');
      const out = await compressVideo(file, {
        onProgress: setProgress, signal: ctl.current.signal,
        target: Math.max(1, limits.maxMb - 1) * MB, limit: limits.maxMb * MB, maxSide: 1280, maxSeconds: limits.maxSeconds, mp4Only: true,
      });
      const cover = await makeCover(p, 480, { at: coverAt, image: coverImg });
      const k = Math.min(1, 1280 / Math.max(p.width, p.height));
      setStep('Uploading'); setProgress(0);
      const up = await api('/clips/upload-url', { method: 'POST', body: {
        size: out.size, posterSize: cover.size, posterType: 'image/jpeg', seconds,
        width: even(p.width * k), height: even(p.height * k), caption, rights: true,
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
      setFile(null); setCaption(''); setRights(false);
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
          <div className="clip-cover">
            <div className="clip-cover-pic">
              {coverImgUrl
                ? <img src={coverImgUrl} alt="Cover picture" />
                : <video ref={pv} src={prevUrl} muted playsInline preload="auto" onLoadedMetadata={(e) => { const d = e.currentTarget.duration || 0; setDur(d); e.currentTarget.currentTime = Math.min(1, (d || 1) / 2); }} />}
            </div>
            <div className="clip-cover-ctl">
              <b>Cover picture</b>
              <span className="muted">This is what people see in chat before they press play.</span>
              {!coverImgUrl && dur > 0 && (
                <input type="range" min="0" max={dur} step="0.1" disabled={busy} aria-label="Pick a frame for the cover"
                  value={coverAt ?? Math.min(1, dur / 2)}
                  onChange={(e) => { const t = Number(e.target.value); setCoverAt(t); if (pv.current) pv.current.currentTime = t; }} />
              )}
              <div className="clip-up-row">
                <label className={'btn' + (busy ? ' disabled' : '')}>
                  Upload a picture
                  <input type="file" accept="image/*" hidden disabled={busy} onChange={(e) => { setCoverImg(e.target.files?.[0] || null); e.target.value = ''; }} />
                </label>
                {coverImg && <button type="button" className="btn" disabled={busy} onClick={() => setCoverImg(null)}>Use a video frame</button>}
              </div>
            </div>
          </div>
          <input className="clip-caption" value={caption} maxLength={150} placeholder="Add a caption (optional)" disabled={busy} onChange={(e) => setCaption(e.target.value)} />
          <label className="dash-check">
            <input type="checkbox" checked={rights} disabled={busy} onChange={(e) => setRights(e.target.checked)} />
            <span>I made this clip or have permission to post everything in it (video, music and anything else), and it follows the creator terms.</span>
          </label>
          <div className="clip-up-row">
            <button className="btn primary" disabled={busy || !rights || (!limits.unlimited && limits.left <= 0)} onClick={go}>{busy ? step + '…' : 'Post clip'}</button>
            {step === 'Making the clip' && <button className="btn" onClick={cancel}>Cancel</button>}
            {step === 'Making the clip' && <span className="muted">{Math.round(progress * 100)}%</span>}
          </div>
        </>
      )}
      <p className="muted clip-note">
        Portrait video, up to {limits.maxSeconds} seconds. It is squeezed to 720p and under {limits.maxMb} MB on this device before it uploads.
        Clips are removed after {limits.keepDays} days. {limits.unlimited ? 'You can post as many as you like.' : <>{limits.left} of {limits.dailyLimit} posts left today{limits.credits ? ` (${limits.credits} credits each)` : ''}.</>}
      </p>
    </div>
  );
}

export function ClipCard({ clip, onChange, onGone, reel }) {
  const counted = useRef(false);
  const doubleLike = useDoubleLike(clip, onChange);
  const play = (e) => {
    document.querySelectorAll('.clip video').forEach((v) => { if (v !== e.currentTarget) v.pause(); });
    if (!counted.current) { counted.current = true; api(`/clips/${clip.id}/view`, { method: 'POST' }).catch(() => {}); }
  };
  const ratio = clip.width && clip.height ? clip.width / clip.height : 9 / 16;
  const who = clip.owner.username || 'Someone';
  // `reel` (the Clips website feed): on a wide screen the creator, caption and numbers sit over the bottom of the video
  const info = reel ? (
    <>
      <div className="vp-info-who">
        <a className="vp-info-ava" href={`/clips/user/${clip.owner.id}`} aria-label={`${who}'s page`}><Avatar user={{ ...clip.owner, id: clip.owner.id }} size={36} /></a>
        <a className="vp-info-name" href={`/clips/user/${clip.owner.id}`}><b>{who}</b></a>
        <FollowButton clip={clip} onChange={onChange} />
      </div>
      {clip.caption && <p className="vp-info-cap">{clip.caption}</p>}
      <div className="vp-info-meta">{compact(clip.views)} {clip.views === 1 ? 'view' : 'views'} · {ago(clip.createdAt)} · {left(clip.expiresAt)}</div>
    </>
  ) : undefined;
  return (
    <article className={'clip' + (reel ? ' reel' : '') + (reel && ratio > 0.9 ? ' land' : '')} style={reel ? { '--ratio': String(ratio) } : undefined}>
      <div className="clip-who">
        <a className="clip-ava" href={`/clips/user/${clip.owner.id}`} aria-label={`${who}'s page`}><Avatar user={{ ...clip.owner, id: clip.owner.id }} size={32} /></a>
        <a className="clip-name" href={`/clips/user/${clip.owner.id}`}><b>{who}</b></a>
        <span className="muted">{reel ? `${compact(clip.views)} ${clip.views === 1 ? 'view' : 'views'} · ` : ''}{ago(clip.createdAt)} · {left(clip.expiresAt)}</span>
        <FollowButton clip={clip} onChange={onChange} />
      </div>
      <VideoPlayer inView ratio={ratio} src={clip.url} poster={clip.poster} onPlay={play} onDoubleLike={doubleLike} info={info}>
        <ClipActions overlay clip={clip} onChange={onChange} onGone={onGone} />
      </VideoPlayer>
      {clip.caption && <p className="clip-text">{clip.caption}</p>}
    </article>
  );
}

// "Your clips" list (dashboard Content page and the Mine tab). A live, hidden or still-uploading clip has a Delete button that asks first.
// `query` filters by caption; `onChange` runs after a delete so the page can refresh its numbers and the posts left today.
// Every row can be deleted. A live, hidden or uploading clip is taken down first; one that is already removed, expired or not posted is just dropped from the list.
// `onOpen(id)` runs when a row is clicked (the dashboard opens that video's analytics); without it a live clip links to its watch page.
export function Mine({ rev, query = '', onChange, onOpen }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(() => api('/clips/mine').then((r) => setRows(r.clips)).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load, rev]);

  const remove = async (c) => {
    const holding = !c.purgedAt && ['live', 'hidden', 'pending'].includes(c.state);
    const ok = await askConfirm(holding ? {
      title: 'Delete this video?',
      body: 'This deletes the video for good, for everyone. It cannot be undone, and its comments go with it. Only the numbers (views, likes, shares) are kept.',
      confirmLabel: 'Delete video', danger: true,
    } : {
      title: 'Remove from your list?',
      body: 'This clip is already gone. This removes it from your list and it will not show up again.',
      confirmLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    setBusy(c.id);
    try { await api(`/clips/${c.id}`, { method: 'DELETE' }); toast(holding ? 'Video deleted' : 'Removed from your list'); await load(); if (onChange) onChange(); }
    catch (e) { toast(e.message || 'Could not delete the video', 'error'); }
    finally { setBusy(''); }
  };

  if (!rows) return <p className="muted clip-note">Loading…</p>;
  if (!rows.length) return <p className="muted clip-note">You have not posted any clips yet.</p>;
  const q = query.trim().toLowerCase();
  const list = q ? rows.filter((c) => (c.caption || '').toLowerCase().includes(q)) : rows;
  if (!list.length) return <p className="muted clip-note">No clips match “{query.trim()}”.</p>;
  return (
    <div className="clip-mine">
      {list.map((c) => (
        <div key={c.id} className="clip-row">
          <div className="clip-row-main">
            {onOpen
              ? <button type="button" className="clip-open" onClick={() => onOpen(c.id)} title="See analytics for this video"><b>{c.caption || 'No caption'}</b></button>
              : c.state === 'live' && c.available ? <a href={`/clips/${c.id}`}><b>{c.caption || 'No caption'}</b></a> : <b>{c.caption || 'No caption'}</b>}
            <span className="muted">{STATE_LABEL[c.state] || c.state}{c.why ? ' · ' + c.why : ''}</span>
          </div>
          <div className="clip-row-nums muted">{c.views} views · {c.likes} likes · {c.comments || 0} comments · {c.shares || 0} shares{c.reports ? ` · ${c.reports} reports` : ''}</div>
          <button className="btn clip-del" disabled={busy === c.id} onClick={() => remove(c)} aria-label={`Delete ${c.caption || 'video'}`}><Icon name="trash" size={16} /> {busy === c.id ? 'Deleting…' : 'Delete'}</button>
        </div>
      ))}
    </div>
  );
}

export default function Clips({ onBack }) {
  const [tab, setTab] = useState('feed'); // 'feed' | 'top' | 'following' | 'mine'
  const [clips, setClips] = useState([]);
  const [limits, setLimits] = useState(null);
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'off' | 'error'
  const [more, setMore] = useState(false);
  const [rev, setRev] = useState(0);

  const load = useCallback(async (append, list) => {
    const sort = tab === 'top' ? 'top' : tab === 'following' ? 'following' : 'new';
    const q = new URLSearchParams({ sort, limit: '10' });
    if (append && list.length) { if (sort === 'top') q.set('offset', String(list.length)); else q.set('before', String(list[list.length - 1].createdAt)); }
    try {
      const r = await api('/clips?' + q);
      setLimits(r.limits);
      setClips(append ? [...list, ...r.clips] : r.clips);
      setMore(r.clips.length >= 10);
      setState('ready');
    } catch (e) {
      setState(e.status === 503 ? 'off' : 'error');
    }
  }, [tab]);

  useEffect(() => { if (tab !== 'mine') load(false, []); }, [load, tab, rev]);

  // a change to one clip (a like, a follow...) is kept; following a creator also updates their other clips on screen
  const swap = (c) => setClips((p) => p.map((x) => (x.id === c.id ? c : x.owner.id === c.owner.id ? { ...x, following: c.following, owner: { ...x.owner, followers: c.owner.followers } } : x)));
  const gone = (id) => { setClips((p) => p.filter((x) => x.id !== id)); setRev((n) => n + 1); };

  return (
    <section className="chat clips">
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title="Back" aria-label="Back to list" onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash"><Icon name="video" size={20} /></span>
        <h3>Clips</h3>
        <div className="explore-tabs" role="tablist">
          {[['feed', 'New'], ['top', 'Top'], ['following', 'Following'], ['mine', 'Mine']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={'explore-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>{label}</button>)}
        </div>
      </header>
      <div className="clips-body">
        {state === 'off' && <p className="muted clip-note">Clips are not switched on yet.</p>}
        {state === 'error' && <p className="muted clip-note">Could not load clips. <button className="btn" onClick={() => load(false, [])}>Try again</button></p>}
        {state === 'loading' && tab !== 'mine' && <p className="muted clip-note">Loading…</p>}
        {state === 'ready' && (
          <div className="clip-cta">
            <span>Want to post clips? Become a Clips creator and upload from your dashboard.</span>
            <a className="btn" href="/dashboard">Clips dashboard</a>
          </div>
        )}
        {tab === 'mine' ? <Mine rev={rev} /> : state === 'ready' && (
          <>
            {clips.length === 0 && <p className="muted clip-note">{tab === 'following' ? 'Nothing here yet. Tap Follow on a creator and their new clips show up here.' : 'No clips yet. Be the first to post one.'}</p>}
            <div className="clip-list">{clips.map((c) => <ClipCard key={c.id} clip={c} onChange={swap} onGone={gone} />)}</div>
            {more && <button className="btn clip-more" onClick={() => load(true, clips)}>Load more</button>}
          </>
        )}
      </div>
    </section>
  );
}
