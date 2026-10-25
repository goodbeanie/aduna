import React, { useSyncExternalStore } from 'react';
import { Icon, Modal } from './ui.jsx';

// One place for the small messages and yes/no questions the app used to hand to the browser (alert / confirm).
//   toast('Could not save that', 'error')                    a short message in the corner that goes away by itself
//   await askConfirm({ title, body, confirmLabel, danger })  a dialog in the app's own style; resolves true or false
// <DialogHost /> is mounted once in App. These two functions work from anywhere, no hook needed.
let state = { toasts: [], ask: null };
const subs = new Set();
const set = (patch) => { state = { ...state, ...patch }; subs.forEach((f) => f()); };
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const snapshot = () => state;
let seq = 0;

function dismiss(id) { set({ toasts: state.toasts.filter((t) => t.id !== id) }); }

// kind: 'info' | 'error'. Errors stay a little longer.
export function toast(text, kind = 'info') {
  if (!text) return;
  const id = ++seq;
  set({ toasts: [...state.toasts.slice(-3), { id, text: String(text), kind }] });
  setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 4000);
}

// A plain string works too: askConfirm('Leave this server?'). A new question replaces one nobody answered.
export function askConfirm(opts) {
  const o = typeof opts === 'string' ? { body: opts } : (opts || {});
  return new Promise((resolve) => {
    if (state.ask) state.ask.resolve(false);
    set({ ask: { o, resolve } });
  });
}
function answer(v) {
  const a = state.ask;
  if (!a) return;
  set({ ask: null });
  a.resolve(v);
}

export function DialogHost() {
  const { toasts, ask } = useSyncExternalStore(subscribe, snapshot);
  const o = ask?.o;
  return (
    <>
      {ask && (
        <div className="dlg-layer">
        <Modal title={o.title || 'Are you sure?'} onClose={() => answer(false)}>
          {o.body && <p className="muted">{o.body}</p>}
          <div className="modal-foot">
            <button className="btn" autoFocus={!!o.danger} onClick={() => answer(false)}>{o.cancelLabel || 'Cancel'}</button>
            <button className={'btn primary' + (o.danger ? ' danger-fill' : '')} autoFocus={!o.danger} onClick={() => answer(true)}>{o.confirmLabel || 'Confirm'}</button>
          </div>
        </Modal>
        </div>
      )}
      <div className="dlg-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={'dlg-toast ' + t.kind}>
            <span>{t.text}</span>
            <button className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}><Icon name="close" size={14} /></button>
          </div>
        ))}
      </div>
    </>
  );
}
