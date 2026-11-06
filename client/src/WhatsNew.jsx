import React, { useEffect, useState } from 'react';
import { Modal } from './ui.jsx';
import { useLang } from './i18n.js';
import { getReleases, loadReleases, markWhatsNewSeen, setWhatsNewEnabled, unseenReleases, whatsNewEnabled } from './whatsnew.js';

const EVENT = 'aduna:releases'; // App.jsx fires this when a creator publishes (or pulls back) a release

function ReleaseList({ releases }) {
  const { t } = useLang();
  return (
    <div className="whatsnew-list">
      {releases.map((r) => (
        <section key={r.id} className="whatsnew-release">
          <h3>{r.title}<span className="muted small"> · {new Date(r.date + 'T12:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span></h3>
          <ul>{r.items.map((it) => <li key={it.title}><b>{it.title}</b><span>{it.text}</span></li>)}</ul>
        </section>
      ))}
      {!releases.length && <p className="muted small">{t('whatsNewNone')}</p>}
    </div>
  );
}

// Shown once after an update, over whatever the person is doing. Closing it records that this update was seen.
export function WhatsNewPopup() {
  const { t } = useLang();
  const [releases, setReleases] = useState([]);
  useEffect(() => {
    let dead = false;
    const check = () => loadReleases().then(() => { if (!dead) setReleases(unseenReleases()); });
    const id = setTimeout(check, 1500); // let the app settle before interrupting
    window.addEventListener(EVENT, check);
    return () => { dead = true; clearTimeout(id); window.removeEventListener(EVENT, check); };
  }, []);
  if (!releases.length) return null;
  const close = () => { markWhatsNewSeen(); setReleases([]); };
  return (
    <Modal title={t('whatsNewTitle')} onClose={close}>
      <ReleaseList releases={releases} />
      <label className="check-row">
        <input type="checkbox" defaultChecked={false} onChange={(e) => setWhatsNewEnabled(!e.target.checked)} />
        <span>{t('whatsNewDontShow')}</span>
      </label>
      <div className="modal-foot"><button className="btn primary" onClick={close}>{t('whatsNewGotIt')}</button></div>
    </Modal>
  );
}

// Settings > What's new: the on/off switch, and every past update to look back at.
export function WhatsNewSettings() {
  const { t } = useLang();
  const [on, setOn] = useState(whatsNewEnabled);
  const [releases, setReleases] = useState(getReleases);
  useEffect(() => {
    let dead = false;
    const load = () => loadReleases().then((r) => { if (!dead) setReleases(r); });
    load();
    window.addEventListener(EVENT, load);
    return () => { dead = true; window.removeEventListener(EVENT, load); };
  }, []);
  return (
    <div className="whatsnew-settings">
      <label className="check-row">
        <input type="checkbox" checked={on} onChange={(e) => { setOn(e.target.checked); setWhatsNewEnabled(e.target.checked); }} />
        <span>{t('whatsNewToggle')}</span>
      </label>
      <p className="muted small hint">{t('whatsNewHint')}</p>
      <label>{t('whatsNewPast')}</label>
      <ReleaseList releases={releases} />
    </div>
  );
}
