import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon, Modal } from './ui.jsx';
import { askConfirm, toast } from './Dialogs.jsx';
import { Checkout } from './Credits.jsx';
import { setStorageFullHandler, setPlusLimitHandler, sizeLabel } from './files.js';

// The storage plan: a usage bar above the profile bar, the plan window, the cleanup window (when a plan's 10 GB is full) and the checkout.
// The server decides everything (server/storage.js); this only draws it.

const GB = 1024 ** 3;
const fmt = (n) => (n >= GB ? (n / GB).toFixed(n >= 10 * GB ? 0 : 1) + ' GB' : sizeLabel(n));
// width of a usage bar in %: a small amount (10 MB of 10 GB) would round to 0 and the bar would look empty, so any use shows at least a sliver
const fillPct = (used, limit) => (!limit || !used ? 0 : Math.min(100, Math.max(2, (used / limit) * 100)));
// the same share as text: "<1%", "4.2%", "57%". Never "0%" while something is stored.
const pctLabel = (used, limit) => {
  if (!limit || !used) return '0%';
  const v = Math.min(100, (used / limit) * 100);
  return v < 1 ? '<1%' : v < 10 ? v.toFixed(1) + '%' : Math.round(v) + '%';
};
const day = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const WHERE = { dm: 'Private message', group: 'Group chat', channel: 'Server channel', other: 'Unsent upload' };
// icon and label for a file in the list: photo, video, audio, otherwise its extension (ZIP, HTML, ...)
const CODE_EXT = new Set(['html', 'htm', 'js', 'ts', 'css', 'json', 'xml', 'py', 'java', 'c', 'cpp', 'cs', 'php', 'sh', 'bat', 'lua', 'rb', 'go', 'rs']);
function typeInfo(f) {
  if (f.kind === 'photo') return { icon: 'camera', label: 'Photo' };
  if (f.kind === 'video') return { icon: 'video', label: 'Video' };
  if (f.kind === 'audio') return { icon: 'music', label: 'Audio' };
  const ext = String(f.ext || f.kind || '').toLowerCase();
  if (ext) return { icon: CODE_EXT.has(ext) ? 'code' : 'file', label: ext.toUpperCase() };
  return { icon: 'file', label: 'File' };
}

// PayPal sends the buyer back to /app?storage=paypal&subscription_id=I-...; read it once, when the app starts.
const RETURN = (() => {
  try { const p = new URLSearchParams(location.search); return p.get('storage') ? { kind: p.get('storage'), id: p.get('subscription_id') } : null; }
  catch { return null; }
})();
let returnUsed = false;

// The window that lists your files, oldest first. With `needed` (a full plan) the oldest are ticked until that much is freed, and Delete
// stays off until enough is ticked; you can tick more. Without it, it is just a file manager.
function CleanupModal({ needed = 0, fileName, limitMB = 0, readOnly = false, onUpgrade, plusBytes = 0, onDone, onCancel }) {
  const [files, setFiles] = useState(null);
  const [pick, setPick] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    let dead = false;
    api('/storage/files?needed=' + needed).then((r) => { if (!dead) { setFiles(r.files); setPick(new Set(r.suggest)); } }).catch((e) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, [needed]);
  const sum = useMemo(() => (files || []).filter((f) => pick.has(f.id)).reduce((t, f) => t + f.size, 0), [files, pick]);
  const enough = sum >= needed && pick.size > 0;
  const toggle = (id) => setPick((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  async function remove() {
    setBusy(true); setErr('');
    try { await api('/storage/delete', { method: 'POST', body: { ids: [...pick] } }); onDone(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={needed ? (readOnly ? 'Attachments are read-only' : limitMB ? 'Your free storage is full' : 'Your storage is full') : 'Your files'} onClose={onCancel} wide>
      {needed > 0 && readOnly && <p className="st-note">The free storage limit is now {limitMB} MB and you are over it. You cannot add attachments until you free up {fmt(needed)}{fileName ? <> for <b>{fileName}</b></> : ''}. Delete some old files{onUpgrade ? `, or get ${fmt(plusBytes)} of your own with Plus` : ''}. The oldest files are ticked. Older files could be removed to make room for others.</p>}
      {needed > 0 && !readOnly && <p className="st-note">{fileName ? <b>{fileName}</b> : 'This file'} needs {fmt(needed)} more room. The oldest files are ticked. Tick more if you like, then delete to send it.{onUpgrade ? ` Or get ${fmt(plusBytes)} of your own with Plus.` : ''}</p>}
      {err && <p className="error-text">{err}</p>}
      {!files && !err && <p className="muted small">Loading your files…</p>}
      {files && files.length === 0 && <p className="muted small">You have no stored files.</p>}
      {files && files.length > 0 && (
        <ul className="st-list" aria-label="Your files, oldest first">
          {files.map((f) => {
            const t = typeInfo(f);
            return (
              <li key={f.id}>
                <label className={'st-row keep-case' + (pick.has(f.id) ? ' on' : '')}>
                  <input type="checkbox" checked={pick.has(f.id)} onChange={() => toggle(f.id)} />
                  <span className="st-ico"><Icon name={t.icon} size={18} /></span>
                  <span className="st-main">
                    <span className="st-name">{f.name || t.label}</span>
                    <span className="st-sub">{WHERE[f.where] || 'File'} · {day(f.createdAt)}</span>
                  </span>
                  <span className="st-type">{t.label}</span>
                  <b className="st-size">{fmt(f.size)}</b>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="st-actions">
        <span className="muted small">{pick.size ? `${pick.size} selected · ${fmt(sum)}` : 'Nothing selected'}{needed > 0 && !enough && pick.size > 0 ? ` · ${fmt(needed - sum)} more needed` : ''}</span>
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        {onUpgrade && <button className="btn" onClick={onUpgrade} disabled={busy}><Icon name="bag" size={14} /> Get {fmt(plusBytes)}</button>}
        <button className="btn primary" onClick={remove} disabled={busy || !enough}><Icon name="trash" size={14} /> {busy ? 'Deleting…' : 'Delete selected'}</button>
      </div>
    </Modal>
  );
}

// Plus: the plan's 10 GB always applies. An upload limit of your own is optional (a smaller number than the plan).
// `requireChange`: the Save button stays off until the choice differs from what is saved (the Storage window); the "do you want a limit?" question leaves it on.
function LimitForm({ current, onSave, busy, saveLabel = 'Save', max = 10, requireChange = false }) {
  const [mode, setMode] = useState(current ? 'set' : 'none');
  const [gb, setGb] = useState(current ? String(Math.round((current / GB) * 10) / 10) : String(Math.min(5, max)));
  const n = Number(gb);
  const valid = mode === 'none' || (Number.isFinite(n) && n >= 1 && n <= max);
  const changed = mode === 'none' ? !!current : !current || Math.round(n * 10) !== Math.round((current / GB) * 10);
  return (
    <div className="st-limit" role="radiogroup" aria-label="Upload limit">
      <label className={'st-row st-radio keep-case' + (mode === 'none' ? ' on' : '')}>
        <input type="radio" name="plus-limit" checked={mode === 'none'} onChange={() => setMode('none')} />
        <span className="st-main"><span className="st-name">No upload limit</span><span className="st-sub">Upload up to the full {max} GB of your plan.</span></span>
      </label>
      <label className={'st-row st-radio keep-case' + (mode === 'set' ? ' on' : '')}>
        <input type="radio" name="plus-limit" checked={mode === 'set'} onChange={() => setMode('set')} />
        <span className="st-main"><span className="st-name">Set an upload limit</span><span className="st-sub">Uploads stop when you reach it. You can change it any time.</span></span>
        {mode === 'set' && (
          <span className="st-gb">
            <input type="number" min="1" max={max} step="1" value={gb} onChange={(e) => setGb(e.target.value)} aria-label={`Upload limit in GB, 1 to ${max}`} aria-invalid={!valid} />
            <span>GB</span>
          </span>
        )}
      </label>
      {mode === 'set' && !valid && <p className="st-hint">Enter a number from 1 to {max}.</p>}
      <button className="btn primary" onClick={() => onSave(mode === 'none' ? null : n)} disabled={busy || !valid || (requireChange && !changed)}>{saveLabel}</button>
    </div>
  );
}

function PlanModal({ s, onClose, onSubscribe, onManage, onCancelPlan, onSaveLimit, busy }) {
  const pct = s.limit ? Math.min(100, Math.round((s.used / s.limit) * 100)) : 0;
  return (
    <Modal title="Storage" onClose={onClose}>
      {s.subscriber ? (
        <>
          <div className="st-stat"><b>{fmt(s.used)}</b><span>of {fmt(s.limit)} used</span></div>
          <div className="st-track big" role="progressbar" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <i className={pct >= 95 ? 'full' : pct >= 80 ? 'warn' : ''} style={{ width: fillPct(s.used, s.limit) + '%' }} />
            {s.uploadLimit > 0 && s.uploadLimit < s.limit && <b className="st-mark" title={`Upload limit: ${fmt(s.uploadLimit)}`} style={{ left: Math.min(99, (s.uploadLimit / s.limit) * 100) + '%' }} />}
          </div>
          <div className="st-scale">
            <span>{pctLabel(s.used, s.limit)} used</span>
            <span>{s.uploadLimit > 0 && s.uploadLimit < s.limit ? `Upload limit ${fmt(s.uploadLimit)}` : `${fmt(Math.max(0, s.limit - s.used))} free`}</span>
          </div>
          <p className="st-note">{s.lifetime ? 'Aduna Plus is on for this account for good.' : s.renews ? `Renews around ${day(s.paidThrough)} for $${(s.plan.cents / 100).toFixed(2)}.` : `Your plan ends on ${day(s.paidThrough)}. Your files are kept for 14 days after that.`} Your files are yours alone and are never removed to make room for other people.</p>
          <p className="st-head">Upload limit <span>(optional)</span></p>
          <LimitForm current={s.uploadLimit} max={Math.round(s.limit / GB)} onSave={onSaveLimit} busy={busy} requireChange />
        </>
      ) : (
        <>
          {s.freeLimit ? (
            <>
              <div className="st-stat"><b>{fmt(s.used)}</b><span>of {fmt(s.freeLimit)} free storage used</span></div>
              <div className="st-track big" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round((s.used / s.freeLimit) * 100))}><i className={s.readOnly || s.used >= s.freeLimit * 0.95 ? 'full' : s.used >= s.freeLimit * 0.8 ? 'warn' : ''} style={{ width: fillPct(s.used, s.freeLimit) + '%' }} /></div>
              {s.readOnly && <p className="st-note"><b>Attachments are read-only.</b> The free limit is now {fmt(s.freeLimit)} and you are over it. You can still see and download your files, but you cannot add more until you delete some files or get {fmt(s.plan.bytes)} of your own. Older files could be removed to make room for others.</p>}
              <p className="st-note"><b>Heads up:</b> free storage is limited per person ({fmt(s.freeLimit)} right now) and old files expire after a while. The limit follows how many people support Aduna, so it can go down or up. Older files could be removed to make room, so download anything you want to keep, or get {fmt(s.plan.bytes)} of your own so nothing is ever removed.</p>
            </>
          ) : (
            <>
              <div className="st-stat"><b>{fmt(s.used)}</b><span>stored</span></div>
              <p className="st-note">Free storage is shared by everyone. When it fills up, the oldest files are removed to make room, and old files expire after a while.</p>
            </>
          )}
          <div className="st-offer">
            <div className="st-offer-head">
              <div><div className="st-offer-title">{fmt(s.plan.bytes)} of your own</div><div className="st-note">Just for you</div></div>
              <div className="st-price">${(s.plan.cents / 100).toFixed(2)}<small>/month</small></div>
            </div>
            <ul className="st-perks">
              <li>Never removed or expired while you have it</li>
              <li>You choose what to delete when it is full</li>
              <li>Cancel any time</li>
            </ul>
            <button className="btn primary st-cta" onClick={onSubscribe} disabled={!s.purchases || busy}>{s.purchases ? 'Get storage' : 'Not available yet'}</button>
          </div>
          {s.status === 'ended' && <p className="st-note">Your last plan ended{s.paidThrough ? ' on ' + day(s.paidThrough) : ''}. Files are kept for 14 days after that, then the normal clean-up applies again.</p>}
        </>
      )}
      <div className="st-actions">
        <button className="btn st-left" onClick={onManage}>Manage files</button>
        {s.subscriber && s.renews && <button className="btn danger-btn" onClick={onCancelPlan} disabled={busy}>Cancel plan</button>}
        <button className="btn primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

// `storage` and `setStorage` live in App.jsx (it also listens for the 'storage:update' socket event).
export function StorageDock({ storage, setStorage }) {
  const [modal, setModal] = useState(null);        // 'plan' | 'files' | null
  const [full, setFull] = useState(null);          // { needed, fileName, resolve } while an upload waits for room
  const [checkout, setCheckout] = useState(false);
  const [coErr, setCoErr] = useState('');
  const [busy, setBusy] = useState(false);
  const fullRef = useRef(null); fullRef.current = full;
  const [ask, setAsk] = useState(null);            // { resolve } while a Plus person's first upload waits for "do you want a limit?"
  const askRef = useRef(null); askRef.current = ask;

  const reload = useCallback(() => api('/storage').then(setStorage).catch(() => {}), [setStorage]);
  useEffect(() => { reload(); const f = () => reload(); window.addEventListener('focus', f); return () => window.removeEventListener('focus', f); }, [reload]);

  // an upload that does not fit asks for the cleanup window and waits for the answer
  useEffect(() => {
    setStorageFullHandler((info) => new Promise((resolve) => { fullRef.current?.resolve(false); setFull({ ...info, resolve }); }));
    setPlusLimitHandler(() => new Promise((resolve) => { askRef.current?.resolve(false); setAsk({ resolve }); }));
    return () => { setStorageFullHandler(null); setPlusLimitHandler(null); };
  }, []);

  async function saveLimit(gb, afterAsk = false) {
    setBusy(true);
    try {
      setStorage(await api('/storage/limit', { method: 'POST', body: { gb } }));
      toast(gb === null ? 'Upload limit removed. You can use all of your plan.' : `Upload limit set to ${gb} GB.`);
      if (afterAsk) { askRef.current?.resolve(true); setAsk(null); }
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }

  // every free person is warned about their limit: once when the app opens, and again whenever the limit changes
  const warnedLimit = useRef(null);
  useEffect(() => {
    if (!storage || storage.subscriber || !storage.freeLimit || warnedLimit.current === storage.freeLimit) return;
    const first = warnedLimit.current === null;
    warnedLimit.current = storage.freeLimit;
    toast(`Free storage ${first ? 'is' : 'is now'} ${fmt(storage.freeLimit)} per person.${storage.readOnly ? ' You are over it, so attachments are read-only.' : ''} Older files could be removed to make room, so keep a copy of anything important.`);
  }, [storage]);

  // back from PayPal: the server asks PayPal whether the plan is on (it never believes the browser)
  useEffect(() => {
    if (!RETURN || returnUsed) return;
    returnUsed = true;
    try { history.replaceState(null, '', '/app'); } catch { /* ignore */ }
    if (RETURN.kind === 'cancelled') { toast('Checkout cancelled. You were not charged.'); return; }
    if (RETURN.kind !== 'paypal' || !RETURN.id) return;
    toast('Confirming your plan with PayPal…');
    let tries = 0;
    const ask = () => api('/storage/confirm', { method: 'POST', body: { subscriptionId: RETURN.id } }).then((r) => {
      setStorage(r);
      if (r.status === 'active') toast('Your storage plan is on. Thank you!');
      else if (r.status === 'pending' && ++tries < 8) setTimeout(ask, 4000);
      else if (r.status === 'pending') toast('PayPal is still processing it. Your plan turns on as soon as it clears.');
      else toast('PayPal did not start the plan. You were not charged.', 'error');
    }).catch((e) => toast(e.message, 'error'));
    ask();
  }, [setStorage]);

  async function subscribe(buyer = {}) {
    setBusy(true); setCoErr('');
    try { const { url } = await api('/storage/subscribe', { method: 'POST', body: buyer }); window.location.assign(url); }
    catch (e) { setCoErr(e.message); setBusy(false); }
  }
  async function cancelPlan() {
    if (!(await askConfirm({ title: 'Cancel storage plan', body: 'You keep the plan until the month you paid for ends. After that your files are kept for 14 more days.', confirmLabel: 'Cancel plan' }))) return;
    setBusy(true);
    try { setStorage(await api('/storage/cancel', { method: 'POST' })); toast('Your plan will not renew.'); }
    catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }
  const finishFull = (ok) => { full?.resolve(ok); setFull(null); reload(); };

  if (!storage) return null;
  const s = storage;
  const pct = s.limit ? Math.min(100, Math.round((s.used / s.limit) * 100)) : 0;
  const plan = { ...s.plan, recurring: true, title: 'Aduna Storage', subtitle: `${fmt(s.plan.bytes)} of your own · billed monthly`, icon: 'bag' };

  const freePct = s.freeLimit ? Math.min(100, Math.round((s.used / s.freeLimit) * 100)) : 0;

  if (checkout) return <Checkout pack={plan} provider={s.provider} clientId={null} tax={s.tax} busy={busy} error={coErr} onPay={subscribe} onPaid={() => {}} onError={setCoErr} onClose={() => { setCheckout(false); setBusy(false); }} />;

  return (
    <>
      <button className="storage-bar" onClick={() => setModal('plan')} title={s.subscriber ? (s.limit ? `${fmt(s.used)} of ${fmt(s.limit)} used` : `${fmt(s.used)} stored, no limit`) : s.freeLimit ? `${fmt(s.used)} of ${fmt(s.freeLimit)} free storage used` : 'Storage'} aria-label={s.subscriber ? (s.limit ? `Storage: ${fmt(s.used)} of ${fmt(s.limit)} used` : `Storage: ${fmt(s.used)} stored, no limit`) : s.freeLimit ? `Storage: ${fmt(s.used)} of ${fmt(s.freeLimit)} used${s.readOnly ? ', attachments are read-only' : ''}. Get more room` : `Storage: ${fmt(s.used)} stored. Get more room`}>
        <span className="st-top">
          <span className="st-label"><Icon name="bag" size={13} /> {s.subscriber ? (s.limit ? `${fmt(s.used)} of ${fmt(s.limit)}` : `${fmt(s.used)} stored`) : s.freeLimit ? `${fmt(s.used)} of ${fmt(s.freeLimit)}` : `${fmt(s.used)} stored`}</span>
          {!s.subscriber && <span className="st-up">{s.readOnly ? 'Read-only' : `Get ${fmt(s.plan.bytes)}`}</span>}
        </span>
        {s.subscriber && s.limit && <span className="st-track"><i className={pct >= 95 ? 'full' : pct >= 80 ? 'warn' : ''} style={{ width: fillPct(s.used, s.limit) + '%' }} /></span>}
        {!s.subscriber && s.freeLimit && <span className="st-track"><i className={s.readOnly || freePct >= 95 ? 'full' : freePct >= 80 ? 'warn' : ''} style={{ width: fillPct(s.used, s.freeLimit) + '%' }} /></span>}
      </button>
      {modal === 'plan' && <PlanModal s={s} busy={busy} onClose={() => setModal(null)} onSubscribe={() => { setModal(null); setCoErr(''); setCheckout(true); }} onManage={() => setModal('files')} onCancelPlan={cancelPlan} onSaveLimit={(gb) => saveLimit(gb)} />}
      {ask && (
        <Modal title="Do you want a storage limit?" onClose={() => { ask.resolve(false); setAsk(null); }}>
          <p className="st-note">With Plus your files are never removed. You can keep uploading with no limit, or set one yourself so uploads stop at a size you choose. You can change this any time in Storage.</p>
          <LimitForm current={null} onSave={(gb) => saveLimit(gb, true)} busy={busy} saveLabel="Save and upload" />
        </Modal>
      )}
      {modal === 'files' && <CleanupModal onDone={() => { setModal('plan'); reload(); }} onCancel={() => setModal('plan')} />}
      {full && <CleanupModal needed={full.needed} fileName={full.fileName} limitMB={full.freeLimitMB || 0} readOnly={!!full.readOnly} plusBytes={s.plan.bytes}
        onUpgrade={full.canUpgrade && s.purchases ? () => { finishFull(false); setCoErr(''); setCheckout(true); } : null}
        onDone={() => finishFull(true)} onCancel={() => finishFull(false)} />}
    </>
  );
}
