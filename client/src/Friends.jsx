import React, { useState } from 'react';
import { Avatar, BadgeIcons, Icon, STATUS_LABEL } from './ui.jsx';
import { useLang } from './i18n.js';
import { PopMenu } from './ShellBits.jsx';
import { askConfirm } from './Dialogs.jsx';

const TABS = [['all', 'fAll'], ['online', 'fOnline'], ['pending', 'fPending'], ['add', 'fAdd']];

// Friends list order: Online, then Idle, then Offline, then Do Not Disturb.
const STATUS_ORDER = { online: 0, idle: 1, offline: 2, dnd: 3 };
const rankOf = (st) => (st in STATUS_ORDER ? STATUS_ORDER[st] : STATUS_ORDER.offline);

export default function Friends({ fr, statusOf, onMessage, onUser, onUserMenu, onRequest, onAccept, onRemove, onBack }) {
  const { t } = useLang();
  const [tab, setTab] = useState('all');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState(null); // { ok, text }
  const [busy, setBusy] = useState(false);
  const [moreId, setMoreId] = useState(null); // the friend whose "more" menu is open
  const [q, setQ] = useState(''); // the filter box on the All and Online lists

  async function removeFriend(u) {
    if (await askConfirm({ title: t('removeFriend'), body: t('confirmRemove', { name: u.displayName }), confirmLabel: t('removeFriend'), danger: true })) onRemove(u.id);
  }
  const byStatus = (a, b) =>
    rankOf(statusOf(a.id)) - rankOf(statusOf(b.id)) || a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  const sorted = [...fr.friends].sort(byStatus);
  const online = sorted.filter((u) => statusOf(u.id) !== 'offline');
  const shown = (tab === 'online' ? online : sorted).filter((u) => !q.trim() || (u.displayName + ' ' + u.username).toLowerCase().includes(q.trim().toLowerCase()));
  const pending = fr.incoming.length + fr.outgoing.length;

  async function add(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const r = await onRequest(name.trim());
      setMsg({ ok: true, text: r.result === 'friends' ? t('nowFriends', { name: r.user.displayName }) : t('requestSent', { name: r.user.displayName }) });
      setName('');
    } catch (err) {
      setMsg({ ok: false, text: err.message });
      setTimeout(() => document.getElementById('add-friend-name')?.focus(), 0);
    }
    setBusy(false);
  }

  const row = (u, sub, actions, onMain = () => onUser(u.id)) => (
    <div className="frow" key={u.id} onContextMenu={onUserMenu ? (e) => onUserMenu(e, u.id) : undefined}>
      <button className="frow-main" onClick={onMain}>
        <Avatar user={u} size={36} presence={statusOf(u.id)} />
        <div className="frow-text">
          <b data-nc style={{ '--nc': u.accentColor }}>{u.displayName}</b><BadgeIcons user={u} size={16} /><span className="muted"> @{u.username}</span>
          <div className="muted small">{sub}</div>
        </div>
      </button>
      <div className="frow-actions">{actions}</div>
    </div>
  );

  return (
    <section className="chat">
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title={t('back')} aria-label={t('backToList')} onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash"><Icon name="users" size={20} /></span>
        <h3 className="fh">{t('friends')}</h3>
        <div className="ftabs">
          {TABS.map(([k, label]) => (
            <button key={k} className={'ftab' + (tab === k ? ' on' : '') + (k === 'add' ? ' add' : '')} onClick={() => { setTab(k); setMsg(null); }}>
              {t(label)}{k === 'pending' && fr.incoming.length > 0 && <span className="badge inline">{fr.incoming.length}</span>}
            </button>
          ))}
        </div>
      </header>

      <div className="friends-body">
        {tab === 'add' && (
          <form onSubmit={add} className="add-friend">
            <h3>{t('fAdd')}</h3>
            <p className="muted">{t('addFriendSub')}</p>
            <div className="add-row">
              <input id="add-friend-name" autoFocus value={name} onChange={(e) => { setName(e.target.value); setMsg(null); }} placeholder={t('enterUsername')} aria-label={t('enterUsername')} maxLength={21} aria-invalid={msg && !msg.ok ? 'true' : undefined} aria-describedby={msg ? 'add-friend-msg' : undefined} />
              <button className="btn primary" disabled={busy || !name.trim()}>{t('sendRequest')}</button>
            </div>
            {msg && <p id="add-friend-msg" className={(msg.ok ? 'ok-text' : 'error-text field-error')} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
          </form>
        )}

        {(tab === 'online' || tab === 'all') && (
          <>
            {fr.friends.length > 0 && (
              <div className="friend-filter">
                <Icon name="search" size={16} />
                <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter friends" aria-label="Filter friends" maxLength={40} />
              </div>
            )}
            <div className="side-label">{tab === 'online' ? t('lblOnline') : t('lblAllFriends')} — {shown.length}</div>
            {shown.map((u) => row(u, STATUS_LABEL[statusOf(u.id)],
              <>
                <button className="icon-btn" title={t('message')} aria-label={t('message')} onClick={() => onMessage(u)}><Icon name="message" size={17} /></button>
                <div className="frow-more">
                  <button className="icon-btn more-btn" title={t('more')} aria-label={t('more')} aria-haspopup="menu" aria-expanded={moreId === u.id} onClick={() => setMoreId(moreId === u.id ? null : u.id)}><Icon name="more" size={17} /></button>
                  {moreId === u.id && (
                    <PopMenu className="menu frow-menu" ignore=".more-btn" onClose={() => setMoreId(null)}>
                      <button role="menuitem" className="danger-text" onClick={() => { setMoreId(null); removeFriend(u); }}>{t('removeFriend')}</button>
                    </PopMenu>
                  )}
                </div>
              </>,
              () => onMessage(u)))}
            {shown.length === 0 && (
              <div className="friends-empty">
                <p className="muted">{q.trim() && fr.friends.length > 0 ? `No friends match “${q.trim()}”.` : fr.friends.length === 0 ? t('noFriends') : t('noOneOnline')}</p>
                {fr.friends.length === 0 && <button className="btn primary" onClick={() => setTab('add')}>{t('fAdd')}</button>}
              </div>
            )}
          </>
        )}

        {tab === 'pending' && (
          <>
            {pending === 0 && <div className="friends-empty"><p className="muted">{t('noPending')}</p></div>}
            {fr.incoming.length > 0 && <div className="side-label">{t('lblIncoming')} — {fr.incoming.length}</div>}
            {fr.incoming.map(({ user }) => row(user, t('incomingReq'),
              <>
                <button className="icon-btn ok" title={t('accept')} onClick={() => onAccept(user.id)}><Icon name="check" size={17} /></button>
                <button className="icon-btn" title={t('decline')} onClick={() => onRemove(user.id)}><Icon name="close" size={16} /></button>
              </>))}
            {fr.outgoing.length > 0 && <div className="side-label">{t('lblOutgoing')} — {fr.outgoing.length}</div>}
            {fr.outgoing.map(({ user }) => row(user, t('outgoingReq'),
              <button className="icon-btn" title={t('cancelReq')} onClick={() => onRemove(user.id)}><Icon name="close" size={16} /></button>))}
          </>
        )}
      </div>
    </section>
  );
}
