import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon, Modal } from './ui.jsx';
import { askConfirm, toast } from './Dialogs.jsx';
import { Checkout } from './Credits.jsx';
import { setStorageFullHandler, sizeLabel } from './files.js';

// The storage plan: a usage bar above the profile bar, the plan window, the cleanup window (when a plan's 10 GB is full) and the checkout.
// The server decides everything (server/storage.js); this only draws it.

const GB = 1024 ** 3;
const fmt = (n) => (n >= GB ? (n / GB).toFixed(n >= 10 * GB ? 0 : 1) + ' GB' : sizeLabel(n));
const day = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const WHERE = { dm: 'Private message', group: 'Group chat', channel: 'Server channel', other: 'Unsent upload' };

// PayPal sends the buyer back to /app?storage=paypal&subscription_id=I-...; read it once, when the app starts.
const RETURN = (() => {
  try { const p = new URLSearchParams(location.search); return p.get('storage') ? { kind: p.get('storage'), id: p.get('subscription_id') } : null; }
  catch { return null; }
})();
let returnUsed = false;

// The window that lists your files, oldest first. With `needed` (a full plan) the oldest are ticked until that much is freed, and Delete
// stays off until enough is ticked; you can tick more. Without it, it is just a file manager.
function CleanupModal({ needed = 0, fileName, onDone, onCancel }) {
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
    <Modal title={needed ? 'Your storage is full' : 'Your files'} onClose={onCancel} wide>
      {needed > 0 && <p className="st-note">{fileName ? <b>{fileName}</b> : 'This file'} needs {fmt(needed)} more room. The oldest files are ticked. Tick more if you like, then delete to send it.</p>}
      {err && <p className="error-text">{err}</p>}
      {!files && !err && <p className="muted small">Loading your files…</p>}
      {files && files.length === 0 && <p className="muted small">You have no stored files.</p>}
      {files && files.length > 0 && (
        <ul className="st-list" aria-label="Your files, oldest first">
          {files.map((f) => (
            <li key={f.id}>
              <label className={'st-row' + (pick.has(f.id) ? ' on' : '')}>
                <input type="checkbox" checked={pick.has(f.id)} onChange={() => toggle(f.id)} />
                <span className="st-name">{f.name || WHERE[f.where] || 'File'}</span>
                <span className="muted small st-meta">{f.name ? WHERE[f.where] + ' · ' : ''}{day(f.createdAt)}</span>
                <b className="st-size">{fmt(f.size)}</b>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="st-actions">
        <span className="muted small">{pick.size ? `${pick.size} selected · ${fmt(sum)}` : 'Nothing selected'}{needed > 0 && !enough && pick.size > 0 ? ` · ${fmt(needed - sum)} more needed` : ''}</span>
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={remove} disabled={busy || !enough}><Icon name="trash" size={14} /> {busy ? 'Deleting…' : 'Delete selected'}</button>
      </div>
    </Modal>
  );
}

function PlanModal({ s, onClose, onSubscribe, onManage, onCancelPlan, busy }) {
  const pct = s.limit ? Math.min(100, Math.round((s.used / s.limit) * 100)) : 0;
  return (
    <Modal title="Storage" onClose={onClose}>
      {s.subscriber ? (
        <>
          <div className="st-stat"><b>{fmt(s.used)}</b><span>of {fmt(s.limit)} used</span></div>
          <div className="st-track big" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i className={pct >= 95 ? 'full' : pct >= 80 ? 'warn' : ''} style={{ width: pct + '%' }} /></div>
          <p className="st-note">{s.renews ? `Renews around ${day(s.paidThrough)} for $${(s.plan.cents / 100).toFixed(2)}.` : `Your plan ends on ${day(s.paidThrough)}. Your files are kept for 14 days after that.`} Your files are yours alone and are never removed to make room for other people.</p>
        </>
      ) : (
        <>
          <div className="st-stat"><b>{fmt(s.used)}</b><span>stored</span></div>
          <p className="st-note">Free storage is shared by everyone. When it fills up, the oldest files are removed to make room, and old files expire after a while.</p>
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
        <button className="btn" onClick={onManage}>Manage files</button>
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

  const reload = useCallback(() => api('/storage').then(setStorage).catch(() => {}), [setStorage]);
  useEffect(() => { reload(); const f = () => reload(); window.addEventListener('focus', f); return () => window.removeEventListener('focus', f); }, [reload]);

  // an upload that does not fit asks for the cleanup window and waits for the answer
  useEffect(() => {
    setStorageFullHandler((info) => new Promise((resolve) => { fullRef.current?.resolve(false); setFull({ ...info, resolve }); }));
    return () => setStorageFullHandler(null);
  }, []);

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

  if (checkout) return <Checkout pack={plan} provider={s.provider} clientId={null} tax={s.tax} busy={busy} error={coErr} onPay={subscribe} onPaid={() => {}} onError={setCoErr} onClose={() => { setCheckout(false); setBusy(false); }} />;

  return (
    <>
      <button className="storage-bar" onClick={() => setModal('plan')} title={s.subscriber ? `${fmt(s.used)} of ${fmt(s.limit)} used` : 'Storage'} aria-label={s.subscriber ? `Storage: ${fmt(s.used)} of ${fmt(s.limit)} used` : `Storage: ${fmt(s.used)} stored. Get more room`}>
        <span className="st-top">
          <span className="st-label"><Icon name="bag" size={13} /> {s.subscriber ? `${fmt(s.used)} of ${fmt(s.limit)}` : `${fmt(s.used)} stored`}</span>
          {!s.subscriber && <span className="st-up">Get {fmt(s.plan.bytes)}</span>}
        </span>
        {s.subscriber && <span className="st-track"><i className={pct >= 95 ? 'full' : pct >= 80 ? 'warn' : ''} style={{ width: pct + '%' }} /></span>}
      </button>
      {modal === 'plan' && <PlanModal s={s} busy={busy} onClose={() => setModal(null)} onSubscribe={() => { setModal(null); setCoErr(''); setCheckout(true); }} onManage={() => setModal('files')} onCancelPlan={cancelPlan} />}
      {modal === 'files' && <CleanupModal onDone={() => { setModal('plan'); reload(); }} onCancel={() => setModal('plan')} />}
      {full && <CleanupModal needed={full.needed} fileName={full.fileName} onDone={() => finishFull(true)} onCancel={() => finishFull(false)} />}
    </>
  );
}
