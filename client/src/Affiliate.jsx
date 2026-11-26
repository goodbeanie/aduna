import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { Icon } from './ui.jsx';
import './payments.css';
import './affiliate.css';

// /affiliate. Creators send a video about Aduna from another app (the buttons below), a reviewer watches it and sets what it earns. The rules are in
// server/affiliate.js, the numbers come from GET /api/affiliate/me, so nothing about credits is written twice. The page is outside the app shell.
const day = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const lengthText = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
const TIER_NAME = { affiliate: 'Affiliate', silver: 'Silver', gold: 'Gold' };
const baseFor = (bands, seconds) => (bands.find((b) => b.upTo === null || seconds <= b.upTo) || bands[bands.length - 1]).credits;

// minutes and seconds as two boxes; `value` is the total in seconds ('' while empty)
function Length({ value, onChange, disabled }) {
  const m = value === '' ? '' : Math.floor(value / 60), s = value === '' ? '' : value % 60;
  const set = (mm, ss) => onChange(mm === '' && ss === '' ? '' : Math.max(0, Number(mm || 0)) * 60 + Math.max(0, Math.min(59, Number(ss || 0))));
  return (
    <div className="af-length">
      <label><input type="number" min="0" max="180" inputMode="numeric" placeholder="0" value={m} disabled={disabled} onChange={(e) => set(e.target.value, s)} /> min</label>
      <label><input type="number" min="0" max="59" inputMode="numeric" placeholder="0" value={s} disabled={disabled} onChange={(e) => set(m, e.target.value)} /> sec</label>
    </div>
  );
}

function Rewards({ info }) {
  return (
    <div className="pay-card af-rewards">
      <b>What a video earns</b>
      <p className="pay-sub">Credits for how long it is, times what it says. A reviewer decides the second part after watching.</p>
      <div className="af-cols">
        <ul className="af-plain">
          {info.bands.map((b, i) => (
            <li key={i}><span>{i === 0 ? `Under ${info.bands[0].upTo + 1} seconds` : b.upTo === null ? `Over ${lengthText(info.bands[i - 1].upTo)}` : `Up to ${lengthText(b.upTo)}`}</span><b>{b.credits}</b></li>
          ))}
        </ul>
        <ul className="af-plain">
          {info.quality.map((q) => <li key={q.id}><span>{q.label}<small>{q.hint}</small></span><b>x{q.times}</b></li>)}
        </ul>
      </div>
    </div>
  );
}

function SendForm({ info, rec, onSent, say }) {
  const [platform, setPlatform] = useState('');
  const [url, setUrl] = useState('');
  const [seconds, setSeconds] = useState('');
  const [note, setNote] = useState('');
  const [slug, setSlug] = useState(rec ? rec.slug : '');
  const [busy, setBusy] = useState(false);
  const picking = !rec || rec.status === 'pending'; // the link name can change until the first video is approved
  const plat = info.platforms.find((p) => p.id === platform);
  const ready = platform && url.trim() && seconds !== '' && seconds > 0 && (!picking || slug.trim());

  async function send(e) {
    e.preventDefault();
    setBusy(true); say('', '');
    try {
      const r = await api('/affiliate/videos', { method: 'POST', body: { platform, url: url.trim(), seconds, note: note.trim(), ...(picking ? { slug: slug.trim() } : {}) } });
      setUrl(''); setSeconds(''); setNote(''); setPlatform('');
      onSent(r.affiliate);
      say('Sent. A reviewer will watch it and you will see the result here.', 'ok');
    } catch (err) { say(err.message, 'error'); }
    setBusy(false);
  }

  return (
    <form className="pay-card af-form" onSubmit={send}>
      <b>{rec ? 'Send another video' : 'Send your first video'}</b>
      <p className="pay-sub">Make a video about Aduna, post it, and send the link. Your first approved video makes you an affiliate.</p>

      <div className="af-field">
        <span className="af-label" id="af-app">Where is the video?</span>
        <div className="af-apps" role="radiogroup" aria-labelledby="af-app">
          {info.platforms.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={platform === p.id} className={'af-app' + (platform === p.id ? ' on' : '')} onClick={() => setPlatform(p.id)}>{p.name}</button>
          ))}
        </div>
      </div>

      <label className="af-field"><span className="af-label">Link to the video</span>
        <input type="url" inputMode="url" autoComplete="off" spellCheck="false" maxLength={info.limits.urlMax} value={url} disabled={!platform} onChange={(e) => setUrl(e.target.value)}
          placeholder={plat ? `Paste the ${plat.name} link` : 'Pick the app first'} />
      </label>

      <div className="af-field">
        <span className="af-label">How long is it?</span>
        <Length value={seconds} onChange={setSeconds} />
      </div>

      {picking && (
        <label className="af-field"><span className="af-label">Your link name</span>
          <span className="af-slug"><span>{location.host}/</span><input type="text" autoComplete="off" spellCheck="false" maxLength={info.limits.slugMax} value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="your-name" /></span>
          <small className="pay-quiet">Letters, numbers and dashes, {info.limits.slugMin} to {info.limits.slugMax} characters.</small>
        </label>
      )}

      <label className="af-field"><span className="af-label">Anything the reviewer should know? (optional)</span>
        <textarea rows={2} maxLength={info.limits.noteMax} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>

      <div className="pay-actions"><button type="submit" className="btn primary" disabled={busy || !ready}>{busy ? 'Sending…' : 'Send for review'}</button></div>
    </form>
  );
}

function Mine({ info, rec, onChange, say }) {
  const [busy, setBusy] = useState('');
  async function withdraw(v) {
    setBusy(v.id); say('', '');
    try { onChange((await api('/affiliate/videos/' + v.id, { method: 'DELETE' })).affiliate); } catch (e) { say(e.message, 'error'); }
    setBusy('');
  }
  const name = (id) => (info.platforms.find((p) => p.id === id) || { name: id }).name;
  return (
    <>
      {rec && (
        <div className="pay-card">
          <div className="pay-card-top">
            <span className="pay-ico"><Icon name="star" size={20} /></span>
            <div className="pay-card-main">
              <b>{rec.status === 'approved' ? `${TIER_NAME[rec.tier] || 'Affiliate'}` : rec.status === 'revoked' ? 'Access removed' : 'Waiting for your first approved video'}</b>
              <span className="pay-sub">Link name: {location.host}/{rec.slug}{rec.status === 'approved' ? '' : ' (reserved for you)'}</span>
            </div>
            <span className={'pay-pill' + (rec.status === 'approved' ? ' on' : rec.status === 'revoked' ? ' ending' : '')}>{rec.status === 'approved' ? 'Affiliate' : rec.status === 'revoked' ? 'Removed' : 'Pending'}</span>
          </div>
          <p className="pay-line">You have earned <b>{rec.earned.toLocaleString()} credits</b> from videos.{rec.status === 'approved' && ' Your link starts working soon.'}</p>
        </div>
      )}
      {rec && rec.videos.length > 0 && (
        <>
          <h2 className="pay-h">Your videos</h2>
          <ul className="pay-list">
            {rec.videos.map((v) => (
              <li className="pay-row af-video" key={v.id}>
                <div className="pay-row-main">
                  <b>{name(v.platform)}, {lengthText(v.seconds)}</b>
                  <a className="pay-sub" href={v.url} target="_blank" rel="noopener noreferrer">{v.url.replace(/^https:\/\//, '')}</a>
                  <span className="pay-sub">Sent {day(v.at)}{v.status === 'approved' && info.quality.find((q) => q.id === v.quality) ? `, ${info.quality.find((q) => q.id === v.quality).label}` : ''}</span>
                  {v.reviewNote && <span className="pay-sub af-note">{v.reviewNote}</span>}
                </div>
                {v.status === 'approved' && <span className="pay-amt"><Icon name="coin" size={14} /> {v.credits}</span>}
                <span className={'pay-pill' + (v.status === 'approved' ? ' on' : v.status === 'rejected' ? ' ending' : '')}>{v.status === 'pending' ? 'In review' : v.status === 'approved' ? 'Approved' : 'Not approved'}</span>
                {v.status === 'pending' && <button type="button" className="icon-btn" title="Take this back" aria-label="Take this video back" disabled={busy === v.id} onClick={() => withdraw(v)}><Icon name="trash" size={16} /></button>}
              </li>
            ))}
          </ul>
        </>
      )}
      {(!rec || rec.status !== 'revoked') && <SendForm info={info} rec={rec} onSent={onChange} say={say} />}
      <Rewards info={info} />
    </>
  );
}

function ReviewCard({ v, info, onDone, say }) {
  const [quality, setQuality] = useState('');
  const [seconds, setSeconds] = useState(v.seconds);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const q = info.quality.find((x) => x.id === quality);
  const credits = q && seconds > 0 ? Math.round(baseFor(info.bands, seconds) * q.times) : 0;
  const plat = (info.platforms.find((p) => p.id === v.platform) || { name: v.platform }).name;
  async function decide(action) {
    setBusy(true); say('', '');
    try {
      const r = await api(`/affiliate/review/${v.userId}/${v.id}`, { method: 'POST', body: { action, note: note.trim(), ...(action === 'approve' ? { quality, seconds } : {}) } });
      say(action === 'approve' ? `Approved. ${r.credits} credits sent.` : 'Sent back with your note.', 'ok');
      onDone();
    } catch (e) { say(e.message, 'error'); }
    setBusy(false);
  }
  return (
    <div className="pay-card af-review">
      <div className="pay-card-top">
        <div className="pay-card-main">
          <b>{v.displayName || v.username} <span className="pay-sub">@{v.username}</span></b>
          <span className="pay-sub">{plat}, {lengthText(v.seconds)} typed by them · {v.tier ? TIER_NAME[v.tier] : 'new'} · wants {location.host}/{v.slug}</span>
        </div>
        <a className="btn" href={v.url} target="_blank" rel="noopener noreferrer"><Icon name="link" size={14} /> Watch</a>
      </div>
      {v.note && <p className="pay-line af-note">{v.note}</p>}
      {v.own ? <p className="pay-line pay-warn">This is your own video. Someone else has to review it.</p> : (
        <>
          <div className="af-field"><span className="af-label">What does it say?</span>
            <div className="af-apps" role="radiogroup" aria-label="What the video says">
              {info.quality.map((x) => <button key={x.id} type="button" role="radio" aria-checked={quality === x.id} title={x.hint} className={'af-app' + (quality === x.id ? ' on' : '')} onClick={() => setQuality(x.id)}>{x.label} x{x.times}</button>)}
            </div>
            {q && <small className="pay-quiet">{q.hint}</small>}
          </div>
          <div className="af-field"><span className="af-label">Length you saw</span><Length value={seconds} onChange={setSeconds} /></div>
          <label className="af-field"><span className="af-label">Note (needed to send it back)</span><textarea rows={2} maxLength={info.limits.noteMax} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="pay-actions">
            <button type="button" className="btn danger" disabled={busy || !note.trim()} onClick={() => decide('reject')}>Send back</button>
            <button type="button" className="btn primary" disabled={busy || !q || !(seconds > 0)} onClick={() => decide('approve')}><Icon name="coin" size={14} /> {credits ? `Approve, pay ${credits}` : 'Approve'}</button>
          </div>
        </>
      )}
    </div>
  );
}

function Review({ info, say, onCount }) {
  const [list, setList] = useState(null);
  const load = useCallback(() => api('/affiliate/review').then((r) => { setList(r.videos); onCount(r.videos.length); }).catch((e) => say(e.message, 'error')), [say, onCount]);
  useEffect(() => { load(); }, [load]);
  if (!list) return <p className="pay-quiet">Loading…</p>;
  if (!list.length) return <div className="pay-empty"><b>Nothing waiting</b><span>New videos show up here.</span></div>;
  return <>{list.map((v) => <ReviewCard key={v.userId + v.id} v={v} info={info} say={say} onDone={load} />)}</>;
}

export default function Affiliate() {
  const [info, setInfo] = useState(null);
  const [rec, setRec] = useState(null);
  const [tab, setTab] = useState('mine');
  const [waiting, setWaiting] = useState(0);
  const [msg, setMsg] = useState({ text: '', kind: '' });
  const say = useCallback((text, kind) => setMsg({ text, kind }), []);

  useEffect(() => {
    document.title = 'Affiliate - Aduna';
    api('/affiliate/me').then((r) => { setInfo(r); setRec(r.affiliate); setWaiting(r.waiting || 0); }).catch((e) => {
      if (e.status === 401) { location.replace('/app'); return; }
      say(e.message, 'error');
    });
  }, [say]);

  const swap = useMemo(() => (r) => setRec(r), []);
  return (
    <div className="pay-page">
      <div className="pay-wrap">
        <header className="pay-head">
          <a className="pay-back" href="/app" aria-label="Back to Aduna" title="Back to Aduna"><Icon name="back" size={20} /></a>
          <h1>Affiliate program</h1>
        </header>
        <p className="pay-sub">Make a video about Aduna and earn credits for it. It is free: no payment, no fee.</p>
        {msg.text && <p className={'pay-msg ' + msg.kind} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</p>}
        {!info && !msg.text && <p className="pay-quiet">Loading…</p>}
        {info && info.reviewer && (
          <div className="af-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'mine'} className={'af-tab' + (tab === 'mine' ? ' on' : '')} onClick={() => { setTab('mine'); say('', ''); }}>My videos</button>
            <button type="button" role="tab" aria-selected={tab === 'review'} className={'af-tab' + (tab === 'review' ? ' on' : '')} onClick={() => { setTab('review'); say('', ''); }}>Review{waiting > 0 ? ` (${waiting})` : ''}</button>
          </div>
        )}
        {info && tab === 'mine' && <Mine info={info} rec={rec} onChange={swap} say={say} />}
        {info && tab === 'review' && <Review info={info} say={say} onCount={setWaiting} />}
      </div>
    </div>
  );
}
