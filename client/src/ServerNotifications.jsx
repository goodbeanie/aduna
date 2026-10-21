import React from 'react';
import { Modal, Icon } from './ui.jsx';
import * as np from './notifprefs.js';

// Server menu > Notification settings. Every change is saved at once (on your account, so it follows you to other devices).
// What the numbers mean is decided in notifprefs.js: "All messages" counts every message as unread, "Only @mentions" counts just
// the ones that name you (or @everyone), "Nothing" counts nothing. Muting silences alerts and the unread number, but a direct
// @mention is still counted quietly so you do not miss it.

const H = 3600 * 1000;
const DURATIONS = [['15 minutes', 15 * 60 * 1000], ['1 hour', H], ['8 hours', 8 * H], ['24 hours', 24 * H], ['Until I turn it back on', null]];
const LEVEL_NAMES = { all: 'All messages', mentions: 'Only @mentions', nothing: 'Nothing' };
const LEVEL_HINT = {
  all: 'Unread numbers for every message. You are alerted for @mentions and announcements.',
  mentions: 'Only messages that name you (or @everyone) are counted. Announcements still alert you.',
  nothing: 'No numbers and no alerts, not even for @mentions. A channel can still opt back in below.',
};

export const muteLabel = (mute, now = Date.now()) => {
  if (!np.muteActive(mute, now)) return '';
  if (mute.until === null) return 'Muted until you turn it back on';
  const d = new Date(mute.until), t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return 'Muted until ' + (d.toDateString() === new Date(now).toDateString() ? t : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + t);
};

function MuteButtons({ mute, onMute, onUnmute, idPrefix }) {
  const on = np.muteActive(mute);
  return (
    <div className="mute-row">
      {DURATIONS.map(([label, ms]) => <button key={label} type="button" className="btn small-btn" onClick={() => onMute(ms === null ? null : Date.now() + ms)} aria-label={`${idPrefix} ${label}`}>{label}</button>)}
      {on && <button type="button" className="btn small-btn primary" onClick={onUnmute}>Unmute</button>}
    </div>
  );
}

export function ServerNotifications({ server, prefs, focusChannel, onSave, onMarkRead, onClose }) {
  const sp = prefs || {};
  const [open, setOpen] = React.useState(focusChannel || null); // the channel whose mute buttons are showing
  const now = Date.now();
  const level = np.LEVELS.includes(sp.level) ? sp.level : 'all';
  const change = (patch) => {
    const next = { ...sp, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === false) delete next[k];
    onSave(next);
  };
  const chanChange = (cid, patch) => {
    const channels = { ...(sp.channels || {}) };
    const c = { ...(channels[cid] || {}), ...patch };
    for (const k of Object.keys(c)) if (c[k] === undefined || c[k] === 'default') delete c[k];
    if (Object.keys(c).length) channels[cid] = c; else delete channels[cid];
    change({ channels: Object.keys(channels).length ? channels : undefined });
  };
  const listed = server.channels.filter((c) => c.type !== 'voice' && c.type !== 'rules'); // nothing is posted in those
  const focusRef = React.useRef(null);
  React.useEffect(() => { focusRef.current?.scrollIntoView?.({ block: 'center' }); }, []);

  return (
    <Modal title={`Notifications · ${server.name}`} onClose={onClose} wide>
      <label>MUTE SERVER</label>
      <p className="muted small hint">{np.muteActive(sp.mute, now) ? muteLabel(sp.mute, now) + '.' : 'Not muted.'} While muted you get no alerts and no unread numbers; a direct @mention is still counted quietly.</p>
      <MuteButtons mute={sp.mute} idPrefix="Mute server for" onMute={(until) => change({ mute: { until } })} onUnmute={() => change({ mute: undefined })} />

      <label>NOTIFY ME FOR</label>
      {np.LEVELS.map((l) => (
        <label key={l} className="check-row">
          <input type="radio" name="note-level" checked={level === l} onChange={() => change({ level: l === 'all' ? undefined : l })} />
          <span>{LEVEL_NAMES[l]}</span>
        </label>
      ))}
      <p className="muted small hint">{LEVEL_HINT[level]}</p>

      <label className="check-row">
        <input type="checkbox" checked={sp.noEveryone === true} onChange={(e) => change({ noEveryone: e.target.checked })} />
        <span>Ignore @everyone</span>
      </label>
      <p className="muted small hint">A message that pings everyone is then just an ordinary message to you.</p>
      <label className="check-row">
        <input type="checkbox" checked={sp.noAnnouncements === true} onChange={(e) => change({ noAnnouncements: e.target.checked })} />
        <span>Do not alert me for announcements</span>
      </label>
      <p className="muted small hint">They are still counted as unread in the announcements channel.</p>

      <label>CHANNELS</label>
      <p className="muted small hint">A channel's own setting beats the server's. Right-click a channel in the list to come straight here.</p>
      <div className="note-chans">
        {listed.map((c) => {
          const cs = (sp.channels || {})[c.id] || {};
          const eff = np.effective(sp, c.id, now);
          const isOpen = open === c.id;
          return (
            <div key={c.id} className={'note-chan' + (eff.muted ? ' muted' : '')} ref={focusChannel === c.id ? focusRef : null}>
              <div className="note-chan-head">
                <span className="hash">{c.type === 'announcements' ? <Icon name="megaphone" size={16} /> : '#'}</span>
                <b className="grow">{c.name}</b>
                <select aria-label={`Notify me for ${c.name}`} value={cs.level || 'default'} onChange={(e) => chanChange(c.id, { level: e.target.value })}>
                  <option value="default">Server setting ({LEVEL_NAMES[level]})</option>
                  {np.LEVELS.map((l) => <option key={l} value={l}>{LEVEL_NAMES[l]}</option>)}
                </select>
                <button type="button" className={'btn small-btn' + (np.muteActive(cs.mute, now) ? ' primary' : '')} onClick={() => (np.muteActive(cs.mute, now) ? chanChange(c.id, { mute: undefined }) : setOpen(isOpen ? null : c.id))} aria-expanded={isOpen}>
                  {np.muteActive(cs.mute, now) ? 'Unmute' : 'Mute…'}
                </button>
              </div>
              {np.muteActive(cs.mute, now) && <div className="muted small">{muteLabel(cs.mute, now)}</div>}
              {!np.muteActive(cs.mute, now) && eff.serverMuted && <div className="muted small">Muted with the server</div>}
              {isOpen && !np.muteActive(cs.mute, now) && (
                <MuteButtons mute={cs.mute} idPrefix={`Mute ${c.name} for`} onMute={(until) => { chanChange(c.id, { mute: { until } }); setOpen(null); }} onUnmute={() => {}} />
              )}
            </div>
          );
        })}
      </div>

      <div className="modal-foot">
        <button type="button" className="btn" onClick={onMarkRead}>Mark all as read</button>
        <button type="button" className="btn primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
